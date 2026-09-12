import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ZodType, z } from "zod";

import { ValidationError } from "../lib/errors.js";

export interface RequestSchemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
  headers?: ZodType;
}

type OutputOf<T> = T extends ZodType ? z.output<T> : undefined;

export type Validated<S extends RequestSchemas> = {
  body: OutputOf<S["body"]>;
  query: OutputOf<S["query"]>;
  params: OutputOf<S["params"]>;
  headers: OutputOf<S["headers"]>;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Parsed and coerced request data. Only populated on routes that run the
       * `validate` middleware — reach for this instead of the raw `req.*`
       * fields so handlers never see unvalidated input.
       */
      validated: {
        body: unknown;
        query: unknown;
        params: unknown;
        headers: unknown;
      };
    }
  }
}

export type ValidatedRequest<S extends RequestSchemas> = Request & {
  validated: Validated<S>;
};

/**
 * Validates `body`, `query`, `params` and `headers` against the given Zod
 * schemas. Every part is checked before responding, so the client gets the full
 * list of problems in one 400 rather than one per round trip.
 *
 * Express 5 exposes `req.query` through a getter with no setter, so parsed
 * output is written to `req.validated` rather than mutated in place. `req.body`
 * is also replaced, since that is where most middleware expects to find it.
 */
export const validate = (schemas: RequestSchemas): RequestHandler => {
  return (req: Request, _res: Response, next: NextFunction) => {
    const issues: { path: string; message: string; code: string }[] = [];
    const output: Record<string, unknown> = {
      body: undefined,
      query: undefined,
      params: undefined,
      headers: undefined,
    };

    for (const part of ["body", "query", "params", "headers"] as const) {
      const schema = schemas[part];
      if (!schema) continue;

      const result = schema.safeParse(req[part]);

      if (result.success) {
        output[part] = result.data;
        continue;
      }

      for (const issue of result.error.issues) {
        issues.push({
          path: [part, ...issue.path.map(String)].join("."),
          message: issue.message,
          code: issue.code,
        });
      }
    }

    if (issues.length > 0) {
      next(new ValidationError(issues));
      return;
    }

    req.validated = output as Request["validated"];
    if (schemas.body) req.body = output.body;

    next();
  };
};

/**
 * Pairs a schema set with its handler so the handler's `req.validated` is fully
 * typed without a cast at the call site:
 *
 * ```ts
 * router.post("/", ...route({ body: createPayoutSchema }, async (req, res) => {
 *   const { amount } = req.validated.body; // typed from the schema
 *   res.status(201).json(await createPayout(amount));
 * }));
 * ```
 *
 * Express 5 forwards rejected promises to the error handler on its own, so
 * async handlers need no extra wrapping.
 */
export const route = <S extends RequestSchemas>(
  schemas: S,
  handler: (
    req: ValidatedRequest<S>,
    res: Response,
    next: NextFunction,
  ) => unknown,
): RequestHandler[] => [validate(schemas), handler as RequestHandler];
