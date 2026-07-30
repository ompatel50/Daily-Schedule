import { expect, test, type Page } from "@playwright/test";

import { STORAGE } from "./auth";

test.use({ storageState: STORAGE.alice });

// The rest countdown itself is pure stamp-derived logic unit-tested in
// tests/session.test.ts; exercising it live would mean completing sets, which
// the server then (correctly) refuses to discard. What this covers end-to-end
// is the template → live session → discard loop, which is fully restorative:
// a discarded session with nothing ticked leaves no record behind.

const TEMPLATE = "E2E rest timer template";

async function deleteTemplateIfPresent(page: Page) {
  const edit = page.getByRole("button", { name: `Edit template ${TEMPLATE}` });
  if ((await edit.count()) > 0) {
    await edit.click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText("Template deleted").first()).toBeVisible();
    await expect(edit).toHaveCount(0);
  }
}

test("template Start opens the live session panel; discard restores", async ({ page }) => {
  await page.goto("/workouts");
  await expect(page.getByText("Workout history", { exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle");

  // A live session left open by a human (or a crashed run that completed
  // sets) must not be stopped by a test.
  if ((await page.getByText(/In progress/).count()) > 0) {
    test.skip(true, "a live workout session is already open for this account — not touching it");
  }

  await deleteTemplateIfPresent(page);

  const start = page.getByRole("button", { name: "Start", exact: true });
  let createdTemplate = false;
  if ((await start.count()) === 0) {
    const newTemplate = page.getByRole("button", { name: "New template" });
    if ((await newTemplate.count()) === 0) {
      // The current build ships template *running* but no template-creation
      // UI, and no account has a seeded template — there is no non-destructive
      // way to put a Start button on the page. Skip visibly instead of faking
      // one through the database.
      test.skip(true, "no workout template exists and this build has no template-creation UI");
    }

    // Future builds: create a throwaway template through the UI and remove it
    // again at the end.
    await expect(async () => {
      await newTemplate.click();
      await expect(page.getByRole("dialog")).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
    const dialog = page.getByRole("dialog");
    await dialog.locator("#t-name").fill(TEMPLATE);
    await dialog.getByRole("button", { name: "Add exercise" }).click();
    await dialog.getByLabel("Exercise 1", { exact: true }).fill("E2E bench press");
    await dialog.getByLabel("Rest seconds for exercise 1").fill("90");
    await dialog.getByRole("button", { name: "Save template" }).click();
    await expect(page.getByText("Template saved").first()).toBeVisible();
    createdTemplate = true;
  }

  await expect(start.first()).toBeVisible();
  await expect(async () => {
    if ((await start.count()) > 0) await start.first().click();
    await expect(page.getByText(/In progress/)).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });

  // The live panel: set progress and per-set controls.
  await expect(page.getByText(/0 of \d+ sets/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Complete set 1" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Finish" })).toBeVisible();

  // Nothing was ticked, so Discard removes the session without a trace.
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(page.getByText("Session discarded").first()).toBeVisible();
  await expect(page.getByText(/In progress/)).toHaveCount(0);
  await expect(start.first()).toBeVisible();

  if (createdTemplate) await deleteTemplateIfPresent(page);
});
