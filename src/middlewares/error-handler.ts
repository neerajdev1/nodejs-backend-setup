import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";

import { isProduction } from "../config/env.js";
import { AppError, NotFoundError } from "../lib/errors.js";
import { Prisma } from "../generated/prisma/client.js";

interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

/** Body-parser failures arrive as generic errors carrying a `type` tag. */
const isBodyParserError = (
  error: unknown,
): error is Error & { type: string; status?: number } =>
  error instanceof Error && typeof (error as { type?: unknown }).type === "string";

const toErrorBody = (error: unknown): { status: number; body: ErrorBody } => {
  if (error instanceof AppError) {
    return {
      status: error.statusCode,
      body: { code: error.code, message: error.message, details: error.details },
    };
  }

  // A ZodError thrown outside the validate middleware (e.g. from a service
  // parsing a third-party response) still reads as a client-visible 400 only
  // when it came from request data, so treat it as a generic bad request.
  if (error instanceof ZodError) {
    return {
      status: 400,
      body: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        details: error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          message: issue.message,
          code: issue.code,
        })),
      },
    };
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    switch (error.code) {
      case "P2002":
        return {
          status: 409,
          body: {
            code: "CONFLICT",
            message: "A record with these values already exists",
            details: { fields: error.meta?.["target"] },
          },
        };
      case "P2025":
        return {
          status: 404,
          body: { code: "NOT_FOUND", message: "Resource not found" },
        };
      case "P2003":
        return {
          status: 400,
          body: {
            code: "BAD_REQUEST",
            message: "Referenced record does not exist",
          },
        };
      default:
        break;
    }
  }

  if (isBodyParserError(error)) {
    if (error.type === "entity.too.large") {
      return {
        status: 413,
        body: {
          code: "PAYLOAD_TOO_LARGE",
          message: "Request body is too large",
        },
      };
    }
    if (error.type === "entity.parse.failed") {
      return {
        status: 400,
        body: { code: "MALFORMED_JSON", message: "Request body is not valid JSON" },
      };
    }
  }

  return {
    status: 500,
    body: { code: "INTERNAL_ERROR", message: "Internal server error" },
  };
};

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Cannot ${req.method} ${req.path}`));
};

export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const { status, body } = toErrorBody(error);

  // 5xx means we did something wrong, so keep the full error. 4xx is the
  // caller's problem and pino-http already logs a line per request, so it stays
  // at debug to avoid logging every rejected payload twice.
  const log = req.log ?? console;
  if (status >= 500) {
    log.error({ err: error }, "Unhandled request error");
  } else {
    log.debug({ code: body.code, status, details: body.details }, "Request rejected");
  }

  // Never let an unexpected error's message or stack reach the client in
  // production — it leaks table names, file paths and query fragments.
  const payload: ErrorBody =
    status >= 500 && isProduction
      ? { code: body.code, message: body.message }
      : {
          ...body,
          ...(status >= 500 && error instanceof Error
            ? { message: error.message, details: { stack: error.stack } }
            : {}),
        };

  res.status(status).json({ error: payload, requestId: req.id });
};
