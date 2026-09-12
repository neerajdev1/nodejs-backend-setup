import { Redis, type RedisOptions } from "ioredis";

import { env } from "../config/env.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "redis" });

/**
 * Note the absence of ioredis's `keyPrefix` option. It is applied by the client
 * to ordinary commands but NOT to `KEYS`/`EVAL` arguments, so Lua scripts and
 * SCAN patterns silently address the wrong keys. All keys are therefore built
 * explicitly in redis-keys.ts, which is also the only place the layout lives.
 */
const baseOptions: RedisOptions = {
  connectTimeout: env.REDIS_CONNECT_TIMEOUT_MS,

  // ioredis retries a command 20 times by default, which can pin a request for
  // a long time during a failover. Fail fast and let the caller degrade.
  maxRetriesPerRequest: env.REDIS_MAX_RETRIES_PER_REQUEST,

  enableReadyCheck: true,

  // Commands issued before the socket is ready are buffered and flushed on
  // connect. This must stay true: rate-limit-redis runs SCRIPT LOAD when the
  // store is constructed at module load, long before the handshake finishes.
  // With the queue disabled that command rejects, the store caches the
  // rejected promise, and rate limiting is silently dead for the life of the
  // process. The queue is not unbounded either — once a command exceeds
  // maxRetriesPerRequest the queue is flushed with an error, which is what
  // makes the degraded paths below fire instead of growing memory.
  enableOfflineQueue: true,

  // Exponential backoff with jitter and a ceiling, so a fleet of instances does
  // not reconnect in lockstep and hammer a recovering server.
  retryStrategy: (attempt) => {
    const backoff = Math.min(2 ** attempt * 50, 5_000);
    return backoff + Math.floor(Math.random() * 100);
  },

  // A replica promoted to primary answers writes with READONLY. Reconnecting
  // picks up the new topology instead of failing writes until someone notices.
  reconnectOnError: (error) => error.message.includes("READONLY"),
};

/** Collapses repeated identical errors so a long outage cannot flood the logs. */
const makeErrorThrottle = (windowMs = 30_000) => {
  let lastMessage = "";
  let lastAt = 0;
  let suppressed = 0;

  return (error: Error, name: string) => {
    const now = Date.now();
    if (error.message === lastMessage && now - lastAt < windowMs) {
      suppressed += 1;
      return;
    }
    log.warn(
      {
        client: name,
        err: error,
        ...(suppressed > 0 ? { suppressedSinceLast: suppressed } : {}),
      },
      "Redis connection error",
    );
    lastMessage = error.message;
    lastAt = now;
    suppressed = 0;
  };
};

/**
 * ioredis needs a dedicated connection per blocking or subscribing consumer: a
 * client in subscriber mode cannot run ordinary commands, and a blocking call
 * like BLPOP occupies the socket. Use this for those; use `redis` for the rest.
 */
export const createRedisClient = (name: string): Redis => {
  const client = new Redis(env.REDIS_URL, {
    ...baseOptions,
    // Shows up in CLIENT LIST, so a rogue connection is traceable to a process.
    connectionName: `${env.REDIS_KEY_PREFIX}:${env.NODE_ENV}:${name}`,
  });

  const onError = makeErrorThrottle();

  // An 'error' event with no listener is an unhandled exception in Node, so this
  // listener is mandatory, not optional.
  client.on("error", (error: Error) => onError(error, name));
  client.on("ready", () => log.info({ client: name }, "Redis ready"));
  client.on("reconnecting", (delay: number) =>
    log.warn({ client: name, delay }, "Redis reconnecting"),
  );
  client.on("end", () => log.warn({ client: name }, "Redis connection closed"));

  return client;
};

export const redis = createRedisClient("main");

export const isRedisReady = (): boolean => redis.status === "ready";

export interface RedisPing {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export const pingRedis = async (): Promise<RedisPing> => {
  const startedAt = performance.now();
  try {
    await redis.ping();
    return { ok: true, latencyMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "unknown error",
    };
  }
};

/**
 * Closes the connection on shutdown. QUIT drains in-flight replies first; if the
 * socket is already gone QUIT rejects, so fall back to dropping it outright.
 */
export const closeRedis = async (): Promise<void> => {
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
};

/**
 * Waits for the connection to reach "ready".
 *
 * Request handlers do not need this — their commands queue until ready and they
 * degrade on error. Short-lived scripts and jobs do: they should fail loudly if
 * Redis never answers, rather than queue work and exit.
 */
export const waitForRedis = async (timeoutMs = 5_000): Promise<void> => {
  if (redis.status === "ready") return;

  await new Promise<void>((resolve, reject) => {
    const onReady = () => {
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Redis not ready within ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      redis.removeListener("ready", onReady);
    };

    redis.once("ready", onReady);
  });
};
