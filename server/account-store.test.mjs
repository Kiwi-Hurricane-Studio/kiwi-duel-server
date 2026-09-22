import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AccountStore } from "./account-store.mjs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

const STARTERS = [
  [1060, 60], [1114, 114], [1161, 161],
  [1162, 162], [1078, 78], [1132, 132],
].map(([item_master_id, model_id]) => ({ item_master_id, model_id, level: 1 }));
const PLATES = [5022, 5015, 5306, 5306, 5026, 5015];
const REWARDS = [
  { item_master_id: 1001, model_id: 1, figure_no: 50, poke_no: 6 },
  { item_master_id: 1002, model_id: 2, figure_no: 60, poke_no: 160 },
  ...STARTERS,
];

function fixture(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "kiwi-duel-account-"));
  const databasePath = join(directory, "accounts.sqlite");
  let now = 1_788_900_000_000;
  const open = () => new AccountStore({
    databasePath,
    now: () => now,
    chestUnlockMilliseconds: 3_000,
    starterFigures: STARTERS,
    starterPlateIds: PLATES,
    plateMasters: [...new Set(PLATES)].map((item_master_id) => ({ item_master_id, cost: 1 })),
    rewardCatalog: REWARDS,
    ...options,
  });
  return {
    directory,
    open,
    advance(milliseconds) { now += milliseconds; },
    cleanup() { rmSync(directory, { recursive: true, force: true }); },
  };
}

test("accounts receive isolated normal starter inventories and survive restart", () => {
  const value = fixture();
  try {
    let store = value.open();
    const first = store.createAccount({ email: "first@example.test", displayName: "Kiwi_Primary", password: "correct horse battery" });
    const second = store.createAccount({ email: "second@example.test", displayName: "Kiwi_Alt", password: "another correct horse" });
    assert.notEqual(first.user_id, second.user_id);
    for (const user of [first, second]) {
      const snapshot = store.accountSnapshot(user.user_id);
      assert.deepEqual(snapshot.figures.map((figure) => figure.model_id), [60, 114, 161, 162, 78, 132]);
      assert.equal(snapshot.decks.length, 5);
      assert.deepEqual(snapshot.decks[0].plates, PLATES);
      assert.deepEqual(snapshot.decks[4].figures.map((figure) => figure.item_master_id), STARTERS.map((figure) => figure.item_master_id));
      assert.equal(snapshot.chests.length, 1);
      assert.equal(snapshot.chests[0].state, "locked");
    }
    store.close();
    store = value.open();
    assert.equal(store.authenticatePassword("FIRST@example.test", "correct horse battery")?.user_id, first.user_id);
    assert.equal(store.authenticatePassword("first@example.test", "wrong password"), null);
    assert.equal(store.accountSnapshot(second.user_id).figures.length, 6);
    store.close();
  } finally {
    value.cleanup();
  }
});

test("deck edits validate inventory and cost, survive restart, expand to the recovered limit, and remain account-isolated", () => {
  const value = fixture();
  try {
    let store = value.open();
    const first = store.createAccount({ email: "decks@example.test", displayName: "Deck_Player", password: "safe test password" });
    const second = store.createAccount({ email: "decks-other@example.test", displayName: "Deck_Other", password: "safe test password" });
    const reversedFigures = [...STARTERS].reverse();
    const saved = store.updateDeck(first.user_id, {
      deck_no: 2,
      name: "Second Deck",
      figures: reversedFigures,
      plates: PLATES,
    });
    assert.equal(saved.name, "Second Deck");
    assert.deepEqual(saved.figures.map((figure) => figure.item_master_id), reversedFigures.map((figure) => figure.item_master_id));
    assert.throws(() => store.updateDeck(first.user_id, {
      deck_no: 2,
      figures: [{ item_master_id: 999999 }],
      plates: PLATES,
    }), /deck_figure_not_owned/);
    assert.throws(() => store.updateDeck(first.user_id, {
      deck_no: 2,
      figures: STARTERS,
      plates: [...PLATES, 5022],
    }), /deck_plates_invalid/);
    assert.deepEqual(store.battleDeck(first.user_id, 2).figures.map((figure) => figure.item_master_id), reversedFigures.map((figure) => figure.item_master_id));
    assert.notEqual(store.deckSnapshot(second.user_id)[1].name, "Second Deck");

    store.database.prepare("UPDATE users SET gems = 40 WHERE id = ?").run(first.user_id);
    for (let expected = 6; expected <= 12; expected += 1) {
      const expanded = store.expandDecks(first.user_id);
      assert.equal(expanded.deck.deck_no, expected);
      assert.equal(expanded.deck.figures.length, 0);
    }
    assert.equal(store.accountSnapshot(first.user_id).user.balances.gems, 5);
    assert.throws(() => store.expandDecks(first.user_id), /deck_case_at_capacity/);
    store.close();

    store = value.open();
    assert.equal(store.deckSnapshot(first.user_id).length, 12);
    assert.equal(store.deckSnapshot(first.user_id)[1].name, "Second Deck");
    assert.throws(() => store.battleDeck(first.user_id, 6), /battle_deck_requires_six_figures/);
    store.close();
  } finally {
    value.cleanup();
  }
});

test("browser sign-in links a device without exposing the password to the game", () => {
  const value = fixture();
  try {
    const store = value.open();
    const user = store.createAccount({ email: "link@example.test", displayName: "Linked_Player", password: "safe test password" });
    const deviceToken = "device-token-0123456789abcdef";
    const firstLogin = store.beginDeviceLogin(deviceToken);
    assert.equal(firstLogin.linked, false);
    assert.ok(firstLogin.link_code.length >= 24);
    assert.equal(store.linkDevice(firstLogin.link_code, user.user_id), true);
    const secondLogin = store.beginDeviceLogin(deviceToken);
    assert.equal(secondLogin.linked, true);
    assert.equal(secondLogin.user.user_id, user.user_id);
    assert.equal(store.authenticateGameToken(secondLogin.access_token)?.user_id, user.user_id);
    assert.equal(JSON.stringify(secondLogin).includes("safe test password"), false);
    store.close();
  } finally {
    value.cleanup();
  }
});

test("chest countdown, claim, reward ledger, match idempotency, and account isolation work", () => {
  const value = fixture();
  try {
    const store = value.open();
    const first = store.createAccount({ email: "chest@example.test", displayName: "Chest_Player", password: "safe test password" });
    const second = store.createAccount({ email: "other@example.test", displayName: "Other_Player", password: "safe test password" });
    const chest = store.accountSnapshot(first.user_id).chests[0];
    const unlocking = store.startChest(first.user_id, chest.chest_id);
    assert.equal(unlocking.state, "unlocking");
    assert.throws(() => store.claimChest(first.user_id, chest.chest_id), /chest_not_ready/);
    assert.throws(() => store.claimChest(second.user_id, chest.chest_id), /chest_not_claimable/);
    value.advance(3_000);
    assert.equal(store.listChests(first.user_id)[0].state, "ready");
    const reward = store.claimChest(first.user_id, chest.chest_id);
    assert.equal(reward.item_master_id, 1001);
    assert.equal(store.accountSnapshot(first.user_id).figures.length, 7);
    assert.equal(store.accountSnapshot(second.user_id).figures.length, 6);
    assert.deepEqual(store.createMatchChest(first.user_id, 55), {
      created: true, chest_id: chest.chest_id + 2, slot_index: 0, state: "locked",
    });
    assert.equal(store.createMatchChest(first.user_id, 55).reason, "already_awarded");
    assert.equal(store.inventoryEvents(first.user_id).filter((event) => event.event_type === "chest_claimed").length, 1);
    store.close();
  } finally {
    value.cleanup();
  }
});

test("expired browser, game, and pending link sessions are rejected", () => {
  const value = fixture();
  try {
    let now = 1_788_900_000_000;
    const store = new AccountStore({
      databasePath: join(value.directory, "expiry.sqlite"),
      now: () => now,
      browserSessionMilliseconds: 60_000,
      gameSessionMilliseconds: 60_000,
      deviceLinkMilliseconds: 60_000,
      starterFigures: STARTERS,
      starterPlateIds: PLATES,
      plateMasters: [...new Set(PLATES)].map((item_master_id) => ({ item_master_id, cost: 1 })),
      rewardCatalog: REWARDS,
    });
    const user = store.createAccount({ email: "expiry@example.test", displayName: "Expiry_Player", password: "safe test password" });
    const browser = store.createBrowserSession(user.user_id);
    const pending = store.beginDeviceLogin("expiry-device-token-0123456789");
    store.linkDevice(pending.link_code, user.user_id);
    const game = store.beginDeviceLogin("expiry-device-token-0123456789");
    assert.ok(store.browserSession(browser.token));
    assert.ok(store.authenticateGameToken(game.access_token));
    const secondPending = store.beginDeviceLogin("second-expiry-device-0123456789");
    now += 60_001;
    assert.equal(store.browserSession(browser.token), null);
    assert.equal(store.authenticateGameToken(game.access_token), null);
    assert.throws(() => store.linkDevice(secondPending.link_code, user.user_id), /device_link_invalid_or_expired/);
    store.close();
  } finally {
    value.cleanup();
  }
});

test("the additive account-access migration retains old credentials, devices, sessions, inventory, and decks", () => {
  const value = fixture();
  let store;
  try {
    store = value.open();
    const user = store.createAccount({ email: "migrate@example.test", displayName: "Migrated", password: "migration test password" });
    const browser = store.createBrowserSession(user.user_id);
    const device = "migration-device-0123456789abcdef";
    store.linkDeviceTokenToUser(device, user.user_id);
    const game = store.beginDeviceLogin(device);
    const pendingDevice = "migration-pending-device-0123456789";
    const pending = store.beginDeviceLogin(pendingDevice);
    const before = store.accountSnapshot(user.user_id);
    store.close();
    store = null;
    // Rebuild precisely the previous schema shape in this disposable fixture.
    const database = new DatabaseSync(join(value.directory, "accounts.sqlite"));
    for (const table of ["browser_sessions", "device_links"]) {
      database.exec(`DROP INDEX ${table}_public_id`);
      for (const column of [table === "browser_sessions" ? "session_id" : "device_id", "label", "last_seen_at"]) {
        database.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
      }
    }
    database.exec("DROP TABLE anonymous_browser_sessions");
    database.exec("DROP TABLE device_link_requests");
    database.exec("DROP INDEX game_sessions_reusable_device; ALTER TABLE game_sessions DROP COLUMN credential_nonce");
    database.exec("DROP TABLE completed_match_players; DROP TABLE completed_matches");
    database.close();

    store = value.open();
    assert.deepEqual(store.accountSnapshot(user.user_id), before);
    assert.equal(store.authenticatePassword(user.email, "migration test password").user_id, user.user_id);
    assert.equal(store.browserSession(browser.token).user.user_id, user.user_id);
    assert.equal(store.authenticateGameToken(game.access_token).user_id, user.user_id);
    assert.equal(store.beginDeviceLogin(device).user.user_id, user.user_id);
    const security = store.accountSecuritySnapshot(user.user_id);
    assert.match(security.devices[0].device_id, /^[a-f0-9]{32}$/u);
    assert.match(security.browser_sessions[0].session_id, /^[a-f0-9]{32}$/u);
    assert.equal(JSON.stringify(security).includes("token_hash"), false);
    assert.equal(JSON.stringify(security).includes(game.access_token), false);
    assert.equal(JSON.stringify(security).includes(device), false);
    assert.equal(store.pendingDeviceLink(pending.link_code).verification_code, pending.verification_code);
    assert.deepEqual(store.recentMatchCompletions(user.user_id), []);
    store.close(); store = value.open();
    const migratedAgain = store.accountSecuritySnapshot(user.user_id);
    assert.equal(migratedAgain.devices[0].device_id, security.devices[0].device_id);
    assert.equal(migratedAgain.browser_sessions[0].session_id, security.browser_sessions[0].session_id);
    assert.equal(store.linkDevice(pending.link_code, user.user_id), true);
    assert.equal(store.beginDeviceLogin(pendingDevice).user.user_id, user.user_id);
    assert.deepEqual(store.accountSnapshot(user.user_id), before);
  } finally {
    store?.close();
    value.cleanup();
  }
});

test("browser and game-device revocation are owned, durable, and revoke every bearer of that device", () => {
  const value = fixture();
  let store;
  try {
    store = value.open();
    const a = store.createAccount({ email: "revoke-a@example.test", displayName: "Player_A", password: "revocation test password" });
    const b = store.createAccount({ email: "revoke-b@example.test", displayName: "Player_B", password: "revocation test password" });
    const browser = store.createBrowserSession(a.user_id);
    const otherBrowser = store.createBrowserSession(a.user_id);
    const browserId = store.browserSession(browser.token).session_id;
    const device = "revocation-device-0123456789abcdef";
    const otherDevice = "unaffected-device-0123456789abcdef";
    store.linkDeviceTokenToUser(device, a.user_id);
    const deviceId = store.accountSecuritySnapshot(a.user_id).devices[0].device_id;
    store.linkDeviceTokenToUser(otherDevice, a.user_id);
    const games = [store.beginDeviceLogin(device), store.beginDeviceLogin(device)];
    // Preserve an independently issued legacy bearer too; repeated modern
    // login now deliberately reuses one bearer instead of allocating another.
    const legacyToken = "legacy-issued-game-bearer-0123456789";
    const digest = (text) => createHash("sha256").update(text).digest("hex");
    store.database.prepare(`INSERT INTO game_sessions(token_hash,user_id,device_hash,expires_at,created_at)
      VALUES(?,?,?,?,?)`).run(digest(legacyToken), a.user_id, digest(device), 1_900_000_000_000, 1_788_900_000_000);
    games.push({ access_token: legacyToken });
    const unaffected = store.beginDeviceLogin(otherDevice);
    assert.equal(store.accountSecuritySnapshot(a.user_id).devices.find((entry) => entry.device_id === deviceId).active_sessions, 2);
    assert.throws(() => store.revokeBrowserSessionById(b.user_id, browserId), /session_not_found/u);
    assert.throws(() => store.revokeDevice(b.user_id, deviceId), /device_not_found/u);
    store.revokeBrowserSessionById(a.user_id, browserId);
    store.revokeDevice(a.user_id, deviceId);
    assert.equal(store.browserSession(browser.token), null);
    assert.ok(store.browserSession(otherBrowser.token));
    for (const game of games) assert.equal(store.authenticateGameToken(game.access_token), null);
    assert.equal(store.authenticateGameToken(unaffected.access_token).user_id, a.user_id);
    assert.equal(store.beginDeviceLogin(device).linked, false);
    store.close();
    store = value.open();
    assert.equal(store.browserSession(browser.token), null);
    for (const game of games) assert.equal(store.authenticateGameToken(game.access_token), null);
    assert.equal(store.accountSnapshot(a.user_id).figures.length, 6);
    store.linkDeviceTokenToUser(otherDevice, b.user_id);
    assert.equal(store.authenticateGameToken(unaffected.access_token), null);
    assert.equal(store.beginDeviceLogin(otherDevice).user.user_id, b.user_id);
  } finally {
    store?.close();
    value.cleanup();
  }
});

test("anonymous browser sessions expire and pending link confirmation codes match the game request", () => {
  const value = fixture();
  const store = value.open();
  try {
    const anonymous = store.createAnonymousBrowserSession();
    assert.equal(store.anonymousBrowserSession(anonymous.token).csrf_token, anonymous.csrf_token);
    assert.equal(store.anonymousBrowserSession("forged-anonymous-token-0123456789"), null);
    const pending = store.beginDeviceLogin("pending-device-token-0123456789");
    const retry = store.beginDeviceLogin("pending-device-token-0123456789");
    const summary = store.pendingDeviceLink(pending.link_code);
    assert.match(pending.verification_code, /^\d{6}$/u);
    assert.equal(summary.verification_code, pending.verification_code);
    assert.equal(JSON.stringify(summary).includes("link_code_hash"), false);
    assert.ok(store.pendingDeviceLink(retry.link_code));
    value.advance(15 * 60 * 1000 + 1);
    assert.equal(store.anonymousBrowserSession(anonymous.token), null);
    assert.equal(store.pendingDeviceLink(pending.link_code), null);
    const user = store.createAccount({ email: "expired-link@example.test", displayName: "Expired", password: "expired link password" });
    assert.throws(() => store.linkDevice(pending.link_code, user.user_id), /device_link_invalid_or_expired/u);
  } finally {
    store.close();
    value.cleanup();
  }
});

test("game retries preserve an open consent page and one approval consumes all pending codes", () => {
  const value = fixture(); const store = value.open();
  try {
    const user = store.createAccount({ email: "polling@example.test", displayName: "Polling_Player", password: "polling consent test password" });
    const first = store.beginDeviceLogin("retry-game-device-token-0123456789");
    const retry = store.beginDeviceLogin("retry-game-device-token-0123456789");
    assert.ok(store.pendingDeviceLink(first.link_code));
    store.linkDevice(first.link_code, user.user_id);
    assert.equal(store.pendingDeviceLink(first.link_code), null);
    assert.equal(store.pendingDeviceLink(retry.link_code), null);
    assert.throws(() => store.linkDevice(retry.link_code, user.user_id), /device_link_invalid_or_expired/u);
    assert.equal(store.beginDeviceLogin("retry-game-device-token-0123456789").user.user_id, user.user_id);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM device_link_requests").get().n, 0);
  } finally { store.close(); value.cleanup(); }
});

test("hot authentication throttles physical cleanup but expiry and revocation remain immediate", () => {
  let monotonic = 0;
  const value = fixture({
    monotonicNow: () => monotonic,
    gameSessionMilliseconds: 60_000,
    browserSessionMilliseconds: 60_000,
    anonymousSessionMilliseconds: 60_000,
    deviceLinkMilliseconds: 60_000,
  });
  const store = value.open();
  try {
    const user = store.createAccount({ email: "cleanup@example.test", displayName: "Cleanup", password: "cleanup cadence password" });
    const device = "cleanup-active-device-token-0123456789";
    store.linkDeviceTokenToUser(device, user.user_id);
    const game = store.beginDeviceLogin(device);
    const browser = store.createBrowserSession(user.user_id);
    const anonymous = store.createAnonymousBrowserSession();
    const pending = store.beginDeviceLogin("cleanup-pending-device-0123456789");
    const prepare = store.database.prepare.bind(store.database);
    let deletionStatements = 0;
    store.database.prepare = (sql) => {
      if (/^DELETE\b/u.test(sql.trim())) deletionStatements += 1;
      return prepare(sql);
    };
    for (let index = 0; index < 1_000; index += 1) {
      assert.equal(store.authenticateGameToken(game.access_token).user_id, user.user_id);
    }
    assert.equal(deletionStatements, 0, "battle command/outbound checks must not run repeated deletion scans");
    value.advance(60_000);
    assert.equal(store.authenticateGameToken(game.access_token), null);
    assert.equal(store.browserSession(browser.token), null);
    assert.equal(store.anonymousBrowserSession(anonymous.token), null);
    assert.equal(store.pendingDeviceLink(pending.link_code), null);
    assert.throws(() => store.linkDevice(pending.link_code, user.user_id), /device_link_invalid_or_expired/u);
    const expiredSecurity = store.accountSecuritySnapshot(user.user_id);
    assert.deepEqual(expiredSecurity.browser_sessions, []);
    assert.equal(expiredSecurity.devices[0].active_sessions, 0);
    assert.equal(deletionStatements, 0, "expiry rejection cannot depend on deleting a row first");
    for (const table of ["game_sessions", "browser_sessions", "anonymous_browser_sessions", "device_link_requests"]) {
      assert.equal(store.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 1, "expired fixture rows still exist before housekeeping");
    }
    monotonic = 29_999;
    assert.equal(store.authenticateGameToken(game.access_token), null);
    assert.equal(deletionStatements, 0);
    monotonic = 30_000;
    assert.equal(store.authenticateGameToken(game.access_token), null);
    assert.equal(deletionStatements, 5);
    for (const table of ["game_sessions", "browser_sessions", "anonymous_browser_sessions", "device_link_requests"]) {
      assert.equal(store.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
    }
    monotonic = 1_000;
    store.authenticateGameToken(game.access_token);
    monotonic = 59_999;
    store.authenticateGameToken(game.access_token);
    assert.equal(deletionStatements, 5, "clock rollback cannot grant an early housekeeping cycle");
    monotonic = 60_000;
    store.authenticateGameToken(game.access_token);
    assert.equal(deletionStatements, 10);

    const currentGame = store.beginDeviceLogin(device);
    const currentBrowser = store.createBrowserSession(user.user_id);
    const deviceId = store.accountSecuritySnapshot(user.user_id).devices[0].device_id;
    assert.ok(store.authenticateGameToken(currentGame.access_token));
    store.revokeDevice(user.user_id, deviceId);
    store.revokeBrowserSession(currentBrowser.token);
    deletionStatements = 0;
    assert.equal(store.authenticateGameToken(currentGame.access_token), null);
    assert.equal(store.browserSession(currentBrowser.token), null);
    assert.equal(deletionStatements, 0, "revocation is immediately visible without deferred cleanup or an auth cache");
  } finally { store.close(); value.cleanup(); }
});

test("login polling reuses one hashed-only consent and bearer across restart without extending their expiry", () => {
  const value = fixture({ gameSessionMilliseconds: 60_000 }); let store;
  try {
    store = value.open();
    const device = "bounded-polling-device-token-0123456789";
    const first = store.beginDeviceLogin(device);
    value.advance(1_000);
    for (let index = 0; index < 500; index += 1) assert.deepEqual(store.beginDeviceLogin(device), first);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM device_link_requests").get().n, 1);
    const pendingAtRest = JSON.stringify({
      devices: store.database.prepare("SELECT * FROM device_links").all(),
      requests: store.database.prepare("SELECT * FROM device_link_requests").all(),
    });
    assert.equal(pendingAtRest.includes(first.link_code), false);
    assert.equal(pendingAtRest.includes(device), false);
    store.close(); store = value.open();
    assert.deepEqual(store.beginDeviceLogin(device), first);
    const user = store.createAccount({ email: "bounded@example.test", displayName: "Bounded", password: "bounded test password" });
    store.linkDevice(first.link_code, user.user_id);
    const game = store.beginDeviceLogin(device);
    value.advance(1_000);
    for (let index = 0; index < 500; index += 1) assert.deepEqual(store.beginDeviceLogin(device), game);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM game_sessions").get().n, 1);
    const atRest = JSON.stringify(store.database.prepare("SELECT * FROM game_sessions").all());
    assert.equal(atRest.includes(game.access_token), false);
    assert.equal(atRest.includes(device), false);
    store.close(); store = value.open();
    assert.deepEqual(store.beginDeviceLogin(device), game);
    value.advance(60_000);
    const refreshed = store.beginDeviceLogin(device);
    assert.notEqual(refreshed.access_token, game.access_token);
    assert.equal(store.authenticateGameToken(game.access_token), null);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM game_sessions").get().n, 1);
  } finally { store?.close(); value.cleanup(); }
});

test("damaged reusable credential state fails closed without issuing replacement credentials", () => {
  const value = fixture(); const store = value.open();
  try {
    const device = "tampered-nonce-device-token-0123456789";
    const pending = store.beginDeviceLogin(device);
    const nonce = store.database.prepare("SELECT credential_nonce FROM device_link_requests").get().credential_nonce;
    store.database.prepare("UPDATE device_link_requests SET credential_nonce=?").run("damaged-test-nonce");
    assert.throws(() => store.beginDeviceLogin(device), /device_link_state_invalid/u);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM device_link_requests").get().n, 1);
    store.database.prepare("UPDATE device_link_requests SET credential_nonce=?").run(nonce);
    assert.deepEqual(store.beginDeviceLogin(device), pending);
    const user = store.createAccount({ email: "tampered@example.test", displayName: "Tampered", password: "tampered nonce test password" });
    store.linkDevice(pending.link_code, user.user_id);
    const game = store.beginDeviceLogin(device);
    store.database.prepare("UPDATE game_sessions SET credential_nonce=?").run("damaged-test-nonce");
    assert.throws(() => store.beginDeviceLogin(device), /device_session_state_invalid/u);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM game_sessions").get().n, 1);
    assert.equal(store.authenticateGameToken(game.access_token).user_id, user.user_id, "an existing valid bearer is not replaced or revoked by corrupt retry state");
  } finally { store.close(); value.cleanup(); }
});

test("legacy open links are not evicted by a per-device cap, and legacy bearers survive bounded session adoption", () => {
  const value = fixture(); const store = value.open();
  try {
    const device = "legacy-bounded-device-token-0123456789";
    const issued = [];
    // Legacy entries lack a nonce, so their cleartext cannot be recovered for
    // retry. Keep them valid rather than evicting a still-open consent page.
    for (let index = 0; index < 4; index += 1) {
      issued.push(store.beginDeviceLogin(device));
      store.database.prepare("UPDATE device_link_requests SET credential_nonce=NULL").run();
      value.advance(1);
    }
    assert.throws(() => store.beginDeviceLogin(device), (error) => error.message === "device_link_request_limit" && error.retryAfterSeconds === 900);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM device_link_requests").get().n, 4);
    assert.ok(store.pendingDeviceLink(issued[0].link_code));
    const user = store.createAccount({ email: "legacy-bounded@example.test", displayName: "Legacy", password: "legacy bounded password" });
    store.linkDevice(issued[0].link_code, user.user_id);
    const legacyGame = store.beginDeviceLogin(device);
    store.database.prepare("UPDATE game_sessions SET credential_nonce=NULL").run();
    const currentGame = store.beginDeviceLogin(device);
    assert.notEqual(currentGame.access_token, legacyGame.access_token);
    assert.equal(store.authenticateGameToken(legacyGame.access_token).user_id, user.user_id);
    for (let index = 0; index < 25; index += 1) assert.deepEqual(store.beginDeviceLogin(device), currentGame);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM game_sessions").get().n, 2);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM device_link_requests").get().n, 0);
  } finally { store.close(); value.cleanup(); }
});

test("global pending-device capacity is bounded, preserves live requests, and releases on link or expiry", () => {
  const value = fixture({ maximumPendingDevices: 2, deviceLinkMilliseconds: 60_000 }); const store = value.open();
  try {
    const first = store.beginDeviceLogin("capacity-first-device-0123456789");
    const second = store.beginDeviceLogin("capacity-second-device-0123456789");
    assert.throws(() => store.beginDeviceLogin("capacity-third-device-0123456789"), (error) => error.message === "pending_device_capacity_reached" && error.retryAfterSeconds === 60);
    assert.deepEqual(store.beginDeviceLogin("capacity-first-device-0123456789"), first);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM device_links").get().n, 2);
    const user = store.createAccount({ email: "capacity@example.test", displayName: "Capacity", password: "capacity test password" });
    store.linkDevice(first.link_code, user.user_id);
    store.beginDeviceLogin("capacity-third-device-0123456789");
    assert.ok(store.pendingDeviceLink(second.link_code));
    value.advance(60_001);
    store.beginDeviceLogin("capacity-fourth-device-0123456789");
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM device_links WHERE user_id IS NULL").get().n, 1);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM device_link_requests").get().n, 1);
    assert.equal(store.beginDeviceLogin("capacity-first-device-0123456789").user.user_id, user.user_id);
  } finally { store.close(); value.cleanup(); }
  for (const options of [{ maximumPendingDevices: 0 }, { maximumPendingDeviceLinks: 0 }, { maximumPendingDeviceLinks: 33 }]) {
    assert.throws(() => new AccountStore({ databasePath: ":memory:", ...options }), /must_be_between/u);
  }
});

test("completed human matches are immutable, idempotent, participant-owned, and durable without invented rewards", () => {
  const value = fixture();
  let store;
  try {
    store = value.open();
    const players = ["black", "white", "outsider"].map((side) => store.createAccount({
      email: `${side}-history@example.test`, displayName: `History_${side}`, password: "match history test password",
    }));
    const before = players.map((player) => store.accountSnapshot(player.user_id));
    const completion = {
      match_id: 101, mode: "human", winner: "black", reason: "goal", finished_at: 1_800_000_000_000,
      players: [{ user_id: players[1].user_id, side: "white" }, { user_id: players[0].user_id, side: "black" }],
      record: { initial: { first_player: "black" }, moves: [{ type: "mp_move", route: [1, 2] }] },
    };
    assert.deepEqual(store.recordMatchCompletion(completion), { created: true, match_id: "101" });
    assert.deepEqual(store.recordMatchCompletion({ ...completion, record: { moves: completion.record.moves, initial: completion.record.initial } }), { created: false, match_id: "101" });
    assert.throws(() => store.recordMatchCompletion({ ...completion, winner: "white" }), /match_completion_conflict/u);
    assert.equal(store.matchCompletion(players[2].user_id, 101), null);
    assert.equal(store.matchCompletion(players[0].user_id, "missing"), null);
    assert.deepEqual(store.matchCompletion(players[0].user_id, 101), store.matchCompletion(players[1].user_id, 101));
    assert.equal(store.recentMatchCompletions(players[0].user_id)[0].side, "black");
    assert.equal(store.recentMatchCompletions(players[1].user_id)[0].side, "white");
    assert.deepEqual(store.recentMatchCompletions(players[2].user_id), []);
    assert.deepEqual(players.map((player) => store.accountSnapshot(player.user_id)), before);
    assert.throws(() => store.recordMatchCompletion({ ...completion, match_id: 102, players: [{ user_id: players[0].user_id, side: "black" }, { user_id: 99999, side: "white" }] }), /player_not_found/u);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM completed_matches").get().n, 1);
    assert.throws(() => store.recordMatchCompletion({ ...completion, record: { bad: Number.NaN } }), /invalid_record/u);
    store.close(); store = value.open();
    assert.deepEqual(store.matchCompletion(players[0].user_id, 101).record, completion.record);
    assert.equal(store.recordMatchCompletion(completion).created, false);
    assert.equal(store.matchCompletion(players[2].user_id, 101), null);
    assert.deepEqual(players.map((player) => store.accountSnapshot(player.user_id)), before);
  } finally { store?.close(); value.cleanup(); }
});
