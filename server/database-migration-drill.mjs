import { createHash } from "node:crypto";
import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { BackupError, prepareRestore, validateAccountDatabase, verifyBackup } from "./database-backup.mjs";

const quote = (identifier) => `"${String(identifier).replaceAll('"', '""')}"`;
const digest = (value) => createHash("sha256").update(value).digest("hex");
export class MigrationDrillError extends Error {
  constructor(code, result = undefined) { super(code); this.code = code; this.result = result; }
}
const fail = (code) => { throw new MigrationDrillError(code); };

function encodeValue(value) {
  if (value === null) return ["null"];
  if (typeof value === "bigint") return ["integer", value.toString()];
  if (typeof value === "string") return ["text", value];
  if (typeof value === "number") {
    const bytes = Buffer.allocUnsafe(8); bytes.writeDoubleBE(value);
    return ["real", bytes.toString("hex")];
  }
  if (value instanceof Uint8Array) return ["blob", Buffer.from(value).toString("base64")];
  fail("migration_value_type_unsupported");
}

function inspectRows(databasePath, projection = null) {
  // No rows, credentials, or per-row digests leave this function. Only sorted
  // row hashes are retained in memory; duplicate rows remain significant.
  const db = new DatabaseSync(databasePath, { readOnly: true, timeout: 5000 });
  try {
    db.exec("BEGIN");
    const tables = projection ? Object.keys(projection).sort() : db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all().map((row) => row.name);
    return Object.fromEntries(tables.map((table) => {
      const columns = projection ? projection[table].columns : db.prepare(`PRAGMA table_xinfo(${quote(table)})`).all()
        .filter((column) => column.hidden !== 1).map((column) => column.name);
      if (!columns.length) fail("migration_table_columns_missing");
      const statement = db.prepare(`SELECT ${columns.map(quote).join(",")} FROM ${quote(table)}`);
      statement.setReadBigInts(true); statement.setReturnArrays(true);
      const rows = [];
      for (const row of statement.iterate()) rows.push(digest(JSON.stringify(row.map(encodeValue))));
      rows.sort();
      const hash = createHash("sha256").update(JSON.stringify(columns)).update("\n");
      for (const row of rows) hash.update(row).update("\n");
      return [table, { columns, row_count: rows.length, digest: hash.digest("hex") }];
    }));
  } finally {
    try { db.exec("ROLLBACK"); } finally { db.close(); }
  }
}

function compareRows(before, after) {
  return Object.fromEntries(Object.entries(before).map(([table, original]) => [table, {
    rows_before: original.row_count,
    rows_after: after[table]?.row_count ?? null,
    columns_compared: original.columns.length,
    data_digest_equal: original.digest === after[table]?.digest,
  }]));
}
const unchanged = (comparison) => Object.values(comparison).every((entry) => entry.data_digest_equal && entry.rows_before === entry.rows_after);

function migratePrivateCopy(databasePath) {
  // Only the constructor runs. No login/authentication/seed calls, expiration
  // housekeeping, HTTP listeners, or production runtime configuration is used.
  // A separate bounded process also releases SQLite handles if a constructor
  // throws partway through migration; raw child errors are never reported.
  const script = `import {AccountStore} from ${JSON.stringify(new URL("./account-store.mjs", import.meta.url).href)};
    const store = new AccountStore({databasePath: process.argv[1]}); store.close();`;
  const child = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script, databasePath], {
    windowsHide: true, encoding: "utf8", timeout: 60_000, maxBuffer: 65_536,
  });
  if (child.error || child.status !== 0) fail("migration_constructor_failed");
}

export async function runMigrationDrill({ databasePath, manifestPath, destinationDirectory }) {
  const verified = await verifyBackup({ databasePath, manifestPath });
  const sourceManifestHash = digest(await readFile(manifestPath));
  const restored = await prepareRestore({ databasePath, manifestPath, destinationDirectory });
  const sourceReal = await realpath(databasePath);
  const copyReal = await realpath(restored.databasePath);
  if (sourceReal === copyReal || dirname(copyReal) !== await realpath(restored.directory)
      || dirname(await realpath(restored.directory)) !== await realpath(destinationDirectory)) fail("migration_private_copy_required");
  // A pre-migration manifest cannot describe the subsequently migrated bytes.
  // Keep it as provenance, never leave a stale success manifest at manifest.json.
  await rename(restored.manifestPath, join(restored.directory, "pre-migration-manifest.json"));
  const reportPath = join(restored.directory, "migration-drill.json");
  const summary = {
    schema: "kiwi-duel-isolated-migration-drill-1",
    source_profile: verified.schema_profile,
    source_schema_sha256: verified.schema_sha256,
    prepared_copy_digest_equal: false,
    original_rows_preserved: false,
    migrated_schema_valid: false,
    reopen_schema_stable: false,
    reopen_data_stable: false,
    input_backup_unchanged: false,
    input_manifest_unchanged: false,
    expiry_purge_permitted: false,
  };
  let errorCode = null;
  try {
    const before = inspectRows(sourceReal);
    summary.prepared_copy_digest_equal = unchanged(compareRows(before, inspectRows(copyReal, before)));
    if (!summary.prepared_copy_digest_equal) fail("migration_prepared_copy_changed");
    migratePrivateCopy(copyReal);
    const migrated = await validateAccountDatabase(copyReal);
    summary.migrated_profile = migrated.schema_profile;
    summary.migrated_schema_sha256 = migrated.schema_sha256;
    summary.migrated_schema_valid = migrated.schema_profile === "owned-accounts-reusable-15";
    const projected = inspectRows(copyReal, before);
    summary.original_tables = compareRows(before, projected);
    summary.original_rows_preserved = unchanged(summary.original_tables);
    summary.tables_after = migrated.row_counts;
    if (!summary.migrated_schema_valid) fail("migration_current_schema_required");
    if (!summary.original_rows_preserved) fail("migration_original_rows_changed");
    const firstOpen = inspectRows(copyReal);
    migratePrivateCopy(copyReal);
    const reopened = await validateAccountDatabase(copyReal);
    summary.reopen_schema_stable = migrated.schema_sha256 === reopened.schema_sha256;
    summary.reopen_data_stable = unchanged(compareRows(firstOpen, inspectRows(copyReal, firstOpen)));
    if (!summary.reopen_schema_stable || !summary.reopen_data_stable) fail("migration_reopen_unstable");
  } catch (error) {
    errorCode = error instanceof MigrationDrillError || error instanceof BackupError ? error.code : "migration_operation_failed";
  }
  try {
    const after = await verifyBackup({ databasePath, manifestPath });
    summary.input_backup_unchanged = verified.manifest.sha256 === after.manifest.sha256;
    summary.input_manifest_unchanged = sourceManifestHash === digest(await readFile(manifestPath));
    if (!summary.input_backup_unchanged || !summary.input_manifest_unchanged) errorCode = "migration_input_changed";
  } catch { errorCode = "migration_input_validation_failed"; }
  const result = { ok: errorCode === null, directory: restored.directory, databasePath: copyReal, reportPath, summary,
    ...(errorCode ? { error: errorCode } : {}) };
  // Private staging metadata contains comparison booleans/counts, not row data
  // or in-memory data hashes. A failed copy is retained for operator diagnosis.
  await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  if (errorCode) throw new MigrationDrillError(errorCode, result);
  return result;
}

async function main(flags) {
  const options = {};
  const allowed = ["database", "manifest", "output"];
  if (flags.length !== 6) fail("usage_database_manifest_output_required");
  for (let index = 0; index < flags.length; index += 2) {
    const key = flags[index].replace(/^--/, "");
    if (flags[index] !== `--${key}` || !allowed.includes(key) || options[key] || !flags[index + 1]
        || flags[index + 1].startsWith("--")) fail("migration_arguments_invalid");
    options[key] = flags[index + 1];
  }
  if (allowed.some((key) => !options[key])) fail("migration_arguments_invalid");
  return runMigrationDrill({ databasePath: options.database, manifestPath: options.manifest, destinationDirectory: options.output });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.umask(0o077);
  try { console.log(JSON.stringify(await main(process.argv.slice(2)), null, 2)); }
  catch (error) {
    console.error(JSON.stringify(error instanceof MigrationDrillError && error.result ? error.result
      : { ok: false, error: error instanceof MigrationDrillError || error instanceof BackupError ? error.code : "migration_operation_failed" }));
    process.exitCode = 1;
  }
}
