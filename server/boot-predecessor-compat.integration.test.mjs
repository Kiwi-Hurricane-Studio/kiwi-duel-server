import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const godot = join(project, ".tools/godot/Godot_v4.7.2-stable_win64_console.exe");
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function freePort() {
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((done) => socket.close(done));
  return port;
}

function start(executable, arguments_, environment) {
  const child = spawn(executable, arguments_, { cwd: project, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const state = { child, output: "" };
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { state.output = (state.output + data).slice(-1_000_000); });
  return state;
}

async function stop(state) {
  if (!state || state.child.exitCode !== null || state.child.signalCode !== null) return;
  const exit = once(state.child, "exit");
  state.child.kill("SIGTERM");
  await Promise.race([exit, delay(2000)]);
  if (state.child.exitCode === null && state.child.signalCode === null) { state.child.kill("SIGKILL"); await exit; }
}

test("actual predecessor HTTP payloads join safely; legacy duplicate projection does not weaken global or ownership checks", {
  timeout: 30000, skip: !existsSync(godot) ? "pinned Godot required" : false,
}, async (t) => {
  // Read-only preflight: do not let this fixture repair or rewrite the shared editor profile.
  const editorSettings = readFileSync(join(project, ".tools/godot/editor_data/editor_settings-4.7.tres"), "utf8");
  assert.match(editorSettings, /^export\/android\/shutdown_adb_on_exit\s*=\s*false\s*$/mu);
  const directory = mkdtempSync(join(tmpdir(), "kiwi-predecessor-compat-"));
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DUEL_") && key !== "NODE_ENV"));
  const secret = "isolated-predecessor-test-device";
  const password = "isolated-predecessor-not-real-password";
  const seedPath = join(directory, "private-seeds.json");
  const fixturePath = join(directory, "private-fixture.json");
  writeFileSync(seedPath, JSON.stringify({ accounts: [{ email: "predecessor-fixture@example.test", displayName: "Predecessor Fixture", password, deviceToken: secret }] }));
  let server;
  let runner;
  try {
    const port = await freePort();
    let gamePort = await freePort();
    while (port === gamePort) gamePort = await freePort();
    const base = `http://127.0.0.1:${port}`;
    server = start(process.execPath, [join(project, "server/custom-bootstrap-server.mjs")], {
      ...environment, NODE_ENV: "test", DUEL_SERVER_HOST: "127.0.0.1", DUEL_SERVER_PORT: String(port), DUEL_SERVER_PUBLIC_BASE: base,
      DUEL_GAME_SERVER_HOST: "127.0.0.1", DUEL_GAME_SERVER_PORT: String(gamePort), DUEL_GAME_SERVER_PUBLIC_HOST: "127.0.0.1",
      DUEL_ACCOUNT_DATABASE: join(directory, "fixture.sqlite"), DUEL_SEED_ACCOUNTS_PATH: seedPath,
    });
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      assert.equal(server.child.exitCode, null, "isolated server must remain alive");
      try { ready = (await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(300) }).then((r) => r.json())).ok; } catch {}
      if (ready) break;
      await delay(20);
    }
    assert.equal(ready, true);
    let token = "";
    const api = async (path, body = {}) => {
      const response = await fetch(`${base}${path}`, { method: "POST", signal: AbortSignal.timeout(5000),
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
      const value = await response.json();
      assert.equal(response.status, 200, `${path} response status`);
      assert.equal(value.ok, true, `${path} ${value.error ?? ""}`);
      return value.data;
    };
    const login = await api("/v1/session/login", { device_token: secret });
    token = login.access_token;
    const predecessorRevisions = { schema: 2, content: 2, figures: 2, localization: 1 };
    const resources = async (version) => ({
      login: { user: { user_id: login.user.user_id } },
      revision_master: version === 1 ? predecessorRevisions : await api("/v1/bootstrap/revisions"),
      figure_masters: await api("/v1/bootstrap/figures", version === 1 ? {} : { readiness_schema: 2 }),
      room_preload: await api("/v1/bootstrap/room", version === 1 ? {} : { readiness_schema: 2 }),
    });
    const baseline = await resources(1);
    const v2 = await resources(2);
    assert.equal(baseline.room_preload.schema, 1);
    assert.equal(baseline.room_preload.readiness, undefined);
    assert.equal(baseline.figure_masters.length, baseline.room_preload.models.figures.length);
    const decks = baseline.room_preload.models.decks;
    assert.equal(decks.length, 5);
    const update = async (deck, figures) => api("/v1/decks/update", { deck_no: deck.deck_no, figures, plates: [] });
    await update(decks[0], decks[0].figures.slice(0, 5));
    const onePartial = await resources(1);
    for (const deck of decks.slice(1)) await update(deck, deck.figures.slice(0, 5));
    const allPartial = await resources(1);
    assert.ok(allPartial.room_preload.models.decks.every((deck) => deck.figures.length === 5));
    for (const deck of decks) await update(deck, []);
    const allEmpty = await resources(1);
    assert.ok(allEmpty.room_preload.models.decks.every((deck) => deck.figures.length === 0));
    const invalidMatch = await fetch(`${base}/v1/matching/entry`, {
      method: "POST", signal: AbortSignal.timeout(5000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ deckNo: 0, alterEntryFeeItemMasterId: 0, arenaEventMasterId: "", mode: "training" }),
    });
    assert.equal(invalidMatch.status, 400, "empty deck cannot enter a match while recovery remains available");
    assert.equal((await invalidMatch.json()).error, "battle_deck_requires_six_figures");
    writeFileSync(fixturePath, JSON.stringify({ isolation_root: directory, base_url: base, device_token: secret, baseline, v2, one_partial: onePartial, all_partial: allPartial, all_empty: allEmpty }));
    const roaming = join(directory, "roaming");
    const xdg = join(directory, "xdg");
    mkdirSync(roaming); mkdirSync(xdg);
    runner = start(godot, ["--headless", "--path", project, "--log-file", join(directory, "godot-private.log"),
      "--script", "res://tests/boot_predecessor_compat_runner.gd", "--", `--predecessor-fixture=${fixturePath}`], {
      ...environment, APPDATA: roaming, XDG_DATA_HOME: xdg,
    });
    const deadline = Date.now() + 20000;
    while (runner.child.exitCode === null && runner.child.signalCode === null) {
      if (Date.now() > deadline) throw Error("isolated_validator_timeout");
      await delay(20);
    }
    for (const privateValue of [secret, password, token]) {
      assert.equal(server.output.includes(privateValue), false);
      assert.equal(runner.output.includes(privateValue), false);
    }
    const line = runner.output.split(/\r?\n/u).find((entry) => entry.startsWith("BOOT_PREDECESSOR_COMPAT="));
    assert.ok(line, runner.output.split(/\r?\n/u).filter((entry) => /SCRIPT ERROR|Parse Error|ERROR:|at:/.test(entry)).join(" | "));
    const proof = JSON.parse(line.slice("BOOT_PREDECESSOR_COMPAT=".length));
    t.diagnostic(JSON.stringify(proof));
    assert.equal(proof.ok, true, proof.failures.join("; "));
    assert.equal(runner.child.exitCode, 0);
    assert.equal(proof.checks, 30);
    assert.equal(proof.godot_network_requests, proof.godot_network_operations.length);
    for (const operation of ["service_state", "revision_master", "login", "localization", "asset_manifest", "figure_masters", "refresh_user", "room_preload"]) {
      assert.equal(proof.godot_network_operations.filter((value) => value === operation).length, 2, `both real HTTP boot pipelines require ${operation}`);
    }
    assert.equal(proof.godot_network_operations.filter((value) => value === "deck_update").length, 1, "one acknowledged repair request");
    assert.equal(proof.godot_network_operations.filter((value) => value === "asset").length, 2, "both boots verify the actual content download");
    assert.deepEqual(proof.pipeline_recovery.before_repair, {
      ready: true, home_ready: false, scope: "validated_account_recovery", deck_recovery_required: true,
      full_original_ready: false, home_deck_numbers: [],
    });
    assert.deepEqual(proof.pipeline_recovery.after_acknowledged_repair, {
      ready: true, home_ready: true, scope: "validated_home_playtest", deck_recovery_required: false,
      full_original_ready: false, home_deck_numbers: [1],
    });
    const persistedRepair = await resources(1);
    assert.equal(persistedRepair.room_preload.models.figures.length, baseline.room_preload.models.figures.length, "repair does not manufacture inventory");
    assert.equal(persistedRepair.room_preload.models.decks[0].figures.length, 6);
    assert.ok(persistedRepair.room_preload.models.decks.slice(1).every((deck) => deck.figures.length === 0), "other empty saved deck cases remain untouched");
  } finally {
    await stop(runner);
    await stop(server);
    // Never accept a cleanup path from an environment variable or fixture input.
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.startsWith(join(tmpdir(), "kiwi-predecessor-compat-"))) throw Error("fixture_cleanup_boundary");
    rmSync(directory, { recursive: true, force: true });
  }
});
