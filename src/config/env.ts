import "dotenv/config";

import { z } from "zod";

const logLevels = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
] as const;

/**
 * Environment variables are always strings, so booleans need an explicit set of
 * accepted spellings rather than JS truthiness ("false" would be truthy).
 */
const booleanFromEnv = (defaultValue: boolean) =>
  z
    .enum(["true", "false", "1", "0"])
    .default(defaultValue ? "true" : "false")
    .transform((value) => value === "true" || value === "1");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  DATABASE_URL: z
    .string()
    .min(1)
    .refine(
      (value) => /^postgres(ql)?:\/\//.test(value),
      "must be a postgres:// or postgresql:// connection string",
    ),

  LOG_LEVEL: z.enum(logLevels).default("info"),

  // Comma-separated browser origins allowed to call this API.
  // Empty means no cross-origin browser requests are permitted.
  CORS_ORIGINS: z.string().default(""),

  // Number of reverse proxies in front of this app. Keep at 0 when the app is
  // exposed directly — trusting X-Forwarded-For blindly lets clients spoof
  // their IP and bypass rate limiting.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),

  // Maximum accepted request body size, as an Express/bytes string.
  BODY_LIMIT: z.string().min(1).default("100kb"),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),

  // When the Redis-backed rate limit store is unreachable, allow the request
  // through rather than returning 500. Availability over enforcement — flip to
  // false if you would rather shed traffic than lose the limit.
  RATE_LIMIT_FAIL_OPEN: booleanFromEnv(true),

  // redis:// or rediss:// (TLS). Credentials, db index and TLS all come from
  // the URL, so there is a single source of truth for the connection.
  REDIS_URL: z
    .string()
    .min(1)
    .refine(
      (value) =>
        value.startsWith("redis://") || value.startsWith("rediss://"),
      "must be a redis:// or rediss:// connection string",
    )
    .default("redis://127.0.0.1:6379"),

  // Root of every key this service writes. Keep it short: the prefix is stored
  // with every key, and Redis keeps all keys in memory.
  REDIS_KEY_PREFIX: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]*$/, "must be lowercase alphanumeric, _ or -")
    .max(24)
    .default("payplus"),

  REDIS_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // Retries per command before it rejects. ioredis defaults to 20, which can
  // pin a request for a very long time during a failover.
  REDIS_MAX_RETRIES_PER_REQUEST: z.coerce.number().int().min(0).max(10).default(2),

  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  // Bump to invalidate every cached payload at once, e.g. after changing the
  // shape of what gets cached. Cheaper and safer than deleting keys.
  CACHE_SCHEMA_VERSION: z
    .string()
    .regex(/^v[0-9]+$/, 'must look like "v1"')
    .default("v1"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");

  // Fail fast and loudly: a half-configured process is worse than no process.
  console.error(`Invalid environment configuration:\n${details}`);
  process.exit(1);
}

export const env = Object.freeze(parsed.data);

export const isProduction = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";

export const corsOrigins = env.CORS_ORIGINS.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
