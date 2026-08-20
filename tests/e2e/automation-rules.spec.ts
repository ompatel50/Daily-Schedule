import { expect, test } from "@playwright/test";

import { STORAGE } from "./auth";

test.use({ storageState: STORAGE.you });

/**
 * The rule builder end to end: build a rule in the dialog (watching the
 * live plain-language summary), save it disabled, run the mandatory dry
 * run, enable from the preview, and add a starter template. Cleanup keeps
 * reruns idempotent.
 */

test("build, dry-run, enable and clean up a rule", async ({ page }) => {
  await page.goto("/settings/rules");
  await expect(page.getByText("Your rules")).toBeVisible();

  // Idempotent cleanup of leftovers from earlier runs.
  for (const leftover of ["E2E categorise", "Categorise a merchant"]) {
    for (;;) {
      const row = page
        .locator("div.rounded-lg.border", { hasText: leftover })
        .getByRole("button", { name: "Delete" })
        .first();
      if ((await row.count()) === 0) break;
      await row.click();
      await page.getByRole("button", { name: "Really delete?" }).first().click();
      await expect(page.getByText("Rule deleted").first()).toBeVisible();
      await page.waitForTimeout(300);
    }
  }

  // Build a rule. The default trigger (a transaction is created) stands;
  // one condition, one action.
  await page.getByRole("button", { name: "New rule" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("E2E categorise");
  await dialog.getByRole("button", { name: "Add condition" }).click();
  await dialog.getByLabel("Value").fill("zzz-e2e-payee");
  await dialog.getByLabel("Task title").fill("Review {{payee}}");

  // The live summary reads as one plain-English sentence.
  await expect(dialog.getByTestId("rule-summary")).toContainText(
    "When a transaction is created, if payee contains “zzz-e2e-payee”, create the task “Review {{payee}}”.",
  );
  await dialog.getByRole("button", { name: "Save rule" }).click();
  await expect(page.getByText(/Run the dry run to review/).first()).toBeVisible();

  // Saved disabled, flagged for review.
  const card = page.locator("div.rounded-lg.border", { hasText: "E2E categorise" }).first();
  await expect(card.getByText("needs dry run")).toBeVisible();

  // The mandatory dry run, then enable from the preview.
  await card.getByRole("button", { name: "Dry run" }).click();
  const preview = page.getByRole("dialog");
  await expect(preview.getByText(/candidates examined/)).toBeVisible();
  await preview.getByRole("button", { name: "Enable this rule" }).click();
  await expect(page.getByText("Rule enabled").first()).toBeVisible();
  await expect(card.getByText("on", { exact: true })).toBeVisible();

  // The starter library offers the four templates, added disabled.
  await expect(page.getByText("Starter library")).toBeVisible();
  for (const starter of [
    "Categorise a merchant",
    "Link a recurring charge to its bill",
    "Log a habit after training",
    "Protect a short-sleep day",
  ]) {
    await expect(page.getByText(starter, { exact: true })).toBeVisible();
  }
  await page
    .locator("div.rounded-lg.border", { hasText: "Categorise a merchant" })
    .first()
    .getByRole("button", { name: "Add to my rules" })
    .click();
  await expect(page.getByText(/review it and run the dry run/).first()).toBeVisible();

  // Clean up both rules.
  for (const name of ["E2E categorise", "Categorise a merchant"]) {
    const row = page.locator("div.rounded-lg.border", { hasText: name }).first();
    await row.getByRole("button", { name: "Delete" }).click();
    await row.getByRole("button", { name: "Really delete?" }).click();
    await expect(page.getByText("Rule deleted").first()).toBeVisible();
    await page.waitForTimeout(300);
  }
});
