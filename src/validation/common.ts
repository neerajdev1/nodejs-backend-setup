import { z } from "zod";

/** Trimmed string that must still hold content after trimming. */
export const nonEmptyString = (max = 255) =>
  z.string().trim().min(1).max(max);

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email())
  .describe("Email address");

/**
 * Minimum password policy. Length carries most of the real-world strength, so
 * the floor is deliberately high rather than relying only on character classes.
 */
export const passwordSchema = z
  .string()
  .min(12, "must be at least 12 characters")
  .max(128, "must be at most 128 characters")
  .refine((v) => /[a-z]/.test(v), "must contain a lowercase letter")
  .refine((v) => /[A-Z]/.test(v), "must contain an uppercase letter")
  .refine((v) => /\d/.test(v), "must contain a digit");

export const uuidParamsSchema = z.object({
  id: z.uuid(),
});

/**
 * Cursor-free pagination with a hard ceiling on `limit`, so a caller cannot ask
 * for an unbounded result set.
 */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(["asc", "desc"]).default("desc"),
});

export type PaginationQuery = z.output<typeof paginationQuerySchema>;
