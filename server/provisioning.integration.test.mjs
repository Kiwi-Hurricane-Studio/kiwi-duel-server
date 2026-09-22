import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const scripts = join(project, "scripts");
const powershell = process.env.DUEL_TEST_POWERSHELL || (process.platform === "win32" ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "pwsh");
const localOnly = { skip: process.platform !== "win32" };
const account = { email: "provisioning@example.test", displayName: "Provisioning_Player", password: "local-fixture-only-password" };
const otherAccount = { email: "other-provisioning@example.test", displayName: "Other_Player", password: "other-fixture-only-password" };

async function freePort() {
  const listener = createTcpServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function runScript(script, args, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args], {
      cwd: project, env: { ...process.env, ...env }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("isolated_provisioning_timeout")); }, 30_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "kiwi-duel-provisioning-"));
  const credentials = join(directory, "owned-accounts.json");
  const databasePath = join(directory, "accounts.sqlite");
  writeFileSync(credentials, JSON.stringify({ accounts: [account, otherAccount] }));
  const events = [];
  let upstream = "";
  let retryDuringConsent = false;
  let retried = false;
  let requestedDevice = "";
  let attack = "";
  let child;
  const proxy = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const path = new URL(request.url, "http://fixture.test").pathname;
      const event = { method: request.method, path };
      if (request.method === "POST" && path === "/v1/session/login") {
        requestedDevice = JSON.parse(body).device_token;
        event.password_sent_to_game = body.includes(Buffer.from(account.password));
      }
      if (request.method === "POST" && path.startsWith("/account/")) {
        const form = new URLSearchParams(body.toString("utf8"));
        event.has_csrf = Boolean(form.get("csrf"));
        event.has_cookie = Boolean(request.headers.cookie);
        event.confirmed = form.get("confirm_link") === "yes";
      }
      events.push(event);
      if (retryDuringConsent && !retried && path === "/account/link" && request.method === "GET") {
        // A real second game login while the first browser link is open must
        // not invalidate its old consent URL. The upstream is the real server.
        await fetch(`${upstream}/v1/session/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_token: requestedDevice }) });
        retried = true;
      }
      if (attack === "redirect" && path === "/account/login") {
        response.writeHead(303, { Location: "https://outside.invalid/account/link?code=never-follow-this" }); response.end(); return;
      }
      const headers = { ...request.headers };
      delete headers.host; delete headers.connection; delete headers["content-length"]; delete headers["transfer-encoding"]; delete headers.expect;
      const result = await fetch(`${upstream}${request.url}`, { method: request.method, headers, ...(body.length ? { body } : {}), redirect: "manual" });
      let bytes = Buffer.from(await result.arrayBuffer());
      if (attack === "link" && path === "/v1/session/login") {
        const json = JSON.parse(bytes);
        if (json.link_url) json.link_url = "https://outside.invalid/account/link?code=never-follow-this";
        bytes = Buffer.from(JSON.stringify(json));
      }
      if (attack === "verification" && path === "/account/link" && request.method === "GET") {
        bytes = Buffer.from(bytes.toString("utf8").replace(/(<strong class="link-code">)(\d{6})(<\/strong>)/u,
          (_all, prefix, code, suffix) => `${prefix}${code === "000000" ? "999999" : "000000"}${suffix}`));
      }
      const outputHeaders = Object.fromEntries(result.headers);
      delete outputHeaders["content-length"]; delete outputHeaders["transfer-encoding"]; delete outputHeaders["connection"];
      const cookies = result.headers.getSetCookie();
      if (cookies.length) outputHeaders["set-cookie"] = cookies;
      outputHeaders["content-length"] = bytes.length;
      response.writeHead(result.status, outputHeaders); response.end(bytes);
    } catch { response.writeHead(500); response.end("isolated_proxy_failure"); }
  });
  await new Promise((resolve, reject) => proxy.listen(0, "127.0.0.1", resolve).once("error", reject));
  const base = `http://127.0.0.1:${proxy.address().port}`;
  const httpPort = await freePort();
  const gamePort = await freePort();
  upstream = `http://127.0.0.1:${httpPort}`;
  child = spawn(process.execPath, [join(project, "server", "custom-bootstrap-server.mjs")], {
    cwd: project, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: {
      ...process.env, NODE_ENV: "test", DUEL_SERVER_HOST: "127.0.0.1", DUEL_SERVER_PORT: String(httpPort),
      DUEL_SERVER_PUBLIC_BASE: base, DUEL_GAME_SERVER_HOST: "127.0.0.1", DUEL_GAME_SERVER_PORT: String(gamePort),
      DUEL_GAME_SERVER_PUBLIC_HOST: "127.0.0.1", DUEL_ACCOUNT_DATABASE: databasePath, DUEL_SEED_ACCOUNTS_PATH: credentials,
      DUEL_TRUSTED_PROXY_ADDRESSES: "", DUEL_DEFAULT_MATCH_MODE: "human",
    },
  });
  let serverOutput = "";
  child.stdout.on("data", (chunk) => { serverOutput += chunk; });
  child.stderr.on("data", (chunk) => { serverOutput += chunk; });
  const cleanup = async () => {
    if (child && child.exitCode == null) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    let ready = false;
    for (let count = 0; count < 100; count += 1) {
      if (child.exitCode != null) throw new Error(`isolated_server_exited: ${serverOutput}`);
      try { if ((await fetch(`${upstream}/healthz`).then((value) => value.json())).ok) { ready = true; break; } } catch {}
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!ready) throw new Error("isolated_server_not_ready");
  } catch (error) { await cleanup(); throw error; }
  return {
    directory, credentials, base, events, cleanup,
    retry() { retryDuringConsent = true; },
    attack(value) { attack = value; },
    get retried() { return retried; },
    inspect(sql) { const database = new DatabaseSync(databasePath, { readOnly: true }); try { return database.prepare(sql).all(); } finally { database.close(); } },
    windows(email = account.email, name = "windows") {
      const userData = join(directory, name);
      return { userData, run: () => runScript(join(scripts, "provision-owned-windows.ps1"), ["-AccountEmail", email, "-ServerBaseUrl", base, "-CredentialsPath", credentials, "-UserDataPath", userData]) };
    },
  };
}

function assertNoSecrets(result, token = "") {
  const output = result.stdout + result.stderr;
  for (const secret of [account.password, otherAccount.password, token].filter(Boolean)) assert.equal(output.includes(secret), false, "tool output must not disclose credentials or installation tokens");
  assert.doesNotMatch(output, /kiwi_duel_session=|access_token|link_code=|csrf=/u);
}

test("owned Windows provisioning follows real CSRF and explicit consent, survives retry, and preserves other identities", localOnly, async () => {
  const value = await fixture();
  try {
    value.retry();
    const windows = value.windows();
    mkdirSync(windows.userData);
    const secretsPath = join(windows.userData, "server-secrets.json");
    const token = "preserved-windows-device-token-0123456789";
    const unrelated = { kaeru: { device_token: "unrelated-provider-private-token", access_token: "unrelated-provider-session" } };
    writeFileSync(secretsPath, JSON.stringify({ profiles: { ...unrelated, custom: { device_token: token, preference: "keep" } }, unrelated: true }));
    const beforeCredentials = readFileSync(value.credentials);
    const beforeSecrets = readFileSync(secretsPath);
    const result = await windows.run();
    assertNoSecrets(result, token);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).provisioning_browser_signed_out, true);
    assert.equal(value.retried, true);
    assert.deepEqual(JSON.parse(readFileSync(secretsPath)).profiles.kaeru, unrelated.kaeru);
    assert.equal(JSON.parse(readFileSync(secretsPath)).profiles.custom.device_token, token);
    assert.deepEqual(readFileSync(value.credentials), beforeCredentials);
    assert.deepEqual(readFileSync(secretsPath), beforeSecrets, "an existing identity must not be rewritten");
    assert.equal(value.inspect("SELECT COUNT(*) AS n FROM browser_sessions")[0].n, 0);
    assert.equal(value.inspect("SELECT COUNT(*) AS n FROM device_link_requests")[0].n, 0);
    const login = value.events.find((event) => event.method === "POST" && event.path === "/account/login");
    const consent = value.events.find((event) => event.method === "POST" && event.path === "/account/link");
    assert.equal(login.has_csrf && login.has_cookie, true);
    assert.equal(consent.has_csrf && consent.has_cookie && consent.confirmed, true);
    assert.equal(value.events.filter((event) => event.path === "/v1/session/login").some((event) => event.password_sent_to_game), false);
    const originalInventory = value.inspect("SELECT user_id,item_master_id,level FROM user_figures ORDER BY id");
    const formsBefore = value.events.filter((event) => event.path === "/account/login").length;
    const repeat = await windows.run();
    assert.equal(repeat.code, 0, repeat.stderr);
    assert.equal(value.events.filter((event) => event.path === "/account/login").length, formsBefore, "already-linked device must not authenticate another browser");
    const second = await value.windows(account.email, "separate-computer").run();
    assert.equal(second.code, 0, second.stderr);
    assert.equal(value.inspect("SELECT COUNT(*) AS n FROM device_links WHERE user_id=1")[0].n, 2);
    assert.deepEqual(value.inspect("SELECT user_id,item_master_id,level FROM user_figures ORDER BY id"), originalInventory);
    const wrongOwner = await value.windows(otherAccount.email, "windows").run();
    assert.equal(wrongOwner.code, 1);
    assertNoSecrets(wrongOwner, token);
    assert.match(wrongOwner.stderr, /already linked to a different account/u);
    assert.equal(value.inspect("SELECT COUNT(*) AS n FROM device_links WHERE user_id=1")[0].n, 2);
  } finally { await value.cleanup(); }
});

test("Android provisioning uses the same consent flow with an isolated fake transport and fails before writes on unreadable identity", localOnly, async () => {
  const value = await fixture();
  try {
    const fakeAdb = join(value.directory, "fake-adb.ps1");
    const fakeRoutes = join(value.directory, "fake-routes.ps1");
    const fakeSecrets = join(value.directory, "android-server-secrets.json");
    const fakeStage = join(value.directory, "android-staged-secrets.json");
    const adbLog = join(value.directory, "adb-commands.txt");
    const routeLog = join(value.directory, "route-calls.txt");
    writeFileSync(fakeAdb, String.raw`
$command = (@($args) -join ' ')
[IO.File]::AppendAllText($env:PROVISION_FAKE_ADB_LOG, $command + [Environment]::NewLine)
$global:LASTEXITCODE = 0
if ($command -cnotmatch '^-s emulator-5562 ') { throw 'Fake transport rejects any other device.' }
if ($command -match ' getprop ro.boot.qemu.avd_name$') { 'duel_modern_api36'; return }
if ($command -match ' pm list packages org.duelmodern.localprototype$') { 'package:org.duelmodern.localprototype'; return }
if ($command -match ' run-as org.duelmodern.localprototype pwd$') {
  if ($env:PROVISION_FAKE_RUNAS_DENIED -eq '1') { 'run-as denied'; $global:LASTEXITCODE = 1; return }
  '/data/user/0/org.duelmodern.localprototype'; return
}
if ($command -match ' cat files/server-secrets.json$') {
  if ([IO.File]::Exists($env:PROVISION_FAKE_SECRETS)) { [IO.File]::ReadAllText($env:PROVISION_FAKE_SECRETS); return }
  'cat: files/server-secrets.json: No such file or directory'; $global:LASTEXITCODE = 1; return
}
if ($args[2] -ceq 'push') { [IO.File]::Copy($args[3], $env:PROVISION_FAKE_STAGE, $true); return }
if ($command -match ' cp /data/local/tmp/kiwi-provision-[a-f0-9]+.json files/server-secrets.json$') { [IO.File]::Copy($env:PROVISION_FAKE_STAGE, $env:PROVISION_FAKE_SECRETS, $true); return }
if ($command -match ' chmod 600 files/server-secrets.json$') { return }
if ($command -match ' shell rm -f /data/local/tmp/kiwi-provision-[a-f0-9]+.json$') { [IO.File]::Delete($env:PROVISION_FAKE_STAGE); return }
throw 'Unexpected fake transport command.'
`);
    writeFileSync(fakeRoutes, String.raw`param([int]$Port, [string]$AuthorizedPhysicalSerial='')
if ($Port -ne 5562 -or $AuthorizedPhysicalSerial) { throw 'Fake routes reject unexpected device.' }
[IO.File]::AppendAllText($env:PROVISION_FAKE_ROUTE_LOG, 'candidate-route-refreshed' + [Environment]::NewLine)
`);
    const env = { PROVISION_FAKE_ADB_LOG: adbLog, PROVISION_FAKE_SECRETS: fakeSecrets, PROVISION_FAKE_STAGE: fakeStage, PROVISION_FAKE_ROUTE_LOG: routeLog, PROVISION_FAKE_RUNAS_DENIED: "" };
    const run = (overrides = {}) => runScript(join(scripts, "provision-owned-device.ps1"), ["-AccountEmail", account.email,
      "-ServerBaseUrl", value.base, "-CredentialsPath", value.credentials, "-AdbPath", fakeAdb, "-RouteHelperPath", fakeRoutes], { env: { ...env, ...overrides } });
    value.retry();
    const first = await run();
    assert.equal(first.code, 0, first.stderr);
    const token = JSON.parse(readFileSync(fakeSecrets)).profiles.custom.device_token;
    assert.match(token, /^[a-f0-9]{64}$/u);
    assertNoSecrets(first, token);
    assert.equal(JSON.parse(first.stdout).provisioning_browser_signed_out, true);
    assert.equal(value.retried, true);
    assert.match(readFileSync(routeLog, "utf8"), /candidate-route-refreshed/u);
    assert.equal(value.inspect("SELECT COUNT(*) AS n FROM browser_sessions")[0].n, 0);
    const secretsBefore = readFileSync(fakeSecrets);
    writeFileSync(adbLog, "");
    const second = await run();
    assert.equal(second.code, 0, second.stderr);
    assert.deepEqual(readFileSync(fakeSecrets), secretsBefore);
    assert.doesNotMatch(readFileSync(adbLog, "utf8"), / push | cp | chmod | shell rm /u, "already-present tokens must never be staged or rewritten");
    const eventsBefore = value.events.length;
    const denied = await run({ PROVISION_FAKE_RUNAS_DENIED: "1" });
    assert.equal(denied.code, 1);
    assertNoSecrets(denied, token);
    assert.match(denied.stderr, /refusing to replace an unreadable installation identity/u);
    assert.deepEqual(readFileSync(fakeSecrets), secretsBefore);
    assert.equal(value.events.length, eventsBefore, "unreadable device identity must fail before any account request");
    const malformed = '{"private":"malformed-fixture-private-token",';
    writeFileSync(fakeSecrets, malformed);
    const badJson = await run();
    assert.equal(badJson.code, 1);
    assertNoSecrets(badJson, "malformed-fixture-private-token");
    assert.equal(readFileSync(fakeSecrets, "utf8"), malformed);
    assert.equal(value.events.length, eventsBefore);
  } finally { await value.cleanup(); }
});

test("owned provisioning refuses hostile links/redirects and non-loopback origins without disclosing credentials", localOnly, async () => {
  const value = await fixture();
  try {
    for (const attack of ["link", "redirect", "verification"]) {
      value.attack(attack);
      const result = await value.windows(account.email, `hostile-${attack}`).run();
      assert.equal(result.code, 1);
      assertNoSecrets(result);
      assert.match(result.stderr, attack === "verification" ? /does not match the requesting installation/u : /outside its configured loopback origin/u);
      assert.equal(value.inspect("SELECT COUNT(*) AS n FROM device_links WHERE user_id IS NOT NULL")[0].n, 0);
      assert.equal(value.inspect("SELECT COUNT(*) AS n FROM browser_sessions")[0].n, 0, "an interrupted consent flow must sign out its temporary browser");
    }
    value.attack("");
    const invalidCredentials = join(value.directory, "incorrect-password.json");
    writeFileSync(invalidCredentials, JSON.stringify({ accounts: [{ ...account, password: "incorrect-fixture-password" }] }));
    const badPassword = await runScript(join(scripts, "provision-owned-windows.ps1"), ["-AccountEmail", account.email,
      "-ServerBaseUrl", value.base, "-CredentialsPath", invalidCredentials, "-UserDataPath", join(value.directory, "wrong-password")]);
    assert.equal(badPassword.code, 1);
    assertNoSecrets(badPassword, "incorrect-fixture-password");
    assert.match(badPassword.stderr, /HTTP 401/u);
    assert.equal(value.inspect("SELECT COUNT(*) AS n FROM device_links WHERE user_id IS NOT NULL")[0].n, 0);
    assert.equal(value.inspect("SELECT COUNT(*) AS n FROM browser_sessions")[0].n, 0);
    const eventCount = value.events.length;
    for (const base of ["https://outside.invalid", "http://127.0.0.1:80/other", "http://user:password@127.0.0.1", "http://127.0.0.1?x=1"]) {
      const output = join(value.directory, "must-not-exist");
      const result = await runScript(join(scripts, "provision-owned-windows.ps1"), ["-AccountEmail", account.email, "-ServerBaseUrl", base, "-CredentialsPath", value.credentials, "-UserDataPath", output]);
      assert.equal(result.code, 1);
      assertNoSecrets(result);
    }
    assert.equal(value.events.length, eventCount);
  } finally { await value.cleanup(); }
});
