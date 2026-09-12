import { randomUUID } from "node:crypto";

import { redis } from "./redis.js";

/**
 * Single-instance mutual exclusion: `SET key token NX PX ttl`.
 *
 * Scope and limits, stated plainly because this matters for money movement:
 * this is a best-effort lock against one Redis primary. If that primary fails
 * over before replicating the SET, two holders can believe they own the same
 * lock. Use it to stop duplicate work (one worker per job, one recompute per
 * cache miss), never as the only thing standing between a payment and a double
 * charge — that needs a uniqueness constraint or an idempotency record in
 * Postgres, where the write is durable.
 */

/**
 * Release and extend compare the token before acting. Without that check, a
 * holder that stalls past the TTL would delete the lock its successor now owns.
 */
const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

const EXTEND_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0
`;

export interface Lock {
  readonly key: string;
  readonly token: string;
}

export class LockNotAcquiredError extends Error {
  constructor(readonly key: string) {
    super(`Could not acquire lock ${key}`);
    this.name = "LockNotAcquiredError";
  }
}

/** Returns null when someone else holds the lock. Never throws on contention. */
export const acquireLock = async (
  key: string,
  ttlMs: number,
): Promise<Lock | null> => {
  const token = randomUUID();
  const result = await redis.set(key, token, "PX", ttlMs, "NX");
  return result === "OK" ? { key, token } : null;
};

export const releaseLock = async (lock: Lock): Promise<boolean> => {
  const result = await redis.eval(RELEASE_SCRIPT, 1, lock.key, lock.token);
  return result === 1;
};

/** Renews a lock still held by this token, for work that outruns its TTL. */
export const extendLock = async (lock: Lock, ttlMs: number): Promise<boolean> => {
  const result = await redis.eval(
    EXTEND_SCRIPT,
    1,
    lock.key,
    lock.token,
    String(ttlMs),
  );
  return result === 1;
};

export interface WithLockOptions {
  /** Lock lifetime. Must exceed the worst-case runtime of `fn`. */
  ttlMs: number;
  /** Extra acquisition attempts before giving up. 0 means try once. */
  retries?: number;
  retryDelayMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn` while holding the lock, releasing it even if `fn` throws. Throws
 * LockNotAcquiredError if the lock could not be taken within the retry budget.
 */
export const withLock = async <T>(
  key: string,
  options: WithLockOptions,
  fn: (lock: Lock) => Promise<T>,
): Promise<T> => {
  const { ttlMs, retries = 0, retryDelayMs = 100 } = options;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const lock = await acquireLock(key, ttlMs);

    if (lock) {
      try {
        return await fn(lock);
      } finally {
        // Releasing is best-effort: if it fails the TTL still frees the lock.
        await releaseLock(lock).catch(() => undefined);
      }
    }

    if (attempt < retries) {
      // Jittered backoff, so queued contenders do not retry in lockstep.
      await sleep(retryDelayMs + Math.floor(Math.random() * retryDelayMs));
    }
  }

  throw new LockNotAcquiredError(key);
};
