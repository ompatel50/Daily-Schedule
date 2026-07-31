/**
 * Prepare a disposable database for the browser suite:
 *
 *   node scripts/seed-e2e-users.mjs
 *
 * Three things, in order:
 *
 *  1. **The two test accounts**, with a known password. The password provider
 *     never creates accounts on sign-in (by design), so the e2e suite needs
 *     its users to exist before the server starts. Existing users keep their
 *     data; only the password fields are (re)set, so the suite always signs in
 *     with the expected password even after a failed run.
 *  2. **Stale sign-up-journey accounts are pruned.** The public sign-up spec
 *     creates one throwaway `…@e2e.local` account per run. Left alone they
 *     accumulate one row per run forever in a database that is otherwise
 *     reused between runs.
 *  3. **The abuse fences are reset.** Sign-up, sign-in and recovery are rate
 *     limited per client per hour, and a local server behind no proxy resolves
 *     every run to the same bucket — so a fourth run within the hour used to
 *     fail with "rate-limited". This clears the *counters* in a disposable
 *     database; it does not touch, weaken or bypass the protection itself,
 *     which stays exactly as production runs it and is asserted directly by
 *     tests/integration/signup-flow.test.ts.
 *
 * Refuses non-local databases unless E2E_ALLOW_REMOTE_DB=1 — these are
 * well-known credentials that must never reach a real deployment, and steps
 * 2 and 3 delete rows.
 */
import { PrismaClient } from "@prisma/client";

import { hashPassword } from "./lib/password-hash.mjs";

export const E2E_PASSWORD = process.env.E2E_USER_PASSWORD || "e2e-password-123";
const EMAILS = ["you@local", "alice@example.com", "importer@example.com"];

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

  // Throwaway accounts the public sign-up journey creates, one per run. Cascade
  // deletes take their recovery codes and sessions with them. The suffix is
  // reserved for the suite, so this can never reach a real account.
  const pruned = await prisma.user.deleteMany({ where: { email: { endsWith: "@e2e.local" } } });
  if (pruned.count > 0) console.log(`Pruned ${pruned.count} stale sign-up-journey account(s).`);

  // Rate-limit counters only — the fences themselves are untouched. Scoped to
  // the buckets the suite can spend so an unrelated row is never removed.
  const cleared = await prisma.rateLimitBucket.deleteMany({
    where: {
      OR: [
        { key: { startsWith: "signup:" } },
        { key: { startsWith: "signin:" } },
        { key: { startsWith: "recover:" } },
        { key: { startsWith: "recover-email:" } },
      ],
    },
  });
  if (cleared.count > 0) console.log(`Reset ${cleared.count} rate-limit counter(s).`);
} finally {
  await prisma.$disconnect();
}
