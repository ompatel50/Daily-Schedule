/**
 * Seed CLI — `npm run db:seed` (or `npm run setup` for generate + migrate +
 * backfill + seed). The actual generator lives in `prisma/demo-data.ts` and is
 * shared with the in-app "Start with sample data" action, so there is exactly
 * one definition of what the demo dataset is.
 *
 * Re-running wipes the demo user's records first, so it produces a fresh,
 * consistent dataset rather than duplicates. To start empty instead, run
 * `npm run setup:empty` (or simply never seed).
 *
 * Demo data must never end up in production automatically: this CLI refuses
 * to run against anything that is not a local database (and the hosted app
 * only ever seeds through the explicit in-app "Start with sample data"
 * choice, into the signed-in user's own empty account).
 */
import { createDbClient } from "./db-client";
import { seedDemoData } from "./demo-data";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "db", "postgres"]);
const url = process.env.DATABASE_URL ?? "";
let host = "";
try {
  host = new URL(url).hostname;
} catch {
  // Unparseable URL — treat as non-local below.
}
if (!LOCAL_HOSTS.has(host) && process.env.SEED_ALLOW_REMOTE !== "1") {
  console.error(
    `db:seed refuses to run against non-local database host "${host || "(unset)"}".\n` +
      "Demo data is never seeded into production. For a disposable remote dev database, " +
      "re-run with SEED_ALLOW_REMOTE=1.",
  );
  process.exit(1);
}

const prisma = createDbClient();

seedDemoData(prisma)
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
