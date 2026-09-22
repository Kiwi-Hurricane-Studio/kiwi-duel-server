import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { packagedMasterBinding, ROOM_GATE_NAMES } from "./bootstrap-readiness.mjs";

async function freePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => socket.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

test("isolated HTTP negotiation preserves v1 and returns truthful v2 catalogs/readiness without account mutation", { timeout: 20_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "kiwi-bootstrap-v2-"));
  const database = join(directory, "isolated.sqlite");
  const seeds = join(directory, "disposable-seed.json");
  const deviceToken = "bootstrap-v2-isolated-device-token";
  writeFileSync(seeds, JSON.stringify({ accounts: [{ email: "bootstrap-v2@example.test", displayName: "Bootstrap Test", password: "disposable-not-real-password", deviceToken }] }));
  const httpPort = await freePort();
  let gamePort = await freePort();
  while (gamePort === httpPort) gamePort = await freePort();
  const base = `http://127.0.0.1:${httpPort}`;
  // Never inherit a live path, seed list, production origin, or server port.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DUEL_") && key !== "NODE_ENV"));
  let child;
  try {
    child = spawn(process.execPath, [fileURLToPath(new URL("./custom-bootstrap-server.mjs", import.meta.url))], {
      env: { ...environment, NODE_ENV: "test", DUEL_SERVER_HOST: "127.0.0.1", DUEL_SERVER_PORT: String(httpPort),
        DUEL_SERVER_PUBLIC_BASE: base, DUEL_GAME_SERVER_HOST: "127.0.0.1", DUEL_GAME_SERVER_PORT: String(gamePort),
        DUEL_GAME_SERVER_PUBLIC_HOST: "127.0.0.1", DUEL_ACCOUNT_DATABASE: database, DUEL_SEED_ACCOUNTS_PATH: seeds },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let startupOutput = "";
    child.stdout.on("data", (bytes) => { startupOutput = (startupOutput + bytes).slice(-4096); });
    child.stderr.on("data", (bytes) => { startupOutput = (startupOutput + bytes).slice(-4096); });
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`isolated_server_exit_${child.exitCode}: ${startupOutput}`);
      try { ready = (await fetch(`${base}/healthz`).then((response) => response.json())).ok === true; } catch {}
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(ready, true, "isolated readiness server starts");
    const post = async (path, body = {}, token = "") => {
      const response = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const revisions = await post("/v1/bootstrap/revisions");
    assert.equal(revisions.status, 200);
    assert.equal(revisions.body.data.room_contract, 2);
    assert.equal(revisions.body.data.content, revisions.body.data.master_binding.content_revision);
    assert.deepEqual(revisions.body.data.master_binding, packagedMasterBinding());
    assert.equal((await post("/v1/bootstrap/room", { readiness_schema: 2 })).status, 401);
    const login = await post("/v1/session/login", { device_token: deviceToken });
    assert.equal(login.body.ok, true);
    const token = login.body.data.access_token;
    const snapshotBefore = (await post("/v1/account/me", {}, token)).body.data;
    const v1 = (await post("/v1/bootstrap/room", {}, token)).body.data;
    assert.equal(v1.schema, 1);
    assert.equal(v1.owner_user_id, undefined);
    assert.equal(v1.readiness, undefined);
    assert.ok(ROOM_GATE_NAMES.every((name) => v1.steps[name] === true));
    assert.equal(v1.models.figure_libraries.length, 6);
    const explicitV1 = (await post("/v1/bootstrap/room", { readiness_schema: 1 }, token)).body.data;
    assert.deepEqual(explicitV1, v1);
    const oldFigures = (await post("/v1/bootstrap/figures", {}, token)).body.data;
    assert.equal(oldFigures.length, 6);

    const v2 = (await post("/v1/bootstrap/room", { readiness_schema: 2 }, token)).body.data;
    assert.equal(v2.schema, 2);
    assert.equal(v2.owner_user_id, login.body.data.user.user_id);
    const spoofedOwner = (await post("/v1/bootstrap/room", { readiness_schema: 2, owner_user_id: 99999 }, token)).body.data;
    assert.equal(spoofedOwner.owner_user_id, login.body.data.user.user_id);
    assert.equal(v2.steps, undefined);
    assert.deepEqual(v2.master_binding, revisions.body.data.master_binding);
    assert.deepEqual(Object.keys(v2.readiness.steps).sort(), [...ROOM_GATE_NAMES].sort());
    assert.equal(v2.readiness.home_playtest_supported, true);
    assert.equal(v2.readiness.server_data_valid, true);
    assert.equal(v2.readiness.full_original_ready, false);
    assert.deepEqual(v2.readiness.errors, []);
    assert.deepEqual(v2.models.figures, v1.models.figures);
    assert.deepEqual(v2.models.plate_inventory, v1.models.plate_inventory);
    assert.deepEqual(v2.models.decks, v1.models.decks);
    assert.deepEqual(v2.models.figure_libraries, []);
    assert.equal(v2.models.user_arena.progression_supported, false);
    assert.equal(v2.readiness.steps.LoadUserTutorials.state, "unsupported");
    assert.equal(v2.readiness.steps.LoadChapterMasters.state, "pending");
    assert.equal(v2.readiness.steps.PreloadUsedScSeAndBootAndAdvSe.authority, "client");
    assert.equal(v2.readiness.steps.RefreshUserArenaEvent.state, "not_applicable");
    assert.equal(v2.models.service_policy.arena_events, "none");
    const fullFigures = (await post("/v1/bootstrap/figures", { readiness_schema: 2 }, token)).body.data;
    assert.equal(fullFigures.length, 583);
    assert.equal(fullFigures.find((master) => master.item_master_id === 0).playable, false);
    for (const figure of v2.models.figures) assert.ok(fullFigures.some((master) => master.item_master_id === figure.item_master_id && master.model_id === figure.model_id && master.render_available));
    for (const path of ["/v1/bootstrap/room", "/v1/bootstrap/figures"]) for (const readiness_schema of [3, "2", null]) {
      const denied = await post(path, { readiness_schema }, token);
      assert.equal(denied.status, 400);
      assert.equal(denied.body.error, "unsupported_readiness_schema");
    }
    const snapshotAfter = (await post("/v1/account/me", {}, token)).body.data;
    assert.deepEqual(snapshotAfter, snapshotBefore);
    assert.ok(readFileSync(database).length > 0);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 2000))]);
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await new Promise((resolve) => child.once("exit", resolve)); }
    }
    // Only the uniquely-created disposable fixture is removed; no live path is accepted.
    rmSync(directory, { recursive: true, force: true });
  }
});
