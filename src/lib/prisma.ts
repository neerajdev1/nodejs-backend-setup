import { PrismaPg } from "@prisma/adapter-pg";

import { env, isProduction } from "../config/env.js";
import { Prisma, PrismaClient } from "../generated/prisma/client.js";

const logLevels: Prisma.LogLevel[] = isProduction
  ? ["warn", "error"]
  : ["query", "warn", "error"];

const createPrismaClient = () =>
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
    log: logLevels,
  });

// `tsx watch` re-evaluates modules on every change, which would otherwise leak
// a new connection pool per reload. Cache the client on globalThis outside prod.
const globalForPrisma = globalThis as unknown as {
  prisma?: ReturnType<typeof createPrismaClient>;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (!isProduction) {
  globalForPrisma.prisma = prisma;
}
