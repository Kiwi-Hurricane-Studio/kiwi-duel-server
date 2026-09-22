import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AccountStore } from "./account-store.mjs";
import { createBackup, verifyBackup } from "./database-backup.mjs";
import { MigrationDrillError, runMigrationDrill } from "./database-migration-drill.mjs";

const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const cli = fileURLToPath(new URL("./database-migration-drill.mjs", import.meta.url));
const PRIVATE_MARKER = "private-fixture-秘密@example.test";

async function fixture(t, { legacy = 0, corruptMigration = "", missingDecks = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "kiwi-duel-migration-test-"));
  t.after(() => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("kiwi-duel-migration-test-"));
    rmSync(directory, { recursive: true, force: true });
  });
  const sourcePath = join(directory, "fixture.sqlite");
  const store = new AccountStore({ databasePath: sourcePath,
    starterFigures: [{ item_master_id: 1060, model_id: 60 }], starterPlateIds: [5022],
    plateMasters: [{ item_master_id: 5022, cost: 1 }], rewardCatalog: [{ item_master_id: 1060, model_id: 60 }] });
  try {
    const user = store.createAccount({ email: PRIVATE_MARKER, displayName: "Fixture", password: "private-fixture-password" });
    const other = store.createAccount({ email: "other-migration@example.test", displayName: "Other", password: "private-fixture-password" });
    store.createBrowserSession(user.user_id);
    store.createAnonymousBrowserSession();
    store.linkDeviceTokenToUser("migration-fixture-device-0123456789", user.user_id);
    store.beginDeviceLogin("migration-fixture-device-0123456789");
    store.beginDeviceLogin("migration-pending-device-0123456789");
    store.recordMatchCompletion({ match_id: "migration-history-1", mode: "human", winner: "black", reason: "goal",
      finished_at: 1_800_000_000_000, players: [{ user_id: user.user_id, side: "black" }, { user_id: other.user_id, side: "white" }],
      record: { notes: PRIVATE_MARKER, moves: [{ type: "mp_move", route: [1, 2] }] } });
    // Expired rows must remain preserved. The drill never invokes any API that
    // purges them, even though its actual wall clock is much later.
    store.database.exec(`UPDATE browser_sessions SET expires_at=1; UPDATE game_sessions SET expires_at=1;
      UPDATE anonymous_browser_sessions SET expires_at=1; UPDATE device_link_requests SET expires_at=1;
      UPDATE device_links SET link_expires_at=1 WHERE user_id IS NULL;
      CREATE TABLE "extra \"\" data" (i INTEGER,r REAL,t TEXT,b BLOB,n TEXT);`);
    const extras = store.database.prepare('INSERT INTO "extra "" data" VALUES(?,?,?,?,?)');
    for (let index = 0; index < 2; index += 1) extras.run(9223372036854775807n, 1.125, PRIVATE_MARKER, Buffer.from([0, 255, 127]), null);
    if (legacy) {
      store.database.exec(`DROP TABLE completed_match_players; DROP TABLE completed_matches;
        DROP TABLE device_link_requests; DROP INDEX game_sessions_reusable_device;
        ALTER TABLE game_sessions DROP COLUMN credential_nonce;`);
      if (legacy === 11) {
        store.database.exec("DROP TABLE anonymous_browser_sessions");
        for (const table of ["browser_sessions", "device_links"]) {
          store.database.exec(`DROP INDEX ${table}_public_id`);
          for (const column of [table === "browser_sessions" ? "session_id" : "device_id", "label", "last_seen_at"]) {
            store.database.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
          }
        }
      }
    }
    if (missingDecks) store.database.exec("DELETE FROM user_decks WHERE deck_no > 1");
    if (corruptMigration) {
      store.database.exec("UPDATE browser_sessions SET last_seen_at=NULL");
      store.database.exec(corruptMigration === "abort"
        ? `CREATE TRIGGER migration_abort BEFORE UPDATE OF last_seen_at ON browser_sessions BEGIN SELECT RAISE(ABORT,'${PRIVATE_MARKER}'); END`
        : "CREATE TRIGGER migration_drift AFTER UPDATE OF last_seen_at ON browser_sessions BEGIN UPDATE users SET coins=coins+1; END");
    }
  } finally { store.close(); }
  const backup = await createBackup({ sourcePath, destinationDirectory: join(directory, "backups") });
  return { directory, sourcePath, backup, destinationDirectory: join(directory, "drills") };
}

for (const legacy of [11, 12, 0]) {
  test(`isolated ${legacy || "current"} migration preserves all original values, expired credentials, types, duplicates and reopen stability`, async (t) => {
    const value = await fixture(t, { legacy });
    const before = [hash(value.backup.databasePath), hash(value.backup.manifestPath), hash(value.sourcePath)];
    const result = await runMigrationDrill({ ...value.backup, destinationDirectory: value.destinationDirectory });
    assert.equal(result.ok, true);
    for (const key of ["prepared_copy_digest_equal", "original_rows_preserved", "migrated_schema_valid", "reopen_schema_stable", "reopen_data_stable", "input_backup_unchanged", "input_manifest_unchanged"]) {
      assert.equal(result.summary[key], true, key);
    }
    assert.equal(result.summary.expiry_purge_permitted, false);
    assert.equal(result.summary.migrated_profile, "owned-accounts-reusable-15");
    assert.equal(result.summary.original_tables['extra " data'].rows_before, 2);
    assert.equal(result.summary.original_tables.game_sessions.rows_after, 1);
    assert.equal(result.summary.original_tables.browser_sessions.rows_after, 1);
    if (!legacy) assert.equal(result.summary.original_tables.completed_matches.rows_after, 1);
    assert.equal(dirname(result.directory), value.destinationDirectory);
    assert.notEqual(result.databasePath, value.backup.databasePath);
    assert.ok(!existsSync(join(result.directory, "manifest.json")));
    assert.ok(existsSync(join(result.directory, "pre-migration-manifest.json")));
    assert.deepEqual(JSON.parse(readFileSync(result.reportPath, "utf8")), result);
    assert.doesNotMatch(JSON.stringify(result), /private-fixture|秘密|password_hash|token_hash|"digest":/u);
    assert.deepEqual([hash(value.backup.databasePath), hash(value.backup.manifestPath), hash(value.sourcePath)], before);
    await verifyBackup(value.backup);
    const db = new DatabaseSync(result.databasePath, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM game_sessions WHERE expires_at=1").get().n, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM device_link_requests WHERE expires_at=1").get().n, 1);
    } finally { db.close(); }
    const repeated = await runMigrationDrill({ ...value.backup, destinationDirectory: value.destinationDirectory });
    assert.notEqual(result.directory, repeated.directory);
    assert.ok(existsSync(result.reportPath));
  });
}

test("drill rejects original-value drift and constructor failures, preserves inputs and emits only sanitized failure evidence", async (t) => {
  for (const corruptMigration of ["drift", "abort"]) {
    await t.test(corruptMigration, async (nested) => {
      const value = await fixture(nested, { legacy: 12, corruptMigration });
      const before = [hash(value.backup.databasePath), hash(value.backup.manifestPath)];
      await assert.rejects(runMigrationDrill({ ...value.backup, destinationDirectory: value.destinationDirectory }), (error) => {
        assert.ok(error instanceof MigrationDrillError);
        assert.equal(error.code, corruptMigration === "abort" ? "migration_constructor_failed" : "migration_original_rows_changed");
        assert.equal(error.result.ok, false);
        assert.equal(error.result.summary.input_backup_unchanged, true);
        assert.equal(error.result.summary.input_manifest_unchanged, true);
        assert.ok(existsSync(error.result.databasePath));
        const report = readFileSync(error.result.reportPath, "utf8");
        assert.doesNotMatch(report, /private-fixture|秘密|password_hash|token_hash/u);
        if (corruptMigration === "drift") assert.equal(error.result.summary.original_tables.users.data_digest_equal, false);
        return true;
      });
      assert.deepEqual([hash(value.backup.databasePath), hash(value.backup.manifestPath)], before);
      await verifyBackup(value.backup);
    });
  }
});

test("existing-table deck backfill is reported as a preservation failure, never silently excepted", async (t) => {
  const value = await fixture(t, { legacy: 12, missingDecks: true });
  await assert.rejects(runMigrationDrill({ ...value.backup, destinationDirectory: value.destinationDirectory }), (error) => {
    assert.equal(error.code, "migration_original_rows_changed");
    const decks = error.result.summary.original_tables.user_decks;
    assert.equal(decks.rows_before, 2);
    assert.equal(decks.rows_after, 10);
    assert.equal(decks.data_digest_equal, false);
    return true;
  });
});

test("unverified or corrupt inputs fail before allocating a migration directory", async (t) => {
  const value = await fixture(t);
  const damaged = Buffer.from(readFileSync(value.backup.databasePath)); damaged[damaged.length - 1] ^= 1;
  writeFileSync(value.backup.databasePath, damaged);
  await assert.rejects(runMigrationDrill({ ...value.backup, destinationDirectory: value.destinationDirectory }), /snapshot_checksum_failed/u);
  assert.equal(existsSync(value.destinationDirectory), false);
});

test("CLI takes only explicit backup/manifest/output paths and returns safe results without input mutation", async (t) => {
  const value = await fixture(t, { legacy: 12 });
  const result = spawnSync(process.execPath, [cli, "--database", value.backup.databasePath, "--manifest", value.backup.manifestPath,
    "--output", value.destinationDirectory], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
  assert.doesNotMatch(result.stdout + result.stderr, /private-fixture|秘密|password_hash|token_hash/u);
  const savedDirectories = readdirSync(value.destinationDirectory);
  for (const args of [[], ["--database", "private-fixture"], ["--database", "a", "--database", "b", "--output", "c"]]) {
    const invalid = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, "");
    assert.equal(JSON.parse(invalid.stderr).ok, false);
    assert.doesNotMatch(invalid.stderr, /private-fixture/u);
  }
  assert.deepEqual(readdirSync(value.destinationDirectory), savedDirectories);
});
