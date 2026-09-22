import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const recordDigest = (record) => createHash("sha256").update(JSON.stringify(record)).digest("hex");

async function until(predicate, description, milliseconds = 5000) {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`);
    await delay(5);
  }
}

async function freePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolveClose) => listener.close(resolveClose));
  return port;
}

async function startServer({ httpPort, gamePort, databasePath }) {
  const base = `http://127.0.0.1:${httpPort}`;
  const child = spawn(process.execPath, [fileURLToPath(new URL("./custom-bootstrap-server.mjs", import.meta.url))], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      DUEL_SERVER_HOST: "127.0.0.1", DUEL_SERVER_PORT: String(httpPort), DUEL_SERVER_PUBLIC_BASE: base,
      DUEL_GAME_SERVER_HOST: "127.0.0.1", DUEL_GAME_SERVER_PORT: String(gamePort), DUEL_GAME_SERVER_PUBLIC_HOST: "127.0.0.1",
      DUEL_ACCOUNT_DATABASE: databasePath, DUEL_SEED_ACCOUNTS_PATH: "", DUEL_DEFAULT_MATCH_MODE: "human",
      DUEL_GAME_MOVE_DELAY_MS: "1", DUEL_GAME_OPPONENT_PLATE_MODE: "off", DUEL_GAME_BATTLE_EVIDENCE_MODE: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const server = { child, base, output: "", startupError: null };
  child.on("error", (error) => { server.startupError = error.code ?? "child_start_failed"; });
  // Keep bounded diagnostic output private. No bearer, ticket, password, browser
  // cookie or device token is emitted in test diagnostics, including failures.
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
    server.output = (server.output + chunk.toString()).slice(-256 * 1024);
  });
  try {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (server.startupError || child.exitCode != null) throw new Error("isolated_bootstrap_start_failed");
      try {
        const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(500) });
        const health = await response.json();
        if (health.ok && health.data.human_matchmaking && health.data.game_port === gamePort) return server;
      } catch {}
      await delay(20);
    }
    throw new Error("isolated_bootstrap_start_timeout");
  } catch (error) {
    await stopServer(server);
    throw error;
  }
}

async function stopServer(server) {
  if (server.child.exitCode != null || server.child.signalCode != null) return;
  const exited = once(server.child, "exit");
  server.child.kill("SIGTERM");
  let timer;
  await Promise.race([exited, new Promise((resolveTimeout) => {
    timer = setTimeout(resolveTimeout, 2000);
  })]);
  clearTimeout(timer);
  if (server.child.exitCode == null && server.child.signalCode == null) {
    server.child.kill("SIGKILL");
    await exited;
  }
}

async function post(base, path, body = {}, token = "") {
  const response = await fetch(`${base}${path}`, {
    method: "POST", signal: AbortSignal.timeout(5000),
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function api(base, path, body = {}, token = "") {
  const response = await post(base, path, body, token);
  assert.equal(response.status, 200, `${path} status`);
  assert.equal(response.body.ok, true, `${path} error: ${response.body.error ?? "none"}`);
  return response.body.data;
}

function browserAt(base) {
  const cookies = new Map();
  return { async request(path, form = null) {
    const response = await fetch(new URL(path, base), {
      method: form == null ? "GET" : "POST", redirect: "manual", signal: AbortSignal.timeout(5000),
      headers: {
        Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
        ...(form == null ? {} : { "Content-Type": "application/x-www-form-urlencoded", Origin: base }),
      },
      body: form == null ? undefined : new URLSearchParams(form),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [name, value] = cookie.split(";", 1)[0].split("=");
      if (cookie.includes("Max-Age=0")) cookies.delete(name); else cookies.set(name, value);
    }
    const html = await response.text();
    return { status: response.status, location: response.headers.get("location"),
      csrf: /name="csrf" value="([^"]+)"/u.exec(html)?.[1] ?? "", html };
  } };
}

async function signupLinkedPlayer(base, ordinal, secrets) {
  const device = `isolated-human-device-${randomUUID()}`;
  const password = `isolated-human-password-${randomUUID()}`;
  secrets.add(device); secrets.add(password);
  const unlinked = await post(base, "/v1/session/login", { device_token: device });
  assert.equal(unlinked.body.link_required, true);
  const link = new URL(unlinked.body.link_url);
  const code = link.searchParams.get("code");
  assert.ok(code, "new installation receives explicit link challenge");
  secrets.add(code);
  const browser = browserAt(base);
  const page = await browser.request(link);
  const signedUp = await browser.request("/account/signup", {
    email: `human-${ordinal}@example.test`, display_name: `Human_${ordinal}`,
    password, csrf: page.csrf, link_code: code,
  });
  assert.equal(signedUp.status, 303);
  const beforeConfirmation = await post(base, "/v1/session/login", { device_token: device });
  assert.equal(beforeConfirmation.body.link_required, true, "signup alone cannot link a device");
  // beginDeviceLogin may renew the same challenge; explicitly follow the most
  // recent one, exactly as another first-boot login attempt would require.
  const currentLink = new URL(beforeConfirmation.body.link_url);
  const currentCode = currentLink.searchParams.get("code");
  secrets.add(currentCode);
  const confirmation = await browser.request(currentLink);
  assert.match(confirmation.html, /Confirm your game/u);
  assert.equal((await browser.request("/account/link", {
    csrf: confirmation.csrf, link_code: currentCode, confirm_link: "yes", device_name: `Isolated player ${ordinal}`,
  })).status, 303);
  const login = await api(base, "/v1/session/login", { device_token: device });
  secrets.add(login.access_token);
  assert.ok(Number.isSafeInteger(login.user.user_id));
  return { device, token: login.access_token, user: login.user, browser };
}

class BattlePeer {
  constructor(socket) {
    this.socket = socket;
    this.lines = [];
    this.buffer = "";
    this.record = null;
    this.sendIndex = -1;
    this.recvIndex = -1;
    this.parseError = null;
    socket.on("error", () => {});
    socket.on("message", (data) => {
      try {
        this.buffer += data.toString();
        while (this.buffer.includes("\n")) {
          const end = this.buffer.indexOf("\n");
          let line = this.buffer.slice(0, end);
          this.buffer = this.buffer.slice(end + 1);
          this.lines.push(line);
          const envelope = line.match(/^sequence (\d+) (-?\d+) (.*)$/u);
          if (envelope) {
            assert.equal(Number(envelope[1]), this.recvIndex + 1, "server sequence is contiguous for this side");
            this.recvIndex = Number(envelope[1]);
            line = envelope[3];
          }
          if (line.startsWith("playgame ")) {
            this.snapshot = JSON.parse(line.slice(9));
            this.record = this.snapshot.Record;
            this.sendIndex = this.snapshot.ServerRecvIndex;
            this.recvIndex = this.snapshot.ClientRecvIndex;
            this.acceptPlateState(this.snapshot.PlateState);
          } else if (line.startsWith("do_move ")) {
            assert.ok(this.record, "initial record must precede system/opponent moves");
            this.record.all_moves.push(JSON.parse(line.slice(8)));
          } else if (line.startsWith("plate_state ")) {
            assert.ok(envelope, "plate state uses authenticated sequenced delivery");
            this.acceptPlateState(JSON.parse(line.slice(12)));
          } else if (line.startsWith("match_finish ")) {
            const [, winner, reason] = line.split(" ");
            this.result = { winner, reason };
          }
        }
      } catch (error) { this.parseError = error; }
    });
  }

  acceptPlateState(snapshot) {
    assert.equal(snapshot.schema, 1);
    assert.equal(snapshot.match_id, String(this.record.id));
    assert.equal(snapshot.record_move_count, this.record.all_moves.length);
    assert.deepEqual(snapshot.equipped, ["black", "white"].map((color) => ({ color, plates: this.record.players.find((entry) => entry.color === color).plates })));
    this.plateState = snapshot;
  }

  static async open(base, player, ticket, clients, loginUserId = player.user.user_id) {
    const socket = new WebSocket(base.replace("http:", "ws:") + "/v1/battle/socket", {
      headers: { Authorization: `Bearer ${player.token}` },
    });
    const peer = new BattlePeer(socket);
    clients.add(peer);
    await once(socket, "open");
    socket.send(`@login ${loginUserId} ${ticket}\n`);
    await until(() => peer.lines.some((line) => line.startsWith("@login ")), "WebSocket ticket response");
    return peer;
  }

  play() { this.socket.send("playgame custom.2 evidence-base.1\n"); }

  move(side, value) {
    const move = { display_info: "move", selective_side: side, value };
    this.record.all_moves.push(structuredClone(move));
    this.sendIndex += 1;
    this.socket.send(`sequence ${this.sendIndex} ${this.recvIndex} do_move ${JSON.stringify(move)}\n`);
  }

  assertHealthy() {
    if (this.parseError) throw this.parseError;
    assert.equal(this.lines.some((line) => line.startsWith("move_rejected ")), false, "scripted legal route is accepted");
  }

  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = once(this.socket, "close");
    this.socket.terminate();
    await closed;
  }
}

async function rejectedUpgrade(base) {
  const socket = new WebSocket(base.replace("http:", "ws:") + "/v1/battle/socket");
  socket.on("error", () => {});
  return new Promise((resolveStatus, reject) => {
    socket.on("open", () => { socket.terminate(); reject(new Error("unauthenticated_websocket_accepted")); });
    socket.on("unexpected-response", (_request, response) => {
      response.resume(); socket.terminate(); resolveStatus(response.statusCode);
    });
  });
}

async function rawTicketResponse(port, userId, ticket) {
  const socket = connect({ host: "127.0.0.1", port });
  socket.on("error", () => {});
  let received = "";
  socket.on("data", (chunk) => { received += chunk.toString(); });
  try {
    await once(socket, "connect");
    socket.write(`@login ${userId} ${ticket}\n`);
    await until(() => received.includes("\n"), "raw TCP revocation response");
    return received.split("\n", 1)[0];
  } finally { socket.destroy(); }
}

test("real HTTP signup/link, two-human WebSocket goal match, reconnect and durable isolated results", { timeout: 30000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "kiwi-duel-human-http-"));
  const databasePath = join(directory, "isolated-accounts.sqlite");
  const clients = new Set();
  const secrets = new Set();
  let server;
  try {
    const httpPort = await freePort();
    let gamePort = await freePort();
    while (gamePort === httpPort) gamePort = await freePort();
    server = await startServer({ httpPort, gamePort, databasePath });
    const players = [];
    for (let ordinal = 1; ordinal <= 3; ordinal += 1) players.push(await signupLinkedPlayer(server.base, ordinal, secrets));
    assert.equal(new Set(players.map((player) => player.user.user_id)).size, 3);
    const [first, second, outsider] = players;
    assert.equal(await rejectedUpgrade(server.base), 401);
    assert.equal((await post(server.base, "/v1/battle/challenge", {}, outsider.token)).body.ok, false);

    const secondRoom = await api(server.base, "/v1/bootstrap/room", {}, second.token);
    const editedDeck = await api(server.base, "/v1/decks/update", {
      deck_no: 2, name: "Second human actual deck", figures: [...secondRoom.models.decks[1].figures].reverse(),
      plates: secondRoom.models.decks[1].plates,
    }, second.token);
    const entryBody = { deckNo: 0, arenaEventMasterId: "", alterEntryFeeItemMasterId: 0 };
    assert.equal((await api(server.base, "/v1/matching/poll", {}, first.token)).status, 99);
    const waiting = await api(server.base, "/v1/matching/entry", entryBody, first.token);
    assert.equal(waiting.status, 1);
    assert.equal(waiting.online_match, null);
    assert.equal((await api(server.base, "/v1/matching/poll", {}, first.token)).status, 1);
    assert.equal((await api(server.base, "/v1/matching/entry", entryBody, first.token)).room_id, waiting.room_id,
      "same account cannot become its own opponent");
    const found = await api(server.base, "/v1/matching/entry", { ...entryBody, deckNo: 1 }, second.token);
    const matchId = found.online_match.online_match_id;
    assert.equal(found.status, 3);
    assert.equal(found.online_match.mode, "human");
    assert.equal(found.online_match.game_server.websocket_path, "/v1/battle/socket");
    assert.equal(found.online_match.game_server.plate_state_schema, 1);
    assert.equal(found.online_match.player1.user_id, first.user.user_id);
    assert.equal(found.online_match.player2.user_id, second.user.user_id);
    assert.equal(found.online_match.player2.deck_no, 2);
    assert.deepEqual(found.online_match.player2.deck.user_deck_figures.map((figure) => figure.figure_user_items[0].item_master_id),
      editedDeck.figures.map((figure) => figure.item_master_id));
    assert.equal((await api(server.base, "/v1/matching/poll", {}, first.token)).room_id, matchId);
    assert.equal((await api(server.base, "/v1/matching/cancel", {}, first.token)).canceled, false);

    const stolenTicket = await api(server.base, "/v1/battle/challenge", {}, first.token);
    secrets.add(stolenTicket);
    const wrongSession = await BattlePeer.open(server.base, second, stolenTicket, clients, first.user.user_id);
    assert.ok(wrongSession.lines.includes("@login rejected"), "HTTP bearer and side-bound ticket must name the same account");
    await wrongSession.close();
    const blackTicket = await api(server.base, "/v1/battle/challenge", {}, first.token);
    const whiteTicket = await api(server.base, "/v1/battle/challenge", {}, second.token);
    secrets.add(blackTicket); secrets.add(whiteTicket);
    const black = await BattlePeer.open(server.base, first, blackTicket, clients);
    black.play();
    await delay(40);
    assert.equal(black.record, null, "game_start waits until the other actual player is ready");
    let white = await BattlePeer.open(server.base, second, whiteTicket, clients);
    white.play();
    await until(() => black.record && white.record, "both initial authoritative records");
    assert.deepEqual(black.record, white.record);
    assert.deepEqual(white.record.players[1].pokemons.map((pokemon) => pokemon.id), editedDeck.figures.map((figure) => figure.item_master_id));
    assert.deepEqual(black.snapshot.ClockPolicy, white.snapshot.ClockPolicy);

    const routes = [
      ["black", [28, 27]], ["white", [34, 0, 7]], ["black", [27, 20, 15]],
      ["white", [7, 0, 1]], ["black", [15, 11, 6]], ["white", [1, 0, 7]],
      ["black", [6, 5, 4]], ["white", [7, 0, 1]], ["black", [4, 3]],
    ];
    for (let index = 0; index < routes.length; index += 1) {
      const [side, route] = routes[index];
      const previousCount = black.record.all_moves.length;
      const peer = side === "black" ? black : white;
      peer.socket.send(`timer_start ${side}\n`);
      peer.move(side, { type: "mp_move", route });
      const expectedCount = previousCount + (index === routes.length - 1 ? 1 : 2);
      await until(() => black.record.all_moves.length === expectedCount && white.record.all_moves.length === expectedCount
        && black.plateState?.record_move_count === expectedCount && white.plateState?.record_move_count === expectedCount,
        `both peers receive action ${index + 1}, authoritative Z and bound plate state`);
      black.assertHealthy(); white.assertHealthy();
      assert.deepEqual(black.record, white.record, `independent records agree after action ${index + 1}`);
      if (index === 1) {
        const beforeReconnect = structuredClone(white.record);
        const acknowledged = white.sendIndex;
        await white.close();
        const renewed = await api(server.base, "/v1/session/login", { device_token: second.device });
        second.token = renewed.access_token;
        secrets.add(second.token);
        const ticket = await api(server.base, "/v1/battle/challenge", {}, second.token);
        secrets.add(ticket);
        white = await BattlePeer.open(server.base, second, ticket, clients);
        white.play();
        await until(() => white.record, "reconnected authoritative record");
        assert.deepEqual(white.record, beforeReconnect);
        assert.equal(white.snapshot.ServerRecvIndex, acknowledged);
        assert.ok(white.snapshot.WhiteMilliSecondsTimeLimit > 0);
      }
    }
    await until(() => black.result && white.result, "both terminal result packets");
    assert.deepEqual(black.result, { winner: "black", reason: "goal" });
    assert.deepEqual(white.result, black.result);
    const blackResult = await api(server.base, "/v1/matching/result", { matchId }, first.token);
    const whiteResult = await api(server.base, "/v1/matching/result", { matchId }, second.token);
    assert.equal(blackResult.won, true); assert.equal(whiteResult.won, false);
    assert.equal(blackResult.player_color, "black"); assert.equal(whiteResult.player_color, "white");
    const repeatResults = [
      await api(server.base, "/v1/matching/result", { matchId }, first.token),
      await api(server.base, "/v1/matching/result", { matchId }, second.token),
    ];
    assert.equal(repeatResults[0].chest_award.created, false,
      "result retries cannot award a second chest");
    assert.equal((await post(server.base, "/v1/matching/result", { matchId }, outsider.token)).body.ok, false);
    const completion = await api(server.base, "/v1/matches/get", { matchId }, first.token);
    assert.deepEqual(completion.record, black.record, "durable authority matches both independently replayed peers");
    assert.equal((await post(server.base, "/v1/matches/get", { matchId }, outsider.token)).body.ok, false);
    assert.equal(await api(server.base, "/v1/matching/reset-active", {}, first.token), true);
    assert.equal((await api(server.base, "/v1/matching/poll", {}, first.token)).status, 99);
    assert.equal((await api(server.base, "/v1/matching/result", { matchId }, second.token)).won, false,
      "one player's dismissal cannot erase the other's result");
    assert.equal(await api(server.base, "/v1/matching/reset-active", {}, second.token), true);
    for (const [index, player] of [first, second].entries()) {
      assert.deepEqual(await api(server.base, "/v1/matching/result", { matchId }, player.token), repeatResults[index],
        "completed result remains participant-owned after either player resets");
    }
    assert.equal((await post(server.base, "/v1/matching/result", { matchId }, outsider.token)).body.ok, false);
    for (const client of clients) await client.close();
    for (const secret of secrets) assert.equal(server.output.includes(secret), false, "server must not log credentials or tickets");

    await stopServer(server);
    server = await startServer({ httpPort, gamePort, databasePath });
    for (const player of players) {
      const login = await api(server.base, "/v1/session/login", { device_token: player.device });
      assert.equal(login.user.user_id, player.user.user_id);
      player.token = login.access_token;
      secrets.add(player.token);
    }
    for (const [index, player] of [first, second].entries()) {
      const restored = await api(server.base, "/v1/matches/get", { matchId }, player.token);
      assert.deepEqual(restored.record, completion.record);
      assert.equal(restored.winner, "black");
      const history = await api(server.base, "/v1/matches/list", {}, player.token);
      assert.equal(history.length, 1);
      assert.equal(Number(history[0].match_id), matchId);
      assert.deepEqual(await api(server.base, "/v1/matching/result", { matchId }, player.token), repeatResults[index],
        "the same participant result DTO remains available after the authoritative process restarts");
    }
    assert.equal((await post(server.base, "/v1/matches/get", { matchId }, outsider.token)).body.ok, false);
    assert.equal((await post(server.base, "/v1/matching/result", { matchId }, outsider.token)).body.ok, false);
    assert.deepEqual(await api(server.base, "/v1/matches/list", {}, outsider.token), []);
    const nextQueue = await api(server.base, "/v1/matching/entry", entryBody, first.token);
    assert.equal(nextQueue.status, 1);
    assert.notEqual(nextQueue.room_id, matchId, "new process does not restart at a colliding fixed match ID");
    assert.equal((await api(server.base, "/v1/matching/cancel", {}, first.token)).canceled, true);

    // Revoke an actual linked device in the website while its real battle
    // socket is active. This covers production callback wiring, not a mock map
    // or waiting fifteen seconds for the gateway's separate heartbeat sweep.
    await api(server.base, "/v1/matching/entry", entryBody, first.token);
    await api(server.base, "/v1/matching/entry", entryBody, second.token);
    const firstFreshTicket = await api(server.base, "/v1/battle/challenge", {}, first.token);
    const secondFreshTicket = await api(server.base, "/v1/battle/challenge", {}, second.token);
    secrets.add(firstFreshTicket); secrets.add(secondFreshTicket);
    const revokedPeer = await BattlePeer.open(server.base, first, firstFreshTicket, clients);
    const observer = await BattlePeer.open(server.base, second, secondFreshTicket, clients);
    revokedPeer.play(); observer.play();
    await until(() => revokedPeer.record && observer.record, "revocation fixture game_start");
    const pendingRawTicket = await api(server.base, "/v1/battle/challenge", {}, first.token);
    secrets.add(pendingRawTicket);
    const dashboard = await first.browser.request("/account");
    const firstDeviceId = /Isolated player 1<\/strong>[\s\S]*?name="device_id" value="([a-f0-9]{32})"/u.exec(dashboard.html)?.[1];
    assert.ok(firstDeviceId, "test website owns its explicitly linked installation");
    assert.equal((await first.browser.request("/account/devices/revoke", {
      csrf: dashboard.csrf, device_id: firstDeviceId,
    })).status, 303);
    if (revokedPeer.socket.readyState === WebSocket.OPEN) {
      revokedPeer.move("black", { type: "mp_move", route: [28, 27] });
    }
    await until(() => revokedPeer.socket.readyState === WebSocket.CLOSED, "revoked active socket closes immediately");
    assert.equal(observer.record.all_moves.length, 0, "revoked account cannot append a move during the heartbeat interval");
    assert.equal((await post(server.base, "/v1/battle/challenge", {}, first.token)).status, 401);
    assert.equal(await rawTicketResponse(gamePort, first.user.user_id, pendingRawTicket), "@login rejected",
      "pending raw TCP tickets are invalidated by the same real AccountStore revocation");
    for (const secret of secrets) assert.equal(server.output.includes(secret), false);
    t.diagnostic(JSON.stringify({
      schema: "kiwi-duel-human-http-ws-proof-1", accounts: 3, participants: 2, signup_and_explicit_link: true,
      default_queue_mode: "human", transport: "authenticated_websocket", independent_socket_reconnect: true,
      player_actions: routes.length, authoritative_record_moves: completion.record.all_moves.length,
      authoritative_record_sha256: recordDigest(completion.record), winner: "black", reason: "goal",
      durable_history_after_restart: true, result_dto_after_reset: true, result_dto_after_restart: true,
      nonparticipant_result_denied: true, duplicate_chest_denied: true,
      revoked_websocket_action_denied: true, revoked_raw_tcp_ticket_denied: true,
      live_service_touched: false,
    }));
  } finally {
    for (const client of clients) await client.close();
    if (server) await stopServer(server);
    const resolvedDirectory = resolve(directory);
    if (dirname(resolvedDirectory) !== resolve(tmpdir()) || !basename(resolvedDirectory).startsWith("kiwi-duel-human-http-")) {
      throw new Error("unsafe_isolated_test_cleanup_target");
    }
    rmSync(resolvedDirectory, { recursive: true, force: true });
  }
});
