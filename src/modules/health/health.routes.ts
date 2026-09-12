import { Router } from "express";

import { prisma } from "../../lib/prisma.js";
import { pingRedis } from "../../lib/redis.js";

export const healthRouter = Router();

/** Liveness: is the process up? Must not touch dependencies. */
healthRouter.get("/", (_req, res) => {
  res.json({
    status: "ok",
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

/**
 * Readiness: can the process actually serve traffic?
 *
 * Postgres is required — without it nothing works. Redis is reported but does
 * not fail the probe: cache, locks and rate limiting all degrade on their own,
 * so pulling the instance out of the load balancer for a Redis blip would turn a
 * slowdown into an outage.
 */
healthRouter.get("/ready", async (req, res) => {
  const [database, cache] = await Promise.all([
    prisma
      .$queryRaw`SELECT 1`.then(() => true)
      .catch((error: unknown) => {
        // Log the cause, but tell the probe only that we are not ready — the
        // connection error text can carry host names and credentials.
        req.log.error({ err: error }, "Database readiness check failed");
        return false;
      }),
    pingRedis(),
  ]);

  if (!cache.ok) {
    req.log.warn({ error: cache.error }, "Redis readiness check failed");
  }

  res.status(database ? 200 : 503).json({
    status: database ? "ready" : "unavailable",
    checks: {
      database: database ? "up" : "down",
      redis: cache.ok ? "up" : "degraded",
      ...(cache.latencyMs !== undefined ? { redisLatencyMs: cache.latencyMs } : {}),
    },
  });
});
