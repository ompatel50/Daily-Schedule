/**
 * Seed the two browser-test accounts with a known password:
 *
 *   node scripts/seed-e2e-users.mjs
 *
 * The password provider never creates accounts on sign-in (by design), so
 * the e2e suite needs its users to exist before the server starts. Runs in
 * CI between `prisma migrate deploy` and the build, and locally before
 * `npm run test:e2e` against a database that already has the app schema.
 *
 * Refuses non-local databases unless E2E_ALLOW_REMOTE_DB=1 — these are
 * well-known credentials that must never reach a real deployment. Existing
 * users keep their data; only the password fields are (re)set, so the suite
 * always signs in with the expected password even after a failed run.
 */
import { PrismaClient } from "@prisma/client";

import { hashPassword } from "./lib/password-hash.mjs";

export const E2E_PASSWORD = process.env.E2E_USER_PASSWORD || "e2e-password-123";
const EMAILS = ["you@local", "alice@example.com"];

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "db", "postgres"]);
let host = "";
try {
  host = new URL(process.env.DATABASE_URL ?? "").hostname;
} catch {
  // Unparseable URL — treated as non-local below.
}
if (!LOCAL_HOSTS.has(host) && process.env.E2E_ALLOW_REMOTE_DB !== "1") {
  console.error(
    `seed-e2e-users refuses to run against non-local database host "${host || "(unset)"}".`,
  );
  process.exit(1);
}

const prisma = new PrismaClient();
try {
  const passwordHash = await hashPassword(E2E_PASSWORD);
  for (const email of EMAILS) {
    await prisma.user.upsert({
      where: { email },
      create: {
        email,
        name: email.split("@")[0],
        passwordHash,
        passwordUpdatedAt: new Date(),
      },
      update: {
        passwordHash,
        passwordUpdatedAt: new Date(),
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });
  }
  console.log(`Seeded ${EMAILS.join(", ")} with the e2e password.`);
} finally {
  await prisma.$disconnect();
}
