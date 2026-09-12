import cors, { type CorsOptions } from "cors";
import express, { type Express } from "express";
import helmet from "helmet";

import { corsOrigins, env } from "./config/env.js";
import { errorHandler, notFoundHandler } from "./middlewares/error-handler.js";
import { httpLogger } from "./middlewares/http-logger.js";
import { globalRateLimiter } from "./middlewares/rate-limit.js";
import { healthRouter } from "./modules/health/health.routes.js";
import { apiRouter } from "./routes.js";

const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    if (!origin) {
      callback(null, true);
      return;
    }
    callback(null, corsOrigins.includes(origin));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  exposedHeaders: ["X-Request-Id"],
  maxAge: 600,
};

export const createApp = (): Express => {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", env.TRUST_PROXY_HOPS);

  app.use(httpLogger);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      },
      referrerPolicy: { policy: "no-referrer" },
      frameguard: { action: "deny" },
      crossOriginResourcePolicy: { policy: "same-site" },
    }),
  );

  app.use(cors(corsOptions));

  // Cap body size before any parsing work happens.
  app.use(express.json({ limit: env.BODY_LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: env.BODY_LIMIT }));

  app.use(globalRateLimiter);

  app.get("/", (_, res) => res.send("<h1>Welcome to the API</h1>"));
  app.use("/health", healthRouter);
  app.use("/api/v1", apiRouter);

  // Order matters: unmatched routes become a 404 error, then every error in
  // the stack funnels through one handler.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
