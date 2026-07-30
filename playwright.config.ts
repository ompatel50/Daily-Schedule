import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end rendering suite. It runs against an ALREADY-RUNNING production
 * server — there is deliberately no `webServer` block, because building inside
 * the test run would double its cost and race concurrent dev servers. The
 * integrator prepares the database (`prisma migrate deploy`, then
 * `npm run seed:e2e` to create the two test accounts with the known e2e
 * password — the app never creates accounts at sign-in), starts the app
 * (`npm run build && npm start` with AUTH_SECRET and ALLOWED_EMAILS set),
 * then runs `npx playwright test` (suggested package script: `test:e2e`).
 *
 * Browsers are never downloaded here: the pre-installed cache is resolved via
 * PLAYWRIGHT_BROWSERS_PATH. The fallback below covers shells that don't
 * export it; it must point at a cache matching the installed @playwright/test.
 */
process.env.PLAYWRIGHT_BROWSERS_PATH ??= "/opt/pw-browsers";

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
