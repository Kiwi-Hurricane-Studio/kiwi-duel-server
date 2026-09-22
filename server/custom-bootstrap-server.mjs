import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AccountStore } from "./account-store.mjs";
import { createAccountSite } from "./account-site.mjs";
import { CustomMatchService, customMatchContract } from "./custom-match-engine.mjs";
import { HumanMatchService, humanMatchResult } from "./human-match-service.mjs";
import { attachBattleWebSocket, BATTLE_SOCKET_PATH } from "./battle-websocket.mjs";
import { createIpRateLimiter } from "./ip-rate-limiter.mjs";
import { createBootstrapReadiness, requestedReadinessSchema, ROOM_CONTRACT_VERSION, OWNED_CONTENT_REVISION } from "./bootstrap-readiness.mjs";
import { createContentReleaseHandler } from "./content-release-store.mjs";

const host = process.env.DUEL_SERVER_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.DUEL_SERVER_PORT || "8080", 10);
const publicBase = (process.env.DUEL_SERVER_PUBLIC_BASE || `http://${host}:${port}`).replace(/\/$/, "");
const gameHost = process.env.DUEL_GAME_SERVER_HOST || host;
const gamePort = Number.parseInt(process.env.DUEL_GAME_SERVER_PORT || String(port + 1), 10);
const gamePublicHost = process.env.DUEL_GAME_SERVER_PUBLIC_HOST || new URL(publicBase).hostname;
const gameMoveDelayMs = Number.parseInt(process.env.DUEL_GAME_MOVE_DELAY_MS || "250", 10);
const gameOpponentTurnDelayMs = Number.parseInt(process.env.DUEL_GAME_OPPONENT_DELAY_MS || "2500", 10);
const gameOpponentPlateContinuationDelayMs = Number.parseInt(
  process.env.DUEL_GAME_OPPONENT_PLATE_CONTINUATION_DELAY_MS || String(gameMoveDelayMs),
  10,
);
const gameOpponentPlateMode = process.env.DUEL_GAME_OPPONENT_PLATE_MODE || "off";
const gameBattleEvidenceMode = process.env.DUEL_GAME_BATTLE_EVIDENCE_MODE || "off";
const accountDatabasePath = resolve(process.env.DUEL_ACCOUNT_DATABASE || fileURLToPath(new URL("./runtime/kiwi-duel.sqlite", import.meta.url)));
const chestUnlockMilliseconds = Number.parseInt(process.env.DUEL_CHEST_UNLOCK_MS || "3000", 10);
const production = process.env.NODE_ENV === "production";
const trustedProxyAddresses = (process.env.DUEL_TRUSTED_PROXY_ADDRESSES || "").split(",").filter(Boolean);
const loginRateLimiter = createIpRateLimiter({ trustedProxyAddresses });
const defaultMatchMode = process.env.DUEL_DEFAULT_MATCH_MODE || "human";
const contentRoot = process.env.DUEL_CONTENT_ROOT || "";
const handleContentRelease = await createContentReleaseHandler({ root: contentRoot });
if (!["human", "training"].includes(defaultMatchMode)) throw new Error("invalid_default_match_mode");
if (production) {
  const publicUrl = new URL(publicBase);
  if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== "/") {
    throw new Error("production_requires_https_public_origin");
  }
  if (!["127.0.0.1", "::1"].includes(gameHost)) throw new Error("production_raw_game_port_must_be_loopback");
  if (process.env.DUEL_SEED_ACCOUNTS_PATH) throw new Error("production_seed_accounts_forbidden");
}

const plateContract = JSON.parse(readFileSync(fileURLToPath(new URL("../data/reference_match_plate_contract.json", import.meta.url)), "utf8"));
const figureMasterDocument = JSON.parse(readFileSync(fileURLToPath(new URL("../data/figure_master_map.json", import.meta.url)), "utf8"));
const figureCatalogDocument = JSON.parse(readFileSync(fileURLToPath(new URL("../data/figure_catalog.json", import.meta.url)), "utf8"));
// Room preload is the presentation authority for every plate a persisted deck
// may carry, not only the handful present in the preserved reference match.
// Filtering this list to matchPlateIds made custom/account-specific decks lose
// their names, descriptions, type icons, cost, and rarity in PlateThumbnailM/L.
// Keep the match service's equipped-plate filtering at the consumer boundary,
// while exposing the complete recovered PlateMaster catalog to the client.
const matchPlateMasters = (plateContract.plate_masters || []).map((value) => ({ ...value }));
const starterModelIds = [60, 114, 161, 162, 78, 132];
const starterFigures = starterModelIds.map((modelId) => {
  const entry = Object.values(figureMasterDocument.figures || {}).find((candidate) => Number(candidate.model_id) === modelId);
  if (!entry) throw new Error(`starter_figure_master_missing_${modelId}`);
  return { item_master_id: Number(entry.item_master_id), model_id: modelId, level: 1 };
});
const availableModelIds = new Set(Object.keys(figureCatalogDocument.figures || {}).map(Number));
const bootstrapReadiness = createBootstrapReadiness({
  figureMasters: Object.values(figureMasterDocument.figures || {}),
  renderModelIds: availableModelIds,
  plateMasters: matchPlateMasters,
});
const rewardCatalog = Object.values(figureMasterDocument.figures || {}).filter((entry) => availableModelIds.has(Number(entry.model_id)));
const accountStore = new AccountStore({
  databasePath: accountDatabasePath,
  chestUnlockMilliseconds,
  starterFigures,
  starterPlateIds: customMatchContract.plateIds,
  plateMasters: matchPlateMasters,
  rewardCatalog,
});

const seedAccountsPath = process.env.DUEL_SEED_ACCOUNTS_PATH ? resolve(process.env.DUEL_SEED_ACCOUNTS_PATH) : "";
if (seedAccountsPath) {
  const seedDocument = JSON.parse(readFileSync(seedAccountsPath, "utf8"));
  for (const account of seedDocument.accounts || []) accountStore.seedAccount(account);
}
const trainingService = new CustomMatchService({
  authenticateSession: (session) => accountStore.authenticateGameToken(session),
  bindHost: gameHost,
  publicHost: gamePublicHost,
  port: gamePort,
  moveDelayMs: gameMoveDelayMs,
  opponentTurnDelayMs: gameOpponentTurnDelayMs,
  opponentPlateContinuationDelayMs: gameOpponentPlateContinuationDelayMs,
  opponentPlateMode: gameOpponentPlateMode,
  battleEvidenceMode: gameBattleEvidenceMode,
  plateMasters: matchPlateMasters,
});
const matchService = new HumanMatchService({
  authenticateSession: (session) => accountStore.authenticateGameToken(session),
  bindHost: gameHost, publicHost: gamePublicHost, port: gamePort,
  moveDelayMs: gameMoveDelayMs, plateMasters: matchPlateMasters, trainingService,
  loadDeck: (userId, deckNo) => accountStore.battleDeck(userId, deckNo),
  onMatchFinished: (completion) => accountStore.recordMatchCompletion(completion),
});
// Only explicit training requests select a bot. Normal entry waits for another
// authenticated account; it cannot quietly manufacture a human-looking rival.
const selectedMatchModes = new Map();
function serviceFor(user) {
  return selectedMatchModes.get(user.user_id) === "training" ? trainingService : matchService;
}
function withGameTransport(status) {
  if (status?.online_match?.game_server) {
    status.online_match.game_server.websocket_path = BATTLE_SOCKET_PATH;
  }
  return status;
}

const bootstrapDocument = Buffer.from(JSON.stringify({
  schema: 1,
  content_revision: OWNED_CONTENT_REVISION,
  capabilities: ["bootstrap", "content-digest", "profile-switching", "accounts", "device-link", "persistent-inventory", "persistent-decks", "chests"],
}), "utf8");
const bootstrapDigest = createHash("sha256").update(bootstrapDocument).digest("hex");

const roomPreloadTemplate = {
  schema: 1,
  steps: Object.fromEntries([
    "FigureList",
    "UserLibrariesByEvoIdLoad",
    "PlateList",
    "DeckList",
    "TicketList",
    "LoadChapterMasters",
    "UpdateCampaign",
    "RefreshUserArena",
    "RefreshUserArenaEvent",
    "LoadArenaLeagueDetail",
    "LoadArenaRewardBoxRouletteMasters",
    "GetSwissDrawAndKnockoutStageTheFirstLoading",
    "LoadUserTutorials",
    "PreloadUsedScSeAndBootAndAdvSe",
  ].map((name) => [name, true])),
  models: {
    figures: [],
    figure_libraries: [],
    plates: matchPlateMasters.map((value) => ({ ...value })),
    plate_inventory: [],
    decks: [],
    tickets: [],
    chapters: [],
    arena_leagues: [],
    arena_rewards: {},
    user_arena: { beginner: true, active_events: [], chests: [] },
    tutorials: [],
  },
};

function accountRoomPreload(userId, readinessSchema = 1) {
  const snapshot = accountStore.accountSnapshot(userId);
  if (!snapshot) throw new Error("account_not_found");
  const room = structuredClone(roomPreloadTemplate);
  room.models.figures = snapshot.figures.map((figure) => ({ ...figure }));
  room.models.figure_libraries = snapshot.figures.map((figure) => ({
    user_figure_id: figure.user_figure_id,
    item_master_id: figure.item_master_id,
    model_id: figure.model_id,
    level: figure.level,
  }));
  room.models.plate_inventory = snapshot.plates.map((plate) => ({ ...plate }));
  room.models.decks = snapshot.decks.map((deck) => ({
    deck_no: deck.deck_no,
    name: deck.name,
    figures: deck.figures.map((figure) => ({ ...figure })),
    plates: [...deck.plates],
  }));
  room.models.user_arena.chests = snapshot.chests;
  // Deployed v1 clients retain their exact predecessor payload. Negotiated v2
  // does not inherit its all-true markers or invented progression/history.
  return readinessSchema === ROOM_CONTRACT_VERSION ? bootstrapReadiness.roomPreload(room.models, { ownerUserId: Number(userId) }) : room;
}

function figureBootstrap(userId) {
  return accountStore.accountSnapshot(userId).figures.map((figure) => {
    const master = figureMasterDocument.figures?.[String(figure.item_master_id)] || {};
    return {
      figure_master_id: figure.item_master_id,
      item_master_id: figure.item_master_id,
      model_id: figure.model_id,
      figure_no: Number(master.figure_no ?? -1),
      poke_no: Number(master.poke_no ?? -1),
      movement_points: Number(master.mp ?? 0),
      playable: true,
    };
  });
}

function sendJson(response, status, body) {
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": bytes.length,
    "Cache-Control": "no-store",
  });
  response.end(bytes);
}

function getBearer(request) {
  const header = request.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function requiresSession(pathname) {
  return !new Set([
    "/healthz",
    "/v1/bootstrap/service-state",
    "/v1/bootstrap/revisions",
    "/v1/session/login",
  ]).has(pathname);
}

function authenticatedUser(request) {
  return accountStore.authenticateGameToken(getBearer(request));
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 1024 * 1024) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  if (length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("json_object_required");
  return parsed;
}

const routes = new Map([
  ["/v1/bootstrap/service-state", () => ({ available: true, maintenance: false })],
  ["/v1/bootstrap/revisions", () => ({ schema: 2, content: OWNED_CONTENT_REVISION, figures: 2, localization: 1,
    room_contract: ROOM_CONTRACT_VERSION, master_binding: structuredClone(bootstrapReadiness.masterBinding) })],
  ["/v1/bootstrap/localization", () => ({ locale: "en", strings: { loading: "Loading", play: "Play" } })],
  ["/v1/bootstrap/assets", () => ([{
    id: "server-bootstrap",
    url: `${publicBase}/content/bootstrap.json`,
    digest: bootstrapDigest,
    bytes: bootstrapDocument.length,
    boot_required: true,
  }])],
  ["/v1/bootstrap/figures", (body, _request, user) => requestedReadinessSchema(body) === ROOM_CONTRACT_VERSION
    ? bootstrapReadiness.figureCatalog() : figureBootstrap(user.user_id)],
  ["/v1/user/device-settings", () => ({ sound: true, music: true, language: "en" })],
  ["/v1/bootstrap/multiple", () => ({ capabilities: ["home", "decks", "shop", "chests"], revision: 2 })],
  ["/v1/bootstrap/room", (body, _request, user) => accountRoomPreload(user.user_id, requestedReadinessSchema(body))],
  ["/v1/user/balances", (_body, _request, user) => user.balances],
  ["/v1/user/info", (_body, request, user) => {
    const info = serviceFor(user).userInfo(getBearer(request), user);
    if (info.private?.matching_status) withGameTransport(info.private.matching_status);
    return info;
  }],
  ["/v1/account/me", (_body, _request, user) => accountStore.accountSnapshot(user.user_id)],
  ["/v1/matches/list", (_body, _request, user) => accountStore.recentMatchCompletions(user.user_id)],
  ["/v1/matches/get", (body, _request, user) => {
    const completion = accountStore.matchCompletion(user.user_id, body.matchId);
    if (!completion) throw new Error("match_result_unavailable");
    return completion;
  }],
  ["/v1/decks/list", (_body, _request, user) => ({
    decks: accountStore.deckSnapshot(user.user_id),
    maximum_deck_count: 12,
    expansion_gem_cost: 5,
    maximum_plate_cost: 8,
  })],
  ["/v1/decks/update", (body, _request, user) => accountStore.updateDeck(user.user_id, body)],
  ["/v1/decks/expand", (_body, _request, user) => accountStore.expandDecks(user.user_id)],
  ["/v1/chests/list", (_body, _request, user) => ({ chests: accountStore.listChests(user.user_id) })],
  ["/v1/chests/start", (body, _request, user) => accountStore.startChest(user.user_id, Number(body.chest_id))],
  ["/v1/chests/claim", (body, _request, user) => accountStore.claimChest(user.user_id, Number(body.chest_id))],
  ["/v1/home/figure-lots", () => []],
  ["/v1/home/arena", (_body, _request, user) => ({
    arena_league_master_id: 101,
    is_beginner: true,
    win_star: 0,
    chest_slot_count: 3,
    chests: accountStore.listChests(user.user_id),
  })],
  ["/v1/home/banners", () => ([{
    banner_type: 3,
    ranking: { ranking_type: 0, master_id: 90005, rank: 0, rate: 0 },
  }])],
  ["/v1/home/check-reboot", () => false],
  ["/v1/home/missions", () => []],
  ["/v1/home/messages", () => []],
  ["/v1/home/daily-missions", () => ({ daily_missions: [], status: { special_mission_count: 0 } })],
  ["/v1/home/admin-messages", () => []],
  ["/v1/matching/entry", (body, request, user) => {
    const deckNo = Number(body.deckNo);
    if (!Number.isInteger(deckNo) || deckNo < 0 || deckNo >= 12 || Number(body.alterEntryFeeItemMasterId) !== 0 || body.arenaEventMasterId !== "") {
      throw new Error("matching_entry_contract_invalid");
    }
    const mode = body.mode ?? defaultMatchMode;
    if (!["human", "training"].includes(mode)) throw new Error("invalid_match_mode");
    const previousMode = selectedMatchModes.get(user.user_id);
    if (previousMode && previousMode !== mode) throw new Error("reset_match_before_changing_mode");
    const result = serviceForMode(mode).enter(getBearer(request), user, accountStore.battleDeck(user.user_id, deckNo + 1));
    selectedMatchModes.set(user.user_id, mode);
    return withGameTransport(result);
  }],
  ["/v1/matching/poll", (_body, request, user) => withGameTransport(serviceFor(user).poll(getBearer(request), user))],
  ["/v1/matching/cancel", (_body, request, user) => {
    const canceled = serviceFor(user).cancel(getBearer(request), user);
    if (canceled) selectedMatchModes.delete(user.user_id);
    return { canceled };
  }],
  ["/v1/matching/reset-active", (_body, request, user) => {
    const result = serviceFor(user).reset(getBearer(request), user);
    selectedMatchModes.delete(user.user_id);
    return result;
  }],
  ["/v1/matching/result", (body, request, user) => {
    let result;
    try {
      result = serviceFor(user).result(getBearer(request), body.matchId, user);
    } catch (error) {
      if (error.message !== "match_result_unavailable") throw error;
      const completion = accountStore.matchCompletion(user.user_id, body.matchId);
      if (!completion) throw error;
      result = humanMatchResult(completion, user.user_id, Number(user.rate ?? user.rating ?? user.public?.rate ?? 1000));
    }
    const chest = accountStore.createMatchChest(user.user_id, body.matchId);
    result.user_arena_rewards = chest.created ? [{
      user_arena_reward_id: chest.chest_id,
      slot_index: chest.slot_index,
      reward_type: "time_chest",
      state: chest.state,
    }] : [];
    result.chest_award = chest;
    return result;
  }],
  ["/v1/battle/challenge", (_body, request, user) => serviceFor(user).issueTicket(getBearer(request), user)],
]);

function serviceForMode(mode) { return mode === "training" ? trainingService : matchService; }

const accountSite = createAccountSite({
  store: accountStore,
  publicBase,
  production,
  trustedProxyAddresses,
  iconPath: fileURLToPath(new URL("../assets/branding/kiwi_duel_mew_icon.png", import.meta.url)),
});

async function handleHttpRequest(request, response) {
  let url;
  try {
    url = new URL(request.url || "/", publicBase);
  } catch {
    sendJson(response, 400, { ok: false, error: "invalid_request_target" });
    return;
  }
  const pathname = url.pathname;
  console.log(`${new Date().toISOString()} ${request.method} ${pathname}`);
  const startedAt = performance.now();
  response.once("finish", () => console.log(JSON.stringify({
    schema: "kiwi-duel-http-result-1", method: request.method, path: pathname,
    status: response.statusCode, elapsed_ms: Math.round(performance.now() - startedAt),
  })));

  if (await accountSite(request, response, url)) return;
  if (await handleContentRelease(request, response, url)) return;

  if (request.method === "GET" && pathname === "/healthz") {
    sendJson(response, 200, { ok: true, data: {
      service: "kiwi-duel-owned",
      protocol: 2,
      game_port: gamePort,
      accounts: true,
      persistent_inventory: true,
      persistent_decks: true,
      chests: true,
      human_matchmaking: true,
      battle_websocket: BATTLE_SOCKET_PATH,
      content_updates: Boolean(contentRoot),
    } });
    return;
  }
  const user = requiresSession(pathname) ? authenticatedUser(request) : null;
  if (requiresSession(pathname) && !user) {
    sendJson(response, 401, { ok: false, error: "unauthorized" });
    return;
  }
  if (request.method === "GET" && pathname === "/content/bootstrap.json") {
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": bootstrapDocument.length,
      "ETag": `"${bootstrapDigest}"`,
    });
    response.end(bootstrapDocument);
    return;
  }
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: "method_not_allowed" });
    return;
  }

  try {
    if (pathname === "/v1/session/login") {
      const allowance = loginRateLimiter.consume(request);
      if (!allowance.allowed) {
        // Reject before buffering/parsing the body or allocating durable device
        // state. Reverse proxies must overwrite a single trusted forwarded IP.
        response.setHeader("Retry-After", String(allowance.retry_after_seconds));
        sendJson(response, 429, { ok: false, error: "login_rate_limited" });
        request.resume();
        return;
      }
    }
    const body = await readJson(request);
    if (pathname === "/v1/session/login") {
      const login = accountStore.beginDeviceLogin(body.device_token);
      if (!login.linked) {
        sendJson(response, 200, {
          ok: false,
          error: "account_link_required",
          link_required: true,
          link_url: `${publicBase}/account/link?code=${encodeURIComponent(login.link_code)}`,
          message: "This Kiwi Duel install is not linked to an account. Open the website to sign in.",
          expires_at: login.expires_at,
          link_verification_code: login.verification_code,
        });
        return;
      }
      sendJson(response, 200, { ok: true, data: {
        access_token: login.access_token,
        expires_at: login.expires_at,
        user: login.user,
      } });
      return;
    }
    const handler = routes.get(pathname);
    if (!handler) {
      sendJson(response, 404, { ok: false, error: "route_not_found" });
      return;
    }
    sendJson(response, 200, { ok: true, data: handler(body, request, user) });
  } catch (error) {
    const capacityLimited = ["device_link_request_limit", "pending_device_capacity_reached"].includes(error.message);
    if (capacityLimited) response.setHeader("Retry-After", String(Math.max(1, Math.ceil(Number(error.retryAfterSeconds) || 600))));
    sendJson(response, capacityLimited ? 429 : error.message === "request_too_large" ? 413 : 400, { ok: false, error: error.message || "bad_request" });
  }
}

const server = createHttpServer((request, response) => {
  // Node's HTTP server does not catch rejected async handlers. URL/site/session
  // failures must not become unhandled rejections that terminate all matches.
  void handleHttpRequest(request, response).catch(() => {
    console.error(JSON.stringify({ schema: "kiwi-duel-http-error-1", error: "request_handler_failed" }));
    if (!response.headersSent) sendJson(response, 500, { ok: false, error: "internal_server_error" });
    else response.destroy();
  });
});

server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;
server.maxRequestsPerSocket = 1000;
server.maxConnections = 2000;
const battleWebSocket = attachBattleWebSocket({ server, service: matchService, publicBase,
  authenticate: (session) => accountStore.authenticateGameToken(session) });

await matchService.listen();
trainingService.port = matchService.port;
console.log(`Pokemon Duel custom game server listening at ${gamePublicHost}:${gamePort} (opponent plate mode: ${gameOpponentPlateMode}; battle evidence mode: ${gameBattleEvidenceMode})`);
server.listen(port, host, () => console.log(`Pokemon Duel custom bootstrap server listening at ${publicBase}`));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close();
    Promise.all([battleWebSocket.close(), matchService.close()]).finally(() => {
      accountStore.close();
      process.exit(0);
    });
  });
}
