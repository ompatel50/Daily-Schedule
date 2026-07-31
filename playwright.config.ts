import { randomUUID } from "node:crypto";

import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end rendering suite. It runs against an ALREADY-RUNNING production
 * server — there is deliberately no `webServer` block, because building inside
 * the test run would double its cost and race concurrent dev servers. The
 * integrator prepares the database (`prisma migrate deploy`, then
 * `npm run seed:e2e` to create the two test accounts with the known e2e
 * password — sign-in itself never creates accounts), starts the app
 * (`npm run build && npm start` with AUTH_SECRET set), then runs
 * `npx playwright test` (suggested package script: `test:e2e`).
 *
 * Browsers are never downloaded here: the pre-installed cache is resolved via
 * PLAYWRIGHT_BROWSERS_PATH. The fallback below covers shells that don't
 * export it; it must point at a cache matching the installed @playwright/test.
 */
process.env.PLAYWRIGHT_BROWSERS_PATH ??= "/opt/pw-browsers";

/**
 * A distinct client identity per run — the fix for a real flake.
 *
 * Sign-up, sign-in and recovery are fenced by a database-backed per-client
 * rate limit keyed on the forwarding headers a proxy sets. A local `npm start`
 * sits behind no proxy, so every request from every run resolved to the same
 * `unknown` bucket: the sign-up journey spends two of the eight hourly
 * attempts, and the fourth consecutive run in an hour started failing with
 * "rate-limited" — the suite tripping the application's own abuse protection
 * because the test environment made every run look like one persistent client.
 *
 * Each run now presents itself as its own client, which is what separate runs
 * genuinely are. The protection is untouched and still enforced: a single run
 * that exceeded a fence would still be refused, which is what
 * tests/integration/signup-flow.test.ts asserts directly.
 *
 * Assigned here, in the runner process, so every worker inherits the same
 * value through the environment — the same mechanism the browser path above
 * relies on.
 */
process.env.E2E_CLIENT_ADDRESS ??= `e2e-run-${randomUUID()}`;

export default defineConfig({
  // CI runs against a freshly-migrated empty database; the one spec that
  // needs a pre-seeded Apple Health import batch is skipped there and runs
  // in environments that have the seeded account.
  testIgnore: process.env.CI_SKIP_SEEDED ? ["**/health-labels.spec.ts"] : [],
  testDir: "tests/e2e",
  outputDir: "tests/e2e/.output",
  // Spec files run in parallel across workers; tests inside a file run in
  // order, which the create → assert → clean-up flows rely on.
  fullyParallel: false,
  workers: 2,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [["list"]],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    // See E2E_CLIENT_ADDRESS above. Applies to page navigations and to the
    // server-action POSTs the forms make, which is where the fences live.
    extraHTTPHeaders: { "x-forwarded-for": process.env.E2E_CLIENT_ADDRESS as string },
  },
  projects: [
    // Signs in each test account once and stores the session cookie; every
    // spec reuses that storage state instead of walking the form again.
    { name: "setup", testMatch: /auth\.setup\.ts$/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
    },
  ],
});
