import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { closeRedis } from "./lib/redis.js";

const app = createApp();

const server = app.listen(env.PORT, env.HOST, () => {
  logger.info(
    { host: env.HOST, port: env.PORT, nodeEnv: env.NODE_ENV },
    "Server listening",
  );
});

// Slow-request defences: cut off clients that open a socket and dribble bytes.
// Raise keepAliveTimeout above your load balancer's idle timeout if you put one
// in front, otherwise the LB will reuse a socket we just closed.
server.headersTimeout = 10_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;

let shuttingDown = false;

const shutdown = async (reason: string, exitCode = 0): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ reason }, "Shutting down");

  // Never hang forever waiting for in-flight requests to drain.
  const forceExit = setTimeout(() => {
    logger.error("Graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  try {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    // Both run regardless of the other failing, so one bad connection cannot
    // leave the other open.
    await Promise.allSettled([prisma.$disconnect(), closeRedis()]);
    logger.info("Shutdown complete");
    process.exit(exitCode);
  } catch (error) {
    logger.error({ err: error }, "Error during shutdown");
    process.exit(1);
  }
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// An unhandled rejection or uncaught exception leaves the process in an unknown
// state. Log it, drain, and let the supervisor restart us clean.
process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "Unhandled promise rejection");
  void shutdown("unhandledRejection", 1);
});

process.on("uncaughtException", (error) => {
  logger.fatal({ err: error }, "Uncaught exception");
  void shutdown("uncaughtException", 1);
});
