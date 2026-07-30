import path from "node:path";

import type { Page } from "@playwright/test";

/**
 * Storage-state files written once by `auth.setup.ts`. Sessions are stateless
 * JWTs, so signing out inside one test's context never invalidates the stored
 * cookie for the others.
 *
 * - you@local: the demo profile account; used for read-only shell/posture
 *   checks so its data is never mutated by this suite.
 * - alice@example.com: the account the mutating flows (workout template,
 *   manual health metric) run against — every mutation cleans up after itself
 *   or replaces the same record on re-runs.
 */
export const STORAGE = {
  you: path.join(__dirname, ".auth/you.json"),
  alice: path.join(__dirname, ".auth/alice.json"),
} as const;

/** A context with no cookies at all — the signed-out visitor. */
export const SIGNED_OUT = { cookies: [], origins: [] };

/** Walks the /signin dev form (requires DANGEROUSLY_ENABLE_DEV_LOGIN=1). */
export async function signInWithDevForm(page: Page, email: string): Promise<void> {
  await page.goto("/signin");
  await page.locator("#dev-email").fill(email);
  await page.getByRole("button", { name: "Sign in without Google" }).click();
  await page.waitForURL("/");
}
