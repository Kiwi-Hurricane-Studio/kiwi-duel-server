import { createWebSocketStream, WebSocketServer } from "ws";

export const BATTLE_SOCKET_PATH = "/v1/battle/socket";

// The recovered line protocol is unchanged inside the authenticated WebSocket.
// HTTP TLS termination can therefore protect both account and battle traffic on
// one public port, while the old local TCP listener remains compatible.
export function attachBattleWebSocket({ server, service, authenticate, publicBase,
  maximumConnections = 1000, maximumConnectionsPerUser = 4, loginTimeoutMs = 10000,
  heartbeatMs = 15000, maximumBacklogBytes = 1024 * 1024 }) {
  const origin = new URL(publicBase).origin;
  const clients = new Map();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 65536 });
  function reject(socket, code) {
    socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  function upgrade(request, socket, head) {
    let url;
    try { url = new URL(request.url, origin); } catch { reject(socket, 400); return; }
    if (url.pathname !== BATTLE_SOCKET_PATH || url.search || url.hash) { reject(socket, 404); return; }
    if (request.headers.origin && request.headers.origin !== origin) { reject(socket, 403); return; }
    const authorization = request.headers.authorization || "";
    const session = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    let user;
    try { user = session ? authenticate(session) : null; } catch { reject(socket, 503); return; }
    if (!user) { reject(socket, 401); return; }
    const userId = String(user.user_id);
    const sameUser = [...clients.values()].filter((entry) => entry.userId === userId).length;
    if (clients.size >= maximumConnections || sameUser >= maximumConnectionsPerUser) { reject(socket, 429); return; }
    socket.setNoDelay(true);
    wss.handleUpgrade(request, socket, head, (websocket) => {
      const stream = createWebSocketStream(websocket, { encoding: "utf8", highWaterMark: 65536 });
      stream.setNoDelay = () => stream;
      stream.authenticatedSession = session;
      stream.authenticatedUserId = user.user_id;
      const entry = { userId, session, stream, alive: true };
      clients.set(websocket, entry);
      const firstCommandTimer = setTimeout(() => stream.destroy(), loginTimeoutMs);
      firstCommandTimer.unref?.();
      stream.once("data", () => clearTimeout(firstCommandTimer));
      const write = stream.write.bind(stream);
      stream.write = (...args) => {
        if (stream.writableLength + websocket.bufferedAmount > maximumBacklogBytes) {
          stream.destroy();
          return false;
        }
        return write(...args);
      };
      // Never log the Authorization header, ticket, stream payload or close text.
      stream.on("error", () => {});
      websocket.on("error", () => {});
      websocket.on("pong", () => { entry.alive = true; });
      websocket.once("close", () => {
        clearTimeout(firstCommandTimer);
        clients.delete(websocket);
      });
      service.attach(stream);
    });
  }
  server.on("upgrade", upgrade);
  const heartbeat = setInterval(() => {
    for (const [websocket, entry] of clients) {
      let user = null;
      try { user = authenticate(entry.session); } catch {}
      if (!entry.alive || !user || String(user.user_id) !== entry.userId) {
        websocket.terminate();
        continue;
      }
      entry.alive = false;
      websocket.ping();
    }
  }, heartbeatMs);
  heartbeat.unref?.();
  return {
    get connectionCount() { return clients.size; },
    async close() {
      clearInterval(heartbeat);
      server.off("upgrade", upgrade);
      for (const websocket of clients.keys()) websocket.terminate();
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}
