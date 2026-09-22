import { backup, DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const BACKUP_FORMAT = "kiwi-duel-sqlite-backup-v2";
const LEGACY_BACKUP_FORMAT = "kiwi-duel-sqlite-backup-v1";
// An account database, not an arbitrary SQLite file. Additive migrations are
// permitted; the complete schema fingerprint is captured for restore checks.
const CORE_COLUMNS = {
  users: ["id", "email", "display_name", "password_hash", "password_salt", "rank", "coins", "gems", "created_at", "updated_at"],
  browser_sessions: ["token_hash", "user_id", "csrf_token", "expires_at", "created_at"],
  device_links: ["device_hash", "user_id", "link_code_hash", "link_expires_at", "created_at", "linked_at"],
  game_sessions: ["token_hash", "user_id", "device_hash", "expires_at", "created_at"],
  user_figures: ["id", "user_id", "item_master_id", "model_id", "level", "source", "source_chest_id", "acquired_at"],
  user_plates: ["id", "user_id", "item_master_id", "quantity", "acquired_at"],
  user_decks: ["user_id", "deck_no", "name"],
  user_deck_figures: ["user_id", "deck_no", "deck_index", "item_master_id", "model_id"],
  user_deck_plates: ["user_id", "deck_no", "deck_index", "item_master_id"],
  chests: ["id", "user_id", "slot_index", "state", "reward_item_master_id", "reward_model_id", "unlock_started_at", "ready_at", "created_at", "claimed_at", "source", "source_key"],
  inventory_events: ["id", "user_id", "event_type", "source_key", "payload_json", "created_at"],
};
const ACCESS_COLUMNS = {
  browser_sessions: ["session_id", "label", "last_seen_at"],
  device_links: ["device_id", "label", "last_seen_at"],
};
const NEW_COLUMNS = {
  anonymous_browser_sessions: ["token_hash", "csrf_token", "expires_at"],
  device_link_requests: ["code_hash", "device_hash", "expires_at", "created_at"],
  completed_matches: ["match_id", "mode", "winner", "reason", "finished_at", "completion_json", "completion_hash"],
  completed_match_players: ["match_id", "user_id", "side"],
};
const PRIMARY_KEYS = {
  users: ["id"], browser_sessions: ["token_hash"], device_links: ["device_hash"], game_sessions: ["token_hash"],
  user_figures: ["id"], user_plates: ["id"], user_decks: ["user_id", "deck_no"],
  user_deck_figures: ["user_id", "deck_no", "deck_index"], user_deck_plates: ["user_id", "deck_no", "deck_index"],
  chests: ["id"], inventory_events: ["id"], anonymous_browser_sessions: ["token_hash"],
  device_link_requests: ["code_hash"], completed_matches: ["match_id"], completed_match_players: ["match_id", "user_id"],
};
const V1_COUNTED_TABLES = [...Object.keys(CORE_COLUMNS), ...Object.keys(NEW_COLUMNS)].sort();
const quoteIdentifier = (name) => `"${String(name).replaceAll('"', '""')}"`;

export class BackupError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new BackupError(code); };

async function regularFile(path) {
  if (typeof path !== "string" || !path) fail("file_path_required");
  const absolute = resolve(path);
  let info;
  try { info = await lstat(absolute); } catch { fail("file_unavailable"); }
  if (!info.isFile() || info.isSymbolicLink()) fail("regular_file_required");
  return { path: await realpath(absolute), size: info.size };
}

function inspectDatabase(db, { legacyFingerprint = false } = {}) {
  // One read transaction keeps these diagnostics internally consistent even
  // when the live writer is committing concurrently in WAL mode.
  db.exec("BEGIN");
  try {
    const integrity = db.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== "ok") fail("database_integrity_failed");
    if (db.prepare("PRAGMA foreign_key_check").all().length) fail("database_foreign_keys_failed");
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name").all();
    const tables = new Map(schema.filter((row) => row.type === "table").map((row) => [row.name,
      db.prepare(`PRAGMA table_info(${quoteIdentifier(row.name)})`).all()]));
    if (schema.some((row) => Object.hasOwn({ ...CORE_COLUMNS, ...NEW_COLUMNS }, row.name) && row.type !== "table")) fail("account_schema_required");
    const hasColumn = (table, column) => tables.get(table)?.some((entry) => entry.name === column) ?? false;
    function requireTable(table, required) {
      if (required.some((column) => !hasColumn(table, column))) fail("account_schema_required");
      const key = tables.get(table).filter((column) => column.pk).sort((a, b) => a.pk - b.pk).map((column) => column.name);
      if (JSON.stringify(key) !== JSON.stringify(PRIMARY_KEYS[table])) fail("account_schema_required");
    }
    for (const [table, required] of Object.entries(CORE_COLUMNS)) requireTable(table, required);
    const accessCount = Object.entries(ACCESS_COLUMNS).reduce((count, [table, columns]) => count + columns.filter((column) => hasColumn(table, column)).length, 0);
    if (![0, 6].includes(accessCount)) fail("account_schema_partial_migration");
    const modernTables = ["device_link_requests", "completed_matches", "completed_match_players"];
    const modernCount = modernTables.filter((table) => tables.has(table)).length;
    if (![0, 3].includes(modernCount)) fail("account_schema_partial_migration");
    const anonymous = tables.has("anonymous_browser_sessions");
    const nonceCount = ["device_link_requests", "game_sessions"].filter((table) => hasColumn(table, "credential_nonce")).length;
    let profile;
    if (modernCount === 3) {
      if (!anonymous || accessCount !== 6 || ![0, 2].includes(nonceCount)) fail("account_schema_partial_migration");
      profile = nonceCount ? "owned-accounts-reusable-15" : "owned-accounts-consent-history-15";
    } else {
      // Only genuine historical versions: the original eleven-table store,
      // or its anonymous-CSRF/public-session-ID twelve-table successor.
      if (nonceCount || anonymous !== (accessCount === 6)) fail("account_schema_partial_migration");
      profile = anonymous ? "owned-accounts-access-legacy-12" : "owned-accounts-legacy-11";
    }
    for (const [table, required] of Object.entries(NEW_COLUMNS)) if (tables.has(table)) requireTable(table, required);
    const rowCounts = Object.fromEntries([...tables.keys()].sort().map((table) => [table,
      db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get().count]));
    // The v1 spelling treated '_' as a LIKE wildcard. Preserve that exact
    // historical fingerprint only when checking an existing v1 manifest.
    const fingerprintSchema = legacyFingerprint
      ? db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() : schema;
    const schemaHash = createHash("sha256").update(JSON.stringify(fingerprintSchema)).digest("hex");
    return { schema_profile: profile, schema_sha256: schemaHash, row_counts: rowCounts };
  } finally { db.exec("ROLLBACK"); }
}

export async function validateAccountDatabase(databasePath, options) {
  const source = await regularFile(databasePath);
  let db;
  try {
    db = new DatabaseSync(source.path, { readOnly: true, timeout: 5000 });
    return inspectDatabase(db, options);
  } catch (error) {
    if (error instanceof BackupError) throw error;
    fail("database_validation_failed");
  } finally { db?.close(); }
}

async function digestFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function uniqueDirectory(destinationDirectory, prefix) {
  if (typeof destinationDirectory !== "string" || !destinationDirectory) fail("destination_directory_required");
  const absolute = resolve(destinationDirectory);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink()) fail("destination_directory_invalid");
  const directory = await mkdtemp(join(await realpath(absolute), prefix));
  await chmod(directory, 0o700);
  return directory;
}

async function standaloneSnapshot(databasePath) {
  // Only the new, privately owned destination is changed. Never checkpoint or
  // change the journal mode of the source. DELETE makes the archive standalone.
  const db = new DatabaseSync(databasePath, { timeout: 5000 });
  try {
    const mode = db.prepare("PRAGMA journal_mode=DELETE").get();
    if (Object.values(mode)[0] !== "delete") fail("snapshot_journal_mode_failed");
  } finally { db.close(); }
  await chmod(databasePath, 0o600);
}

async function snapshot({ sourcePath, destinationDirectory, prefix, kind, parentHash = null }) {
  const source = await regularFile(sourcePath);
  await validateAccountDatabase(source.path);
  const directory = await uniqueDirectory(destinationDirectory, prefix);
  const databasePath = join(directory, "database.sqlite");
  const manifestPath = join(directory, "manifest.json");
  const db = new DatabaseSync(source.path, { readOnly: true, timeout: 5000 });
  try {
    // node:sqlite.backup overwrites a destination if one exists. The randomly
    // named private directory makes this a new file without risking live data.
    try { await access(databasePath, constants.F_OK); fail("destination_exists"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await backup(db, databasePath, { rate: 100 });
  } finally { db.close(); }
  await standaloneSnapshot(databasePath);
  const inspection = await validateAccountDatabase(databasePath);
  const file = await regularFile(databasePath);
  const manifest = {
    format: BACKUP_FORMAT, kind, created_at: new Date().toISOString(),
    database_file: "database.sqlite", bytes: file.size,
    sha256: await digestFile(databasePath), ...inspection,
    ...(parentHash ? { source_backup_sha256: parentHash } : {}),
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  // A failed attempt deliberately retains its unique incomplete directory for
  // diagnosis. Only a valid manifest marks a completed snapshot.
  return { directory, databasePath, manifestPath, manifest };
}

export async function createBackup({ sourcePath, destinationDirectory }) {
  return snapshot({ sourcePath, destinationDirectory, prefix: "kiwi-duel-backup-", kind: "backup" });
}

export async function verifyBackup({ databasePath, manifestPath }) {
  const database = await regularFile(databasePath);
  const metadata = await regularFile(manifestPath);
  if (metadata.size > 65536) fail("manifest_invalid");
  let manifest;
  try { manifest = JSON.parse(await readFile(metadata.path, "utf8")); } catch { fail("manifest_invalid"); }
  if (!manifest || ![BACKUP_FORMAT, LEGACY_BACKUP_FORMAT].includes(manifest.format) || !["backup", "prepared-restore"].includes(manifest.kind)
      || manifest.database_file !== "database.sqlite" || !/^[a-f0-9]{64}$/.test(manifest.sha256 ?? "")
      || !Number.isSafeInteger(manifest.bytes) || manifest.bytes <= 0) fail("manifest_invalid");
  // Never validate a main-file hash while newer content lives in a WAL/journal.
  for (const suffix of ["-wal", "-journal"]) {
    try { if ((await lstat(database.path + suffix)).size > 0) fail("snapshot_has_live_sidecar"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  if (database.size !== manifest.bytes || await digestFile(database.path) !== manifest.sha256) fail("snapshot_checksum_failed");
  const legacy = manifest.format === LEGACY_BACKUP_FORMAT;
  const inspection = await validateAccountDatabase(database.path);
  const expectedSchemaHash = legacy
    ? (await validateAccountDatabase(database.path, { legacyFingerprint: true })).schema_sha256 : inspection.schema_sha256;
  const expectedTables = legacy ? V1_COUNTED_TABLES : Object.keys(inspection.row_counts).sort();
  const actualTables = Object.keys(manifest.row_counts ?? {}).sort();
  if (expectedSchemaHash !== manifest.schema_sha256
      || JSON.stringify(actualTables) !== JSON.stringify(expectedTables)
      || expectedTables.some((table) => inspection.row_counts[table] !== manifest.row_counts?.[table])
      || (!legacy && inspection.schema_profile !== manifest.schema_profile)) {
    fail("snapshot_metadata_failed");
  }
  return { manifest, ...inspection };
}

export async function prepareRestore({ databasePath, manifestPath, destinationDirectory }) {
  const verified = await verifyBackup({ databasePath, manifestPath });
  const result = await snapshot({ sourcePath: databasePath, destinationDirectory,
    prefix: "kiwi-duel-restore-", kind: "prepared-restore", parentHash: verified.manifest.sha256 });
  // No installation step: a restore is prepared to a unique path. Replacing a
  // service's database always remains an explicit, offline operator action.
  if (result.manifest.schema_sha256 !== verified.schema_sha256
      || JSON.stringify(result.manifest.row_counts) !== JSON.stringify(verified.row_counts)) fail("restore_validation_failed");
  return result;
}

async function main(args) {
  const [command, ...flags] = args;
  const options = {};
  const allowed = command === "backup" ? ["source", "output"]
    : command === "verify" ? ["database", "manifest"]
    : command === "prepare-restore" ? ["database", "manifest", "output"] : [];
  if (!allowed.length || flags.length !== allowed.length * 2) fail("usage_backup_source_output_or_verify_database_manifest_or_prepare_restore_database_manifest_output");
  for (let index = 0; index < flags.length; index += 2) {
    const key = flags[index].replace(/^--/, "");
    if (flags[index] !== `--${key}` || !allowed.includes(key) || options[key] || !flags[index + 1]
        || flags[index + 1].startsWith("--")) fail("arguments_invalid");
    options[key] = flags[index + 1];
  }
  if (allowed.some((key) => !options[key])) fail("arguments_invalid");
  if (command === "backup") return createBackup({ sourcePath: options.source, destinationDirectory: options.output });
  if (command === "verify") return verifyBackup({ databasePath: options.database, manifestPath: options.manifest });
  return prepareRestore({ databasePath: options.database, manifestPath: options.manifest, destinationDirectory: options.output });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.umask(0o077);
  try { console.log(JSON.stringify({ ok: true, ...await main(process.argv.slice(2)) }, null, 2)); }
  catch (error) {
    // SQL errors, account rows and source paths must not enter shared logs.
    console.error(JSON.stringify({ ok: false, error: error instanceof BackupError ? error.code : "backup_operation_failed" }));
    process.exitCode = 1;
  }
}
