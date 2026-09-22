import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { contentManifestReleaseId, contentModuleId, contentSha256 } from "./content-protocol.mjs";

async function freePort() {
  const socket = createServer();
  await new Promise((done) => socket.listen(0, "127.0.0.1", done));
  const port = socket.address().port;
  await new Promise((done) => socket.close(done));
  return port;
}

for (const enabled of [true, false]) test(`actual bootstrap process serves content before login, configured=${enabled}`, { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "kiwi-content-http-"));
  let child;
  try {
    const content = join(root, "content");
    await mkdir(join(content, "manifests"), { recursive: true });
    await mkdir(join(content, "blobs"));
    const bytes = Buffer.from("[gd_scene format=3]\n[node name=\"Game\" type=\"Node\"]\n");
    const path = "src/ui/app.tscn", hash = contentSha256(bytes);
    const manifest = { schema: "kiwi-duel-content-1", platform: "windows", runtime_abi: "godot-4.7.2", entry_scene: `res://${path}`,
      files: [{ path, sha256: hash, md5: createHash("md5").update(bytes).digest("hex"), size: bytes.length,
        chunks: [{ sha256: hash, size: bytes.length }], operation: 2 }],
      modules: [{ id: contentModuleId(path, 0), version: hash, size: bytes.length }] };
    manifest.release_id = contentManifestReleaseId(manifest);
    await writeFile(join(content, "blobs", hash), bytes);
    await writeFile(join(content, "manifests", "windows.json"), JSON.stringify(manifest));
    const port = await freePort(), base = `http://127.0.0.1:${port}`;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DUEL_|NODE_OPTIONS$|NODE_PATH$|NODE_ENV$)/i.test(key)));
    child = spawn(process.execPath, [fileURLToPath(new URL("./custom-bootstrap-server.mjs", import.meta.url))], {
      env: { ...env, NODE_ENV: "test", DUEL_SERVER_HOST: "127.0.0.1", DUEL_SERVER_PORT: String(port),
        DUEL_SERVER_PUBLIC_BASE: base, DUEL_GAME_SERVER_HOST: "127.0.0.1", DUEL_GAME_SERVER_PORT: "0",
        DUEL_GAME_SERVER_PUBLIC_HOST: "127.0.0.1", DUEL_ACCOUNT_DATABASE: join(root, "disposable.sqlite"),
        ...(enabled ? { DUEL_CONTENT_ROOT: content } : {}) }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let output = "", ready = false;
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (bytes) => { output = (output + bytes).slice(-4096); });
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`isolated_server_exit: ${output}`);
      try { ready = (await fetch(base + "/healthz").then((r) => r.json())).data.content_updates === enabled; } catch {}
      if (ready) break;
      await new Promise((done) => setTimeout(done, 30));
    }
    assert.equal(ready, true, output);
    const result = await fetch(base + "/v1/content/manifest?platform=windows&runtime_abi=godot-4.7.2");
    assert.equal(result.status, enabled ? 200 : 404);
    if (enabled) {
      assert.deepEqual(await result.json(), manifest);
      const blob = await fetch(base + "/v1/content/blobs/" + hash);
      assert.equal(blob.status, 200);
      assert.deepEqual(Buffer.from(await blob.arrayBuffer()), bytes);
    }
    const revisions = await fetch(base + "/v1/bootstrap/revisions", { method: "POST", body: "{}" }).then((r) => r.json());
    assert.equal(revisions.ok, true);
    assert.equal(revisions.data.room_contract, 2);
    assert.equal((await fetch(base + "/v1/bootstrap/room", { method: "POST", body: "{}" })).status, 401);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([new Promise((done) => child.once("exit", done)), new Promise((done) => setTimeout(done, 2000))]);
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await new Promise((done) => child.once("exit", done)); }
    }
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("kiwi-content-http-"));
    await rm(root, { recursive: true, force: true });
  }
});
