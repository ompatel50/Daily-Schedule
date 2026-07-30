/**
 * Seed CLI — `npm run db:seed` (or `npm run setup` for generate + push +
 * migrate + seed). The actual generator lives in `prisma/demo-data.ts` and is
 * shared with the in-app "Start with sample data" action, so there is exactly
 * one definition of what the demo dataset is.
 *
 * Re-running wipes the demo user's records first, so it produces a fresh,
 * consistent dataset rather than duplicates. To start empty instead, run
 * `npm run setup:empty` (or simply never seed).
 */
import { PrismaClient } from "@prisma/client";

import { seedDemoData } from "./demo-data";

const prisma = new PrismaClient();

seedDemoData(prisma)
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
