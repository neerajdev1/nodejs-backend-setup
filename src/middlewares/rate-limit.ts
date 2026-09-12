import rateLimit, { ipKeyGenerator, type Store } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";

import { env } from "../config/env.js";
import { TooManyRequestsError } from "../lib/errors.js";
import { hashValue, rateLimitPrefix } from "../lib/redis-keys.js";
import { redis } from "../lib/redis.js";

/**
 * Counters live in Redis, not in process memory. An in-memory store lets N
 * instances each serve the full quota — N times the intended rate — and forgets
 * every counter on deploy, which is exactly when a limit matters most.
 *
 * Each limiter needs its own store instance and its own key prefix, or they
 * share counters.
 */
const createStore = (bucket: string): Store =>
  new RedisStore({
    sendCommand: (command: string, ...args: string[]) =>
      redis.call(command, ...args) as Promise<number | string>,
    prefix: rateLimitPrefix(bucket),
  });

/** Applies to every route, as a blanket guard against floods and scraping. */
export const globalRateLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  store: createStore("global"),
  // A Redis outage would otherwise turn every request into a 500. Allowing
  // traffic through unmetered is the lesser failure; set RATE_LIMIT_FAIL_OPEN
  // to false if you would rather shed load than lose enforcement.
  passOnStoreError: env.RATE_LIMIT_FAIL_OPEN,
  handler: (_req, _res, next) => next(new TooManyRequestsError()),
});

/**
 * Far tighter budget for credential-handling routes (login, password reset,
 * OTP), where the threat is online guessing rather than volume.
 */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  store: createStore("auth"),
  passOnStoreError: env.RATE_LIMIT_FAIL_OPEN,
  // Pair the client IP with the submitted identifier so one attacker cannot
  // lock out every account from a single address, and a distributed attack on
  // one account still shares a budget. The identifier is hashed because the key
  // would otherwise hold an email address, and keys are visible in MONITOR,
  // SLOWLOG and keyspace dumps.
  keyGenerator: (req) => {
    const ip = ipKeyGenerator(req.ip ?? "");
    const email =
      typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    return email ? `${ip}:${hashValue(email)}` : ip;
  },
  handler: (_req, _res, next) =>
    next(new TooManyRequestsError("Too many attempts, please retry later")),
});
