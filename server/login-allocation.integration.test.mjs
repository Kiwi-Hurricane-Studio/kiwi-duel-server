import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ownedLoginRateLimitDefaults } from "./ip-rate-limiter.mjs";

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function freePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  return port;
}

test("HTTP login retries stay bounded and reject before JSON allocation without trusting forged proxy headers", { timeout: 30000 }, async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "kiwi-duel-login-limit-"));
  const databasePath = join(fixture, "accounts.sqlite");
  const httpPort = await freePort();
  let gamePort = await freePort();
  while (gamePort === httpPort) gamePort = await freePort();
  const base = `http://127.0.0.1:${httpPort}`;
  let output = "";
  const child = spawn(process.execPath, [fileURLToPath(new URL("./custom-bootstrap-server.mjs", import.meta.url))], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "test", DUEL_SERVER_HOST: "127.0.0.1", DUEL_SERVER_PORT: String(httpPort),
      DUEL_SERVER_PUBLIC_BASE: base, DUEL_GAME_SERVER_HOST: "127.0.0.1", DUEL_GAME_SERVER_PORT: String(gamePort),
      DUEL_GAME_SERVER_PUBLIC_HOST: "127.0.0.1", DUEL_ACCOUNT_DATABASE: databasePath,
      DUEL_SEED_ACCOUNTS_PATH: "", DUEL_TRUSTED_PROXY_ADDRESSES: "", DUEL_DEFAULT_MATCH_MODE: "human",
      DUEL_GAME_BATTLE_EVIDENCE_MODE: "off", DUEL_GAME_OPPONENT_PLATE_MODE: "off" },
  });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output = (output + chunk.toString()).slice(-256 * 1024); });
  let launchError = "";
  child.on("error", (error) => { launchError = error.code || "launch_failed"; });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      assert.equal(launchError, "");
      assert.equal(child.exitCode, null);
      try { ready = (await (await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(300) })).json()).ok; } catch {}
      if (ready) break;
      await delay(30);
    }
    assert.ok(ready, "isolated service started");
    const deviceToken = "fixture-login-allocation-device-only-0123456789";
    let firstLink;
    for (let index = 0; index < ownedLoginRateLimitDefaults.limit; index += 1) {
      const response = await fetch(`${base}/v1/session/login`, { method: "POST", signal: AbortSignal.timeout(3000),
        headers: { "Content-Type": "application/json", "X-Forwarded-For": `192.0.2.${index % 250 + 1}` },
        body: JSON.stringify({ device_token: deviceToken }) });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.link_required, true);
      firstLink ??= body;
      assert.equal(body.link_url, firstLink.link_url, "retry reuses pending consent");
      assert.equal(body.expires_at, firstLink.expires_at, "retry cannot extend consent expiry");
    }
    const blocked = await fetch(`${base}/v1/session/login`, { method: "POST", signal: AbortSignal.timeout(3000),
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.7" },
      body: "{deliberately-invalid-json" });
    assert.equal(blocked.status, 429, "limit is checked before JSON decoding");
    assert.equal((await blocked.json()).error, "login_rate_limited");
    assert.ok(Number(blocked.headers.get("retry-after")) > 0);
    const reader = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM device_links").get().count, 1);
      assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM device_link_requests").get().count, 1);
      assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM game_sessions").get().count, 0);
    } finally { reader.close(); }
    const malformedStatus = await new Promise((done, reject) => {
      const request = httpRequest({ host: "127.0.0.1", port: httpPort, path: "http://[invalid", method: "GET" }, (response) => {
        response.resume(); response.on("end", () => done(response.statusCode));
      });
      request.on("error", reject); request.setTimeout(3000, () => request.destroy(new Error("request_timeout"))); request.end();
    });
    assert.equal(malformedStatus, 400);
    assert.equal((await (await fetch(`${base}/healthz`)).json()).ok, true, "bad request cannot crash service");
    assert.ok(!output.includes(deviceToken));
    assert.ok(!output.includes(new URL(firstLink.link_url).searchParams.get("code")));
    t.diagnostic(JSON.stringify({ schema: "kiwi-duel-login-allocation-proof-1", successful_retries: ownedLoginRateLimitDefaults.limit,
      pending_devices: 1, pending_consents: 1, excess_http_status: blocked.status, malformed_target_status: malformedStatus,
      spoofed_proxy_ignored: true, credentials_absent_from_logs: true }));
  } finally {
    if (child.pid && child.exitCode == null && child.signalCode == null) {
      const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
    }
    assert.equal(dirname(resolve(fixture)), resolve(tmpdir()));
    assert.ok(basename(fixture).startsWith("kiwi-duel-login-limit-"));
    rmSync(fixture, { recursive: true, force: true });
  }
});
