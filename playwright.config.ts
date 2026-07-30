import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end rendering suite. It runs against an ALREADY-RUNNING production
 * server — there is deliberately no `webServer` block, because building inside
 * the test run would double its cost and race concurrent dev servers. The
 * integrator starts the app first (`npm run build && npm start`) with
 * `DANGEROUSLY_ENABLE_DEV_LOGIN=1` so the suite can sign in without Google,
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
