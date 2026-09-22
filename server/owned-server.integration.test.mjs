import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startServer({ httpPort, gamePort, databasePath, seedPath }) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./custom-bootstrap-server.mjs", import.meta.url))], {
    env: {
      ...process.env,
      DUEL_SERVER_HOST: "127.0.0.1",
      DUEL_SERVER_PORT: String(httpPort),
      DUEL_SERVER_PUBLIC_BASE: `http://127.0.0.1:${httpPort}`,
      DUEL_GAME_SERVER_HOST: "127.0.0.1",
      DUEL_GAME_SERVER_PORT: String(gamePort),
      DUEL_GAME_SERVER_PUBLIC_HOST: "127.0.0.1",
      DUEL_ACCOUNT_DATABASE: databasePath,
      DUEL_SEED_ACCOUNTS_PATH: seedPath,
      DUEL_CHEST_UNLOCK_MS: "25",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const base = `http://127.0.0.1:${httpPort}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`server_exited_${child.exitCode}: ${output}`);
    try {
      const health = await fetch(`${base}/healthz`).then((response) => response.json());
      if (health.ok) return { child, base, output: () => output };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  child.kill();
  throw new Error(`server_start_timeout: ${output}`);
}

async function stopServer(server) {
  if (server.child.exitCode != null) return;
  server.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => server.child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (server.child.exitCode == null) server.child.kill("SIGKILL");
}

async function postJson(base, path, body, token = "") {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function browserAt(base) {
  const cookies = new Map();
  return { async request(path, form = null) {
    const response = await fetch(new URL(path, base), {
      method: form == null ? "GET" : "POST", redirect: "manual",
      headers: {
        Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
        ...(form == null ? {} : { "Content-Type": "application/x-www-form-urlencoded", Origin: base }),
      },
      body: form == null ? undefined : new URLSearchParams(form),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [name, value] = cookie.split(";", 1)[0].split("=");
      if (cookie.includes("Max-Age=0")) cookies.delete(name); else cookies.set(name, value);
    }
    const html = await response.text();
    const csrf = /name="csrf" value="([^"]+)"/u.exec(html)?.[1] ?? "";
    return { status: response.status, headers: response.headers, html, csrf };
  } };
}

test("website device link and game inventory/chests share a restart-safe authority", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kiwi-duel-owned-server-"));
  const databasePath = join(directory, "accounts.sqlite");
  const seedPath = join(directory, "seeds.json");
  const primaryPassword = "test-primary-password";
  const alternatePassword = "test-alternate-password";
  const alternateDevice = "alternate-device-token--0123456789";
  writeFileSync(seedPath, JSON.stringify({ accounts: [
    { email: "alternate@example.test", displayName: "Kiwi_Alt", password: alternatePassword, deviceToken: alternateDevice },
  ] }));
  let server;
  try {
    const httpPort = await freePort();
    const gamePort = await freePort();
    server = await startServer({ httpPort, gamePort, databasePath, seedPath });
    const page = await fetch(`${server.base}/account`).then((response) => response.text());
    assert.match(page, /Welcome to/);
    assert.match(page, /normal starter deck/);
    assert.match(page, /kiwi_duel_mew_icon|account\/icon\.png/);

    const primaryDevice = "primary-device-token-01234567890";
    const unlinked = await postJson(server.base, "/v1/session/login", { device_token: primaryDevice });
    assert.equal(unlinked.status, 200);
    assert.equal(unlinked.body.link_required, true);
    const linkUrl = new URL(unlinked.body.link_url);
    const linkCode = linkUrl.searchParams.get("code");
    assert.ok(linkCode);

    const browser = browserAt(server.base);
    const signupPage = await browser.request(linkUrl);
    const browserLogin = await browser.request("/account/signup", {
      email: "primary@example.test", display_name: "Kiwi_Primary", password: primaryPassword,
      link_code: linkCode, csrf: signupPage.csrf,
    });
    assert.equal(browserLogin.status, 303);
    assert.match(browserLogin.headers.get("set-cookie") || "", /HttpOnly/);
    assert.equal(browserLogin.headers.get("location"), `/account/link?code=${linkCode}`);
    const confirmPage = await browser.request(browserLogin.headers.get("location"));
    assert.match(confirmPage.html, /Confirm your game/u);
    assert.equal((await browser.request("/account/link", { csrf: confirmPage.csrf, link_code: linkCode })).status, 400);
    assert.equal((await browser.request("/account/link", {
      csrf: confirmPage.csrf, link_code: linkCode, confirm_link: "yes", device_name: "Test phone",
    })).status, 303);

    const linked = await postJson(server.base, "/v1/session/login", { device_token: primaryDevice });
    assert.equal(linked.body.ok, true);
    assert.equal(linked.body.data.user.display_name, "Kiwi_Primary");
    const token = linked.body.data.access_token;
    const room = await postJson(server.base, "/v1/bootstrap/room", {}, token);
    assert.equal(room.body.data.models.decks.length, 5);
    assert.deepEqual(room.body.data.models.decks[0].figures.map((figure) => figure.model_id), [60, 114, 161, 162, 78, 132]);
    assert.equal(room.body.data.models.plates.length, 170);
    const longThrow = room.body.data.models.plates.find((plate) => Number(plate.item_master_id) === 5026);
    assert.equal(longThrow.name, "Long Throw");
    assert.match(longThrow.description, /one space away from your entry point/i);
    assert.equal(room.body.data.models.user_arena.chests.length, 1);

    const reversedFigures = [...room.body.data.models.decks[1].figures].reverse();
    const updatedDeck = await postJson(server.base, "/v1/decks/update", {
      deck_no: 2,
      name: "Reversed Deck",
      figures: reversedFigures,
      plates: room.body.data.models.decks[1].plates,
    }, token);
    assert.equal(updatedDeck.body.ok, true);
    assert.equal(updatedDeck.body.data.name, "Reversed Deck");
    assert.deepEqual(updatedDeck.body.data.figures.map((figure) => figure.item_master_id), reversedFigures.map((figure) => figure.item_master_id));
    const selectedEntry = await postJson(server.base, "/v1/matching/entry", {
      mode: "training",
      deckNo: 1,
      arenaEventMasterId: "",
      alterEntryFeeItemMasterId: 0,
    }, token);
    assert.equal(selectedEntry.body.ok, true);
    const selectedPoll = await postJson(server.base, "/v1/matching/poll", {}, token);
    assert.equal(selectedPoll.body.data.online_match.game_server.plate_state_schema, 1);
    assert.equal(selectedPoll.body.data.online_match.player1.deck_no, 2);
    assert.deepEqual(
      selectedPoll.body.data.online_match.player1.deck.user_deck_figures.map((entry) => entry.figure_user_items[0].item_master_id),
      reversedFigures.map((figure) => figure.item_master_id),
    );
    assert.equal((await postJson(server.base, "/v1/matching/reset-active", {}, token)).body.ok, true);

    const chestId = room.body.data.models.user_arena.chests[0].chest_id;
    assert.equal((await postJson(server.base, "/v1/chests/start", { chest_id: chestId }, token)).body.ok, true);
    assert.equal((await postJson(server.base, "/v1/chests/claim", { chest_id: chestId }, token)).body.error, "chest_not_ready");
    await new Promise((resolve) => setTimeout(resolve, 35));
    const claimed = await postJson(server.base, "/v1/chests/claim", { chest_id: chestId }, token);
    assert.equal(claimed.body.ok, true);
    assert.equal(claimed.body.data.item_master_id, 1001);
    assert.equal((await postJson(server.base, "/v1/account/me", {}, token)).body.data.figures.length, 7);

    const alternateLogin = await postJson(server.base, "/v1/session/login", { device_token: alternateDevice });
    assert.equal(alternateLogin.body.ok, true);
    assert.equal((await postJson(server.base, "/v1/account/me", {}, alternateLogin.body.data.access_token)).body.data.figures.length, 6);

    await stopServer(server);
    server = await startServer({ httpPort, gamePort, databasePath, seedPath });
    const afterRestart = await postJson(server.base, "/v1/session/login", { device_token: primaryDevice });
    assert.equal(afterRestart.body.ok, true);
    const restartedAccount = (await postJson(server.base, "/v1/account/me", {}, afterRestart.body.data.access_token)).body.data;
    assert.equal(restartedAccount.figures.length, 7);
    assert.equal(restartedAccount.decks[1].name, "Reversed Deck");

    // A separate browser and separate installation recover the same durable account.
    const computer = browserAt(server.base);
    const computerDevice = "primary-computer-token-01234567890";
    const computerUnlinked = await postJson(server.base, "/v1/session/login", { device_token: computerDevice });
    const computerLink = new URL(computerUnlinked.body.link_url);
    const computerPage = await computer.request(computerLink);
    const computerLogin = await computer.request("/account/login", {
      email: "primary@example.test", password: primaryPassword, csrf: computerPage.csrf,
      link_code: computerLink.searchParams.get("code"),
    });
    assert.equal(computerLogin.status, 303);
    const computerConfirm = await computer.request(computerLogin.headers.get("location"));
    assert.equal((await computer.request("/account/link", {
      csrf: computerConfirm.csrf, link_code: computerLink.searchParams.get("code"), confirm_link: "yes", device_name: "Test computer",
    })).status, 303);
    const computerGame = await postJson(server.base, "/v1/session/login", { device_token: computerDevice });
    assert.equal(computerGame.body.data.user.user_id, afterRestart.body.data.user.user_id);
    assert.notEqual(computerGame.body.data.access_token, afterRestart.body.data.access_token);
    const computerSnapshot = await postJson(server.base, "/v1/account/me", {}, computerGame.body.data.access_token);
    assert.equal(computerSnapshot.body.data.figures.length, 7);
    assert.equal(computerSnapshot.body.data.decks[1].name, "Reversed Deck");
    const dashboard = await computer.request("/account");
    const phoneDeviceId = /Test phone<\/strong>[\s\S]*?name="device_id" value="([a-f0-9]{32})"/u.exec(dashboard.html)?.[1];
    assert.ok(phoneDeviceId);
    assert.equal((await computer.request("/account/devices/revoke", { csrf: dashboard.csrf, device_id: phoneDeviceId })).status, 303);
    assert.equal((await postJson(server.base, "/v1/account/me", {}, afterRestart.body.data.access_token)).status, 401);
    assert.equal((await postJson(server.base, "/v1/session/login", { device_token: primaryDevice })).body.link_required, true);
    assert.equal((await postJson(server.base, "/v1/account/me", {}, computerGame.body.data.access_token)).body.data.figures.length, 7);
    const sessions = [...dashboard.html.matchAll(/name="session_id" value="([a-f0-9]{32})"/gu)].map((match) => match[1]);
    assert.equal(sessions.length, 2);
    const originalBrowserPage = await browser.request("/account");
    const originalSessionId = /This browser<\/strong>[\s\S]*?name="session_id" value="([a-f0-9]{32})"/u.exec(originalBrowserPage.html)?.[1];
    assert.ok(originalSessionId);
    assert.equal((await computer.request("/account/sessions/revoke", { csrf: dashboard.csrf, session_id: originalSessionId })).status, 303);
    assert.match((await browser.request("/account")).html, /Welcome to/u);
  } finally {
    if (server) await stopServer(server);
    rmSync(directory, { recursive: true, force: true });
  }
});
