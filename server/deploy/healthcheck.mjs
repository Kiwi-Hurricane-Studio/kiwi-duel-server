import { connect } from "node:net";

try {
  const response = await fetch("http://127.0.0.1:8080/healthz", { signal: AbortSignal.timeout(3000) });
  const body = await response.json();
  if (!response.ok || !body.ok || body.data?.service !== "kiwi-duel-owned"
      || body.data.game_port !== 8081 || !body.data.human_matchmaking
      || body.data.battle_websocket !== "/v1/battle/socket") throw new Error("health_failed");
  await new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: 8081 });
    socket.setTimeout(2000);
    socket.once("connect", () => { socket.destroy(); resolve(); });
    socket.once("error", reject);
    socket.once("timeout", () => { socket.destroy(); reject(new Error("tcp_health_failed")); });
  });
} catch { process.exitCode = 1; }
