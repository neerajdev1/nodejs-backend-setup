import { cacheDelete, cacheGet, cacheGetOrSet, cacheInvalidatePattern } from "../lib/cache.js";
import { acquireLock, releaseLock, withLock } from "../lib/lock.js";
import { closeRedis, pingRedis, redis, waitForRedis } from "../lib/redis.js";
import { cacheKey, cachePattern, keyRoot, lockKey } from "../lib/redis-keys.js";

/**
 * End-to-end check against a live Redis: connection, key layout, cache
 * round-trip with TTL, SCAN-based invalidation, and lock mutual exclusion.
 * Run with `npm run redis:check`.
 */

// enableOfflineQueue is false, so wait for the handshake before commanding.
await waitForRedis(5_000).catch(() => undefined);

const ping = await pingRedis();
if (!ping.ok) {
  console.error(`Redis unreachable: ${ping.error}`);
  await closeRedis();
  process.exit(1);
}

console.log(`Connected to Redis (${ping.latencyMs}ms)`);
console.log(`  key root: ${keyRoot}`);

const [version] = await redis
  .info("server")
  .then((info) => info.split("\n").filter((line) => line.startsWith("redis_version")));
console.log(`  ${version?.trim() ?? "version unknown"}`);

let failures = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) {
    failures += 1;
    if (extra !== undefined) console.log("      got:", JSON.stringify(extra));
  }
};

// --- cache round trip -------------------------------------------------------
const probeKey = cacheKey("selfcheck", "probe");
console.log(`  sample key: ${probeKey}`);

await cacheDelete(probeKey);
let loaderCalls = 0;
const loader = async () => {
  loaderCalls += 1;
  return { checkedAt: new Date().toISOString(), n: 1 };
};

const first = await cacheGetOrSet(probeKey, loader, 60);
const second = await cacheGetOrSet(probeKey, loader, 60);
check("cacheGetOrSet populates then serves from cache", loaderCalls === 1, { loaderCalls });
check("cached value round-trips intact", JSON.stringify(first) === JSON.stringify(second));

const ttl = await redis.ttl(probeKey);
check("cache write carries a TTL", ttl > 0 && ttl <= 67, { ttl });

// --- SCAN-based invalidation ------------------------------------------------
const subtree = ["selfcheck", "subtree"] as const;
await Promise.all([
  redis.set(cacheKey(...subtree, "a"), "1", "EX", 60),
  redis.set(cacheKey(...subtree, "b"), "1", "EX", 60),
]);
const removed = await cacheInvalidatePattern(cachePattern(...subtree));
check("pattern invalidation removed both keys via SCAN", removed === 2, { removed });

// --- locking ----------------------------------------------------------------
const lKey = lockKey("selfcheck", "probe");
const lock = await acquireLock(lKey, 5_000);
check("lock acquired", lock !== null);
const contended = await acquireLock(lKey, 5_000);
check("second acquire is refused while held", contended === null);
check("release succeeds for the token holder", lock !== null && (await releaseLock(lock)));
check("lock is free after release", (await acquireLock(lKey, 1_000)) !== null);
await redis.unlink(lKey);

const stolen = { key: lKey, token: "not-the-real-token" };
await acquireLock(lKey, 5_000);
check("release with a foreign token is refused", (await releaseLock(stolen)) === false);
await redis.unlink(lKey);

check(
  "withLock runs the body and frees the lock",
  (await withLock(lKey, { ttlMs: 5_000 }, async () => "done")) === "done" &&
    (await cacheGet(lKey)) === null,
);

await cacheDelete(probeKey);
await closeRedis();

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
