/**
 * Data backfill runner.
 *
 * *Schema* changes are applied with committed Prisma migrations
 * (`prisma/migrations/`, `npm run db:migrate` locally, `db:migrate:deploy` in
 * production). Anything that needs to move or *derive* data — rather than
 * change the shape of a table — runs here instead, in plain TypeScript.
 *
 * Every backfill in `prisma/migrations-data/` must be **idempotent**: it
 * checks for its own prior output before writing, so running this twice
 * changes nothing the second time. That is what makes it safe to run on a
 * database that already has real records in it — including right after
 * restoring a pre-upgrade backup, which is exactly when these earn their keep.
 *
 * Usage:  npm run db:backfill
 */
import { PrismaClient } from "@prisma/client";

import * as schedules from "./migrations-data/001-schedules";
import * as templateSourceKeys from "./migrations-data/002-template-source-keys";
import * as healthFingerprints from "./migrations-data/003-health-fingerprints";

const MIGRATIONS = [schedules, templateSourceKeys, healthFingerprints];

async function main() {
  const prisma = new PrismaClient();
  console.log("Running data migrations…\n");

  try {
    for (const migration of MIGRATIONS) {
      console.log(`→ ${migration.id}: ${migration.description}`);
      const notes = await migration.run(prisma);
      for (const note of notes) console.log(`   ${note}`);
      console.log("");
    }
    console.log("Data migrations complete.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("Data migration failed:", error);
  process.exit(1);
});
