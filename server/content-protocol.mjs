// Shared, dependency-free validation for the publisher and portable HTTP server.
// Transport trust is supplied by the configured HTTPS origin; hashes provide integrity.
import crypto from 'node:crypto';

export const CONTENT_SCHEMA = 'kiwi-duel-content-1';
export const CONTENT_RUNTIME_ABI = 'godot-4.7.2';
export const CONTENT_MAX_BLOB_BYTES = 20_000_000;
export const CONTENT_MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
export const CONTENT_MAX_FILE_BYTES = 1024 ** 3;
export const CONTENT_MAX_TOTAL_BYTES = 8 * 1024 ** 3;
export const CONTENT_CHUNK_BYTES = 1024 * 1024;
const SHA = /^[0-9a-f]{64}$/;
const MD5 = /^[0-9a-f]{32}$/;
const check = (condition, message) => { if (!condition) throw new Error(`Invalid content manifest: ${message}`); };
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export const contentSha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

export function contentResourcePath(value) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 512, 'resource path length');
  check(!/[\\:?#%"<>|*\u0000-\u001f\u007f]/u.test(value) && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part)), 'noncanonical resource path');
  check(!/^(?:shell|src\/update)(?:\/|$)/i.test(value), 'reserved launcher resource path');
  check(!/\.(?:exe|dll|so|dylib|gdextension)(?:\.|$)/i.test(value), 'native extensions require a shell release');
  return value;
}

export function contentModuleId(resourcePath, index) {
  return `${contentSha256(resourcePath)}:${index}`;
}

// Sorting object keys makes publisher metadata order irrelevant. The release ID binds
// the complete target, not an optional optimization from one particular predecessor.
export function canonicalContentJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalContentJson).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalContentJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function contentManifestReleaseId(manifest) {
  const target = {
    schema: manifest.schema, runtime_abi: manifest.runtime_abi, platform: manifest.platform,
    entry_scene: manifest.entry_scene,
    files: manifest.files.map(({ path, size, sha256, md5, chunks }) => ({ path, size, sha256, md5, chunks }))
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  };
  return contentSha256(canonicalContentJson(target));
}

export function validateContentManifest(manifest, { platform } = {}) {
  check(object(manifest), 'object required');
  check(Buffer.byteLength(JSON.stringify(manifest)) <= CONTENT_MAX_MANIFEST_BYTES, 'manifest exceeds 16 MiB');
  check(manifest.schema === CONTENT_SCHEMA, 'schema');
  check(manifest.runtime_abi === CONTENT_RUNTIME_ABI, 'runtime ABI');
  check(['windows', 'android'].includes(manifest.platform) && (!platform || manifest.platform === platform), 'platform');
  check(SHA.test(manifest.release_id), 'release ID');
  check(typeof manifest.entry_scene === 'string' && manifest.entry_scene.startsWith('res://'), 'entry scene');
  const entry = contentResourcePath(manifest.entry_scene.slice(6));
  check(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= 100000, 'file count');
  check(Array.isArray(manifest.modules) && manifest.modules.length <= 1000000, 'module count');
  const paths = new Set(), blobSizes = new Map(), expectedModules = new Map();
  let total = 0;
  const admitBlob = (sha256, size, min = 1) => {
    check(SHA.test(sha256) && integer(size, min, CONTENT_MAX_BLOB_BYTES), 'blob hash or size');
    check(!blobSizes.has(sha256) || blobSizes.get(sha256) === size, 'conflicting blob sizes');
    blobSizes.set(sha256, size);
  };
  for (const file of manifest.files) {
    check(object(file), 'file object');
    const resourcePath = contentResourcePath(file.path), folded = resourcePath.toLowerCase();
    check(!paths.has(folded), 'duplicate resource path'); paths.add(folded);
    check(integer(file.size, 0, CONTENT_MAX_FILE_BYTES), 'file size'); total += file.size;
    check(total <= CONTENT_MAX_TOTAL_BYTES, 'total size');
    check(SHA.test(file.sha256) && MD5.test(file.md5), 'file digest');
    check([1, 2, 3].includes(file.operation), 'operation');
    check(Array.isArray(file.chunks) && file.chunks.length <= 1000000, 'chunk list');
    let size = 0;
    file.chunks.forEach((chunk, index) => {
      check(object(chunk), 'chunk object'); admitBlob(chunk.sha256, chunk.size); size += chunk.size;
      expectedModules.set(contentModuleId(resourcePath, index), { path: resourcePath, version: chunk.sha256, size: chunk.size });
    });
    check(size === file.size, 'chunk sizes do not reconstruct file');
    if (file.size === 0) check(file.sha256 === contentSha256('') && file.md5 === 'd41d8cd98f00b204e9800998ecf8427e', 'empty file digest');
    if (file.delta !== undefined) {
      const delta = file.delta;
      check(object(delta) && file.operation !== 1, 'deletions require full replacement');
      check(SHA.test(delta.base_sha256) && delta.base_sha256 !== file.sha256, 'delta base digest');
      check(integer(delta.base_size, 0, CONTENT_MAX_FILE_BYTES) && integer(delta.offset, 0, delta.base_size), 'delta base or offset');
      check(integer(delta.remove_size, 0, delta.base_size - delta.offset), 'delta removal range');
      admitBlob(delta.sha256, delta.size, 0);
      check(delta.base_size - delta.remove_size + delta.size === file.size, 'delta result size');
      if (file.operation === 3) check(delta.offset === delta.base_size && delta.remove_size === 0, 'append must preserve entire base');
    }
  }
  check(paths.has(entry.toLowerCase()) || paths.has(`${entry}.remap`.toLowerCase()), 'entry scene absent');
  check(manifest.modules.length === expectedModules.size, 'module count does not match chunks');
  const moduleIds = new Set();
  for (const module of manifest.modules) {
    check(object(module) && typeof module.id === 'string' && !moduleIds.has(module.id), 'module ID'); moduleIds.add(module.id);
    const expected = expectedModules.get(module.id);
    check(expected && module.version === expected.version && module.size === expected.size, 'module does not match resource chunk');
    if (module.path !== undefined) check(module.path === expected.path, 'module resource path');
    if (module.group !== undefined) check(typeof module.group === 'string' && /^[a-z0-9_-]{1,40}$/.test(module.group), 'module group');
  }
  if (manifest.removed !== undefined) {
    check(Array.isArray(manifest.removed) && manifest.removed.length <= 100000, 'removed file count');
    const removedPaths = new Set();
    for (const removed of manifest.removed) {
      check(object(removed) && removed.operation === 1, 'removed file marker');
      const folded = contentResourcePath(removed.path).toLowerCase();
      check(!paths.has(folded) && !removedPaths.has(folded), 'conflicting removed resource'); removedPaths.add(folded);
    }
  }
  check(manifest.release_id === contentManifestReleaseId(manifest), 'release ID does not match target');
  return manifest;
}
