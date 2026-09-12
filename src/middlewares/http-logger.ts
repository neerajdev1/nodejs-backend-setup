import { randomUUID } from "node:crypto";

import { pinoHttp } from "pino-http";

import { logger } from "../lib/logger.js";

/**
 * Request logging with a generated correlation id echoed back as
 * `x-request-id`. The id is always generated server-side — trusting a
 * client-supplied id would let callers forge or collide log correlation.
 */
export const httpLogger = pinoHttp({
  logger,
  genReqId: (_req, res) => {
    const id = randomUUID();
    res.setHeader("x-request-id", id);
    return id;
  },
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  // Health probes run constantly; logging them buries real traffic.
  autoLogging: {
    ignore: (req) => req.url === "/health" || req.url === "/health/ready",
  },
});
