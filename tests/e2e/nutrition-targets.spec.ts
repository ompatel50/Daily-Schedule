import { expect, test } from "@playwright/test";

import { STORAGE } from "./auth";

test.use({ storageState: STORAGE.alice });

/**
 * The nutrition Targets surface: user-defined numbers, neutral progress. The
 * scoring/day-type mechanics are pinned by unit + integration tests; the
 * browser proves the editor loop and the card's neutral copy.
 */

test("set a calorie target, see neutral progress, remove it again", async ({ page }) => {
  await page.goto("/nutrition");

  // The card states that targets are the user's own.
  const card = page.locator("div", { hasText: "Targets" }).first();
  await page.getByRole("button", { name: "Edit targets" }).click();

  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText(/nothing here is suggested or computed from your body/i),
  ).toBeVisible();

  // Remove any leftover calorie target from a previous run.
  for (;;) {
    const leftover = dialog.getByRole("button", { name: /Remove Calories/ }).first();
    if ((await leftover.count()) === 0) break;
    await leftover.click();
    await expect(page.getByText(/moved to the Trash/).first()).toBeVisible();
    await page.waitForLoadState("networkidle");
  }

  await dialog.getByLabel("Kind").click();
  await page.getByRole("option", { name: "At most" }).click();
  await dialog.getByLabel(/Target \(kcal\)/).fill("2200");
  await dialog.getByRole("button", { name: "Add target" }).click();
  await expect(page.getByText("Calories target set").first()).toBeVisible();
  await dialog.getByRole("button", { name: "Done" }).click();

  // The card shows the target with numbers-only phrasing.
  await expect(card.getByText(/of 2,200 kcal/).first()).toBeVisible();
  await expect(card.getByText(/left|over|not logged yet/).first()).toBeVisible();

  // Clean up: remove the target again.
  await page.getByRole("button", { name: "Edit targets" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Remove Calories/ })
    .first()
    .click();
  await expect(page.getByText(/moved to the Trash/).first()).toBeVisible();
});
