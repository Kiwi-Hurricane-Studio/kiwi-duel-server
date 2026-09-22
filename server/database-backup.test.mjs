import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AccountStore } from "./account-store.mjs";
import { createBackup, prepareRestore, validateAccountDatabase, verifyBackup } from "./database-backup.mjs";

const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "kiwi-duel-backup-test-"));
  const sourcePath = join(directory, "source.sqlite");
  const destinationDirectory = join(directory, "backups");
  const store = new AccountStore({ databasePath: sourcePath,
    starterFigures: [{ item_master_id: 1060, model_id: 60 }],
    starterPlateIds: [5022], plateMasters: [{ item_master_id: 5022, cost: 1 }],
    rewardCatalog: [{ item_master_id: 1060, model_id: 60 }] });
  let open = true;
  const close = () => { if (open) { store.close(); open = false; } };
  t.after(() => {
    close();
    // Cleanup can only affect this test's own mkdtemp directory.
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("kiwi-duel-backup-test-"));
    rmSync(directory, { recursive: true, force: true });
  });
  const add = (index) => store.createAccount({ email: `backup-${index}@example.test`,
    displayName: `Backup_${index}`, password: "isolated fixture password" });
  return { directory, sourcePath, destinationDirectory, store, add, close };
}

function makeLegacy(value, version = 12) {
  const user = value.add(1);
  value.store.createBrowserSession(user.user_id);
  value.store.createAnonymousBrowserSession();
  value.store.linkDeviceTokenToUser("legacy-backup-device-token-0123456789", user.user_id);
  value.store.beginDeviceLogin("legacy-backup-device-token-0123456789");
  value.store.beginDeviceLogin("legacy-pending-backup-token-0123456789");
  // Reconstruct only known historical schema shapes inside the disposable
  // fixture. Never open the source through AccountStore after this downgrade.
  value.store.database.exec(`DROP TABLE completed_match_players; DROP TABLE completed_matches;
    DROP TABLE device_link_requests; DROP INDEX game_sessions_reusable_device;
    ALTER TABLE game_sessions DROP COLUMN credential_nonce;`);
  if (version === 11) {
    value.store.database.exec("DROP TABLE anonymous_browser_sessions");
    for (const table of ["browser_sessions", "device_links"]) {
      value.store.database.exec(`DROP INDEX ${table}_public_id`);
      for (const column of [table === "browser_sessions" ? "session_id" : "device_id", "label", "last_seen_at"]) {
        value.store.database.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
      }
    }
  }
  return user;
}

test("online backup includes committed WAL content without changing source or leaking account values into manifest", async (t) => {
  const value = fixture(t);
  const user = value.add(1);
  assert.ok(statSync(value.sourcePath + "-wal").size > 0);
  const sourceBefore = sha(value.sourcePath);
  const walBefore = sha(value.sourcePath + "-wal");
  const saved = await createBackup(value);
  assert.equal(sha(value.sourcePath), sourceBefore);
  assert.equal(sha(value.sourcePath + "-wal"), walBefore);
  assert.equal(saved.manifest.row_counts.users, 1);
  assert.equal(saved.manifest.row_counts.user_figures, 1);
  assert.equal(Object.keys(saved.manifest.row_counts).length, 15);
  assert.equal(saved.manifest.format, "kiwi-duel-sqlite-backup-v2");
  assert.equal(saved.manifest.schema_profile, "owned-accounts-reusable-15");
  assert.equal(saved.manifest.sha256, sha(saved.databasePath));
  assert.equal(saved.manifest.bytes, statSync(saved.databasePath).size);
  assert.ok(!existsSync(saved.databasePath + "-wal"));
  assert.ok(!existsSync(saved.databasePath + "-journal"));
  const text = readFileSync(saved.manifestPath, "utf8");
  assert.ok(!text.includes("backup-1@example.test"));
  assert.ok(!text.includes("isolated fixture password"));
  assert.ok(!text.includes("password_hash"));
  assert.equal((await verifyBackup(saved)).manifest.sha256, saved.manifest.sha256);
  const copy = new AccountStore({ databasePath: saved.databasePath });
  try {
    assert.equal(copy.authenticatePassword("backup-1@example.test", "isolated fixture password").user_id, user.user_id);
    assert.equal(copy.accountSnapshot(user.user_id).figures[0].model_id, 60);
  } finally { copy.close(); }
});

for (const version of [11, 12]) {
  test(`genuine legacy ${version}-table pre-migration backup and restore preserve exact source schema, WAL, and every count`, async (t) => {
    const value = fixture(t);
    makeLegacy(value, version);
    const before = await validateAccountDatabase(value.sourcePath);
    const sourceBytes = sha(value.sourcePath);
    const walBytes = sha(value.sourcePath + "-wal");
    const saved = await createBackup(value);
    assert.equal(saved.manifest.schema_profile, version === 11 ? "owned-accounts-legacy-11" : "owned-accounts-access-legacy-12");
    assert.equal(Object.keys(saved.manifest.row_counts).length, version);
    assert.equal(saved.manifest.schema_sha256, before.schema_sha256);
    assert.deepEqual(saved.manifest.row_counts, before.row_counts);
    assert.equal(saved.manifest.row_counts.browser_sessions, 1);
    assert.equal(saved.manifest.row_counts.game_sessions, 1);
    assert.equal(saved.manifest.row_counts.device_links, 2);
    const restored = await prepareRestore({ ...saved, destinationDirectory: value.destinationDirectory });
    assert.deepEqual(await validateAccountDatabase(restored.databasePath), before);
    assert.deepEqual((await verifyBackup(restored)).row_counts, before.row_counts);
    assert.equal(sha(value.sourcePath), sourceBytes);
    assert.equal(sha(value.sourcePath + "-wal"), walBytes);
    assert.deepEqual(await validateAccountDatabase(value.sourcePath), before);
    const copy = new DatabaseSync(restored.databasePath, { readOnly: true });
    try {
      assert.equal(copy.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name IN ('device_link_requests','completed_matches','completed_match_players')").get().count, 0);
      assert.equal(copy.prepare("SELECT COUNT(*) AS count FROM users").get().count, 1);
    } finally { copy.close(); }
  });
}

test("complete modern pre-nonce schema is recognized without adding reusable credential columns", async (t) => {
  const value = fixture(t);
  for (const table of ["game_sessions", "device_link_requests"]) {
    value.store.database.exec(`DROP INDEX ${table}_reusable_device; ALTER TABLE ${table} DROP COLUMN credential_nonce`);
  }
  const saved = await createBackup(value);
  assert.equal(saved.manifest.schema_profile, "owned-accounts-consent-history-15");
  assert.deepEqual(await validateAccountDatabase(saved.databasePath), await validateAccountDatabase(value.sourcePath));
});

test("manifests count every extra user table and fingerprint indexes/views/triggers without publishing SQL or row contents", async (t) => {
  const value = fixture(t);
  value.add(1);
  value.store.database.exec(`CREATE TABLE "future \"\" table" (id INTEGER PRIMARY KEY, payload TEXT);
    INSERT INTO "future \"\" table" VALUES(1,'private-test-row');
    CREATE TABLE sqliteXadditional(id INTEGER PRIMARY KEY);
    INSERT INTO sqliteXadditional VALUES(1);
    CREATE INDEX future_payload ON "future \"\" table"(payload);
    CREATE VIEW future_view AS SELECT id FROM "future \"\" table";
    CREATE TRIGGER future_marker AFTER INSERT ON sqliteXadditional BEGIN
      INSERT INTO "future \"\" table" VALUES(new.id,'trigger-fixture'); END;`);
  const saved = await createBackup(value);
  assert.equal(saved.manifest.row_counts['future " table'], 1);
  assert.equal(saved.manifest.row_counts.sqliteXadditional, 1);
  assert.equal(Object.keys(saved.manifest.row_counts).length, 17);
  assert.ok(!readFileSync(saved.manifestPath, "utf8").includes("private-test-row"));
  const restored = await prepareRestore({ ...saved, destinationDirectory: value.destinationDirectory });
  assert.equal(restored.manifest.schema_sha256, saved.manifest.schema_sha256);
  assert.deepEqual(restored.manifest.row_counts, saved.manifest.row_counts);
  for (const rowCounts of [
    Object.fromEntries(Object.entries(saved.manifest.row_counts).filter(([key]) => key !== 'future " table')),
    { ...saved.manifest.row_counts, invented_table: 0 },
  ]) {
    writeFileSync(saved.manifestPath, JSON.stringify({ ...saved.manifest, row_counts: rowCounts }));
    await assert.rejects(verifyBackup(saved), /snapshot_metadata_failed/);
  }
});

test("existing v1 current-schema archives remain verifiable and prepare a v2 restore with complete metadata", async (t) => {
  const value = fixture(t);
  value.add(1);
  value.store.database.exec("CREATE TABLE future_rows(id INTEGER PRIMARY KEY); INSERT INTO future_rows VALUES(1); CREATE TABLE sqliteXrows(id INTEGER PRIMARY KEY)");
  const saved = await createBackup(value);
  const { schema_profile: ignoredProfile, ...v1 } = saved.manifest;
  v1.format = "kiwi-duel-sqlite-backup-v1";
  // Old v1 counted only the known fifteen tables and used LIKE for its schema
  // filter; preserve compatibility even with additional archived tables.
  v1.row_counts = Object.fromEntries(Object.entries(v1.row_counts).filter(([table]) => !["future_rows", "sqliteXrows"].includes(table)));
  const archived = new DatabaseSync(saved.databasePath, { readOnly: true });
  try {
    v1.schema_sha256 = createHash("sha256").update(JSON.stringify(archived.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all())).digest("hex");
  } finally { archived.close(); }
  writeFileSync(saved.manifestPath, JSON.stringify(v1));
  assert.equal((await verifyBackup(saved)).manifest.format, v1.format);
  const restored = await prepareRestore({ ...saved, destinationDirectory: value.destinationDirectory });
  assert.equal(restored.manifest.format, "kiwi-duel-sqlite-backup-v2");
  assert.equal(restored.manifest.schema_profile, saved.manifest.schema_profile);
  assert.deepEqual(restored.manifest.row_counts, saved.manifest.row_counts);
});

test("partial new capability groups, incomplete core tables, and table-shaped views fail before creating backup output", async (t) => {
  const mutations = [
    "DROP TABLE completed_match_players",
    "DROP TABLE completed_match_players; DROP TABLE completed_matches",
    "DROP TABLE device_link_requests",
    "DROP TABLE anonymous_browser_sessions",
    "DROP INDEX game_sessions_reusable_device; ALTER TABLE game_sessions DROP COLUMN credential_nonce",
    "ALTER TABLE browser_sessions DROP COLUMN label",
    "DROP TABLE user_plates",
    "ALTER TABLE users DROP COLUMN display_name",
    "ALTER TABLE user_plates RENAME TO discarded; CREATE TABLE user_plates AS SELECT * FROM discarded",
    "ALTER TABLE anonymous_browser_sessions RENAME TO discarded; CREATE VIEW anonymous_browser_sessions AS SELECT * FROM discarded",
  ];
  for (const mutation of mutations) {
    await t.test(mutation, async (nested) => {
      const value = fixture(nested);
      value.store.database.exec(`PRAGMA foreign_keys=OFF; ${mutation}; PRAGMA foreign_keys=ON`);
      await assert.rejects(createBackup(value), /account_schema_(?:required|partial_migration)/);
      assert.equal(existsSync(value.destinationDirectory), false);
    });
  }
});

test("repeated backups use unique destinations and retain earlier snapshots", async (t) => {
  const value = fixture(t);
  value.add(1);
  const first = await createBackup(value);
  const firstHash = sha(first.databasePath);
  value.add(2);
  const second = await createBackup(value);
  assert.notEqual(first.directory, second.directory);
  assert.equal(sha(first.databasePath), firstHash);
  assert.equal((await verifyBackup(first)).row_counts.users, 1);
  assert.equal((await verifyBackup(second)).row_counts.users, 2);
  assert.equal(readdirSync(value.destinationDirectory).length, 2);
});

test("prepare-restore creates a separately validated destination and never installs over source or backup", async (t) => {
  const value = fixture(t);
  value.add(1);
  const saved = await createBackup(value);
  const originalHash = sha(value.sourcePath);
  const archivedHash = sha(saved.databasePath);
  const restored = await prepareRestore({ ...saved, destinationDirectory: value.destinationDirectory });
  assert.notEqual(restored.directory, saved.directory);
  assert.ok(basename(restored.directory).startsWith("kiwi-duel-restore-"));
  assert.equal(restored.manifest.kind, "prepared-restore");
  assert.equal(restored.manifest.source_backup_sha256, archivedHash);
  assert.deepEqual((await verifyBackup(restored)).row_counts, saved.manifest.row_counts);
  assert.equal(sha(value.sourcePath), originalHash);
  assert.equal(sha(saved.databasePath), archivedHash);
  const restoredDb = new DatabaseSync(restored.databasePath, { readOnly: true });
  try { assert.equal(restoredDb.prepare("SELECT COUNT(*) AS count FROM users").get().count, 1); }
  finally { restoredDb.close(); }
});

test("missing, corrupt and unrelated SQLite inputs fail without creating output", async (t) => {
  const value = fixture(t);
  await assert.rejects(createBackup({ sourcePath: join(value.directory, "missing.sqlite"), destinationDirectory: value.destinationDirectory }), /file_unavailable/);
  const corrupt = join(value.directory, "corrupt.sqlite");
  writeFileSync(corrupt, "not a database");
  await assert.rejects(createBackup({ sourcePath: corrupt, destinationDirectory: value.destinationDirectory }), /database_validation_failed/);
  const unrelated = join(value.directory, "unrelated.sqlite");
  const db = new DatabaseSync(unrelated);
  db.exec("CREATE TABLE unrelated(value TEXT)");
  db.close();
  await assert.rejects(createBackup({ sourcePath: unrelated, destinationDirectory: value.destinationDirectory }), /account_schema_required/);
  assert.equal(existsSync(value.destinationDirectory), false);
  await assert.rejects(validateAccountDatabase(value.directory), /regular_file_required/);
});

test("foreign-key inconsistency is refused instead of producing a apparently successful backup", async (t) => {
  const value = fixture(t);
  value.add(1);
  value.store.database.exec("PRAGMA foreign_keys=OFF; UPDATE user_figures SET user_id=999999; PRAGMA foreign_keys=ON;");
  await assert.rejects(createBackup(value), /database_foreign_keys_failed/);
  assert.equal(existsSync(value.destinationDirectory), false);
});

test("checksum, metadata, malformed manifest and active WAL validation fail closed", async (t) => {
  const value = fixture(t);
  value.add(1);
  const saved = await createBackup(value);
  const bytes = readFileSync(saved.databasePath);
  const manifest = readFileSync(saved.manifestPath);
  const changed = Buffer.from(bytes);
  changed[changed.length - 1] ^= 1;
  writeFileSync(saved.databasePath, changed);
  await assert.rejects(verifyBackup(saved), /snapshot_checksum_failed/);
  await assert.rejects(prepareRestore({ ...saved, destinationDirectory: join(value.directory, "restore") }), /snapshot_checksum_failed/);
  assert.equal(existsSync(join(value.directory, "restore")), false);
  writeFileSync(saved.databasePath, bytes);
  writeFileSync(saved.manifestPath, JSON.stringify({ ...saved.manifest, row_counts: { ...saved.manifest.row_counts, users: 500 } }));
  await assert.rejects(verifyBackup(saved), /snapshot_metadata_failed/);
  writeFileSync(saved.manifestPath, JSON.stringify({ ...saved.manifest, schema_profile: "owned-accounts-legacy-11" }));
  await assert.rejects(verifyBackup(saved), /snapshot_metadata_failed/);
  writeFileSync(saved.manifestPath, "broken json");
  await assert.rejects(verifyBackup(saved), /manifest_invalid/);
  writeFileSync(saved.manifestPath, manifest);
  writeFileSync(saved.databasePath + "-wal", "not a standalone snapshot");
  await assert.rejects(verifyBackup(saved), /snapshot_has_live_sidecar/);
});

test("destination directory cannot be a file; existing unrelated output is preserved", async (t) => {
  const value = fixture(t);
  const marker = join(value.directory, "marker");
  writeFileSync(marker, "preserve me");
  await assert.rejects(createBackup({ ...value, destinationDirectory: marker }));
  assert.equal(readFileSync(marker, "utf8"), "preserve me");
  mkdirSync(value.destinationDirectory);
  writeFileSync(join(value.destinationDirectory, "database.sqlite"), "existing non-backup content");
  await createBackup(value);
  assert.equal(readFileSync(join(value.destinationDirectory, "database.sqlite"), "utf8"), "existing non-backup content");
});

test("symlink inputs and output directories are refused when this platform permits symlinks", async (t) => {
  const value = fixture(t);
  const link = join(value.directory, "source-link.sqlite");
  try { symlinkSync(value.sourcePath, link); }
  catch (error) { if (["EPERM", "EACCES"].includes(error.code)) return t.skip("OS does not allow unprivileged symlink creation"); throw error; }
  await assert.rejects(createBackup({ ...value, sourcePath: link }), /regular_file_required/);
  mkdirSync(value.destinationDirectory);
  const outputLink = join(value.directory, "output-link");
  symlinkSync(value.destinationDirectory, outputLink, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(createBackup({ ...value, destinationDirectory: outputLink }), /destination_directory_invalid/);
});

test("CLI has no live database default, rejects malformed args, and reports only safe errors", () => {
  const cli = fileURLToPath(new URL("./database-backup.mjs", import.meta.url));
  for (const args of [[], ["backup"], ["backup", "--source", "private-value", "--source", "another-private-value"]]) {
    const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", cli, ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    const error = JSON.parse(result.stderr);
    assert.equal(error.ok, false);
    assert.ok(!result.stderr.includes("private-value"));
  }
});
