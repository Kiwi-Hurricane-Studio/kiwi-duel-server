import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const godot = process.env.DUEL_TEST_GODOT || join(project, ".tools", "godot", "Godot_v4.7.2-stable_win64_console.exe");

async function run(executable, args, env) {
  const child = spawn(executable, args, { cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output = (output + chunk.toString()).slice(-256 * 1024); });
  const timer = setTimeout(() => child.kill(), 15000);
  try {
    const [exitCode] = await once(child, "exit");
    return { exitCode, output };
  } finally { clearTimeout(timer); }
}

function cleanup(directory) {
  const resolved = resolve(directory);
  if (dirname(resolved) !== resolve(tmpdir()) || !basename(resolved).startsWith("kiwi-training-harness-safety-")) {
    throw new Error("unsafe_training_harness_test_cleanup");
  }
  rmSync(resolved, { recursive: true, force: true });
}

function runtimeJsonFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? runtimeJsonFiles(join(directory, entry.name)) : entry.name.endsWith(".json") ? [entry.name] : []);
}

test("custom probe refuses incorrect user root or escaped cache before any HTTP/profile access", {
  timeout: 25000,
  skip: !existsSync(godot) ? "Set DUEL_TEST_GODOT to the headless Godot executable" : false,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "kiwi-training-harness-safety-"));
  let requests = 0;
  const server = createServer((_request, response) => { requests += 1; response.end("{}"); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const escapedCache of [false, true]) {
      const args = ["--headless", "--path", project, "--log-file", join(directory, "probe.log"),
        "--script", "res://tests/server_connection_runner.gd", "--", "--server-profile=custom",
        `--server-base-url=${base}`, `--expected-user-root=${escapedCache ? directory : join(directory, "wrong-root")}`];
      if (escapedCache) args.push(`--cache-path=${join(directory, "outside-user-cache.json")}`);
      const result = await run(godot, args, { ...process.env, APPDATA: join(directory, "roaming"), XDG_DATA_HOME: join(directory, "xdg") });
      assert.equal(result.exitCode, 1);
      const line = result.output.split(/\r?\n/u).find((value) => value.startsWith("GODOT_SERVER_CONNECTION="));
      assert.ok(line, "guard reports a sanitized failure proof");
      const proof = JSON.parse(line.slice("GODOT_SERVER_CONNECTION=".length));
      assert.equal(proof.error, "connection_probe_user_directory_not_isolated");
      assert.equal(proof.user_directory_isolated, false);
      assert.equal(requests, 0, "directory assertion precedes networking");
      assert.equal(result.output.includes("GODOT_BOOT_API"), false);
    }
    assert.deepEqual(runtimeJsonFiles(join(directory, "roaming")), [], "guard writes no mailbox/cache/profile JSON");
    assert.deepEqual(runtimeJsonFiles(join(directory, "xdg")), []);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    cleanup(directory);
  }
});

test("occupied-port harness failure preserves inherited environment and cannot borrow a running server", {
  timeout: 20000,
  skip: process.platform !== "win32" ? "PowerShell desktop harness regression" : false,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "kiwi-training-harness-safety-"));
  let requests = 0;
  const server = createServer((_request, response) => { requests += 1; response.end("{}"); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const port = server.address().port;
    const command = "$failed=$false; try { & ./scripts/test-server-connections.ps1 -CustomPort ([int]$env:FIXTURE_PORT) -EvidenceDirectory $env:FIXTURE_EVIDENCE | Out-Null } catch { $failed=$true }; "
      + "$unchanged=($env:DUEL_SERVER_HOST -ceq 'fixture-keep-host' -and $env:DUEL_ACCOUNT_DATABASE -ceq 'fixture-keep-database' -and $env:NODE_ENV -ceq 'production' -and $env:XDG_DATA_HOME -ceq 'fixture-keep-xdg'); "
      + "@{expected_failure=$failed;parent_environment_unchanged=$unchanged} | ConvertTo-Json -Compress; if (-not $failed -or -not $unchanged) { exit 1 }";
    const result = await run("pwsh", ["-NoProfile", "-Command", command], {
      ...process.env, FIXTURE_PORT: String(port), FIXTURE_EVIDENCE: directory,
      DUEL_SERVER_HOST: "fixture-keep-host", DUEL_ACCOUNT_DATABASE: "fixture-keep-database", NODE_ENV: "production", XDG_DATA_HOME: "fixture-keep-xdg",
    });
    assert.equal(result.exitCode, 0);
    const proof = JSON.parse(result.output.trim());
    assert.equal(proof.expected_failure, true);
    assert.equal(proof.parent_environment_unchanged, true);
    assert.equal(requests, 0, "occupied port is rejected before HTTP health requests");
    assert.equal(existsSync(join(directory, "connection-proof.json")), false, "failure cannot leave a successful proof");
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    cleanup(directory);
  }
});
