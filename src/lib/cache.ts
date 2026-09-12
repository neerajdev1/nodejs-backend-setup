import { env } from "../config/env.js";
import { logger } from "./logger.js";
import { redis } from "./redis.js";

const log = logger.child({ module: "cache" });

/**
 * Every write here takes a TTL, and there is deliberately no variant that omits
 * one: keys without an expiry accumulate until they fill the instance, and a
 * cache entry with no expiry is indistinguishable from durable state.
 *
 * All reads and writes swallow Redis errors and report a miss. A cache outage
 * must degrade latency, never availability.
 */

/** Spreads expiry so a batch of keys written together does not expire together. */
const withJitter = (ttlSeconds: number): number => {
  const spread = Math.max(1, Math.round(ttlSeconds * 0.1));
  return ttlSeconds + Math.floor(Math.random() * spread);
};

export const cacheGet = async <T>(key: string): Promise<T | null> => {
  let raw: string | null;

  try {
    raw = await redis.get(key);
  } catch (error) {
    log.warn({ err: error, key }, "Cache read failed, treating as miss");
    return null;
  }

  if (raw === null) return null;

  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    // A value we cannot parse is poison: drop it so it cannot keep failing.
    log.warn({ err: error, key }, "Discarding unparseable cache entry");
    void cacheDelete(key);
    return null;
  }
};

export const cacheSet = async <T>(
  key: string,
  value: T,
  ttlSeconds: number = env.CACHE_TTL_SECONDS,
): Promise<boolean> => {
  try {
    await redis.set(key, JSON.stringify(value), "EX", withJitter(ttlSeconds));
    return true;
  } catch (error) {
    log.warn({ err: error, key }, "Cache write failed");
    return false;
  }
};

/**
 * UNLINK rather than DEL: reclaiming a large value happens on a background
 * thread instead of blocking the server for the duration.
 */
export const cacheDelete = async (...keys: string[]): Promise<number> => {
  if (keys.length === 0) return 0;
  try {
    return await redis.unlink(...keys);
  } catch (error) {
    log.warn({ err: error, keys }, "Cache delete failed");
    return 0;
  }
};

/**
 * Read-through cache. Note that concurrent misses all run `loader` — for a
 * loader expensive enough that this matters, wrap it in `withLock` so only one
 * caller recomputes.
 */
export const cacheGetOrSet = async <T>(
  key: string,
  loader: () => Promise<T>,
  ttlSeconds: number = env.CACHE_TTL_SECONDS,
): Promise<T> => {
  const hit = await cacheGet<T>(key);
  if (hit !== null) return hit;

  const value = await loader();

  // null and undefined are not cached: they are indistinguishable from a miss
  // on the way back out, so caching them would guarantee a reload every time.
  if (value !== null && value !== undefined) {
    await cacheSet(key, value, ttlSeconds);
  }

  return value;
};

/**
 * Deletes a subtree, e.g. `cachePattern("user", id)` for every cached field of
 * one user.
 *
 * Uses SCAN, never KEYS: KEYS walks the entire keyspace in a single blocking
 * call, which on a production instance stalls every other client. SCAN gives up
 * the server between batches and may return a key twice, which is harmless
 * because UNLINK is idempotent.
 */
export const cacheInvalidatePattern = async (pattern: string): Promise<number> => {
  let cursor = "0";
  let removed = 0;

  try {
    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        250,
      );
      cursor = nextCursor;
      if (keys.length > 0) {
        removed += await redis.unlink(...keys);
      }
    } while (cursor !== "0");
  } catch (error) {
    log.warn({ err: error, pattern }, "Cache invalidation failed");
  }

  return removed;
};
