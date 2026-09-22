import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer as httpServer, request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const godot = process.env.DUEL_TEST_GODOT || join(project, ".tools/godot/Godot_v4.7.2-stable_win64_console.exe");
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function freePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  assert.ok(port !== 8080 && port !== 8081, "fixture must not use live service ports");
  return port;
}
function child(executable, args, env) {
  const process = spawn(executable, args, { cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const state = { process, output: "", spawnError: false };
  process.on("error", () => { state.spawnError = true; });
  for (const stream of [process.stdout, process.stderr]) stream.on("data", (chunk) => {
    state.output = (state.output + chunk.toString("utf8")).slice(-2 * 1024 * 1024);
  });
  return state;
}
async function stop(state) {
  if (!state?.process.pid || state.process.exitCode != null || state.process.signalCode != null) return;
  const exited = once(state.process, "exit");
  state.process.kill("SIGTERM");
  let timer;
  await Promise.race([exited, new Promise((done) => { timer = setTimeout(done, 2000); })]);
  clearTimeout(timer);
  if (state.process.exitCode == null && state.process.signalCode == null) {
    state.process.kill("SIGKILL");
    await exited;
  }
}
function privateEnvironment(directory) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DUEL_|KIWI_|GODOT_|XDG_|PYTHON|NODE_OPTIONS$|NODE_PATH$)/iu.test(key)));
  for (const [key, folder] of Object.entries({ APPDATA: "roaming", LOCALAPPDATA: "local", XDG_DATA_HOME: "xdg-data", XDG_CONFIG_HOME: "xdg-config", XDG_CACHE_HOME: "xdg-cache", TEMP: "temp", TMP: "temp" })) {
    env[key] = join(directory, folder); mkdirSync(env[key], { recursive: true });
  }
  return env;
}
function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

test("private actual HTTP failure/retry and finalized bootstrap restart preserve account, provider and verified cache", {
  timeout: 60000, skip: !existsSync(godot) ? "Godot executable unavailable" : false,
}, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "kiwi-core-tests-boot-restart-"));
  const env = privateEnvironment(directory);
  const deviceToken = `fixture-restart-${randomUUID()}`;
  const password = `fixture-password-${randomUUID()}`;
  const seed = join(directory, "seed-private.json");
  const fixture = join(directory, "runner-private.json");
  writeFileSync(seed, JSON.stringify({ accounts: [{ email: "boot-restart@example.test", displayName: "Boot_Retry", password, deviceToken }] }));
  const requests = new Map();
  const roomTimes = [];
  let server, runner, proxy;
  try {
    const ports = new Set();
    while (ports.size < 3) ports.add(await freePort());
    const [httpPort, gamePort, proxyPort] = [...ports];
    const upstream = `http://127.0.0.1:${httpPort}`;
    const base = `http://127.0.0.1:${proxyPort}`;
    proxy = httpServer((incoming, response) => {
      const count = (requests.get(incoming.url) || 0) + 1;
      requests.set(incoming.url, count);
      if (incoming.url.startsWith("/fixture/legacy/")) {
        incoming.resume(); incoming.socket.destroy(); return;
      }
      if (incoming.url === "/v1/bootstrap/room") roomTimes.push(Date.now());
      if (incoming.url === "/v1/bootstrap/room" && count <= 4) {
        incoming.resume();
        // Actual transport failure, not an HTTP status or fabricated response.
        // CommonErrorFunc's ConnectionError policy must not be inferred from503.
        incoming.socket.destroy();
        return;
      }
      const forwarded = httpRequest(`${upstream}${incoming.url}`, { method: incoming.method, headers: incoming.headers }, (result) => {
        response.writeHead(result.statusCode, result.headers);
        result.pipe(response);
      });
      forwarded.on("error", () => { response.writeHead(502); response.end(); });
      incoming.pipe(forwarded);
    });
    proxy.listen(proxyPort, "127.0.0.1"); await once(proxy, "listening");
    server = child(process.execPath, [join(project, "server/custom-bootstrap-server.mjs")], {
      ...env, NODE_ENV: "test", DUEL_SERVER_HOST: "127.0.0.1", DUEL_SERVER_PORT: String(httpPort),
      DUEL_SERVER_PUBLIC_BASE: base, DUEL_GAME_SERVER_HOST: "127.0.0.1", DUEL_GAME_SERVER_PORT: String(gamePort),
      DUEL_GAME_SERVER_PUBLIC_HOST: "127.0.0.1", DUEL_ACCOUNT_DATABASE: join(directory, "disposable.sqlite"),
      DUEL_SEED_ACCOUNTS_PATH: seed, DUEL_DEFAULT_MATCH_MODE: "human",
    });
    let healthy = false;
    for (let index = 0; index < 150; index += 1) {
      assert.equal(server.spawnError, false);
      assert.equal(server.process.exitCode, null, "disposable service exited before healthy");
      try {
        const result = await fetch(`${upstream}/healthz`, { signal: AbortSignal.timeout(300) }).then((response) => response.json());
        if (result.ok === true && result.data.game_port === gamePort) { healthy = true; break; }
      } catch {}
      await delay(20);
    }
    assert.equal(healthy, true, "isolated real owned service healthy");
    writeFileSync(fixture, JSON.stringify({ base_url: base, device_token: deviceToken }));
    runner = child(godot, ["--headless", "--path", project, "--log-file", join(directory, "godot-private.log"),
      "--script", "res://tests/boot_restart_runner.gd", "--", `--expected-user-root=${directory}`, `--boot-restart-fixture=${fixture}`], {
      ...env, KIWI_PRIVATE_TEST_ROOT: directory,
    });
    const deadline = Date.now() + 40000;
    while (runner.process.exitCode == null && runner.process.signalCode == null) {
      assert.equal(runner.spawnError, false, "isolated Godot spawn failed");
      assert.ok(Date.now() < deadline, "isolated Godot timeout (only owned child will be stopped)");
      await delay(20);
    }
    for (const secret of [deviceToken, password]) {
      assert.equal((runner.output + server.output).includes(secret), false, "fixture credentials absent from output");
    }
    const lines = runner.output.split(/\r?\n/u);
    const summaries = lines.filter((line) => line.startsWith("GODOT_BOOT_RESTART_TEST="));
    assert.equal(summaries.length, 1, `exactly one summary required: ${lines.filter((line) => /SCRIPT ERROR|ERROR:|Parse Error/u.test(line)).slice(-8).join(" | ")}`);
    const summary = JSON.parse(summaries[0].slice("GODOT_BOOT_RESTART_TEST=".length));
    t.diagnostic(JSON.stringify(summary));
    assert.equal(runner.process.exitCode, 0, "Godot must exit successfully");
    assert.equal(summary.ok, true);
    assert.deepEqual(summary.failures, []);
    assert.ok(Number.isInteger(summary.assertions) && summary.assertions >= 45);
    assert.equal(summary.real_network, true);
    assert.equal(summary.private_fixture, true);
    assert.equal(summary.http.successful_boots, 2);
    assert.equal(summary.http.terminal_failures, 1);
    assert.equal(summary.http.master_joins, 17503);
    assert.equal(summary.http.audio_loaded, 18);
    assert.equal(summary.http.full_original_ready, false);
    assert.equal(lines.some((line) => /^(SCRIPT ERROR:|ERROR:)/u.test(line)), false, "runtime errors fail closed");
    assert.equal(requests.get("/v1/bootstrap/room"), 6, "three initial attempts, acknowledged retryCount1 then2, and full-plan restart");
    const retryIntervals = roomTimes.slice(1, 5).map((time, index) => time - roomTimes[index]);
    assert.ok(retryIntervals[0] >= 900 && retryIntervals[1] >= 900 && retryIntervals[3] >= 900,
      "real automatic API retries wait one second, including the post-ACK retryCount1 failure");
    assert.ok(retryIntervals[2] >= 4900, "acknowledged same-request retry waits five seconds");
    assert.equal(requests.get("/v1/session/login"), 2, "same-operation retry must not re-login; finalized recovery starts one new plan");
    assert.equal(summary.http.failed_operation_only_retried, true);
    assert.equal(requests.get("/fixture/legacy/register"), 1);
    assert.equal(requests.get("/fixture/legacy/challenge"), 2, "login and battle challenge failures are attributed separately");
    const assetRequests = [...requests].filter(([path]) => path.startsWith("/content/"));
    assert.ok(assetRequests.length > 0, "actual content downloaded");
    assert.ok(assetRequests.every(([, count]) => count === 1), "verified bytes are reused without redownload");
    for (const path of filesBelow(directory).filter((path) => /(?:\.log|cache\.json)$/u.test(path))) {
      const text = readFileSync(path, "utf8");
      for (const secret of [deviceToken, password]) assert.equal(text.includes(secret), false, "logs/cache contain no fixture credential");
    }
    t.diagnostic(JSON.stringify({ private_service_only: true, live_ports_touched: false, asset_download_counts: assetRequests.map(([, count]) => count),
      room_requests: 6, observed_retry_intervals_ms: retryIntervals }));
  } finally {
    await stop(runner);
    await stop(server);
    if (proxy) { proxy.closeAllConnections(); await new Promise((done) => proxy.close(done)); }
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("kiwi-core-tests-boot-restart-"));
    rmSync(target, { recursive: true, force: true });
  }
});
