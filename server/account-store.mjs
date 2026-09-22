import {
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const DISPLAY_NAME_PATTERN = /^[\p{L}\p{N}_ .'-]{2,24}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{16,256}$/u;
const SCRYPT_KEY_BYTES = 64;
const PASSWORD_MINIMUM = 10;
const PASSWORD_MAXIMUM = 256;
const PUBLIC_ID_PATTERN = /^[a-f0-9]{32}$/u;
const MATCH_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const MAXIMUM_PENDING_DEVICE_LINKS = 4;
const MAXIMUM_PENDING_DEVICES = 10_000;
const EXPIRED_CLEANUP_MILLISECONDS = 30_000;
const INITIAL_DECK_COUNT = 5;
const MAXIMUM_DECK_COUNT = 12;
const DECK_EXPANSION_GEM_COST = 5;
const MAXIMUM_DECK_FIGURES = 6;
const MAXIMUM_DECK_PLATES = 6;
const MAXIMUM_DECK_PLATE_COST = 8;

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function deviceCredential(deviceToken, domain, nonce) {
  // Recover the same issued credential for a retry without storing its cleartext.
  // The random nonce alone and the stored device-token hash cannot derive it.
  return createHmac("sha256", String(deviceToken)).update(`kiwi-duel:${domain}:v1\0${nonce}`, "utf8").digest("base64url");
}

function linkVerificationCode(codeHash) {
  return String(Number.parseInt(String(codeHash).slice(0, 8), 16) % 1_000_000).padStart(6, "0");
}

function canonicalJson(value) {
  function normalize(entry) {
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return entry;
    if (typeof entry === "number" && Number.isFinite(entry)) return entry;
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && Object.getPrototypeOf(entry) === Object.prototype) {
      return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, normalize(entry[key])]));
    }
    throw new Error("match_completion_invalid_record");
  }
  try { return JSON.stringify(normalize(value)); }
  catch { throw new Error("match_completion_invalid_record"); }
}

function normalizeEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

function publicUser(row) {
  if (!row) return null;
  return {
    user_id: Number(row.id),
    display_name: String(row.display_name),
    email: String(row.email),
    rank: Number(row.rank),
    balances: {
      coins: Number(row.coins),
      gems: Number(row.gems),
    },
    created_at: Number(row.created_at),
  };
}

function withTransaction(database, action) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

export class AccountStore {
  #nextExpiredCleanupAt = Number.NEGATIVE_INFINITY;
  #lastCleanupClock = 0;

  constructor({
    databasePath,
    now = Date.now,
    chestUnlockMilliseconds = 3_000,
    browserSessionMilliseconds = 30 * 24 * 60 * 60 * 1_000,
    gameSessionMilliseconds = 90 * 24 * 60 * 60 * 1_000,
    deviceLinkMilliseconds = 15 * 60 * 1_000,
    anonymousSessionMilliseconds = 15 * 60 * 1_000,
    maximumPendingDeviceLinks = MAXIMUM_PENDING_DEVICE_LINKS,
    maximumPendingDevices = MAXIMUM_PENDING_DEVICES,
    cleanupIntervalMilliseconds = EXPIRED_CLEANUP_MILLISECONDS,
    monotonicNow = () => performance.now(),
    starterFigures = [],
    starterPlateIds = [],
    plateMasters = [],
    rewardCatalog = [],
  }) {
    if (!databasePath) throw new Error("account_database_path_required");
    if (!Number.isInteger(maximumPendingDeviceLinks) || maximumPendingDeviceLinks < 1 || maximumPendingDeviceLinks > 32) {
      throw new Error("maximum_pending_device_links_must_be_between_1_and_32");
    }
    if (!Number.isInteger(maximumPendingDevices) || maximumPendingDevices < 1 || maximumPendingDevices > 100_000) {
      throw new Error("maximum_pending_devices_must_be_between_1_and_100000");
    }
    if (!Number.isInteger(cleanupIntervalMilliseconds) || cleanupIntervalMilliseconds < 1_000 || cleanupIntervalMilliseconds > 300_000) {
      throw new Error("cleanup_interval_must_be_between_1000_and_300000ms");
    }
    if (typeof monotonicNow !== "function") throw new Error("cleanup_clock_must_be_a_function");
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
    this.databasePath = databasePath;
    this.now = now;
    this.chestUnlockMilliseconds = Math.max(0, Number(chestUnlockMilliseconds));
    this.browserSessionMilliseconds = Math.max(60_000, Number(browserSessionMilliseconds));
    this.gameSessionMilliseconds = Math.max(60_000, Number(gameSessionMilliseconds));
    this.deviceLinkMilliseconds = Math.max(60_000, Number(deviceLinkMilliseconds));
    this.anonymousSessionMilliseconds = Math.max(60_000, Number(anonymousSessionMilliseconds));
    this.maximumPendingDeviceLinks = maximumPendingDeviceLinks;
    this.maximumPendingDevices = maximumPendingDevices;
    this.cleanupIntervalMilliseconds = cleanupIntervalMilliseconds;
    this.monotonicNow = monotonicNow;
    this.starterFigures = starterFigures.map((entry) => ({
      item_master_id: Number(entry.item_master_id),
      model_id: Number(entry.model_id),
      level: Math.max(1, Number(entry.level ?? 1)),
    }));
    this.starterPlateIds = starterPlateIds.map(Number);
    this.plateCosts = new Map(plateMasters.map((entry) => [
      Number(entry.item_master_id),
      Math.max(0, Number(entry.cost ?? 0)),
    ]));
    this.rewardCatalog = rewardCatalog
      .map((entry) => ({
        item_master_id: Number(entry.item_master_id),
        model_id: Number(entry.model_id),
        figure_no: Number(entry.figure_no ?? -1),
        poke_no: Number(entry.poke_no ?? -1),
      }))
      .filter((entry) => entry.item_master_id > 0 && entry.model_id >= 0)
      .sort((left, right) => left.item_master_id - right.item_master_id);
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    this.#migrate();
    this.#ensureInitialDecks();
  }

  close() {
    this.database.close();
  }

  #migrate() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        rank INTEGER NOT NULL DEFAULT 1,
        coins INTEGER NOT NULL DEFAULT 0,
        gems INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS browser_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS browser_sessions_user ON browser_sessions(user_id);
      CREATE INDEX IF NOT EXISTS browser_sessions_expiry ON browser_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS device_links (
        device_hash TEXT PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        link_code_hash TEXT UNIQUE,
        link_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        linked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS device_links_user ON device_links(user_id);
      CREATE INDEX IF NOT EXISTS device_links_pending_expiry ON device_links(link_expires_at) WHERE user_id IS NULL;
      CREATE TABLE IF NOT EXISTS device_link_requests (
        code_hash TEXT PRIMARY KEY,
        device_hash TEXT NOT NULL REFERENCES device_links(device_hash) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS device_link_requests_device ON device_link_requests(device_hash);
      CREATE INDEX IF NOT EXISTS device_link_requests_expiry ON device_link_requests(expires_at);
      CREATE TABLE IF NOT EXISTS game_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_hash TEXT NOT NULL REFERENCES device_links(device_hash) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS game_sessions_user ON game_sessions(user_id);
      CREATE INDEX IF NOT EXISTS game_sessions_expiry ON game_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS user_figures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        item_master_id INTEGER NOT NULL,
        model_id INTEGER NOT NULL,
        level INTEGER NOT NULL DEFAULT 1,
        source TEXT NOT NULL,
        source_chest_id INTEGER,
        acquired_at INTEGER NOT NULL,
        UNIQUE(user_id, item_master_id)
      );
      CREATE INDEX IF NOT EXISTS user_figures_user ON user_figures(user_id);
      CREATE TABLE IF NOT EXISTS user_plates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        item_master_id INTEGER NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 1,
        acquired_at INTEGER NOT NULL,
        UNIQUE(user_id, item_master_id)
      );
      CREATE TABLE IF NOT EXISTS user_decks (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        deck_no INTEGER NOT NULL,
        name TEXT NOT NULL,
        PRIMARY KEY(user_id, deck_no)
      );
      CREATE TABLE IF NOT EXISTS user_deck_figures (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        deck_no INTEGER NOT NULL,
        deck_index INTEGER NOT NULL,
        item_master_id INTEGER NOT NULL,
        model_id INTEGER NOT NULL,
        PRIMARY KEY(user_id, deck_no, deck_index),
        FOREIGN KEY(user_id, deck_no) REFERENCES user_decks(user_id, deck_no) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS user_deck_plates (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        deck_no INTEGER NOT NULL,
        deck_index INTEGER NOT NULL,
        item_master_id INTEGER NOT NULL,
        PRIMARY KEY(user_id, deck_no, deck_index),
        FOREIGN KEY(user_id, deck_no) REFERENCES user_decks(user_id, deck_no) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS chests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        slot_index INTEGER,
        state TEXT NOT NULL CHECK(state IN ('locked', 'unlocking', 'claimed')),
        reward_item_master_id INTEGER NOT NULL,
        reward_model_id INTEGER NOT NULL,
        unlock_started_at INTEGER,
        ready_at INTEGER,
        created_at INTEGER NOT NULL,
        claimed_at INTEGER,
        source TEXT NOT NULL,
        source_key TEXT,
        UNIQUE(user_id, slot_index),
        UNIQUE(user_id, source_key)
      );
      CREATE INDEX IF NOT EXISTS chests_user_state ON chests(user_id, state);
      CREATE TABLE IF NOT EXISTS inventory_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        source_key TEXT,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(user_id, event_type, source_key)
      );
      CREATE INDEX IF NOT EXISTS inventory_events_user ON inventory_events(user_id, id);
      CREATE TABLE IF NOT EXISTS anonymous_browser_sessions (
        token_hash TEXT PRIMARY KEY,
        csrf_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS anonymous_browser_sessions_expiry ON anonymous_browser_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS completed_matches (
        match_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        winner TEXT,
        reason TEXT NOT NULL,
        finished_at INTEGER NOT NULL,
        completion_json TEXT NOT NULL,
        completion_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS completed_match_players (
        match_id TEXT NOT NULL REFERENCES completed_matches(match_id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id),
        side TEXT NOT NULL CHECK(side IN ('black', 'white')),
        PRIMARY KEY(match_id, user_id),
        UNIQUE(match_id, side)
      );
      CREATE INDEX IF NOT EXISTS completed_matches_finished ON completed_matches(finished_at DESC);
      CREATE INDEX IF NOT EXISTS completed_match_players_user ON completed_match_players(user_id, match_id);
      INSERT OR IGNORE INTO device_link_requests(code_hash, device_hash, expires_at, created_at)
        SELECT link_code_hash, device_hash, link_expires_at, created_at FROM device_links
        WHERE user_id IS NULL AND link_code_hash IS NOT NULL AND link_expires_at IS NOT NULL;
    `);
    // Additive migration: existing account/session tokens, inventory, and deck rows survive.
    withTransaction(this.database, () => {
      for (const table of ["device_link_requests", "game_sessions"]) {
        const columns = new Set(this.database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
        if (!columns.has("credential_nonce")) this.database.exec(`ALTER TABLE ${table} ADD COLUMN credential_nonce TEXT`);
        // Old issued credentials remain valid until their normal expiry. Only
        // one new recoverable credential per installation may be outstanding.
        this.database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${table}_reusable_device ON ${table}(device_hash) WHERE credential_nonce IS NOT NULL`);
      }
      for (const [table, definitions] of Object.entries({
        browser_sessions: { session_id: "TEXT", label: "TEXT NOT NULL DEFAULT 'Browser'", last_seen_at: "INTEGER" },
        device_links: { device_id: "TEXT", label: "TEXT NOT NULL DEFAULT 'Game installation'", last_seen_at: "INTEGER" },
      })) {
        const columns = new Set(this.database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
        for (const [column, definition] of Object.entries(definitions)) {
          if (!columns.has(column)) this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        }
        const publicId = table === "browser_sessions" ? "session_id" : "device_id";
        this.database.exec(`UPDATE ${table} SET ${publicId} = lower(hex(randomblob(16))) WHERE ${publicId} IS NULL;
          UPDATE ${table} SET last_seen_at = created_at WHERE last_seen_at IS NULL;
          CREATE UNIQUE INDEX IF NOT EXISTS ${table}_public_id ON ${table}(${publicId});`);
      }
    });
  }

  createAccount({ email, displayName, password }) {
    const normalizedEmail = normalizeEmail(email);
    const normalizedName = String(displayName ?? "").trim();
    if (!EMAIL_PATTERN.test(normalizedEmail) || normalizedEmail.length > 254) throw new Error("invalid_email");
    if (!DISPLAY_NAME_PATTERN.test(normalizedName)) throw new Error("invalid_display_name");
    if (String(password ?? "").length < PASSWORD_MINIMUM) throw new Error("password_too_short");
    if (String(password).length > PASSWORD_MAXIMUM) throw new Error("password_too_long");
    const salt = randomBytes(16).toString("hex");
    const passwordHash = scryptSync(String(password), salt, SCRYPT_KEY_BYTES).toString("hex");
    const createdAt = Number(this.now());
    return withTransaction(this.database, () => {
      try {
        const result = this.database.prepare(`
          INSERT INTO users(email, display_name, password_salt, password_hash, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(normalizedEmail, normalizedName, salt, passwordHash, createdAt, createdAt);
        const userId = Number(result.lastInsertRowid);
        this.#seedStarterInventory(userId, createdAt);
        this.#createChest(userId, 0, "starter", `starter:${userId}`, createdAt);
        return this.userById(userId);
      } catch (error) {
        if (String(error.message).includes("UNIQUE constraint failed: users.email")) throw new Error("email_already_registered");
        throw error;
      }
    });
  }

  seedAccount({ email, displayName, password, deviceToken = "" }) {
    const normalizedEmail = normalizeEmail(email);
    let user = this.database.prepare("SELECT * FROM users WHERE email = ?").get(normalizedEmail);
    if (!user) user = this.createAccount({ email: normalizedEmail, displayName, password });
    else user = publicUser(user);
    if (deviceToken) this.linkDeviceTokenToUser(deviceToken, user.user_id);
    return user;
  }

  authenticatePassword(email, password) {
    if (String(password ?? "").length > PASSWORD_MAXIMUM) return null;
    const row = this.database.prepare("SELECT * FROM users WHERE email = ?").get(normalizeEmail(email));
    if (!row) {
      scryptSync(String(password ?? ""), "00000000000000000000000000000000", SCRYPT_KEY_BYTES);
      return null;
    }
    const candidate = scryptSync(String(password ?? ""), String(row.password_salt), SCRYPT_KEY_BYTES);
    const expected = Buffer.from(String(row.password_hash), "hex");
    return candidate.length === expected.length && timingSafeEqual(candidate, expected) ? publicUser(row) : null;
  }

  userById(userId) {
    return publicUser(this.database.prepare("SELECT * FROM users WHERE id = ?").get(Number(userId)));
  }

  createAnonymousBrowserSession() {
    this.#purgeExpired();
    const token = randomToken();
    const csrfToken = randomToken(24);
    const expiresAt = Number(this.now()) + this.anonymousSessionMilliseconds;
    this.database.prepare("INSERT INTO anonymous_browser_sessions(token_hash, csrf_token, expires_at) VALUES (?, ?, ?)")
      .run(sha256(token), csrfToken, expiresAt);
    return { token, csrf_token: csrfToken, expires_at: expiresAt };
  }

  anonymousBrowserSession(token) {
    if (!TOKEN_PATTERN.test(String(token ?? ""))) return null;
    return this.database.prepare("SELECT csrf_token, expires_at FROM anonymous_browser_sessions WHERE token_hash = ? AND expires_at > ?")
      .get(sha256(token), Number(this.now())) ?? null;
  }

  revokeAnonymousBrowserSession(token) {
    if (token) this.database.prepare("DELETE FROM anonymous_browser_sessions WHERE token_hash = ?").run(sha256(token));
  }

  createBrowserSession(userId, { label = "Browser" } = {}) {
    this.#purgeExpired();
    const token = randomToken();
    const csrfToken = randomToken(24);
    const createdAt = Number(this.now());
    this.database.prepare(`
      INSERT INTO browser_sessions(token_hash, user_id, csrf_token, expires_at, created_at, session_id, label, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sha256(token), Number(userId), csrfToken, createdAt + this.browserSessionMilliseconds, createdAt,
      randomBytes(16).toString("hex"), String(label).slice(0, 80), createdAt);
    return { token, csrf_token: csrfToken, expires_at: createdAt + this.browserSessionMilliseconds };
  }

  browserSession(token) {
    if (!token) return null;
    this.#purgeExpired();
    const row = this.database.prepare(`
      SELECT browser_sessions.csrf_token, browser_sessions.expires_at, browser_sessions.session_id,
             users.id, users.email, users.display_name, users.rank, users.coins, users.gems, users.created_at
      FROM browser_sessions JOIN users ON users.id = browser_sessions.user_id
      WHERE browser_sessions.token_hash = ? AND browser_sessions.expires_at > ?
    `).get(sha256(token), Number(this.now()));
    if (!row) return null;
    this.database.prepare("UPDATE browser_sessions SET last_seen_at = ? WHERE token_hash = ? AND last_seen_at < ?")
      .run(Number(this.now()), sha256(token), Number(this.now()) - 60_000);
    return { user: publicUser(row), csrf_token: String(row.csrf_token), expires_at: Number(row.expires_at), session_id: String(row.session_id) };
  }

  revokeBrowserSession(token) {
    if (token) this.database.prepare("DELETE FROM browser_sessions WHERE token_hash = ?").run(sha256(token));
  }

  accountSecuritySnapshot(userId) {
    this.#purgeExpired();
    return {
      browser_sessions: this.database.prepare(`SELECT session_id, label, created_at, last_seen_at, expires_at
        FROM browser_sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC, session_id`).all(Number(userId), Number(this.now())),
      devices: this.database.prepare(`SELECT device_id, label, created_at, linked_at, last_seen_at,
        (SELECT COUNT(*) FROM game_sessions WHERE game_sessions.device_hash = device_links.device_hash AND expires_at > ?) AS active_sessions
        FROM device_links WHERE user_id = ? ORDER BY linked_at DESC, device_id`).all(Number(this.now()), Number(userId)),
    };
  }

  revokeBrowserSessionById(userId, sessionId) {
    if (!PUBLIC_ID_PATTERN.test(String(sessionId ?? ""))) throw new Error("session_not_found");
    const result = this.database.prepare("DELETE FROM browser_sessions WHERE user_id = ? AND session_id = ?")
      .run(Number(userId), sessionId);
    if (Number(result.changes) !== 1) throw new Error("session_not_found");
    return true;
  }

  revokeDevice(userId, deviceId) {
    if (!PUBLIC_ID_PATTERN.test(String(deviceId ?? ""))) throw new Error("device_not_found");
    // The FK cascades through every issued game bearer. A removed install must be linked again.
    const result = this.database.prepare("DELETE FROM device_links WHERE user_id = ? AND device_id = ?")
      .run(Number(userId), deviceId);
    if (Number(result.changes) !== 1) throw new Error("device_not_found");
    return true;
  }

  recordMatchCompletion(completion) {
    if (!completion || !MATCH_ID_PATTERN.test(String(completion.match_id ?? ""))) throw new Error("match_completion_invalid_id");
    const mode = String(completion.mode ?? "");
    const reason = String(completion.reason ?? "");
    const winner = completion.winner ?? null;
    const finishedAt = Number(completion.finished_at);
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(mode) || !/^[a-z][a-z0-9_-]{0,99}$/u.test(reason) ||
        !["black", "white", "draw", null].includes(winner) || !Number.isSafeInteger(finishedAt) || finishedAt <= 0) {
      throw new Error("match_completion_invalid_result");
    }
    if (!Array.isArray(completion.players) || completion.players.length !== 2) throw new Error("match_completion_invalid_players");
    const players = completion.players.map((player) => ({ user_id: Number(player.user_id), side: player.side }))
      .sort((a, b) => String(a.side).localeCompare(String(b.side)));
    if (players.some((player) => !Number.isSafeInteger(player.user_id) || player.user_id <= 0) ||
        players[0].user_id === players[1].user_id || players[0].side !== "black" || players[1].side !== "white") {
      throw new Error("match_completion_invalid_players");
    }
    if (!completion.record || typeof completion.record !== "object" || Array.isArray(completion.record)) throw new Error("match_completion_invalid_record");
    const normalized = { match_id: String(completion.match_id), mode, winner, reason, finished_at: finishedAt, players, record: completion.record };
    const serialized = canonicalJson(normalized);
    if (Buffer.byteLength(serialized) > 16 * 1024 * 1024) throw new Error("match_completion_record_too_large");
    const digest = sha256(serialized);
    return withTransaction(this.database, () => {
      const existing = this.database.prepare("SELECT completion_json, completion_hash FROM completed_matches WHERE match_id = ?")
        .get(normalized.match_id);
      if (existing) {
        if (existing.completion_hash !== digest || existing.completion_json !== serialized) throw new Error("match_completion_conflict");
        return { created: false, match_id: normalized.match_id };
      }
      if (players.some((player) => !this.userById(player.user_id))) throw new Error("match_completion_player_not_found");
      this.database.prepare(`INSERT INTO completed_matches(match_id, mode, winner, reason, finished_at, completion_json, completion_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(normalized.match_id, mode, winner, reason, finishedAt, serialized, digest);
      const insertPlayer = this.database.prepare("INSERT INTO completed_match_players(match_id, user_id, side) VALUES (?, ?, ?)");
      for (const player of players) insertPlayer.run(normalized.match_id, player.user_id, player.side);
      return { created: true, match_id: normalized.match_id };
    });
  }

  matchCompletion(userId, matchId) {
    const row = this.database.prepare(`SELECT completion_json FROM completed_matches
      JOIN completed_match_players USING(match_id) WHERE match_id = ? AND user_id = ?`)
      .get(String(matchId), Number(userId));
    return row ? JSON.parse(row.completion_json) : null;
  }

  recentMatchCompletions(userId, { limit = 20 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("match_history_limit_invalid");
    return this.database.prepare(`SELECT completed_matches.match_id, mode, winner, reason, finished_at, side
      FROM completed_matches JOIN completed_match_players USING(match_id)
      WHERE user_id = ? ORDER BY finished_at DESC, completed_matches.match_id DESC LIMIT ?`).all(Number(userId), limit);
  }

  beginDeviceLogin(deviceToken) {
    if (!TOKEN_PATTERN.test(String(deviceToken ?? ""))) throw new Error("invalid_device_token");
    // Allocation is a rate-limited slow path: remove expired nonce UNIQUE rows
    // and release the strict persistent pending-device cap immediately. Hot
    // battle authentication uses the throttled housekeeping path instead.
    this.#purgeExpired({ force: true });
    return withTransaction(this.database, () => {
      const deviceHash = sha256(deviceToken);
      const existing = this.database.prepare("SELECT * FROM device_links WHERE device_hash = ?").get(deviceHash);
      const now = Number(this.now());
      if (existing?.user_id) {
        this.database.prepare("UPDATE device_links SET last_seen_at = ? WHERE device_hash = ? AND (last_seen_at IS NULL OR last_seen_at < ?)")
          .run(now, deviceHash, now - 60_000);
        return { linked: true, ...this.#createGameSession(Number(existing.user_id), deviceHash, deviceToken) };
      }
      if (!existing && Number(this.database.prepare("SELECT COUNT(*) AS count FROM device_links WHERE user_id IS NULL").get().count) >= this.maximumPendingDevices) {
        const earliest = this.database.prepare("SELECT MIN(expires_at) AS expiry FROM device_link_requests").get();
        const error = new Error("pending_device_capacity_reached");
        error.retryAfterSeconds = Math.max(1, Math.ceil((Number(earliest.expiry ?? now + 60_000) - now) / 1000));
        throw error;
      }
      const reusable = this.database.prepare(`SELECT code_hash, credential_nonce, expires_at FROM device_link_requests
        WHERE device_hash = ? AND credential_nonce IS NOT NULL AND expires_at > ?`).get(deviceHash, now);
      if (reusable) {
        const code = deviceCredential(deviceToken, "device-link", reusable.credential_nonce);
        if (sha256(code) !== reusable.code_hash) throw new Error("device_link_state_invalid");
        return { linked: false, link_code: code, verification_code: linkVerificationCode(reusable.code_hash), expires_at: Number(reusable.expires_at) };
      }
      const pending = this.database.prepare(`SELECT COUNT(*) AS count, MIN(expires_at) AS earliest_expiry
        FROM device_link_requests WHERE device_hash = ? AND expires_at > ?`).get(deviceHash, now);
      if (Number(pending.count) >= this.maximumPendingDeviceLinks) {
        const error = new Error("device_link_request_limit");
        error.retryAfterSeconds = Math.max(1, Math.ceil((Number(pending.earliest_expiry) - now) / 1000));
        throw error;
      }
      const nonce = randomToken();
      const code = deviceCredential(deviceToken, "device-link", nonce);
      const codeHash = sha256(code);
      const expiresAt = now + this.deviceLinkMilliseconds;
      if (existing) {
        this.database.prepare(`UPDATE device_links SET link_code_hash = ?, link_expires_at = ? WHERE device_hash = ?`)
          .run(codeHash, expiresAt, deviceHash);
      } else {
        this.database.prepare(`INSERT INTO device_links(device_hash, link_code_hash, link_expires_at, created_at, device_id, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?)`).run(deviceHash, codeHash, expiresAt, now, randomBytes(16).toString("hex"), now);
      }
      this.database.prepare(`INSERT INTO device_link_requests(code_hash, device_hash, expires_at, created_at, credential_nonce)
        VALUES (?, ?, ?, ?, ?)`).run(codeHash, deviceHash, expiresAt, now, nonce);
      return { linked: false, link_code: code, verification_code: linkVerificationCode(codeHash), expires_at: expiresAt };
    });
  }

  pendingDeviceLink(linkCode) {
    if (!TOKEN_PATTERN.test(String(linkCode ?? ""))) return null;
    const row = this.database.prepare(`SELECT device_id, label, device_link_requests.created_at, expires_at FROM device_link_requests
      JOIN device_links USING(device_hash) WHERE code_hash = ? AND user_id IS NULL AND expires_at > ?`)
      .get(sha256(linkCode), Number(this.now())) ?? null;
    return row ? { ...row, verification_code: linkVerificationCode(sha256(linkCode)) } : null;
  }

  linkDevice(linkCode, userId, { label = "Game installation" } = {}) {
    const codeHash = sha256(String(linkCode ?? ""));
    const now = Number(this.now());
    return withTransaction(this.database, () => {
      const row = this.database.prepare(`SELECT device_hash FROM device_link_requests JOIN device_links USING(device_hash)
        WHERE code_hash = ? AND user_id IS NULL AND expires_at > ?`).get(codeHash, now);
      if (!row) throw new Error("device_link_invalid_or_expired");
      const result = this.database.prepare(`UPDATE device_links
        SET user_id = ?, link_code_hash = NULL, link_expires_at = NULL, linked_at = ?, last_seen_at = ?, label = ?
        WHERE device_hash = ? AND user_id IS NULL`).run(Number(userId), now, now,
        String(label).trim().slice(0, 80) || "Game installation", String(row.device_hash));
      if (Number(result.changes) !== 1) throw new Error("device_link_invalid_or_expired");
      this.database.prepare("DELETE FROM device_link_requests WHERE device_hash = ?").run(String(row.device_hash));
      return true;
    });
  }

  linkDeviceTokenToUser(deviceToken, userId) {
    if (!TOKEN_PATTERN.test(String(deviceToken ?? ""))) throw new Error("invalid_device_token");
    const deviceHash = sha256(deviceToken);
    const now = Number(this.now());
    withTransaction(this.database, () => {
      this.database.prepare("DELETE FROM game_sessions WHERE device_hash = ? AND user_id != ?").run(deviceHash, Number(userId));
      this.database.prepare(`
        INSERT INTO device_links(device_hash, user_id, created_at, linked_at, device_id, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_hash) DO UPDATE SET
          user_id = excluded.user_id,
          link_code_hash = NULL,
          link_expires_at = NULL,
          linked_at = excluded.linked_at,
          last_seen_at = excluded.last_seen_at
      `).run(deviceHash, Number(userId), now, now, randomBytes(16).toString("hex"), now);
      this.database.prepare("DELETE FROM device_link_requests WHERE device_hash = ?").run(deviceHash);
    });
    return true;
  }

  #createGameSession(userId, deviceHash, deviceToken) {
    // Called inside beginDeviceLogin's transaction, so ownership validation,
    // nonce reuse, and fresh bearer allocation cannot race consent/revocation.
    const now = Number(this.now());
    const reusable = this.database.prepare(`SELECT token_hash, credential_nonce, expires_at FROM game_sessions
      WHERE user_id = ? AND device_hash = ? AND credential_nonce IS NOT NULL AND expires_at > ?`).get(userId, deviceHash, now);
    if (reusable) {
      const token = deviceCredential(deviceToken, "game-session", reusable.credential_nonce);
      if (sha256(token) !== reusable.token_hash) throw new Error("device_session_state_invalid");
      return { access_token: token, user: this.userById(userId), expires_at: Number(reusable.expires_at) };
    }
    const nonce = randomToken();
    const token = deviceCredential(deviceToken, "game-session", nonce);
    this.database.prepare(`INSERT INTO game_sessions(token_hash, user_id, device_hash, expires_at, created_at, credential_nonce)
      VALUES (?, ?, ?, ?, ?, ?)`).run(sha256(token), userId, deviceHash, now + this.gameSessionMilliseconds, now, nonce);
    return { access_token: token, user: this.userById(userId), expires_at: now + this.gameSessionMilliseconds };
  }

  authenticateGameToken(token) {
    if (!token) return null;
    this.#purgeExpired();
    const row = this.database.prepare(`
      SELECT users.* FROM game_sessions JOIN users ON users.id = game_sessions.user_id
      JOIN device_links ON device_links.device_hash = game_sessions.device_hash AND device_links.user_id = game_sessions.user_id
      WHERE game_sessions.token_hash = ? AND game_sessions.expires_at > ?
    `).get(sha256(token), Number(this.now()));
    return publicUser(row);
  }

  accountSnapshot(userId) {
    const user = this.userById(userId);
    if (!user) return null;
    const figures = this.database.prepare(`
      SELECT id AS user_figure_id, item_master_id, model_id, level, source, source_chest_id, acquired_at
      FROM user_figures WHERE user_id = ? ORDER BY id
    `).all(Number(userId)).map((row) => ({ ...row, user_figure_id: Number(row.user_figure_id) }));
    const plates = this.database.prepare(`
      SELECT id AS user_plate_id, item_master_id, quantity, acquired_at
      FROM user_plates WHERE user_id = ? ORDER BY id
    `).all(Number(userId));
    const decks = this.deckSnapshot(userId);
    return { user, figures, plates, decks, chests: this.listChests(userId) };
  }

  deckSnapshot(userId) {
    return this.database.prepare("SELECT deck_no, name FROM user_decks WHERE user_id = ? ORDER BY deck_no").all(Number(userId)).map((deck) => ({
      deck_no: Number(deck.deck_no),
      name: String(deck.name),
      figures: this.database.prepare(`
        SELECT deck_index, item_master_id, model_id FROM user_deck_figures
        WHERE user_id = ? AND deck_no = ? ORDER BY deck_index
      `).all(Number(userId), Number(deck.deck_no)),
      plates: this.database.prepare(`
        SELECT deck_index, item_master_id FROM user_deck_plates
        WHERE user_id = ? AND deck_no = ? ORDER BY deck_index
      `).all(Number(userId), Number(deck.deck_no)).map((entry) => Number(entry.item_master_id)),
    }));
  }

  updateDeck(userId, { deck_no: deckNoValue, name, figures = [], plates = [] }) {
    const normalizedUserId = Number(userId);
    const deckNo = Number(deckNoValue);
    if (!Number.isInteger(deckNo) || deckNo < 1 || deckNo > MAXIMUM_DECK_COUNT) throw new Error("deck_number_invalid");
    if (!Array.isArray(figures) || figures.length > MAXIMUM_DECK_FIGURES) throw new Error("deck_figures_invalid");
    if (!Array.isArray(plates) || plates.length > MAXIMUM_DECK_PLATES) throw new Error("deck_plates_invalid");
    const deck = this.database.prepare("SELECT name FROM user_decks WHERE user_id = ? AND deck_no = ?").get(normalizedUserId, deckNo);
    if (!deck) throw new Error("deck_not_found");

    const ownedFigures = new Map(this.database.prepare(`
      SELECT item_master_id, model_id FROM user_figures WHERE user_id = ?
    `).all(normalizedUserId).map((entry) => [Number(entry.item_master_id), Number(entry.model_id)]));
    const normalizedFigures = figures.map((entry, deckIndex) => {
      const itemMasterId = Number(entry?.item_master_id ?? entry);
      const modelId = ownedFigures.get(itemMasterId);
      if (!Number.isInteger(itemMasterId) || modelId == null) throw new Error("deck_figure_not_owned");
      return { deck_index: deckIndex, item_master_id: itemMasterId, model_id: modelId };
    });
    if (new Set(normalizedFigures.map((entry) => entry.item_master_id)).size !== normalizedFigures.length) {
      throw new Error("deck_figure_duplicate");
    }

    const normalizedPlates = plates.map((entry) => Number(entry?.item_master_id ?? entry));
    if (normalizedPlates.some((plateId) => !Number.isInteger(plateId) || !this.plateCosts.has(plateId))) {
      throw new Error("deck_plate_master_missing");
    }
    const ownedPlates = new Map(this.database.prepare(`
      SELECT item_master_id, quantity FROM user_plates WHERE user_id = ?
    `).all(normalizedUserId).map((entry) => [Number(entry.item_master_id), Number(entry.quantity)]));
    const requestedCounts = new Map();
    for (const plateId of normalizedPlates) requestedCounts.set(plateId, Number(requestedCounts.get(plateId) ?? 0) + 1);
    for (const [plateId, quantity] of requestedCounts) {
      if (quantity > Number(ownedPlates.get(plateId) ?? 0)) throw new Error("deck_plate_not_owned");
    }
    const plateCost = normalizedPlates.reduce((total, plateId) => total + Number(this.plateCosts.get(plateId)), 0);
    const previousPlates = this.database.prepare(`
      SELECT item_master_id FROM user_deck_plates WHERE user_id = ? AND deck_no = ? ORDER BY deck_index
    `).all(normalizedUserId, deckNo).map((entry) => Number(entry.item_master_id));
    // A preserved Kaeru loadout can exceed the packaged editor's current
    // 8-cost limit (the captured starter fixture totals 9). Let an unchanged
    // legacy plate list survive a figure-only autosave, while enforcing the
    // recovered limit on every newly composed plate list.
    if (plateCost > MAXIMUM_DECK_PLATE_COST && JSON.stringify(normalizedPlates) !== JSON.stringify(previousPlates)) {
      throw new Error("deck_plate_cost_exceeded");
    }

    const normalizedName = String(name ?? deck.name).trim().slice(0, 40) || `Deck ${deckNo}`;
    withTransaction(this.database, () => {
      this.database.prepare("UPDATE user_decks SET name = ? WHERE user_id = ? AND deck_no = ?").run(normalizedName, normalizedUserId, deckNo);
      this.database.prepare("DELETE FROM user_deck_figures WHERE user_id = ? AND deck_no = ?").run(normalizedUserId, deckNo);
      this.database.prepare("DELETE FROM user_deck_plates WHERE user_id = ? AND deck_no = ?").run(normalizedUserId, deckNo);
      const insertFigure = this.database.prepare(`
        INSERT INTO user_deck_figures(user_id, deck_no, deck_index, item_master_id, model_id) VALUES (?, ?, ?, ?, ?)
      `);
      for (const figure of normalizedFigures) insertFigure.run(normalizedUserId, deckNo, figure.deck_index, figure.item_master_id, figure.model_id);
      const insertPlate = this.database.prepare(`
        INSERT INTO user_deck_plates(user_id, deck_no, deck_index, item_master_id) VALUES (?, ?, ?, ?)
      `);
      for (const [deckIndex, plateId] of normalizedPlates.entries()) insertPlate.run(normalizedUserId, deckNo, deckIndex, plateId);
      this.#recordEvent(normalizedUserId, "deck_updated", `deck:${deckNo}:${Number(this.now())}`, {
        deck_no: deckNo,
        figure_item_master_ids: normalizedFigures.map((entry) => entry.item_master_id),
        plate_item_master_ids: normalizedPlates,
        plate_cost: plateCost,
      }, Number(this.now()));
    });
    return this.deckSnapshot(normalizedUserId).find((entry) => entry.deck_no === deckNo);
  }

  expandDecks(userId) {
    const normalizedUserId = Number(userId);
    return withTransaction(this.database, () => {
      const count = Number(this.database.prepare("SELECT COUNT(*) AS value FROM user_decks WHERE user_id = ?").get(normalizedUserId)?.value ?? 0);
      if (count >= MAXIMUM_DECK_COUNT) throw new Error("deck_case_at_capacity");
      const user = this.database.prepare("SELECT gems FROM users WHERE id = ?").get(normalizedUserId);
      if (!user) throw new Error("account_not_found");
      if (Number(user.gems) < DECK_EXPANSION_GEM_COST) throw new Error("deck_expand_insufficient_gems");
      const deckNo = Number(this.database.prepare("SELECT COALESCE(MAX(deck_no), 0) + 1 AS value FROM user_decks WHERE user_id = ?").get(normalizedUserId).value);
      this.database.prepare("UPDATE users SET gems = gems - ?, updated_at = ? WHERE id = ?").run(DECK_EXPANSION_GEM_COST, Number(this.now()), normalizedUserId);
      this.database.prepare("INSERT INTO user_decks(user_id, deck_no, name) VALUES (?, ?, ?)").run(normalizedUserId, deckNo, `Deck ${deckNo}`);
      this.#recordEvent(normalizedUserId, "deck_expanded", `deck:${deckNo}`, {
        deck_no: deckNo,
        gem_cost: DECK_EXPANSION_GEM_COST,
      }, Number(this.now()));
      return {
        deck: this.deckSnapshot(normalizedUserId).find((entry) => entry.deck_no === deckNo),
        deck_count: count + 1,
        maximum_deck_count: MAXIMUM_DECK_COUNT,
        gems: Number(user.gems) - DECK_EXPANSION_GEM_COST,
      };
    });
  }

  battleDeck(userId, deckNo) {
    const deck = this.deckSnapshot(userId).find((entry) => entry.deck_no === Number(deckNo));
    if (!deck) throw new Error("deck_not_found");
    if (deck.figures.length !== MAXIMUM_DECK_FIGURES) throw new Error("battle_deck_requires_six_figures");
    if (deck.plates.length === 0 || deck.plates.length > MAXIMUM_DECK_PLATES) throw new Error("battle_deck_plates_invalid");
    return deck;
  }

  listChests(userId) {
    const now = Number(this.now());
    return this.database.prepare(`
      SELECT id, slot_index, state, reward_item_master_id, reward_model_id,
             unlock_started_at, ready_at, created_at, claimed_at, source, source_key
      FROM chests WHERE user_id = ? AND state != 'claimed' ORDER BY slot_index
    `).all(Number(userId)).map((row) => ({
      chest_id: Number(row.id),
      slot_index: Number(row.slot_index),
      state: row.state === "unlocking" && Number(row.ready_at) <= now ? "ready" : String(row.state),
      unlock_started_at: row.unlock_started_at == null ? null : Number(row.unlock_started_at),
      ready_at: row.ready_at == null ? null : Number(row.ready_at),
      remaining_milliseconds: row.ready_at == null ? null : Math.max(0, Number(row.ready_at) - now),
      source: String(row.source),
    }));
  }

  startChest(userId, chestId) {
    const now = Number(this.now());
    const readyAt = now + this.chestUnlockMilliseconds;
    const result = this.database.prepare(`
      UPDATE chests SET state = 'unlocking', unlock_started_at = ?, ready_at = ?
      WHERE id = ? AND user_id = ? AND state = 'locked'
    `).run(now, readyAt, Number(chestId), Number(userId));
    if (Number(result.changes) !== 1) throw new Error("chest_not_startable");
    this.#recordEvent(userId, "chest_unlock_started", `chest:${chestId}`, { chest_id: Number(chestId), ready_at: readyAt }, now);
    return this.listChests(userId).find((chest) => chest.chest_id === Number(chestId));
  }

  claimChest(userId, chestId) {
    const now = Number(this.now());
    return withTransaction(this.database, () => {
      const chest = this.database.prepare(`
        SELECT * FROM chests WHERE id = ? AND user_id = ?
      `).get(Number(chestId), Number(userId));
      if (!chest || chest.state !== "unlocking") throw new Error("chest_not_claimable");
      if (Number(chest.ready_at) > now) throw new Error("chest_not_ready");
      this.database.prepare(`
        INSERT INTO user_figures(user_id, item_master_id, model_id, level, source, source_chest_id, acquired_at)
        VALUES (?, ?, ?, 1, 'chest', ?, ?)
        ON CONFLICT(user_id, item_master_id) DO NOTHING
      `).run(Number(userId), Number(chest.reward_item_master_id), Number(chest.reward_model_id), Number(chest.id), now);
      this.database.prepare(`
        UPDATE chests SET state = 'claimed', claimed_at = ?, slot_index = NULL WHERE id = ?
      `).run(now, Number(chest.id));
      const reward = {
        chest_id: Number(chest.id),
        item_master_id: Number(chest.reward_item_master_id),
        model_id: Number(chest.reward_model_id),
        level: 1,
      };
      this.#recordEvent(userId, "chest_claimed", `chest:${chest.id}`, reward, now);
      return reward;
    });
  }

  createMatchChest(userId, matchId) {
    const existing = this.database.prepare(`
      SELECT id FROM chests WHERE user_id = ? AND source_key = ?
    `).get(Number(userId), `match:${matchId}`);
    if (existing) return { created: false, chest_id: Number(existing.id), reason: "already_awarded" };
    const occupied = new Set(this.database.prepare(`
      SELECT slot_index FROM chests WHERE user_id = ? AND state != 'claimed' AND slot_index IS NOT NULL
    `).all(Number(userId)).map((row) => Number(row.slot_index)));
    const slot = [0, 1, 2].find((candidate) => !occupied.has(candidate));
    if (slot == null) return { created: false, chest_id: null, reason: "slots_full" };
    const chest = withTransaction(this.database, () => this.#createChest(Number(userId), slot, "match", `match:${matchId}`, Number(this.now())));
    return { created: true, chest_id: chest.chest_id, slot_index: slot, state: "locked" };
  }

  inventoryEvents(userId) {
    return this.database.prepare(`
      SELECT id, event_type, source_key, payload_json, created_at
      FROM inventory_events WHERE user_id = ? ORDER BY id
    `).all(Number(userId)).map((row) => ({
      event_id: Number(row.id),
      event_type: String(row.event_type),
      source_key: row.source_key == null ? null : String(row.source_key),
      payload: JSON.parse(String(row.payload_json)),
      created_at: Number(row.created_at),
    }));
  }

  #seedStarterInventory(userId, now) {
    const insertDeck = this.database.prepare("INSERT INTO user_decks(user_id, deck_no, name) VALUES (?, ?, ?)");
    for (let deckNo = 1; deckNo <= INITIAL_DECK_COUNT; deckNo += 1) {
      insertDeck.run(userId, deckNo, deckNo === 1 ? "Starter Deck" : `Deck ${deckNo}`);
    }
    const insertFigure = this.database.prepare(`
      INSERT INTO user_figures(user_id, item_master_id, model_id, level, source, acquired_at)
      VALUES (?, ?, ?, ?, 'starter', ?)
    `);
    const insertDeckFigure = this.database.prepare(`
      INSERT INTO user_deck_figures(user_id, deck_no, deck_index, item_master_id, model_id)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const [index, figure] of this.starterFigures.entries()) {
      insertFigure.run(userId, figure.item_master_id, figure.model_id, figure.level, now);
      for (let deckNo = 1; deckNo <= INITIAL_DECK_COUNT; deckNo += 1) {
        insertDeckFigure.run(userId, deckNo, index, figure.item_master_id, figure.model_id);
      }
    }
    const counts = new Map();
    const insertPlate = this.database.prepare(`
      INSERT INTO user_plates(user_id, item_master_id, quantity, acquired_at)
      VALUES (?, ?, ?, ?)
    `);
    const insertDeckPlate = this.database.prepare(`
      INSERT INTO user_deck_plates(user_id, deck_no, deck_index, item_master_id)
      VALUES (?, ?, ?, ?)
    `);
    for (const [index, plateId] of this.starterPlateIds.entries()) {
      counts.set(plateId, Number(counts.get(plateId) ?? 0) + 1);
      for (let deckNo = 1; deckNo <= INITIAL_DECK_COUNT; deckNo += 1) insertDeckPlate.run(userId, deckNo, index, plateId);
    }
    for (const [plateId, quantity] of counts) insertPlate.run(userId, plateId, quantity, now);
    this.#recordEvent(userId, "account_seeded", `account:${userId}`, {
      starter_figure_item_master_ids: this.starterFigures.map((figure) => figure.item_master_id),
      starter_plate_item_master_ids: this.starterPlateIds,
    }, now);
  }

  #ensureInitialDecks() {
    const users = this.database.prepare("SELECT DISTINCT user_id FROM user_decks WHERE deck_no = 1 ORDER BY user_id").all();
    const insertDeck = this.database.prepare("INSERT OR IGNORE INTO user_decks(user_id, deck_no, name) VALUES (?, ?, ?)");
    const copyFigures = this.database.prepare(`
      INSERT OR IGNORE INTO user_deck_figures(user_id, deck_no, deck_index, item_master_id, model_id)
      SELECT user_id, ?, deck_index, item_master_id, model_id FROM user_deck_figures WHERE user_id = ? AND deck_no = 1
    `);
    const copyPlates = this.database.prepare(`
      INSERT OR IGNORE INTO user_deck_plates(user_id, deck_no, deck_index, item_master_id)
      SELECT user_id, ?, deck_index, item_master_id FROM user_deck_plates WHERE user_id = ? AND deck_no = 1
    `);
    withTransaction(this.database, () => {
      for (const row of users) {
        const userId = Number(row.user_id);
        for (let deckNo = 2; deckNo <= INITIAL_DECK_COUNT; deckNo += 1) {
          const inserted = insertDeck.run(userId, deckNo, `Deck ${deckNo}`);
          if (Number(inserted.changes) === 0) continue;
          copyFigures.run(deckNo, userId);
          copyPlates.run(deckNo, userId);
        }
      }
    });
  }

  #createChest(userId, slotIndex, source, sourceKey, now) {
    const owned = new Set(this.database.prepare("SELECT item_master_id FROM user_figures WHERE user_id = ?").all(userId).map((row) => Number(row.item_master_id)));
    const reserved = new Set(this.database.prepare("SELECT reward_item_master_id FROM chests WHERE user_id = ? AND state != 'claimed'").all(userId).map((row) => Number(row.reward_item_master_id)));
    const reward = this.rewardCatalog.find((entry) => !owned.has(entry.item_master_id) && !reserved.has(entry.item_master_id))
      ?? this.rewardCatalog.find((entry) => !owned.has(entry.item_master_id))
      ?? this.rewardCatalog[0];
    if (!reward) throw new Error("chest_reward_catalog_empty");
    const result = this.database.prepare(`
      INSERT INTO chests(user_id, slot_index, state, reward_item_master_id, reward_model_id, created_at, source, source_key)
      VALUES (?, ?, 'locked', ?, ?, ?, ?, ?)
    `).run(userId, slotIndex, reward.item_master_id, reward.model_id, now, source, sourceKey);
    const chestId = Number(result.lastInsertRowid);
    this.#recordEvent(userId, "chest_created", `chest:${chestId}`, {
      chest_id: chestId,
      slot_index: slotIndex,
      source,
      source_key: sourceKey,
    }, now);
    return { chest_id: chestId, slot_index: slotIndex, state: "locked" };
  }

  #recordEvent(userId, eventType, sourceKey, payload, createdAt) {
    this.database.prepare(`
      INSERT INTO inventory_events(user_id, event_type, source_key, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, event_type, source_key) DO NOTHING
    `).run(Number(userId), eventType, sourceKey, JSON.stringify(payload), Number(createdAt));
  }

  #purgeExpired({ force = false } = {}) {
    const clock = Number(this.monotonicNow());
    if (!Number.isFinite(clock) || clock < 0) throw new Error("cleanup_clock_invalid");
    const stamp = Math.max(this.#lastCleanupClock, clock);
    this.#lastCleanupClock = stamp;
    if (!force && stamp < this.#nextExpiredCleanupAt) return;
    const now = Number(this.now());
    this.database.prepare("DELETE FROM browser_sessions WHERE expires_at <= ?").run(now);
    this.database.prepare("DELETE FROM game_sessions WHERE expires_at <= ?").run(now);
    this.database.prepare("DELETE FROM anonymous_browser_sessions WHERE expires_at <= ?").run(now);
    this.database.prepare("DELETE FROM device_link_requests WHERE expires_at <= ?").run(now);
    this.database.prepare(`
      DELETE FROM device_links WHERE user_id IS NULL AND (link_expires_at <= ? OR link_expires_at IS NULL) AND NOT EXISTS
        (SELECT 1 FROM device_link_requests WHERE device_link_requests.device_hash = device_links.device_hash)
    `).run(now);
    // Expiry is checked by every credential read independently of deletion.
    // Do not cache authentication outcomes: synchronous revocation remains
    // visible to the very next command/outbound notification.
    this.#nextExpiredCleanupAt = stamp + this.cleanupIntervalMilliseconds;
  }
}

export const accountStoreContract = Object.freeze({
  passwordMinimum: PASSWORD_MINIMUM,
  passwordMaximum: PASSWORD_MAXIMUM,
  starterSlotCount: 4,
  initialDeckCount: INITIAL_DECK_COUNT,
  maximumDeckCount: MAXIMUM_DECK_COUNT,
  deckExpansionGemCost: DECK_EXPANSION_GEM_COST,
  maximumDeckFigures: MAXIMUM_DECK_FIGURES,
  maximumDeckPlates: MAXIMUM_DECK_PLATES,
  maximumDeckPlateCost: MAXIMUM_DECK_PLATE_COST,
  maximumPendingDeviceLinks: MAXIMUM_PENDING_DEVICE_LINKS,
  maximumPendingDevices: MAXIMUM_PENDING_DEVICES,
  expiredCleanupMilliseconds: EXPIRED_CLEANUP_MILLISECONDS,
});
