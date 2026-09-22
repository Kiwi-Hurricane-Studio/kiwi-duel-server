import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import WebSocket from "ws";
import { attachBattleWebSocket, BATTLE_SOCKET_PATH } from "./battle-websocket.mjs";

async function fixture(options = {}) {
  const server = createServer((_request, response) => response.end());
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const users = new Map([["fixture-session", { user_id: 17 }]]);
  const attached = [];
  const gateway = attachBattleWebSocket({ server, publicBase: base,
    authenticate: (session) => users.get(session),
    service: { attach(stream) {
      attached.push(stream);
      stream.on("data", (value) => stream.write(value));
    } }, ...options });
  return { base, url: base.replace("http:", "ws:") + BATTLE_SOCKET_PATH, users, attached, gateway,
    async close() { await gateway.close(); await new Promise((resolve) => server.close(resolve)); } };
}

async function rejected(url, options = {}) {
  const socket = new WebSocket(url, options);
  socket.on("error", () => {});
  return new Promise((resolve, reject) => {
    socket.on("open", () => { socket.terminate(); reject(new Error("unexpected_open")); });
    socket.on("unexpected-response", (_request, response) => { response.resume(); socket.terminate(); resolve(response.statusCode); });
  });
}

test("battle gateway authenticates before upgrade and preserves private session binding", async () => {
  const f = await fixture();
  try {
    assert.equal(await rejected(f.url), 401);
    assert.equal(await rejected(f.url, { headers: { Authorization: "Bearer unknown" } }), 401);
    assert.equal(await rejected(f.url, { headers: { Authorization: "Bearer fixture-session", Origin: "https://foreign.test" } }), 403);
    assert.equal(await rejected(f.url + "?ticket=secret", { headers: { Authorization: "Bearer fixture-session" } }), 404);
    assert.equal(f.attached.length, 0);
    const socket = new WebSocket(f.url, { headers: { Authorization: "Bearer fixture-session" } });
    await once(socket, "open");
    assert.equal(f.attached[0].authenticatedSession, "fixture-session");
    assert.equal(f.attached[0].authenticatedUserId, 17);
    const response = once(socket, "message");
    socket.send("sequence 0 -1 unicode Pokémon\n");
    assert.equal((await response)[0].toString(), "sequence 0 -1 unicode Pokémon\n");
    assert.equal(f.gateway.connectionCount, 1);
    socket.close(); await once(socket, "close");
  } finally { await f.close(); }
});

test("gateway bounds per-user connections and closes revoked sessions", async () => {
  const f = await fixture({ maximumConnectionsPerUser: 1, heartbeatMs: 50 });
  try {
    const socket = new WebSocket(f.url, { headers: { Authorization: "Bearer fixture-session" } });
    await once(socket, "open");
    assert.equal(await rejected(f.url, { headers: { Authorization: "Bearer fixture-session" } }), 429);
    const closed = once(socket, "close");
    f.users.clear();
    await closed;
  } finally { await f.close(); }
});

test("gateway closes idle authenticated clients and rejects oversized frames", async () => {
  const f = await fixture({ loginTimeoutMs: 50 });
  try {
    const socket = new WebSocket(f.url, { headers: { Authorization: "Bearer fixture-session" } });
    await once(socket, "open"); await once(socket, "close");
    const oversized = new WebSocket(f.url, { headers: { Authorization: "Bearer fixture-session" } });
    await once(oversized, "open");
    const closed = once(oversized, "close");
    oversized.send("x".repeat(65537));
    assert.equal((await closed)[0], 1009);
  } finally { await f.close(); }
});
