import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, symlink, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, basename, join, resolve } from "node:path";
import test from "node:test";
import { CONTENT_MAX_BLOB_BYTES, contentManifestReleaseId, contentModuleId, contentSha256 } from "./content-protocol.mjs";
import { ContentReleaseStore, createContentReleaseHandler } from "./content-release-store.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "kiwi-content-test-"));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("kiwi-content-test-"));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, "manifests"));
  await mkdir(join(root, "blobs"));
  return root;
}

export async function publishFixture(root, contents = "[gd_scene format=3]\n[node name=\"Game\" type=\"Node\"]\n", patch = {}) {
  const bytes = Buffer.from(contents), hash = contentSha256(bytes), path = "src/ui/app.tscn";
  await writeFile(join(root, "blobs", hash), bytes);
  const manifest = { schema: "kiwi-duel-content-1", runtime_abi: "godot-4.7.2", platform: "windows",
    entry_scene: `res://${path}`, files: [{ path, size: bytes.length, sha256: hash,
      md5: createHash("md5").update(bytes).digest("hex"), chunks: [{ sha256: hash, size: bytes.length }], operation: 2 }],
    modules: [{ id: contentModuleId(path, 0), version: hash, size: bytes.length }], ...patch };
  manifest.release_id = contentManifestReleaseId(manifest);
  const staging = join(root, "manifests", "windows.staging");
  await writeFile(staging, JSON.stringify(manifest));
  await rename(staging, join(root, "manifests", "windows.json"));
  return { manifest, bytes, hash };
}

async function serve(t, root) {
  const handler = await createContentReleaseHandler({ root });
  const server = createServer((request, response) => {
    void handler(request, response, new URL(request.url, "http://localhost")).then((handled) => {
      if (!handled) { response.writeHead(404); response.end(); }
    }).catch((error) => { response.destroy(error); });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(done); }));
  return `http://127.0.0.1:${server.address().port}`;
}

const manifestUrl = "/v1/content/manifest?platform=windows&runtime_abi=godot-4.7.2";

test("HTTP serves validated complete targets, immutable chunks, HEAD, ETag and resumable ranges", async (t) => {
  const root = await fixture(t), release = await publishFixture(root), base = await serve(t, root);
  const result = await fetch(base + manifestUrl);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), release.manifest);
  assert.equal(result.headers.get("cache-control"), "no-cache");
  assert.equal((await fetch(base + manifestUrl, { headers: { "If-None-Match": result.headers.get("etag") } })).status, 304);
  const blobUrl = base + "/v1/content/blobs/" + release.hash;
  const blob = await fetch(blobUrl);
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), release.bytes);
  assert.match(blob.headers.get("cache-control"), /immutable/);
  const head = await fetch(blobUrl, { method: "HEAD" });
  assert.equal(head.headers.get("content-length"), String(release.bytes.length));
  assert.equal(await head.text(), "");
  assert.equal((await fetch(blobUrl, { headers: { "If-None-Match": blob.headers.get("etag") } })).status, 304);
  for (const [range, expected] of [["bytes=2-5", release.bytes.subarray(2, 6)], ["bytes=-4", release.bytes.subarray(-4)], ["bytes=4-", release.bytes.subarray(4)]]) {
    const partial = await fetch(blobUrl, { headers: { Range: range, "If-Range": blob.headers.get("etag") } });
    assert.equal(partial.status, 206);
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), expected);
  }
  assert.equal((await fetch(blobUrl, { headers: { Range: "bytes=2-5", "If-Range": '"old"' } })).status, 200);
  for (const range of ["bytes=-0", "bytes=999999-", "bytes=3-1", "bytes=0-1,3-4", "not-a-range"]) {
    assert.equal((await fetch(blobUrl, { headers: { Range: range } })).status, 416);
  }
});

test("atomic replacement exposes the new target while previous immutable blobs remain downloadable", async (t) => {
  const root = await fixture(t), old = await publishFixture(root, "first release"), base = await serve(t, root);
  const first = await fetch(base + manifestUrl).then((r) => r.json());
  const latest = await publishFixture(root, "completely unrelated latest release");
  const second = await fetch(base + manifestUrl).then((r) => r.json());
  assert.notEqual(first.release_id, second.release_id);
  assert.equal(second.release_id, latest.manifest.release_id);
  assert.equal(await fetch(base + "/v1/content/blobs/" + old.hash).then((r) => r.text()), "first release");
});

test("cached manifests fail closed for corrupted, absent, oversized or mismatched target files and recover after repair", async (t) => {
  const root = await fixture(t), release = await publishFixture(root), base = await serve(t, root);
  assert.equal((await fetch(base + manifestUrl)).status, 200);
  const blobFile = join(root, "blobs", release.hash);
  await writeFile(blobFile, Buffer.alloc(release.bytes.length, 1));
  assert.equal((await fetch(base + manifestUrl)).status, 503);
  assert.equal((await fetch(base + "/v1/content/blobs/" + release.hash)).status, 503);
  await writeFile(blobFile, release.bytes);
  assert.equal((await fetch(base + manifestUrl)).status, 200);
  await rm(blobFile);
  assert.equal((await fetch(base + manifestUrl)).status, 503);
  assert.equal((await fetch(base + "/v1/content/blobs/" + release.hash)).status, 404);
  await writeFile(blobFile, release.bytes);
  const sparse = await open(blobFile, "w");
  await sparse.truncate(CONTENT_MAX_BLOB_BYTES + 1); await sparse.close();
  assert.equal((await fetch(base + manifestUrl)).status, 503);
  assert.equal((await fetch(base + "/v1/content/blobs/" + release.hash)).status, 503);
  await writeFile(blobFile, release.bytes);
  const target = structuredClone(release.manifest);
  target.files[0].sha256 = "1".repeat(64);
  target.release_id = contentManifestReleaseId(target);
  await writeFile(join(root, "manifests", "windows.json"), JSON.stringify(target));
  assert.equal((await fetch(base + manifestUrl)).status, 503, "valid chunk hashes cannot conceal an inconsistent reconstructed target digest");
});

test("no account or predecessor is required; platform, ABI, methods and unsafe paths reject precisely", async (t) => {
  const root = await fixture(t); await publishFixture(root); const base = await serve(t, root);
  assert.equal((await fetch(base + manifestUrl)).status, 200);
  const mismatch = await fetch(base + manifestUrl.replace("godot-4.7.2", "old-runtime"));
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json()).required_runtime_abi, "godot-4.7.2");
  assert.equal((await fetch(base + manifestUrl.replace("windows", "android"))).status, 404);
  assert.equal((await fetch(base + manifestUrl.replace("windows", "../../private"))).status, 400);
  assert.equal((await fetch(base + "/v1/content/manifest?platform=windows")).status, 400);
  assert.equal((await fetch(base + manifestUrl, { method: "POST", body: "test" })).status, 405);
  for (const path of ["fake.json", "%2e%2e%2fmanifests%2fwindows.json", "a".repeat(63), "a".repeat(65), "a".repeat(64) + "/tail"]) {
    assert.equal((await fetch(base + "/v1/content/blobs/" + path)).status, 404);
  }
  const disabled = await serve(t, "");
  assert.equal((await fetch(disabled + manifestUrl)).status, 404);
});

test("manifest parse failures and missing delta blobs never publish a partial release", async (t) => {
  const root = await fixture(t), release = await publishFixture(root), base = await serve(t, root);
  await writeFile(join(root, "manifests", "windows.json"), "{broken");
  assert.equal((await fetch(base + manifestUrl)).status, 503);
  const target = release.manifest;
  target.files[0].delta = { base_sha256: contentSha256("x"), base_size: 1, offset: 0, remove_size: 1, sha256: contentSha256("missing"), size: release.bytes.length };
  await writeFile(join(root, "manifests", "windows.json"), JSON.stringify(target));
  assert.equal((await fetch(base + manifestUrl)).status, 503);
});

test("junction roots and blob directories reject before serving redirected data", async (t) => {
  const root = await fixture(t), other = await fixture(t);
  await publishFixture(root); await publishFixture(other);
  const redirected = join(root, "redirected");
  await symlink(other, redirected, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(ContentReleaseStore.open(redirected), /content_directory_invalid/);
  const base = await serve(t, root);
  await rename(join(root, "blobs"), join(root, "original-blobs"));
  await symlink(join(other, "blobs"), join(root, "blobs"), process.platform === "win32" ? "junction" : "dir");
  assert.equal((await fetch(base + manifestUrl)).status, 503);
  const manifest = JSON.parse(await readFile(join(root, "manifests", "windows.json"), "utf8"));
  assert.equal((await fetch(base + "/v1/content/blobs/" + manifest.files[0].sha256)).status, 503);
});
