import { Router } from "express";

/**
 * Versioned API surface. Mount feature modules here, e.g.
 *
 * ```ts
 * import { authRouter } from "./modules/auth/auth.routes.js";
 * apiRouter.use("/auth", authRouter);
 * ```
 *
 * Anything not mounted falls through to the 404 handler in `app.ts`.
 */
export const apiRouter = Router();
