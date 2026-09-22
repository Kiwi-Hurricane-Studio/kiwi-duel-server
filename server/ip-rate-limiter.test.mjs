import assert from "node:assert/strict";
import test from "node:test";
import { createClientAddressResolver, createIpRateLimiter, ownedLoginRateLimitDefaults } from "./ip-rate-limiter.mjs";

function request(peer = "192.0.2.10", forwarded) {
  return { socket: { remoteAddress: peer }, headers: forwarded == null ? {} : { "x-forwarded-for": forwarded } };
}

test("fixed IP windows bound attempts, reject without sliding expiry, and recover exactly at expiry", () => {
  let now = 1_000;
  const limiter = createIpRateLimiter({ limit: 2, windowMs: 5_000, now: () => now });
  assert.equal(limiter.consume(request()).remaining, 1);
  assert.equal(limiter.consume(request()).remaining, 0);
  assert.deepEqual(limiter.consume(request()), { allowed: false, reason: "limit_exceeded", remaining: 0, retry_after_seconds: 5, reset_at: 6_000 });
  now = 5_999;
  for (let attempt = 0; attempt < 100; attempt += 1) assert.equal(limiter.consume(request()).retry_after_seconds, 1);
  now = 6_000;
  assert.equal(limiter.consume(request()).allowed, true);
  now = 5_000;
  assert.equal(limiter.consume(request()).allowed, true);
  assert.equal(limiter.consume(request()).allowed, false, "clock rollback cannot grant a fresh window");
});

test("an address flood cannot evict active limits or exceed memory capacity, and expired capacity is reusable", () => {
  let now = 0;
  const limiter = createIpRateLimiter({ limit: 1, windowMs: 1_000, maxEntries: 3, now: () => now });
  for (const ip of ["192.0.2.1", "192.0.2.2", "192.0.2.3"]) assert.equal(limiter.consume(request(ip)).allowed, true);
  for (let index = 0; index < 1000; index += 1) assert.equal(limiter.consume(request(`2001:db8::${(index + 1).toString(16)}`)).reason, "capacity_exceeded");
  assert.equal(limiter.consume(request("192.0.2.1")).reason, "limit_exceeded", "new IPs must not evict a limited active IP");
  assert.equal(limiter.snapshot().tracked_ips, 3);
  now = 1_000;
  assert.equal(limiter.snapshot().tracked_ips, 0);
  assert.equal(limiter.consume(request("192.0.2.4")).allowed, true);
  assert.doesNotMatch(JSON.stringify(limiter.snapshot()), /192\.0\.2|2001:db8/u);
});

test("proxy identity requires an exact trusted socket peer and a single valid forwarded IP", () => {
  const resolve = createClientAddressResolver(["127.0.0.1", "::1"]);
  assert.equal(resolve(request("192.0.2.1", "198.51.100.1")), "192.0.2.1");
  assert.equal(resolve(request("127.0.0.1", "198.51.100.1")), "198.51.100.1");
  assert.equal(resolve(request("::ffff:127.0.0.1", "198.51.100.1")), "127.0.0.1", "mapped peer is not an exact match for a configured IPv4 proxy");
  for (const forwarded of ["198.51.100.1, 127.0.0.1", "not-an-ip", "fe80::1%eth0", ["198.51.100.1"], "198.51.100.1:80"]) {
    assert.equal(resolve(request("127.0.0.1", forwarded)), "127.0.0.1");
  }
  assert.equal(resolve(request("::1", " 2001:0db8:0:0::1 ")), "2001:db8::1");
  assert.equal(resolve(request("::1", "::ffff:192.0.2.123")), "192.0.2.123");
  assert.equal(resolve(request("::1", "::ffff:c000:27b")), "192.0.2.123");
  assert.equal(resolve({}), "unknown");
  const limiter = createIpRateLimiter({ limit: 1, trustedProxyAddresses: ["::1"] });
  assert.equal(limiter.consume(request("::1", "2001:0db8:0:0::1")).allowed, true);
  assert.equal(limiter.consume(request("::1", "2001:db8::1")).allowed, false, "alternate IPv6 notation must not bypass a limit");
  for (const invalid of [["*"], ["127.0.0.0/8"], ["localhost"], ["fe80::1%eth0"], "127.0.0.1", [null]]) {
    assert.throws(() => createClientAddressResolver(invalid), /trusted_proxy_must_be_exact_ip_addresses/u);
  }
});

test("owned login defaults are bounded and invalid configuration/clocks fail closed", () => {
  assert.deepEqual(ownedLoginRateLimitDefaults, { limit: 120, windowMs: 600_000, maxEntries: 10_000 });
  for (const options of [{ limit: 0 }, { limit: 1.5 }, { maxEntries: 0 }, { windowMs: NaN }, { windowMs: 86_400_001 }, { now: 0 }]) {
    assert.throws(() => createIpRateLimiter(options));
  }
  for (const now of [NaN, Infinity, -1, 1.1, Number.MAX_SAFE_INTEGER]) {
    const limiter = createIpRateLimiter({ now: () => now });
    assert.throws(() => limiter.consume(request()), /rate_clock_invalid/u);
  }
});
