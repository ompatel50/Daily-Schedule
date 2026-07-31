import path from "node:path";

import type { Page } from "@playwright/test";

/**
 * Storage-state files written once by `auth.setup.ts`. Sessions are stateless
 * JWTs, so signing out inside one test's context never invalidates the stored
 * cookie for the others.
 *
 * - you@local: the demo profile account; used for read-only shell/posture
 *   checks so its data is never mutated by this suite.
 * - alice@example.com: the account the small mutating flows (workout template,
 *   manual health metric) run against — every mutation cleans up after itself
 *   or replaces the same record on re-runs.
 * - importer@example.com: the health-import round trip, and nothing else.
 *
 * That third account is not tidiness, it is correctness. Spec FILES run in
 * parallel across workers, so the import round trip — which writes a month of
 * readings, rebuilds every affected day's summaries, and then undoes the lot —
 * used to run at the same time as, and against the same rows as, the manual
 * health-entry check. The two are individually correct and jointly a race.
 * Separate accounts remove the shared state rather than papering over the
 * timing, and both specs keep asserting exactly what they did before.
 *
 * All three accounts are created by `npm run seed:e2e`
 * (scripts/seed-e2e-users.mjs) with E2E_PASSWORD before the server starts —
 * the password provider never creates accounts at sign-in, exactly like
 * production.
 */
export const STORAGE = {
  you: path.join(__dirname, ".auth/you.json"),
  alice: path.join(__dirname, ".auth/alice.json"),
  importer: path.join(__dirname, ".auth/importer.json"),
} as const;

/** Must match scripts/seed-e2e-users.mjs (overridable via E2E_USER_PASSWORD). */
export const E2E_PASSWORD = process.env.E2E_USER_PASSWORD || "e2e-password-123";

/** A context with no cookies at all — the signed-out visitor. */
export const SIGNED_OUT = { cookies: [], origins: [] };

/** Walks the real /signin form — the same path a human takes. */
export async function signInWithPassword(
  page: Page,
  email: string,
  password: string = E2E_PASSWORD,
): Promise<void> {
  await page.goto("/signin");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("/");
}
