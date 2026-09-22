// Real production scene + actual disposable HTTP/SQLite service. Candidate-only
// GPU/input proof; this is not an original-device visual-parity test.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
// Launch the renderer itself: the console executable is only a child-spawning
// wrapper and cannot safely stand in for process ownership on deadline expiry.
const godot = join(project, ".tools/godot/Godot_v4.7.2-stable_win64.exe");
const evidenceRoot = join(project, "docs/generated/loading-recovery-live-20260911/boot");
const sourcePaths = ["project.godot", "src/ui/app.tscn", "src/ui/app.gd", "src/ui/common_network_error_dialog.gd",
  "src/domain/boot_sequence.gd", "src/services/boot_pipeline.gd", "src/services/boot_api_client.gd",
  "src/services/boot_contract.gd", "src/services/boot_owned_readiness.gd", "src/services/home_sync_service.gd",
  "tests/loading_ui_http_runner.gd", "server/custom-bootstrap-server.mjs", "server/loading-ui-recovery.integration.test.mjs"];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceHashes = () => Object.fromEntries(sourcePaths.map((path) => [path, sha(readFileSync(join(project, path)))]));
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
const inside = (root, path) => { const sub = relative(resolve(root), resolve(path)); return sub !== "" && sub !== ".." && !sub.startsWith(`..${sep}`) && !isAbsolute(sub); };
async function freePort() {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port; await new Promise((done) => server.close(done));
  assert.ok(port !== 8080 && port !== 8081); return port;
}
function privateEnvironment(directory) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DUEL_|KIWI_|GODOT_|XDG_|PYTHON|NODE_OPTIONS$|NODE_PATH$)/iu.test(key)));
  for (const [key, folder] of Object.entries({ APPDATA: "roaming", LOCALAPPDATA: "local", XDG_DATA_HOME: "xdg-data", XDG_CONFIG_HOME: "xdg-config", XDG_CACHE_HOME: "xdg-cache", TEMP: "temp", TMP: "temp" })) {
    env[key] = join(directory, folder); mkdirSync(env[key], { recursive: true });
  }
  return env;
}
function startChild(executable, args, env, cwd, onLine = () => {}) {
  const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const state = { child, output: "", spawnError: false, overflow: false, closed: false, code: null, signal: null };
  state.closedPromise = new Promise((done) => child.once("close", (code, signal) => {
    Object.assign(state, { closed: true, code, signal }); done();
  }));
  child.on("error", () => { state.spawnError = true; });
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8"); let tail = "";
    stream.on("data", (text) => {
      if (Buffer.byteLength(state.output) + Buffer.byteLength(text) > 8 * 1024 * 1024) {
        state.overflow = true; child.kill("SIGTERM"); return;
      }
      state.output += text;
      tail += text;
      const lines = tail.split(/\r?\n/u); tail = lines.pop();
      for (const line of lines) onLine(line);
    });
  }
  return state;
}
async function stopOwned(state) {
  if (!state || state.closed) return;
  if (state.child.pid) state.child.kill("SIGTERM");
  await Promise.race([state.closedPromise, delay(2000)]);
  if (!state.closed && state.child.pid) state.child.kill("SIGKILL");
  await Promise.race([state.closedPromise, delay(3000)]);
  assert.equal(state.closed, true, "owned process must be confirmed closed before fixture cleanup");
}
function parseUnique(output, prefix) {
  const lines = output.split(/\r?\n/u).filter((line) => line.startsWith(prefix));
  assert.equal(lines.length, 1, `exactly one ${prefix} marker`);
  const value = JSON.parse(lines[0].slice(prefix.length));
  assert.ok(value && typeof value === "object" && !Array.isArray(value)); return value;
}
function safePath(path) {
  // Never retain URL queries, headers, request/response bodies, or auth values.
  return new URL(path, "http://fixture.invalid").pathname;
}

for (const acknowledgementInput of ["touch", "android_back"]) {
test(`real production loading modal retries the same HTTP request through ${acknowledgementInput} then reaches rendered Home`, {
  timeout: 150000, skip: process.platform !== "win32" || !existsSync(godot) ? "Windows Godot GPU executable unavailable" : false,
}, async (t) => {
  mkdirSync(evidenceRoot, { recursive: true });
  const evidence = mkdtempSync(join(evidenceRoot, `production-http-${acknowledgementInput}-`));
  const directory = mkdtempSync(join(tmpdir(), "kiwi-core-tests-loading-ui-http-"));
  const env = privateEnvironment(directory);
  const deviceToken = `fixture-ui-${randomUUID()}`, password = `fixture-password-${randomUUID()}`;
  const seed = join(directory, "seed-private.json");
  writeJson(seed, { accounts: [{ email: "loading-ui@example.test", displayName: "Recovery_Test", password, deviceToken }] });
  const before = sourceHashes(), started = Date.now(), requests = [], roomBodies = [];
  let service, runner, proxy, checkingRendered = false, heldRoom = null, failure = null;
  const summary = { schema: 1, ok: false, evidence, candidate_only: true, original_parity: false, private_fixture: true,
    real_network: true, production_scene: "res://src/ui/app.tscn", normal_timing: true, source_before: before, acknowledgement_input: acknowledgementInput,
    started_utc: new Date(started).toISOString(), no_live_ports: true, private_cwd: true, actual_engine_executable: godot };
  const releaseHeldRoom = () => {
    if (heldRoom && checkingRendered) { heldRoom.request.socket.destroy(); heldRoom.entry.socket_destroyed_ms = Date.now(); heldRoom = null; }
  };
  try {
    const ports = new Set(); while (ports.size < 3) ports.add(await freePort());
    const [httpPort, gamePort, proxyPort] = [...ports], upstream = `http://127.0.0.1:${httpPort}`, base = `http://127.0.0.1:${proxyPort}`;
    proxy = createHttpServer((incoming, response) => {
      const path = safePath(incoming.url), count = requests.filter((item) => item.path === path).length + 1;
      const entry = { path, method: incoming.method, ordinal: count, received_ms: Date.now() };
      requests.push(entry);
      if (path === "/v1/bootstrap/room") {
        const chunks = []; let bytes = 0;
        incoming.on("data", (chunk) => { bytes += chunk.length; if (bytes > 65536) incoming.destroy(); else chunks.push(chunk); });
        incoming.on("end", () => { roomBodies.push(Buffer.concat(chunks)); });
        if (count <= 3) {
          if (count === 1 && !checkingRendered) heldRoom = { request: incoming, entry };
          else { incoming.socket.destroy(); entry.socket_destroyed_ms = Date.now(); }
          return;
        }
      }
      const forwarded = httpRequest(`${upstream}${incoming.url}`, { method: incoming.method, headers: incoming.headers }, (result) => {
        entry.response_code = result.statusCode; entry.response_started_ms = Date.now();
        response.writeHead(result.statusCode, result.headers); result.pipe(response);
        result.on("end", () => { entry.completed_ms = Date.now(); });
      });
      forwarded.on("error", () => { response.destroy(); });
      incoming.pipe(forwarded);
    });
    proxy.listen(proxyPort, "127.0.0.1"); await once(proxy, "listening");
    service = startChild(process.execPath, [join(project, "server/custom-bootstrap-server.mjs")], {
      ...env, NODE_ENV: "test", DUEL_SERVER_HOST: "127.0.0.1", DUEL_SERVER_PORT: String(httpPort),
      DUEL_SERVER_PUBLIC_BASE: base, DUEL_GAME_SERVER_HOST: "127.0.0.1", DUEL_GAME_SERVER_PORT: String(gamePort),
      DUEL_GAME_SERVER_PUBLIC_HOST: "127.0.0.1", DUEL_ACCOUNT_DATABASE: join(directory, "disposable.sqlite"),
      DUEL_SEED_ACCOUNTS_PATH: seed, DUEL_DEFAULT_MATCH_MODE: "human",
    }, directory);
    let healthy = false;
    for (let index = 0; index < 150; index++) {
      assert.equal(service.spawnError, false); assert.equal(service.closed, false, "private service exited");
      try { const health = await fetch(`${upstream}/healthz`, { signal: AbortSignal.timeout(300) }).then((r) => r.json());
        if (health.ok === true && health.data.game_port === gamePort) { healthy = true; break; }
      } catch {}
      await delay(20);
    }
    assert.equal(healthy, true, "private service healthy before scene launch");
    const user = join(env.APPDATA, "pokemon-duel-modern"); mkdirSync(user, { recursive: true });
    const profileFile = join(user, "server-profiles.local.json");
    writeJson(profileFile, { active_profile: "custom", profiles: { custom: { base_url: base, game_port: gamePort } } });
    writeJson(join(user, "server-secrets.json"), { profiles: { custom: { device_token: deviceToken } } });
    const profileHash = sha(readFileSync(profileFile));
    const args = ["--path", project, "--rendering-method", "gl_compatibility", "--audio-driver", "Dummy", "--log-file", join(directory, "godot-private.log"),
      "--script", "res://tests/loading_ui_http_runner.gd", "--", `--expected-user-root=${directory}`, `--loading-ui-evidence=${evidence}`, `--loading-ui-ack=${acknowledgementInput}`];
    runner = startChild(godot, args, { ...env, KIWI_PRIVATE_TEST_ROOT: directory }, directory, (line) => {
      const marker = "GODOT_LOADING_UI_HTTP_OBSERVATION=";
      if (line.startsWith(marker)) {
        try { if (JSON.parse(line.slice(marker.length)).label === "startup_checking") { checkingRendered = true; releaseHeldRoom(); } } catch {}
      }
    });
    Object.assign(summary, { owned_service_pid: service.child.pid, owned_engine_pid: runner.child.pid, isolated_ports: { httpPort, gamePort, proxyPort } });
    const deadline = Date.now() + 120000;
    while (!runner.closed) {
      assert.equal(runner.spawnError, false, "actual engine spawn succeeded");
      assert.equal(runner.overflow, false, "bounded output must not truncate markers");
      assert.ok(Date.now() < deadline, "actual production-app timeout; cleanup targets only owned engine PID");
      await delay(40);
    }
    assert.equal(runner.code, 0, "production controller must exit successfully");
    assert.equal(runner.overflow, false);
    for (const secret of [deviceToken, password]) assert.equal((runner.output + service.output).includes(secret), false, "fixture secrets absent from logs");
    const guard = parseUnique(runner.output, "GODOT_PRIVATE_TEST_GUARD=");
    assert.equal(guard.ok, true);
    assert.equal(resolve(guard.expected_root).toLowerCase(), resolve(directory).toLowerCase());
    assert.equal(resolve(guard.actual_user_directory).toLowerCase(), resolve(user).toLowerCase());
    assert.ok(inside(directory, guard.actual_user_directory));
    const result = parseUnique(runner.output, "GODOT_LOADING_UI_HTTP_RESULT=");
    summary.result = result;
    assert.equal(result.ok, true); assert.deepEqual(result.failures, []);
    assert.ok(Number.isInteger(result.assertions) && result.assertions > 0);
    for (const flag of ["real_network", "private_fixture", "candidate_only", "normal_timing", "scripted_input"]) assert.equal(result[flag], true);
    assert.equal(result.original_parity, false); assert.equal(result.renderer, "gl_compatibility");
    assert.equal(result.production_scene, "res://src/ui/app.tscn"); assert.equal(result.process_id, runner.child.pid);
    assert.equal(result.acknowledgement_input, acknowledgementInput);
    assert.equal(result.inputs.length, acknowledgementInput === "touch" ? 4 : 6);
    assert.deepEqual(result.inputs.map((input) => [input.label, input.action]), acknowledgementInput === "touch"
      ? [["welcome", "press"], ["welcome", "release"], ["communication_ok", "press"], ["communication_ok", "release"]]
      : [["welcome", "press"], ["welcome", "release"], ["communication_back", "notification"], ["duplicate_closing_back", "notification"], ["closing_escape_echo", "key"], ["closing_escape_release", "key"]]);
    for (const input of result.inputs) {
      assert.equal(input.dispatch, input.action === "notification" ? "root.propagate_notification" : "Input.parse_input_event"); assert.equal(input.scripted, true);
      assert.ok(Number.isFinite(input.unix_ms));
      if (input.action === "notification") assert.equal(input.physical_android, false);
      if (input.input === "InputEventScreenTouch") assert.ok([...input.viewport_xy, ...input.logical_xy].every(Number.isFinite));
      else { assert.equal(input.viewport_xy, null); assert.equal(input.logical_xy, null); }
    }
    assert.equal(typeof result.back_policy.initial_quit_on_go_back, "boolean");
    assert.equal(result.back_policy.open_quit_on_go_back, false); assert.equal(result.back_policy.closing_quit_on_go_back, false);
    assert.equal(result.back_policy.removed_quit_on_go_back, result.back_policy.initial_quit_on_go_back);
    assert.equal(result.home_sync.completed, 13); assert.equal(result.home_sync.error_count, 0);
    assert.equal(result.audio.loaded_clips, 18); assert.deepEqual(result.audio.failures, {});
    assert.equal(result.capture_count, 6);
    const room = requests.filter((entry) => entry.path === "/v1/bootstrap/room");
    assert.equal(room.length, 4); assert.equal(room[3].response_code, 200);
    assert.equal(roomBodies.length, 4); assert.ok(roomBodies.every((body) => body.equals(roomBodies[0])), "retry body bytes identical, retained privately only");
    assert.equal(requests.filter((entry) => entry.path === "/v1/session/login").length, 1, "OK retries only Room, not full login");
    for (let index = 1; index < 3; index++) assert.ok(room[index].received_ms - room[index - 1].socket_destroyed_ms >= 900, "actual one-second automatic retry");
    const ack = result.inputs.find((input) => acknowledgementInput === "touch" ? input.label === "communication_ok" && input.action === "release" : input.label === "communication_back");
    assert.ok(room[3].received_ms - ack.unix_ms >= 4900, "post-close five-second delayed operation retry");
    const acknowledged = parseUnique(runner.output, "GODOT_BOOT_ERROR_ACKNOWLEDGED=");
    assert.equal(acknowledged.action, "same_request_after_five_seconds"); assert.equal(acknowledged.data_reset, false);
    const modal = parseUnique(runner.output, "GODOT_NETWORK_ERROR_DIALOG=");
    assert.equal(modal.kind, "communication"); assert.equal(modal.buttons, 1);
    const presented = runner.output.split(/\r?\n/u).filter((line) => line.startsWith("GODOT_PRESENTED_STATE=")).map((line) => JSON.parse(line.slice("GODOT_PRESENTED_STATE=".length)));
    assert.ok(presented.some((value) => value.state === "boot_error")); assert.ok(presented.some((value) => value.state === "home"));
    const deckMarkers = runner.output.split(/\r?\n/u).filter((line) => line.startsWith("GODOT_HOME_DECK_STATE=")).map((line) => JSON.parse(line.slice("GODOT_HOME_DECK_STATE=".length)));
    assert.ok(deckMarkers.length > 0 && deckMarkers.every((value) => value.server_ready === true && value.thumbnail_count === 6 && value.recovery_required === false));
    assert.equal(sha(readFileSync(profileFile)), profileHash, "local profile stays byte-identical");
    const secrets = JSON.parse(readFileSync(join(user, "server-secrets.json"), "utf8"));
    // A failure must not stringify the actual/expected opaque token in TAP.
    assert.ok(secrets.profiles.custom.device_token === deviceToken, "existing device identity preserved");
    const save = JSON.parse(readFileSync(join(user, "reconstruction-state-v1.json"), "utf8"));
    assert.equal(save.process_id, runner.child.pid); assert.equal(save.launch_count, 1); assert.equal(save.last_presented_state, "home");
    assert.ok(!/^(?:SCRIPT ERROR:|ERROR:)|Parse Error|Unicode parsing error|WARNING:/mu.test(runner.output), "runtime warnings/errors fail closed");
    summary.frames = [];
    for (const label of ["welcome_ready", "startup_logo", "startup_checking", "communication_modal_open", "acknowledged_retry_wait", "home_ready"]) {
      const meta = JSON.parse(readFileSync(join(evidence, `${label}.json`), "utf8")), raw = readFileSync(join(evidence, `${label}.rgba`));
      assert.equal(meta.format, "RGBA_8888"); assert.equal(meta.bytes, meta.width * meta.height * 4);
      assert.equal(raw.length, meta.bytes); assert.equal(sha(raw), meta.sha256); assert.equal(meta.resampled, false); assert.equal(meta.registered, false);
      assert.equal(meta.width, meta.render_geometry.viewport_visible_width); assert.equal(meta.height, meta.render_geometry.viewport_visible_height);
      let nonblack = 0; for (let index = 0; index < raw.length; index += 4) if (Math.max(raw[index], raw[index + 1], raw[index + 2]) > 48) nonblack++;
      assert.ok(nonblack > 0, `actual GPU pixels visible for ${label}`);
      summary.frames.push({ label, width: meta.width, height: meta.height, bytes: raw.length, sha256: meta.sha256, nonblack_pixels_gt48: nonblack });
    }
    summary.source_after = sourceHashes(); assert.deepEqual(summary.source_after, before, "production sources stable throughout proof");
    summary.http = { requests, request_bodies_identical: true, request_response_content_retained: false, login_requests: 1, room_requests: 4,
      automatic_retry_intervals_ms: [room[1].received_ms - room[0].socket_destroyed_ms, room[2].received_ms - room[1].socket_destroyed_ms],
      ack_release_to_request_ms: room[3].received_ms - ack.unix_ms };
    summary.private_save = { launch_count: save.launch_count, process_id: save.process_id, last_presented_state: save.last_presented_state };
    summary.ok = true;
  } catch (error) {
    failure = error; summary.failure = { name: error.name, message: error.message };
  } finally {
    await stopOwned(runner); await stopOwned(service);
    if (proxy) { proxy.closeAllConnections(); await new Promise((done) => proxy.close(done)); }
    // Logs may contain private fixture session tokens. Redact all exact issued
    // secrets before durable evidence, and do not persist request/response data.
    const hidden = [deviceToken, password];
    const secretPath = join(env.APPDATA, "pokemon-duel-modern/server-secrets.json");
    if (existsSync(secretPath)) {
      const collect = (value) => { if (typeof value === "string" && value.length >= 12) hidden.push(value); else if (value && typeof value === "object") Object.values(value).forEach(collect); };
      collect(JSON.parse(readFileSync(secretPath, "utf8")));
    }
    const sanitized = (text) => hidden.reduce((value, secret) => value.split(secret).join("[PRIVATE_FIXTURE_SECRET]"), text);
    writeFileSync(join(evidence, "godot.log"), sanitized(runner?.output || ""), { flag: "wx" });
    writeFileSync(join(evidence, "service.log"), sanitized(service?.output || ""), { flag: "wx" });
    summary.completed_utc = new Date().toISOString(); summary.duration_ms = Date.now() - started;
    summary.owned_children_closed = (!runner || runner.closed) && (!service || service.closed);
    summary.source_after ??= sourceHashes();
    summary.http ??= { requests, request_response_content_retained: false };
    writeJson(join(evidence, "verification.json"), summary);
    t.diagnostic(JSON.stringify({ ok: summary.ok, evidence, assertions: summary.result?.assertions ?? 0, failure: summary.failure ?? null, duration_ms: summary.duration_ms }));
    const target = resolve(directory); assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith("kiwi-core-tests-loading-ui-http-"));
    rmSync(target, { recursive: true, force: true });
  }
  if (failure) throw failure;
});
}
