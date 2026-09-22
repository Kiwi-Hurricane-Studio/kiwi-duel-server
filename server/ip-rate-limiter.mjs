import { isIP } from "node:net";

export const ownedLoginRateLimitDefaults = Object.freeze({
  limit: 120,
  windowMs: 10 * 60 * 1000,
  maxEntries: 10_000,
});

function canonicalAddress(address) {
  if (isIP(address) === 4) return address;
  if (isIP(address) !== 6 || address.includes("%")) return null;
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/u.exec(normalized);
  if (mapped) {
    const high = Number.parseInt(mapped[1], 16); const low = Number.parseInt(mapped[2], 16);
    return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
  }
  return normalized;
}

export function createClientAddressResolver(trustedProxyAddresses = []) {
  if (!Array.isArray(trustedProxyAddresses) || trustedProxyAddresses.some((address) => typeof address !== "string" || !isIP(address) || address.includes("%"))) {
    throw new Error("trusted_proxy_must_be_exact_ip_addresses");
  }
  const trusted = new Set(trustedProxyAddresses);
  return (request) => {
    const peer = String(request?.socket?.remoteAddress ?? "");
    const forwardedHeader = request?.headers?.["x-forwarded-for"];
    const forwarded = typeof forwardedHeader === "string" ? forwardedHeader.trim() : "";
    // The socket peer must match an explicit literal exactly. The configured
    // proxy must overwrite X-Forwarded-For with ONE IP; chains, array headers,
    // alternate spellings of a trusted peer, and untrusted peers cannot claim it.
    // Canonicalization only affects the rate key, never this trust decision.
    return (trusted.has(peer) ? canonicalAddress(forwarded) : null) ?? canonicalAddress(peer) ?? "unknown";
  };
}

export function createIpRateLimiter({
  limit = ownedLoginRateLimitDefaults.limit,
  windowMs = ownedLoginRateLimitDefaults.windowMs,
  maxEntries = ownedLoginRateLimitDefaults.maxEntries,
  trustedProxyAddresses = [],
  now = Date.now,
} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000) throw new Error("rate_limit_must_be_between_1_and_1000000");
  if (!Number.isSafeInteger(windowMs) || windowMs < 1 || windowMs > 24 * 60 * 60 * 1000) throw new Error("rate_window_must_be_between_1ms_and_24hours");
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 1_000_000) throw new Error("rate_capacity_must_be_between_1_and_1000000");
  if (typeof now !== "function") throw new Error("rate_clock_must_be_a_function");
  const clientAddress = createClientAddressResolver(trustedProxyAddresses);
  const entries = new Map();
  let lastNow = 0;
  function currentTime() {
    const stamp = Number(now());
    if (!Number.isSafeInteger(stamp) || stamp < 0 || !Number.isSafeInteger(stamp + windowMs)) throw new Error("rate_clock_invalid");
    // Clock rollback must not reset limits early. No per-request timers or IP
    // history arrays are retained; each entry is just a counter and expiry.
    lastNow = Math.max(lastNow, stamp);
    return lastNow;
  }
  function purge(stamp) {
    // Fixed-duration windows are inserted in expiry order. Rejected requests
    // never refresh that expiry, so reclamation is amortized O(1) per entry.
    while (entries.size) {
      const oldest = entries.entries().next().value;
      if (oldest[1].resetAt > stamp) break;
      entries.delete(oldest[0]);
    }
  }
  return Object.freeze({
    consume(request) {
      const stamp = currentTime();
      purge(stamp);
      const address = clientAddress(request);
      let entry = entries.get(address);
      if (!entry) {
        if (entries.size >= maxEntries) {
          const resetAt = entries.values().next().value.resetAt;
          return { allowed: false, reason: "capacity_exceeded", remaining: 0, retry_after_seconds: Math.max(1, Math.ceil((resetAt - stamp) / 1000)), reset_at: resetAt };
        }
        entry = { count: 0, resetAt: stamp + windowMs };
        entries.set(address, entry);
      }
      if (entry.count >= limit) {
        return { allowed: false, reason: "limit_exceeded", remaining: 0, retry_after_seconds: Math.max(1, Math.ceil((entry.resetAt - stamp) / 1000)), reset_at: entry.resetAt };
      }
      entry.count += 1;
      return { allowed: true, reason: "allowed", remaining: limit - entry.count, retry_after_seconds: 0, reset_at: entry.resetAt };
    },
    snapshot() {
      purge(currentTime());
      // Aggregate diagnostics contain no client addresses, tokens or requests.
      return { tracked_ips: entries.size, maximum_tracked_ips: maxEntries, limit, window_ms: windowMs };
    },
  });
}
