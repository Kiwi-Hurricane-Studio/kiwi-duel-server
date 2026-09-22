import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateProductionConfig } from "./production-config.mjs";

const directory = fileURLToPath(new URL("./", import.meta.url));
const project = resolve(directory, "../..");
const read = (name) => readFileSync(resolve(directory, name), "utf8");
const compose = JSON.parse(read("compose.json"));
function environment() {
  return Object.fromEntries(Object.entries(compose.services.app.environment).map(([key, value]) => [key,
    value.replace(/\$\{DUEL_PUBLIC_HOST:[^}]+\}/g, "duel.kiwi-games.net")
      .replace(/\$\{DUEL_CHEST_UNLOCK_MS:[^}]+\}/g, "3600000")]));
}

test("production defaults validate before startup with explicit public host and chest policy", () => {
  const result = validateProductionConfig(environment(), "24.19.0");
  assert.equal(result.public_origin, "https://duel.kiwi-games.net");
  assert.equal(result.private_game_port, 8081);
  const startup = read("start-production.mjs");
  assert.ok(startup.indexOf("validateProductionConfig(process.env)") < startup.indexOf('import("../custom-bootstrap-server.mjs")'));
  assert.ok(startup.includes("process.umask(0o077)"));
  assert.ok(startup.includes("info.isSymbolicLink()"));
});

test("production rejects insecure or misrouted configuration before any listener/database is opened", () => {
  const cases = {
    NODE_ENV: ["", "development"],
    DUEL_PUBLIC_HOST: ["localhost", "127.0.0.1", "duel.local", "replace.invalid", "example.com", "a.example.org", "bad/host.net", "USER:PASS@host.net", "Upper.host.net", "https://host.net", "host.net:443", "host.net\nother.net"],
    DUEL_SERVER_PUBLIC_BASE: ["http://duel.kiwi-games.net", "https://duel.kiwi-games.net/extra", "https://duel.kiwi-games.net?secret=oops", "https://elsewhere.net"],
    DUEL_SERVER_HOST: ["0.0.0.0", "::"], DUEL_SERVER_PORT: ["80", "8080oops"],
    DUEL_GAME_SERVER_HOST: ["0.0.0.0", "::"], DUEL_GAME_SERVER_PORT: ["443", "8081oops"],
    DUEL_GAME_SERVER_PUBLIC_HOST: ["localhost", "another.net"],
    DUEL_ACCOUNT_DATABASE: ["server/runtime/live.sqlite", ":memory:", "/tmp/database.sqlite"],
    DUEL_BACKUP_DIRECTORY: ["/tmp", ""], DUEL_TRUSTED_PROXY_ADDRESSES: ["", "0.0.0.0", "127.0.0.1,10.0.0.1"],
    DUEL_DEFAULT_MATCH_MODE: ["training", ""], DUEL_SEED_ACCOUNTS_PATH: ["private-seed.json"],
    DUEL_GAME_BATTLE_EVIDENCE_MODE: ["on"], DUEL_GAME_OPPONENT_PLATE_MODE: ["on"],
    DUEL_CHEST_UNLOCK_MS: ["", "NaN", "-1", "0", "999", "604800001", "3600000ms"],
  };
  for (const [key, values] of Object.entries(cases)) {
    for (const value of values) assert.throws(() => validateProductionConfig({ ...environment(), [key]: value }, "24.19.0"), undefined, key);
  }
  for (const version of ["22.16.0", "23.8.0", "25.0.0"]) assert.throws(() => validateProductionConfig(environment(), version), /node_24/);
});

test("only HTTPS/redirect ports are published; Caddy reaches both private listeners through shared namespace", () => {
  const { app, caddy } = compose.services;
  assert.deepEqual(app.ports, ["80:80/tcp", "443:443/tcp", "443:443/udp"]);
  assert.equal(caddy.network_mode, "service:app");
  assert.equal(caddy.ports, undefined);
  assert.equal(caddy.networks, undefined);
  assert.equal(caddy.depends_on.app.condition, "service_healthy");
  assert.equal(caddy.depends_on.app.restart, true);
  assert.deepEqual(app.volumes, ["accounts:/var/lib/kiwi-duel", "backups:/var/backups/kiwi-duel"]);
  assert.deepEqual(Object.keys(compose.volumes).sort(), ["accounts", "backups", "caddy_config", "caddy_data"]);
  assert.ok(caddy.volumes.includes("caddy_data:/data"));
  assert.ok(caddy.volumes.includes("caddy_config:/config"));
  assert.ok(caddy.volumes.includes("./Caddyfile:/etc/caddy/Caddyfile:ro"));
  for (const service of [app, caddy]) {
    assert.equal(service.read_only, true);
    assert.deepEqual(service.cap_drop, ["ALL"]);
    assert.deepEqual(service.security_opt, ["no-new-privileges:true"]);
    assert.equal(service.restart, "unless-stopped");
  }
  assert.equal(app.init, true);
});

test("proxy preserves WebSocket/auth forwarding and replaces untrusted forwarded-address chains", () => {
  const config = read("Caddyfile");
  assert.ok(config.includes("@battle path /v1/battle/socket"));
  assert.equal((config.match(/reverse_proxy 127\.0\.0\.1:8080/g) || []).length, 2);
  assert.equal((config.match(/header_up X-Forwarded-For \{remote_host\}/g) || []).length, 2);
  assert.ok(config.includes("stream_close_delay 30s"));
  assert.ok(config.includes("admin off"));
  assert.ok(!/^\s*log\s*\{/m.test(config), "access logging cannot expose device-link URL codes");
  assert.ok(!/header_up\s+-(Authorization|Cookie)/i.test(config));
  assert.equal((config.match(/\{/g) || []).length, (config.match(/\}/g) || []).length);
});

test("image COPY inputs exist and its build context is an explicit private-data-free allowlist", () => {
  const dockerfile = read("Dockerfile");
  const ignore = read("Dockerfile.dockerignore");
  const allowed = new Set(ignore.split(/\r?\n/).filter((line) => line.startsWith("!")).map((line) => line.slice(1)));
  assert.ok(ignore.split(/\r?\n/).includes("**"));
  assert.ok(!dockerfile.includes("COPY . "));
  assert.ok(dockerfile.includes("USER node"));
  assert.ok(dockerfile.includes("npm ci --omit=dev --ignore-scripts"));
  assert.ok(dockerfile.includes('ENTRYPOINT ["node", "server/deploy/start-production.mjs"]'));
  assert.ok(dockerfile.includes("HEALTHCHECK"));
  const copied = new Set();
  for (const line of dockerfile.split(/\r?\n/).filter((line) => line.startsWith("COPY "))) {
    const paths = line.split(/\s+/).slice(1, -1);
    for (const path of paths) {
      assert.ok(existsSync(resolve(project, path)), path);
      assert.ok(allowed.has(path), `not in Docker allowlist: ${path}`);
      assert.ok(!/runtime|\.sqlite|\.private|seed|\.test\.mjs|\.env|backup-/.test(path), path);
      copied.add(path);
    }
  }
  for (const name of allowed) {
    if (!name.endsWith("/")) assert.ok(copied.has(name) || name === "server/deploy/Dockerfile", `unnecessary build context: ${name}`);
  }
  for (const name of ["constants", "chapter_masters", "arena_league_masters", "arena_reward_box_masters"]) {
    assert.ok(copied.has(`assets/authentic/android_data/boot_masters/${name}.json`), `missing revision-bound master ${name}`);
  }
  assert.ok(copied.has("server/bootstrap-readiness.mjs"));
  assert.ok(copied.has("server/plate-state.mjs"));
  assert.ok(copied.has("server/z-gauge-rules.mjs"));
  assert.ok(copied.has("server/z-skill-transaction.mjs"));
  assert.ok(copied.has("server/z-skill-catalog.mjs"));
  assert.ok(copied.has("data/z_skill_catalog.json"));
  assert.ok(copied.has("data/match_stage_contract.json"), "server turn awards use the actual authored board-point contract");
  assert.ok(!allowed.has("assets/authentic/**"), "only four exact master files belong in the service image");
  // Detect future static imports/data additions omitted from the image.
  for (const path of copied) {
    if (!path.endsWith(".mjs")) continue;
    const text = readFileSync(resolve(project, path), "utf8");
    for (const match of text.matchAll(/(?:from\s+|import\(|new URL\()(["'])(\.\.?\/[^"'?]+)\1/g)) {
      const target = resolve(project, path, "..", match[2]);
      const relative = target.slice(project.length + 1).replaceAll("\\", "/");
      if (relative.startsWith("server/runtime/")) continue; // Production path is required to override this development fallback.
      assert.ok(copied.has(relative), `${path} depends on uncopied ${relative}`);
    }
  }
});

test("example remains deliberately non-deployable until host/policy choice; no local state is committed", () => {
  const example = read(".env.example");
  assert.ok(example.includes("DUEL_PUBLIC_HOST=replace-with-your-domain.invalid"));
  assert.ok(/^DUEL_CHEST_UNLOCK_MS=$/m.test(example));
  const ignored = read(".gitignore");
  assert.ok(ignored.includes(".env"));
  assert.ok(ignored.includes("!.env.example"));
  assert.ok(!existsSync(resolve(directory, ".env")));
});
