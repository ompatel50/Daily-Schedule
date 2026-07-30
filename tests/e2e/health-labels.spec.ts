import { expect, test } from "@playwright/test";

import { STORAGE } from "./auth";

test.use({ storageState: STORAGE.alice });

// Where the source labels really render on /health (inspected live): the
// import history line reads "<imported at> · Apple Health · <from> → <to>",
// and each Today-panel metric carries one outline badge per source ("Manual",
// "Apple Health"). The seeded import ends before the live "today", so the
// Manual badge is produced by logging a value through the form — a write that
// replaces the same day/metric row on every run rather than accumulating.

test("the import history labels its batch as Apple Health", async ({ page }) => {
  await page.goto("/health");
  await expect(page.getByText("Import history", { exact: true })).toBeVisible();
  await expect(page.getByText(/· Apple Health/).first()).toBeVisible();
});

test("a manually logged metric shows a Manual source badge", async ({ page }) => {
  await page.goto("/health");

  // The detailed form defaults to Steps and the live "today".
  await page.locator("#metric-value").fill("4321");
  await page.getByRole("button", { name: "Log", exact: true }).click();
  await expect(page.getByText("Steps logged").first()).toBeVisible();

  // The Today panel re-renders with the value and says where it came from.
  await expect(page.getByText("Manual", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("4,321").first()).toBeVisible();
});
