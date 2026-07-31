import { expect, test } from "@playwright/test";

import { STORAGE } from "./auth";

/**
 * Every page in the Health section hydrates cleanly.
 *
 * A guard against a class of bug rather than one instance of it. React error
 * #418 is a hydration mismatch, and the commonest cause is invalid nesting — a
 * block element inside a `<p>`, which the HTML parser hoists out, so the DOM no
 * longer matches what the server sent. React then discards the tree and
 * re-renders, and any click that lands in that window is silently lost.
 *
 * That is exactly how it was found: the undo button on /health/imports stopped
 * opening its dialog, deterministically, with no error anywhere except this
 * one. Types, lint and every other test were green.
 *
 * It lives in its own file, rather than alongside the other Health checks, so
 * it is **not** skipped where the seeded demo account is missing. CI runs
 * against an empty database, and an account with no health data still renders
 * eleven pages of markup worth checking — the empty states are markup too.
 */

const HEALTH_PAGES = [
  "/health",
  "/health/activity",
  "/health/sleep",
  "/health/heart",
  "/health/body",
  "/health/nutrition",
  "/health/workouts",
  "/health/vitals",
  "/health/trends",
  "/health/import",
  "/health/imports",
] as const;

async function assertHydratesCleanly(
  page: import("@playwright/test").Page,
  paths: readonly string[],
) {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));

  for (const path of paths) {
    await page.goto(path);
    // Waiting for a rendered landmark rather than a load state: hydration
    // happens after the HTML arrives, so asserting too early would pass before
    // the mismatch could occur.
    await expect(page.getByRole("navigation", { name: "Health sections" })).toBeVisible();
  }

  expect(
    failures,
    `uncaught errors while rendering the Health section:\n${failures.join("\n")}`,
  ).toEqual([]);
}

test.describe("an account with no health data", () => {
  test.use({ storageState: STORAGE.alice });

  test("renders every Health page without a hydration error", async ({ page }) => {
    await assertHydratesCleanly(page, HEALTH_PAGES);
  });
});

test.describe("the seeded demo account", () => {
  test.use({ storageState: STORAGE.you });

  // The populated markup — charts, batch rows, integrity findings — is a
  // different render path from the empty states above, and it is where the
  // original bug lived. Skipped where that seed does not exist, on the same
  // signal the config uses for the other seeded spec.
  test.skip(
    !!process.env.CI_SKIP_SEEDED,
    "needs the demo profile from `npm run db:seed`",
  );

  test("renders every Health page without a hydration error", async ({ page }) => {
    await assertHydratesCleanly(page, HEALTH_PAGES);
  });
});
