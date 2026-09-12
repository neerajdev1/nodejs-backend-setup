import { pino } from "pino";

import { env, isProduction } from "../config/env.js";

// Anything that could carry a credential or cardholder data must never reach
// the log sink. Paths are matched against the serialized log object.
const redactPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  'req.headers["set-cookie"]',
  "res.headers[\"set-cookie\"]",
  "*.password",
  "*.currentPassword",
  "*.newPassword",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.otp",
  "*.pin",
  "*.cvv",
  "*.cardNumber",
  "*.secret",
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: redactPaths, censor: "[redacted]" },
  base: { env: env.NODE_ENV },
  transport: isProduction
    ? undefined
    : {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname,env" },
      },
});
