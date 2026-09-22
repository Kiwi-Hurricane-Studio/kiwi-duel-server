import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AccountStore } from "./account-store.mjs";
import { createAccountSite } from "./account-site.mjs";

const iconPath = fileURLToPath(new URL("../assets/branding/kiwi_duel_mew_icon.png", import.meta.url));
const credentials = { email: "browser-player@example.test", display_name: "Browser_Player", password: "isolated browser test password" };

function csrfFrom(html) {
  const match = /name="csrf" value="([^"]+)"/u.exec(html);
  assert.ok(match, "page must contain its browser-bound CSRF token");
  return match[1];
}

async function fixture(options = {}) {
  let now = 1_800_000_000_000;
  const store = new AccountStore({ databasePath: ":memory:", now: () => now,
    starterFigures: [{ item_master_id: 1060, model_id: 60 }],
    starterPlateIds: [5022], plateMasters: [{ item_master_id: 5022, cost: 1 }],
    rewardCatalog: [{ item_master_id: 1001, model_id: 1 }],
  });
  let handler;
  const server = createServer((request, response) => {
    handler(request, response, new URL(request.url, base)).then((handled) => {
      if (!handled) { response.writeHead(404); response.end(); }
    }).catch((error) => { response.writeHead(500); response.end(error.message); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  handler = createAccountSite({ store, publicBase: base, iconPath, now: () => now, ...options });
  function browser(agent = "Mozilla/5.0 Windows Chrome/130") {
    const cookies = new Map();
    return {
      cookies,
      async request(path = "/account", form = null, headers = {}) {
        const response = await fetch(`${base}${path}`, {
          method: form == null ? "GET" : "POST", redirect: "manual",
          headers: {
            "User-Agent": agent,
            ...(cookies.size ? { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; ") } : {}),
            ...(form == null ? {} : { "Content-Type": "application/x-www-form-urlencoded", Origin: options.publicBase ?? base }),
            ...headers,
          },
          body: form == null ? undefined : form instanceof URLSearchParams ? form : new URLSearchParams(form),
        });
        for (const cookie of response.headers.getSetCookie()) {
          const [key, value] = cookie.split(";", 1)[0].split("=");
          if (cookie.includes("Max-Age=0")) cookies.delete(key); else cookies.set(key, value);
        }
        return { status: response.status, headers: response.headers, html: await response.text() };
      },
      async signup(fields = {}) {
        const page = await this.request();
        return this.request("/account/signup", { ...credentials, ...fields, csrf: csrfFrom(page.html) });
      },
    };
  }
  return { base, store, browser, advance(value) { now += value; }, async close() {
    await new Promise((resolve) => server.close(resolve)); store.close();
  } };
}

test("signup/sign-in require the requesting browser's CSRF and consume it on success", async () => {
  const f = await fixture();
  try {
    const a = f.browser();
    const b = f.browser();
    const pageA = await a.request();
    const pageB = await b.request();
    assert.equal(pageA.headers.get("referrer-policy"), "same-origin", "native form POSTs must preserve their Origin without cross-origin referrer disclosure");
    const csrfA = csrfFrom(pageA.html);
    const csrfB = csrfFrom(pageB.html);
    assert.notEqual(csrfA, csrfB);
    assert.match(pageA.headers.get("set-cookie"), /HttpOnly; SameSite=Lax/u);
    assert.equal((await a.request("/account/signup", credentials)).status, 403);
    assert.equal((await b.request("/account/signup", { ...credentials, csrf: csrfA })).status, 403);
    assert.equal((await a.request("/account/signup", { ...credentials, csrf: csrfA }, { Origin: "https://hostile.example.test" })).status, 403);
    assert.equal((await a.request("/account/signup", { ...credentials, csrf: csrfA }, { Origin: "null", "Sec-Fetch-Site": "same-origin" })).status, 403, "opaque origins remain rejected even with a valid CSRF token");
    assert.equal((await a.request("/account/signup", { ...credentials, csrf: csrfA }, { "Sec-Fetch-Site": "cross-site", Origin: "" })).status, 403);
    const duplicate = new URLSearchParams({ ...credentials, csrf: csrfA }); duplicate.append("csrf", csrfB);
    assert.equal((await a.request("/account/signup", duplicate)).status, 400);
    assert.equal(f.store.database.prepare("SELECT COUNT(*) AS n FROM users").get().n, 0);
    const signup = await a.request("/account/signup", { ...credentials, csrf: csrfA });
    assert.equal(signup.status, 303);
    assert.equal(signup.headers.get("location"), "/account");
    assert.equal((await a.request("/account/signup", { ...credentials, csrf: csrfA })).status, 403);
    assert.match((await a.request()).html, /Browser_Player/u);
    const second = await b.request("/account/login", { email: credentials.email, password: credentials.password, csrf: csrfB }, { Origin: "" });
    assert.equal(second.status, 303, "missing Origin is acceptable only with a valid browser-bound token");
    assert.notEqual(a.cookies.get("kiwi_duel_session"), b.cookies.get("kiwi_duel_session"));
    const old = b.cookies.get("kiwi_duel_session");
    const dashboard = await b.request();
    assert.equal((await b.request("/account/logout", { csrf: "forged" })).status, 403);
    assert.equal((await b.request("/account/logout", { csrf: csrfFrom(dashboard.html) })).status, 303);
    assert.equal(f.store.browserSession(old), null);
    assert.ok(f.store.browserSession(a.cookies.get("kiwi_duel_session")));
  } finally { await f.close(); }
});

test("device links need explicit confirmation; account access can be revoked without losing inventory", async () => {
  const f = await fixture();
  try {
    const a = f.browser();
    const deviceToken = "isolated-game-device-token-0123456789";
    const pending = f.store.beginDeviceLogin(deviceToken);
    const page = await a.request(`/account/link?code=${pending.link_code}`);
    const signedUp = await a.request("/account/signup", { ...credentials, csrf: csrfFrom(page.html), link_code: pending.link_code });
    assert.equal(signedUp.status, 303);
    assert.equal(signedUp.headers.get("location"), `/account/link?code=${pending.link_code}`);
    assert.ok(f.store.pendingDeviceLink(pending.link_code), "signup alone must not link the game");
    const confirmation = await a.request(signedUp.headers.get("location"));
    assert.match(confirmation.html, new RegExp(pending.verification_code, "u"));
    assert.match(confirmation.html, /link sent by someone else/u);
    const fields = { csrf: csrfFrom(confirmation.html), link_code: pending.link_code, device_name: "My phone" };
    assert.equal((await a.request("/account/link", fields)).status, 400);
    assert.ok(f.store.pendingDeviceLink(pending.link_code));
    assert.equal((await a.request("/account/link", { ...fields, confirm_link: "yes" }, { Origin: "https://hostile.example.test" })).status, 403);
    assert.equal((await a.request("/account/link", { ...fields, confirm_link: "yes" })).status, 303);
    assert.equal((await a.request("/account/link", { ...fields, confirm_link: "yes" })).status, 400, "one-time request cannot replay");
    const game = f.store.beginDeviceLogin(deviceToken);
    assert.equal(game.linked, true);
    const account = f.store.accountSnapshot(game.user.user_id);
    const secondBrowser = f.browser("Mozilla/5.0 Android Chrome/130");
    const loginPage = await secondBrowser.request();
    assert.equal((await secondBrowser.request("/account/login", { ...credentials, csrf: csrfFrom(loginPage.html) })).status, 303);
    const secondToken = secondBrowser.cookies.get("kiwi_duel_session");
    const secondId = f.store.browserSession(secondToken).session_id;
    const access = await a.request();
    assert.match(access.html, /Chrome on Windows · This browser/u);
    assert.match(access.html, /Chrome on Android/u);
    assert.match(access.html, /My phone/u);
    assert.equal(access.html.includes(game.access_token), false);
    assert.equal(access.html.includes(deviceToken), false);
    const deviceId = f.store.accountSecuritySnapshot(game.user.user_id).devices[0].device_id;
    assert.equal((await a.request("/account/sessions/revoke", { csrf: csrfFrom(access.html), session_id: secondId })).status, 303);
    assert.equal(f.store.browserSession(secondToken), null);
    assert.equal((await a.request("/account/devices/revoke", { csrf: csrfFrom(access.html), device_id: deviceId })).status, 303);
    assert.equal(f.store.authenticateGameToken(game.access_token), null);
    assert.equal(f.store.beginDeviceLogin(deviceToken).linked, false);
    assert.deepEqual(f.store.accountSnapshot(game.user.user_id), account);
  } finally { await f.close(); }
});

test("expired/hostile links cannot create accounts and cross-account access IDs cannot revoke anything", async () => {
  const f = await fixture();
  try {
    const a = f.browser(); const b = f.browser();
    const pending = f.store.beginDeviceLogin("expiring-device-token-0123456789");
    const oldPage = await a.request(`/account/link?code=${pending.link_code}`);
    f.advance(15 * 60 * 1000 + 1);
    assert.equal((await a.request("/account/signup", { ...credentials, csrf: csrfFrom(oldPage.html), link_code: pending.link_code })).status, 400);
    assert.equal(f.store.database.prepare("SELECT COUNT(*) AS n FROM users").get().n, 0);
    const injected = await a.request("/account/link?code=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E");
    assert.equal(injected.status, 400);
    assert.equal(injected.html.includes("<script>"), false);
    assert.equal((await a.signup()).status, 303);
    assert.equal((await b.signup({ email: "second-owner@example.test", display_name: "Other_Player" })).status, 303);
    const owner = f.store.browserSession(a.cookies.get("kiwi_duel_session"));
    const pending2 = f.store.beginDeviceLogin("owner-device-token-0123456789");
    f.store.linkDevice(pending2.link_code, owner.user.user_id);
    const deviceId = f.store.accountSecuritySnapshot(owner.user.user_id).devices[0].device_id;
    const pageB = await b.request();
    assert.equal((await b.request("/account/devices/revoke", { csrf: csrfFrom(pageB.html), device_id: deviceId })).status, 400);
    assert.equal((await b.request("/account/sessions/revoke", { csrf: csrfFrom(pageB.html), session_id: owner.session_id })).status, 400);
    assert.ok(f.store.browserSession(a.cookies.get("kiwi_duel_session")));
    assert.equal(f.store.accountSecuritySnapshot(owner.user.user_id).devices.length, 1);
  } finally { await f.close(); }
});

test("production origin and cookie security are explicit; untrusted forwarding cannot bypass rate limits", async () => {
  for (const publicBase of ["http://remote.example.test", "file:///tmp/account", "https://account.example.test/path", "https://user:pass@account.example.test", "https://account.example.test?next=bad"]) {
    assert.throws(() => createAccountSite({ store: {}, publicBase, iconPath }), /account_public_base_/u);
  }
  assert.throws(() => createAccountSite({ store: {}, publicBase: "http://127.0.0.1:8080", production: true, iconPath }), /requires_https/u);
  assert.throws(() => createAccountSite({ store: {}, publicBase: "https://account.example.test", trustedProxyAddresses: ["*"], iconPath }), /exact_ip_addresses/u);
  const f = await fixture({ publicBase: "https://accounts.example.test", production: true });
  try {
    const b = f.browser();
    const page = await b.request();
    assert.match(page.headers.get("set-cookie"), /; Secure/u);
    assert.match(page.headers.get("strict-transport-security"), /max-age=31536000/u);
    assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/u);
    assert.equal(page.headers.get("referrer-policy"), "same-origin");
    for (let index = 0; index < 12; index += 1) {
      assert.equal((await b.request("/account/login", { email: credentials.email, password: "wrong", csrf: csrfFrom(page.html) }, { "X-Forwarded-For": `192.0.2.${index + 1}` })).status, 401);
    }
    const limited = await b.request("/account/login", { email: credentials.email, password: "wrong", csrf: csrfFrom(page.html) }, { "X-Forwarded-For": "198.51.100.1" });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "600");
  } finally { await f.close(); }
});
