import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

const COOKIE_NAME = "kiwi_duel_session";
const ANONYMOUS_COOKIE_NAME = "kiwi_duel_form";
const MAX_FORM_BYTES = 64 * 1024;
const AUTH_WINDOW_MS = 10 * 60 * 1_000;
const AUTH_ATTEMPTS = 12;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parseCookies(header) {
  const result = Object.create(null);
  for (const part of String(header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!key) continue;
    // Ambiguous same-name cookies must not choose an attacker-controlled path variant.
    if (Object.hasOwn(result, key)) { result[key] = ""; continue; }
    try { result[key] = decodeURIComponent(value); }
    catch { result[key] = ""; }
  }
  return result;
}

function securityHeaders(contentType) {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "Cross-Origin-Opener-Policy": "same-origin",
    // Native form POSTs under no-referrer can send Origin: null, which our
    // origin guard correctly rejects. Preserve same-origin form identity while
    // withholding referrers from other origins (including device-link URLs).
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function send(response, status, body, type = "text/html; charset=utf-8", extraHeaders = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  response.writeHead(status, {
    ...securityHeaders(type),
    "Content-Length": bytes.length,
    ...extraHeaders,
  });
  response.end(bytes);
}

function redirect(response, location, extraHeaders = {}) {
  response.writeHead(303, {
    ...securityHeaders("text/plain; charset=utf-8"),
    Location: location,
    "Content-Length": 0,
    ...extraHeaders,
  });
  response.end();
}

async function readForm(request) {
  const contentType = String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") throw new Error("form_content_type_required");
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_FORM_BYTES) throw new Error("form_too_large");
    chunks.push(chunk);
  }
  const parameters = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  const fields = Object.create(null);
  for (const [key, value] of parameters) {
    if (Object.hasOwn(fields, key)) throw new Error("duplicate_form_field");
    fields[key] = value;
  }
  return fields;
}

function sessionCookie(token, secure, maxAge = 2592000, name = COOKIE_NAME) {
  return `${name}=${encodeURIComponent(token)}; Path=/account; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function clearSessionCookie(secure) {
  return sessionCookie("", secure, 0);
}

function page({ title, content, user = null, csrf = "", notice = "", error = "" }) {
  const accountActions = user ? `
    <div class="account-chip"><span>${escapeHtml(user.display_name)}</span><small>#${escapeHtml(user.user_id)}</small></div>
    <form action="/account/logout" method="post"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="quiet" type="submit">Sign out</button></form>
  ` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="dark">
  <title>${escapeHtml(title)} · Kiwi Duel</title>
  <style>
    :root { --ink:#edfaff; --muted:#9fc3d0; --navy:#051725; --panel:#0b2635; --line:#1f6074; --cyan:#32d7e7; --lime:#bdf13e; --gold:#ffd839; --danger:#ff606d; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100svh; color:var(--ink); font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; background:radial-gradient(circle at 50% -12%,#205e70 0,#0a293a 27%,#03111c 63%,#02080d 100%); }
    body::before { content:""; position:fixed; inset:0; pointer-events:none; opacity:.16; background:linear-gradient(115deg,transparent 35%,rgba(73,239,255,.35) 48%,transparent 60%),repeating-linear-gradient(0deg,transparent 0 31px,rgba(255,255,255,.025) 32px); }
    header { position:relative; display:flex; align-items:center; justify-content:space-between; gap:18px; padding:18px clamp(18px,4vw,56px); border-bottom:1px solid rgba(50,215,231,.35); background:rgba(2,14,24,.82); backdrop-filter:blur(14px); }
    .brand { display:flex; align-items:center; gap:13px; color:var(--ink); text-decoration:none; }
    .brand img { width:58px; height:58px; border-radius:15px; box-shadow:0 0 0 2px rgba(50,215,231,.55),0 8px 24px rgba(0,0,0,.45); }
    .brand strong { display:block; font-size:1.25rem; letter-spacing:.02em; }
    .brand small { color:var(--muted); }
    .header-actions { display:flex; align-items:center; gap:14px; }
    .account-chip { display:grid; text-align:right; }
    .account-chip small { color:var(--muted); }
    main { position:relative; width:min(1120px,calc(100% - 32px)); margin:0 auto; padding:clamp(34px,7vw,78px) 0 72px; }
    .hero { display:grid; grid-template-columns:minmax(0,1.1fr) minmax(290px,.9fr); align-items:center; gap:clamp(28px,6vw,82px); }
    h1 { margin:0 0 15px; font-size:clamp(2.4rem,7vw,5.7rem); line-height:.93; letter-spacing:-.055em; }
    h1 span { display:block; color:var(--lime); text-shadow:0 0 26px rgba(189,241,62,.22); }
    h2 { margin:0 0 18px; font-size:clamp(1.45rem,3vw,2.2rem); }
    h3 { margin:0; font-size:1.05rem; }
    p { color:var(--muted); line-height:1.62; }
    .eyebrow { color:var(--cyan); font-weight:800; text-transform:uppercase; letter-spacing:.17em; font-size:.76rem; }
    .panel { border:1px solid rgba(50,215,231,.42); border-radius:24px; padding:clamp(20px,4vw,34px); background:linear-gradient(145deg,rgba(15,52,68,.94),rgba(5,25,38,.96)); box-shadow:0 22px 70px rgba(0,0,0,.38),inset 0 1px rgba(255,255,255,.07); }
    .auth-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr)); gap:18px; }
    .dashboard-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:18px; }
    label { display:grid; gap:7px; margin:12px 0; color:#cfe5eb; font-size:.88rem; font-weight:700; }
    input { width:100%; border:1px solid #3a6e7e; border-radius:11px; padding:13px 14px; color:white; background:#04141f; font:inherit; outline:none; }
    input:focus { border-color:var(--cyan); box-shadow:0 0 0 3px rgba(50,215,231,.17); }
    button,.button { border:0; border-radius:12px; padding:12px 18px; color:#241a00; background:linear-gradient(#fff15c,#ffc61c); box-shadow:inset 0 0 0 2px rgba(255,255,255,.7),0 5px 0 #a66b00; font:800 1rem/1 system-ui; cursor:pointer; text-decoration:none; display:inline-block; }
    button:hover,.button:hover { filter:brightness(1.08); transform:translateY(-1px); }
    button.quiet { color:var(--ink); background:#163446; box-shadow:none; border:1px solid #386174; }
    .notice,.error { margin:0 0 22px; padding:13px 16px; border-radius:12px; }
    .notice { color:#eaffe0; border:1px solid #79b72a; background:rgba(83,132,26,.25); }
    .error { color:#ffe8eb; border:1px solid var(--danger); background:rgba(125,22,35,.3); }
    .link-code { padding:12px 14px; border-radius:10px; background:#020b12; color:var(--gold); font:700 .9rem ui-monospace,monospace; overflow-wrap:anywhere; }
    .stats { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin:20px 0 26px; }
    .stat { padding:15px; border:1px solid rgba(159,195,208,.24); border-radius:14px; background:rgba(0,0,0,.2); }
    .stat strong { display:block; color:var(--gold); font-size:1.45rem; }
    .inventory { display:flex; flex-wrap:wrap; gap:9px; padding:0; list-style:none; }
    .figure { min-width:94px; padding:10px 12px; border-radius:12px; border:1px solid #31576b; background:#081b28; }
    .figure strong,.figure small { display:block; }
    .figure small { color:var(--muted); }
    .chests { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; }
    .chest { min-height:164px; display:flex; flex-direction:column; justify-content:space-between; gap:10px; padding:15px; border-radius:15px; border:1px solid rgba(255,216,57,.48); background:linear-gradient(160deg,rgba(89,66,4,.38),rgba(5,19,29,.95)); }
    .chest.empty { opacity:.52; border-style:dashed; justify-content:center; align-items:center; }
    .state { color:var(--lime); font-size:.78rem; font-weight:900; letter-spacing:.11em; text-transform:uppercase; }
    .meta { color:var(--muted); font-size:.82rem; }
    .section { margin-top:22px; }
    .check { display:flex; align-items:flex-start; gap:12px; line-height:1.5; }
    .check input { width:auto; margin-top:5px; }
    .access-list { list-style:none; padding:0; display:grid; gap:12px; }
    .access-list li { display:flex; align-items:center; justify-content:space-between; gap:16px; border:1px solid var(--line); border-radius:12px; padding:15px; }
    .access-list li > div { min-width:0; overflow-wrap:anywhere; }
    .access-list small { display:block; color:var(--muted); line-height:1.6; }
    .access-list button { white-space:nowrap; }
    .section-head { display:flex; align-items:end; justify-content:space-between; gap:20px; margin-bottom:13px; }
    @media (max-width:760px) { .hero,.auth-grid,.dashboard-grid { grid-template-columns:1fr; } .hero-copy { text-align:center; } .chests { grid-template-columns:repeat(2,1fr); } header { align-items:flex-start; } .account-chip { display:none; } }
    @media (max-width:420px) { main { width:min(100% - 20px,1120px); } .brand small { display:none; } .chests { grid-template-columns:1fr 1fr; gap:8px; } .chest { min-height:150px; padding:12px; } .access-list li { flex-direction:column; align-items:stretch; } }
  </style>
</head>
<body>
  <header>
    <a class="brand" href="/account"><img src="/account/icon.png" alt="Mew on an Iridium figure base"><span><strong>Kiwi Duel</strong><small>Independent account service</small></span></a>
    <div class="header-actions">${accountActions}</div>
  </header>
  <main>
    ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ""}
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    ${content}
  </main>
</body>
</html>`;
}

function authContent(linkCode = "", csrf = "") {
  const link = linkCode ? `
    <div class="panel">
      <div class="eyebrow">Device link waiting</div>
      <h2>Connect this Kiwi Duel install</h2>
      <p>Sign in or create an account below, then confirm the device you want to link. Your password stays in the browser.</p>
    </div>` : `
    <div class="hero-copy">
      <div class="eyebrow">Your figures. Your server.</div>
      <h1>Welcome to <span>Kiwi Duel.</span></h1>
      <p>Create an account for the normal starter deck, persistent figures, and chest rewards. The same database serves this page and the game client.</p>
    </div>`;
  const hidden = `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">${linkCode ? `<input type="hidden" name="link_code" value="${escapeHtml(linkCode)}">` : ""}`;
  return `<div class="hero">${link}<div class="auth-grid">
    <section class="panel"><h2>Sign in</h2><form method="post" action="/account/login">${hidden}<label>Email<input name="email" type="email" autocomplete="email" required maxlength="254"></label><label>Password<input name="password" type="password" autocomplete="current-password" required maxlength="256"></label><button type="submit">Sign in</button></form></section>
    <section class="panel"><h2>New account</h2><form method="post" action="/account/signup">${hidden}<label>Player name<input name="display_name" autocomplete="nickname" required minlength="2" maxlength="24"></label><label>Email<input name="email" type="email" autocomplete="email" required maxlength="254"></label><label>Password<input name="password" type="password" autocomplete="new-password" required minlength="10" maxlength="256"></label><button type="submit">Create account</button></form></section>
  </div></div>`;
}

function dashboardContent(snapshot, csrf) {
  const activeBySlot = new Map(snapshot.chests.map((chest) => [Number(chest.slot_index), chest]));
  const chestCards = [0, 1, 2].map((slot) => {
    const chest = activeBySlot.get(slot);
    if (!chest) return `<div class="chest empty"><span>Empty slot</span></div>`;
    let action = "";
    if (chest.state === "locked") action = `<form method="post" action="/account/chests/start"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="chest_id" value="${chest.chest_id}"><button type="submit">Start</button></form>`;
    else if (chest.state === "ready") action = `<form method="post" action="/account/chests/claim"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="chest_id" value="${chest.chest_id}"><button type="submit">Claim</button></form>`;
    else action = `<div class="meta">Ready in ${Math.ceil(Number(chest.remaining_milliseconds) / 1000)} sec</div>`;
    return `<div class="chest"><div><div class="state">${escapeHtml(chest.state)}</div><h3>Figure chest</h3><div class="meta">Slot ${slot + 1} · ${escapeHtml(chest.source)}</div></div>${action}</div>`;
  }).join("");
  const figureCards = snapshot.figures.map((figure) => `<li class="figure"><strong>Model ${figure.model_id}</strong><small>Item ${figure.item_master_id}</small><small>${escapeHtml(figure.source)}</small></li>`).join("");
  return `<section class="panel"><div class="eyebrow">Account ready</div><h1>${escapeHtml(snapshot.user.display_name)}<span>figure vault</span></h1><div class="stats"><div class="stat"><strong>${snapshot.figures.length}</strong><span>Figures</span></div><div class="stat"><strong>${snapshot.user.balances.coins}</strong><span>Coins</span></div><div class="stat"><strong>${snapshot.user.balances.gems}</strong><span>Gems</span></div></div><div class="section-head"><h2>Chest slots</h2><span class="meta">Rewards are committed by the server</span></div><div class="chests">${chestCards}</div><div class="section"><div class="section-head"><h2>Figures</h2><span class="meta">Starter and claimed inventory</span></div><ul class="inventory">${figureCards}</ul></div></section>`;
}

function linkContent(link, code, session) {
  return `<section class="panel"><div class="eyebrow">Confirm your game</div><h2>Link to ${escapeHtml(session.user.display_name)}?</h2>
    <p>Only approve a request that you opened from Kiwi Duel on your own phone or computer. A link sent by someone else could give them access to your account.</p>
    <p>Request code: <strong class="link-code">${escapeHtml(link.verification_code)}</strong>. Compare it with the code in the game.</p>
    <form method="post" action="/account/link"><input type="hidden" name="csrf" value="${escapeHtml(session.csrf_token)}"><input type="hidden" name="link_code" value="${escapeHtml(code)}">
    <label>Device name<input name="device_name" maxlength="80" value="${escapeHtml(link.label)}" autocomplete="off" required></label>
    <label class="check"><input type="checkbox" name="confirm_link" value="yes" required>I opened this request from my own game and the code matches.</label>
    <button type="submit">Link game</button> <a class="button quiet" href="/account">Cancel</a></form></section>`;
}

function securityContent(snapshot, session) {
  const date = (value) => escapeHtml(new Date(Number(value)).toISOString().replace("T", " ").slice(0, 16) + " UTC");
  const revoke = (action, name, value, text) => `<form action="${action}" method="post"><input type="hidden" name="csrf" value="${escapeHtml(session.csrf_token)}"><input type="hidden" name="${name}" value="${escapeHtml(value)}"><button class="quiet" type="submit">${text}</button></form>`;
  const browsers = snapshot.browser_sessions.map((entry) => `<li><div><strong>${escapeHtml(entry.label)}${entry.session_id === session.session_id ? " · This browser" : ""}</strong><small>Signed in ${date(entry.created_at)}</small><small>Last used ${date(entry.last_seen_at)}</small></div>${revoke("/account/sessions/revoke", "session_id", entry.session_id, "Sign out")}</li>`).join("");
  const devices = snapshot.devices.map((entry) => `<li><div><strong>${escapeHtml(entry.label)}</strong><small>Linked ${date(entry.linked_at)}</small><small>Last login ${date(entry.last_seen_at)}</small></div>${revoke("/account/devices/revoke", "device_id", entry.device_id, "Unlink")}</li>`).join("");
  return `<section class="panel section"><h2>Account access</h2><div class="dashboard-grid"><section><h3>Browsers</h3><ul class="access-list">${browsers}</ul></section><section><h3>Linked games</h3><p>Unlinking signs that installation out of your account. Your figures and decks stay saved.</p><ul class="access-list">${devices || "<li>No linked games yet.</li>"}</ul></section></div></section>`;
}

function matchHistoryContent(matches) {
  if (!matches.length) return "";
  return `<section class="panel section"><h2>Recent matches</h2><ul class="access-list">${matches.map((match) => {
    const result = match.winner === match.side ? "Won" : !match.winner || match.winner === "draw" ? "Draw" : "Lost";
    return `<li><div><strong>${result}</strong><small>${escapeHtml(match.mode)} · ${escapeHtml(match.reason)}</small></div><small>${escapeHtml(new Date(Number(match.finished_at)).toISOString().replace("T", " ").slice(0, 16))} UTC</small></li>`;
  }).join("")}</ul></section>`;
}

function requestOriginAllowed(request, publicBase) {
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = String(request.headers.origin ?? "");
  // Some browser/privacy clients omit Origin; the browser-bound CSRF token remains mandatory.
  if (!origin) return true;
  return origin === new URL(publicBase).origin;
}

function sameToken(left, right) {
  if (!left || !right || String(left).length > 256) return false;
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function browserLabel(request) {
  const agent = String(request.headers["user-agent"] ?? "");
  const browser = /Edg\//u.test(agent) ? "Edge" : /Firefox\//u.test(agent) ? "Firefox" : /Chrome\//u.test(agent) ? "Chrome" : /Safari\//u.test(agent) ? "Safari" : "Browser";
  const platform = /Android/u.test(agent) ? "Android" : /iPhone|iPad/u.test(agent) ? "iOS" : /Windows/u.test(agent) ? "Windows" : /Macintosh/u.test(agent) ? "macOS" : /Linux/u.test(agent) ? "Linux" : "";
  return `${browser}${platform ? ` on ${platform}` : ""}`;
}

export function createAccountSite({ store, publicBase, iconPath, now = Date.now, production = process.env.NODE_ENV === "production", trustedProxyAddresses = [] }) {
  const publicUrl = new URL(publicBase);
  const loopback = ["localhost", "127.0.0.1", "[::1]", "10.0.2.2"].includes(publicUrl.hostname);
  if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== "/") {
    throw new Error("account_public_base_must_be_an_http_origin");
  }
  if (publicUrl.protocol !== "https:" && (production || !loopback)) throw new Error("account_public_base_requires_https");
  if (!Array.isArray(trustedProxyAddresses) || trustedProxyAddresses.some((address) => !isIP(address))) throw new Error("account_trusted_proxy_must_be_exact_ip_addresses");
  const trustedProxies = new Set(trustedProxyAddresses);
  const secureCookies = publicUrl.protocol === "https:";
  const icon = readFileSync(iconPath);
  const attempts = new Map();

  function rateAllowed(request, bucket = "auth", limit = AUTH_ATTEMPTS) {
    const peer = String(request.socket.remoteAddress ?? "unknown");
    const forwarded = String(request.headers["x-forwarded-for"] ?? "").trim();
    // Only a configured proxy that overwrites X-Forwarded-For may name a client.
    // Chains or arbitrary client-supplied forwarding values never change the rate key.
    const address = trustedProxies.has(peer) && isIP(forwarded) ? forwarded : peer;
    const key = `${bucket}:${address}`;
    const current = Number(now());
    for (const [storedKey, values] of attempts) {
      if (!values.length || current - values.at(-1) >= AUTH_WINDOW_MS) attempts.delete(storedKey);
    }
    if (!attempts.has(key) && attempts.size >= 10_000) return false;
    const recent = (attempts.get(key) ?? []).filter((stamp) => current - stamp < AUTH_WINDOW_MS);
    if (recent.length >= limit) return false;
    recent.push(current);
    attempts.set(key, recent);
    return true;
  }

  function currentSession(request) {
    return store.browserSession(parseCookies(request.headers.cookie)[COOKIE_NAME]);
  }

  function renderAccount(request, response, session, url, { notice = "", error = "", status = 200 } = {}) {
    const linkCode = String(url.searchParams.get("code") ?? "");
    const link = linkCode ? store.pendingDeviceLink(linkCode) : null;
    if (linkCode && !link) {
      error ||= "That device link expired or has already been used. Reopen Kiwi Duel to request a new one.";
      status = 400;
    }
    if (!session) {
      const cookies = parseCookies(request.headers.cookie);
      let anonymous = store.anonymousBrowserSession(cookies[ANONYMOUS_COOKIE_NAME]);
      const headers = {};
      if (!anonymous) {
        if (!rateAllowed(request, "forms", 120)) {
          send(response, 429, "Too many requests. Try again in ten minutes.", "text/plain; charset=utf-8", { "Retry-After": "600" });
          return;
        }
        anonymous = store.createAnonymousBrowserSession();
        headers["Set-Cookie"] = sessionCookie(anonymous.token, secureCookies, Math.max(0, Math.floor((anonymous.expires_at - now()) / 1000)), ANONYMOUS_COOKIE_NAME);
      }
      send(response, status, page({ title: link ? "Link device" : "Account", content: authContent(link ? linkCode : "", anonymous.csrf_token), notice, error }), undefined, headers);
      return;
    }
    const snapshot = store.accountSnapshot(session.user.user_id);
    send(response, status, page({
      title: link ? "Confirm device" : "Figure vault",
      content: link ? linkContent(link, linkCode, session) : dashboardContent(snapshot, session.csrf_token) +
        matchHistoryContent(store.recentMatchCompletions(session.user.user_id)) + securityContent(store.accountSecuritySnapshot(session.user.user_id), session),
      user: session.user,
      csrf: session.csrf_token,
      notice,
      error,
    }));
  }

  function requireSessionAndCsrf(request, form) {
    const session = currentSession(request);
    if (!session) throw new Error("sign_in_required");
    if (!sameToken(form.csrf, session.csrf_token)) throw new Error("invalid_request_token");
    return session;
  }

  return async function handleAccountRequest(request, response, url) {
    const pathname = url.pathname;
    if (pathname !== "/account" && !pathname.startsWith("/account/")) return false;
    if (secureCookies) response.setHeader("Strict-Transport-Security", "max-age=31536000");
    if (request.method === "GET" && pathname === "/account/icon.png") {
      send(response, 200, icon, "image/png");
      return true;
    }
    if (request.method === "GET" && ["/account", "/account/", "/account/link"].includes(pathname)) {
      renderAccount(request, response, currentSession(request), url, {
        notice: url.searchParams.get("linked") === "1" ? "Game linked. Return to Kiwi Duel. If it is still waiting, close and reopen the game to finish signing in." : url.searchParams.get("claimed") === "1" ? "Chest reward added to your account." : url.searchParams.get("revoked") === "1" ? "Access removed. Your account and saved figures are unchanged." : "",
      });
      return true;
    }
    if (request.method !== "POST") {
      send(response, 405, "Method not allowed", "text/plain; charset=utf-8");
      return true;
    }
    if (!requestOriginAllowed(request, publicBase)) {
      console.warn(JSON.stringify({ schema: "kiwi-duel-account-rejection-1", reason: "request_origin_rejected",
        cross_site: request.headers["sec-fetch-site"] === "cross-site",
        origin_matches: String(request.headers.origin ?? "") === new URL(publicBase).origin }));
      send(response, 403, "Request origin rejected", "text/plain; charset=utf-8");
      return true;
    }
    let form;
    try { form = await readForm(request); }
    catch (error) {
      send(response, error.message === "form_too_large" ? 413 : 400, "Invalid form", "text/plain; charset=utf-8");
      return true;
    }
    try {
      if (["/account/login", "/account/signup"].includes(pathname)) {
        const cookies = parseCookies(request.headers.cookie);
        const anonymous = store.anonymousBrowserSession(cookies[ANONYMOUS_COOKIE_NAME]);
        if (!anonymous || !sameToken(form.csrf, anonymous.csrf_token)) throw new Error("invalid_request_token");
        if (!rateAllowed(request)) throw new Error("too_many_sign_in_attempts");
        if (form.link_code && !store.pendingDeviceLink(form.link_code)) throw new Error("device_link_invalid_or_expired");
        const user = pathname === "/account/signup"
          ? store.createAccount({ email: form.email, displayName: form.display_name, password: form.password })
          : store.authenticatePassword(form.email, form.password);
        if (!user) throw new Error("email_or_password_incorrect");
        // Sign-in proves the account only. Linking is a separate, explicit authenticated action.
        const session = store.createBrowserSession(user.user_id, { label: browserLabel(request) });
        store.revokeAnonymousBrowserSession(cookies[ANONYMOUS_COOKIE_NAME]);
        store.revokeBrowserSession(cookies[COOKIE_NAME]);
        redirect(response, form.link_code ? `/account/link?code=${encodeURIComponent(form.link_code)}` : "/account", { "Set-Cookie": [
          sessionCookie(session.token, secureCookies, Math.max(0, Math.floor((session.expires_at - now()) / 1000))),
          sessionCookie("", secureCookies, 0, ANONYMOUS_COOKIE_NAME),
        ] });
        return true;
      }
      if (pathname === "/account/logout") {
        requireSessionAndCsrf(request, form);
        store.revokeBrowserSession(parseCookies(request.headers.cookie)[COOKIE_NAME]);
        redirect(response, "/account", { "Set-Cookie": clearSessionCookie(secureCookies) });
        return true;
      }
      const session = requireSessionAndCsrf(request, form);
      if (pathname === "/account/link") {
        if (!rateAllowed(request, "links", 30)) throw new Error("too_many_sign_in_attempts");
        if (form.confirm_link !== "yes") throw new Error("device_link_confirmation_required");
        store.linkDevice(form.link_code, session.user.user_id, { label: form.device_name });
        redirect(response, "/account?linked=1");
        return true;
      }
      if (pathname === "/account/sessions/revoke") {
        store.revokeBrowserSessionById(session.user.user_id, form.session_id);
        redirect(response, "/account?revoked=1", form.session_id === session.session_id ? { "Set-Cookie": clearSessionCookie(secureCookies) } : {});
        return true;
      }
      if (pathname === "/account/devices/revoke") {
        store.revokeDevice(session.user.user_id, form.device_id);
        redirect(response, "/account?revoked=1");
        return true;
      }
      if (pathname === "/account/chests/start") {
        store.startChest(session.user.user_id, Number(form.chest_id));
        redirect(response, "/account");
        return true;
      }
      if (pathname === "/account/chests/claim") {
        store.claimChest(session.user.user_id, Number(form.chest_id));
        redirect(response, "/account?claimed=1");
        return true;
      }
      send(response, 404, "Not found", "text/plain; charset=utf-8");
      return true;
    } catch (error) {
      if (error.message === "invalid_request_token") console.warn(JSON.stringify({
        schema: "kiwi-duel-account-rejection-1", reason: "invalid_request_token",
      }));
      const message = {
        email_already_registered: "That email already has a Kiwi Duel account.",
        email_or_password_incorrect: "The email or password was not correct.",
        invalid_email: "Enter a valid email address.",
        invalid_display_name: "Player names must be 2–24 letters, numbers, spaces, underscores, apostrophes, periods, or hyphens.",
        password_too_short: "Passwords must contain at least 10 characters.",
        password_too_long: "Passwords must contain at most 256 characters.",
        device_link_invalid_or_expired: "That device link expired. Reopen Kiwi Duel to request a new one.",
        device_link_confirmation_required: "Confirm that you opened this request from your own game and that its code matches.",
        device_not_found: "That linked game is no longer present in your account.",
        session_not_found: "That browser has already signed out or is not part of your account.",
        too_many_sign_in_attempts: "Too many attempts. Wait ten minutes before trying again.",
        chest_not_ready: "That chest is still unlocking.",
        chest_not_startable: "That chest cannot be started right now.",
        chest_not_claimable: "That chest cannot be claimed right now.",
        sign_in_required: "Sign in before continuing.",
        invalid_request_token: "That page expired. Reload it and try again.",
      }[error.message] ?? "The request could not be completed.";
      const session = currentSession(request);
      const status = error.message === "invalid_request_token" ? 403 : ["sign_in_required", "email_or_password_incorrect"].includes(error.message) ? 401 : error.message === "too_many_sign_in_attempts" ? 429 : 400;
      if (status === 429) response.setHeader("Retry-After", "600");
      renderAccount(request, response, session, new URL(`/account${form.link_code ? `/link?code=${encodeURIComponent(form.link_code)}` : ""}`, publicBase), { error: message, status });
      return true;
    }
  };
}

export const accountSiteContract = Object.freeze({ cookieName: COOKIE_NAME, anonymousCookieName: ANONYMOUS_COOKIE_NAME, maximumFormBytes: MAX_FORM_BYTES });
