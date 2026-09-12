import "dotenv/config";

import { prisma } from "../lib/prisma.js";

const [row] = await prisma.$queryRaw<
  { version: string; database: string }[]
>`SELECT version() AS version, current_database() AS database`;

console.log("Connected to Postgres");
console.log("  database:", row?.database);
console.log("  server:  ", row?.version?.split(",")[0]);

await prisma.$disconnect();
