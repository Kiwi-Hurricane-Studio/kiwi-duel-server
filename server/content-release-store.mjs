import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { parse, resolve, join, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { CONTENT_MAX_BLOB_BYTES, CONTENT_MAX_MANIFEST_BYTES, validateContentManifest } from "./content-protocol.mjs";

const digestPattern = /^[a-f0-9]{64}$/;
const platforms = new Set(["windows", "android"]);
const fingerprint = (info) => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
const recentlyChanged = (info) => Date.now() - Number(info.mtimeNs / 1_000_000n) < 2000
  || Date.now() - Number(info.ctimeNs / 1_000_000n) < 2000;

function fault(code, status = 503) {
  return Object.assign(new Error(code), { contentStatus: status });
}

async function requireDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw fault("content_directory_invalid");
}

async function verifyRoot(root) {
  const prefix = parse(root).root;
  let current = prefix;
  for (const component of root.slice(prefix.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    await requireDirectory(current);
  }
  await requireDirectory(join(root, "manifests"));
  await requireDirectory(join(root, "blobs"));
}

// Every target is chosen from a platform/hash allowlist, never a request path.
// Recheck the directory and final file to reject junction/symlink publication.
async function openRegular(root, directory, name, maximum) {
  await requireDirectory(root);
  await requireDirectory(join(root, directory));
  const path = join(root, directory, name);
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maximum)) throw fault("content_file_invalid");
  const file = await open(path, "r");
  try {
    const info = await file.stat({ bigint: true });
    if (!info.isFile() || fingerprint(info) !== fingerprint(before)) throw fault("content_file_changed");
    return { file, info, signature: fingerprint(info) };
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function readBounded(file, maximum) {
  const chunks = [];
  let length = 0;
  for await (const bytes of file.createReadStream({ autoClose: false, start: 0, end: maximum })) {
    length += bytes.length;
    if (length > maximum) throw fault("content_file_too_large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
}

async function mapBounded(values, visit) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, values.length) }, async () => {
    while (next < values.length) await visit(values[next++]);
  }));
}

export class ContentReleaseStore {
  #root;
  #verified = new Map();
  #manifests = new Map();

  constructor(root) { this.#root = resolve(root); }

  static async open(root) {
    if (typeof root !== "string" || !root.trim()) throw fault("content_root_required");
    const store = new ContentReleaseStore(root);
    await verifyRoot(store.#root);
    return store;
  }

  async #verifiedBlob(hash, expectedSize, forceHash = false) {
    if (!digestPattern.test(hash)) throw fault("content_blob_not_found", 404);
    let record;
    try { record = await openRegular(this.#root, "blobs", hash, CONTENT_MAX_BLOB_BYTES); }
    catch (error) { if (error.code === "ENOENT") throw fault("content_blob_not_found", 404); throw error; }
    const { file, info, signature } = record;
    try {
      if (expectedSize !== undefined && info.size !== BigInt(expectedSize)) throw fault("content_blob_size_mismatch");
      // NTFS can coalesce timestamps for rapid same-length writes. Do not reuse
      // metadata verification until a newly published file has settled; direct
      // blob downloads always hash their opened descriptor before responding.
      if (forceHash || recentlyChanged(info) || this.#verified.get(hash) !== signature) {
        const digest = createHash("sha256");
        let size = 0;
        for await (const bytes of file.createReadStream({ autoClose: false, start: 0, end: CONTENT_MAX_BLOB_BYTES })) {
          size += bytes.length;
          if (size > CONTENT_MAX_BLOB_BYTES) throw fault("content_blob_too_large");
          digest.update(bytes);
        }
        if (digest.digest("hex") !== hash || size !== Number(info.size)
          || fingerprint(await file.stat({ bigint: true })) !== signature) throw fault("content_blob_corrupt");
        // Bound metadata even when old release blobs are queried indefinitely.
        if (this.#verified.size >= 65536) this.#verified.clear();
        this.#verified.set(hash, signature);
      }
      return record;
    } catch (error) { await file.close(); throw error; }
  }

  async manifest(platform, runtimeAbi) {
    if (!platforms.has(platform)) throw fault("content_platform_unsupported", 400);
    if (typeof runtimeAbi !== "string" || !runtimeAbi || runtimeAbi.length > 128) throw fault("content_runtime_abi_required", 400);
    let record;
    try { record = await openRegular(this.#root, "manifests", `${platform}.json`, CONTENT_MAX_MANIFEST_BYTES); }
    catch (error) { if (error.code === "ENOENT") throw fault("content_release_unavailable", 404); throw error; }
    let release;
    try {
      release = this.#manifests.get(platform);
      if (!release || recentlyChanged(record.info) || release.signature !== record.signature) {
        const body = await readBounded(record.file, CONTENT_MAX_MANIFEST_BYTES);
        if (fingerprint(await record.file.stat({ bigint: true })) !== record.signature) throw fault("content_manifest_changed");
        const document = validateContentManifest(JSON.parse(body.toString("utf8")), { platform });
        release = { body, document, etag: `"${createHash("sha256").update(body).digest("hex")}"`, signature: record.signature };
      }
    } catch { throw fault("content_manifest_invalid"); }
    finally { await record.file.close(); }
    if (release.document.runtime_abi !== runtimeAbi) {
      throw Object.assign(fault("content_runtime_incompatible", 409), { requiredRuntimeAbi: release.document.runtime_abi });
    }
    const required = new Map();
    for (const file of release.document.files) {
      for (const chunk of file.chunks) required.set(chunk.sha256, chunk.size);
      if (file.delta) required.set(file.delta.sha256, file.delta.size);
    }
    try {
      await mapBounded([...required], async ([hash, size]) => {
        const blob = await this.#verifiedBlob(hash, size);
        await blob.file.close();
      });
      if (!release.targetValidated) {
        await mapBounded(release.document.files, async (entry) => {
          const sha256 = createHash("sha256"), md5 = createHash("md5");
          for (const chunk of entry.chunks) {
            const blob = await this.#verifiedBlob(chunk.sha256, chunk.size);
            try {
              for await (const bytes of blob.file.createReadStream({ autoClose: false, start: 0, end: chunk.size - 1 })) {
                sha256.update(bytes); md5.update(bytes);
              }
            } finally { await blob.file.close(); }
          }
          if (sha256.digest("hex") !== entry.sha256 || md5.digest("hex") !== entry.md5) throw fault("content_target_corrupt");
        });
        release.targetValidated = true;
      }
    } catch { throw fault("content_release_incomplete"); }
    this.#manifests.set(platform, release);
    return release;
  }

  async blob(hash) { return this.#verifiedBlob(hash, undefined, true); }
}

function sendJson(response, status, body, method) {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": bytes.length,
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(method === "HEAD" ? undefined : bytes);
}

function requestedRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header || "");
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[2] && match[1] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start
    || (!match[1] && Number(match[2]) === 0)) return null;
  return { start, end: Math.min(end, size - 1) };
}

// Content discovery deliberately precedes login: even an old account client
// must obtain the code/data needed to speak the selected server's protocol.
export async function createContentReleaseHandler({ root = "" } = {}) {
  const store = root ? await ContentReleaseStore.open(root) : null;
  return async function handleContent(request, response, url) {
    if (url.pathname !== "/v1/content/manifest" && !url.pathname.startsWith("/v1/content/blobs/")) return false;
    try {
      if (!["GET", "HEAD"].includes(request.method)) {
        response.setHeader("Allow", "GET, HEAD");
        request.resume();
        throw fault("method_not_allowed", 405);
      }
      if (!store) throw fault("content_updates_not_configured", 404);
      if (url.pathname === "/v1/content/manifest") {
        const release = await store.manifest(url.searchParams.get("platform"), url.searchParams.get("runtime_abi"));
        const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache",
          "ETag": release.etag, "X-Content-Type-Options": "nosniff" };
        if (request.headers["if-none-match"] === release.etag) { response.writeHead(304, headers); response.end(); }
        else { response.writeHead(200, { ...headers, "Content-Length": release.body.length }); response.end(request.method === "HEAD" ? undefined : release.body); }
      } else {
        const hash = url.pathname.slice("/v1/content/blobs/".length);
        const { file, info } = await store.blob(hash);
        try {
          const size = Number(info.size);
          const etag = `"${hash}"`;
          const headers = { "Content-Type": "application/octet-stream", "Cache-Control": "public, max-age=31536000, immutable",
            "ETag": etag, "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff" };
          if (request.headers["if-none-match"] === etag) { response.writeHead(304, headers); response.end(); return true; }
          let range;
          if (request.headers.range && (!request.headers["if-range"] || request.headers["if-range"] === etag)) {
            range = requestedRange(request.headers.range, size);
            if (!range) {
              response.writeHead(416, { ...headers, "Content-Range": `bytes */${size}`, "Content-Length": 0 });
              response.end(); return true;
            }
          }
          response.writeHead(range ? 206 : 200, { ...headers,
            "Content-Length": range ? range.end - range.start + 1 : size,
            ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${size}` } : {}) });
          if (request.method === "HEAD" || size === 0) response.end();
          else await pipeline(file.createReadStream({ autoClose: false, start: range?.start ?? 0, end: range?.end ?? size - 1 }), response);
        } finally { await file.close(); }
      }
    } catch (error) {
      if (response.headersSent) response.destroy();
      else sendJson(response, error.contentStatus || 503, { ok: false, error: error.contentStatus ? error.message : "content_release_unavailable",
        ...(error.requiredRuntimeAbi ? { required_runtime_abi: error.requiredRuntimeAbi } : {}) }, request.method);
    }
    return true;
  };
}
