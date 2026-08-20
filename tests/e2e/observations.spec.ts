import { expect, test } from "@playwright/test";

import { STORAGE } from "./auth";

test.use({ storageState: STORAGE.you });

/**
 * The anomaly Observations surface: one honest state (live observations, or
 * "baselines still forming" / "nothing unusual"), the per-category mute
 * panel, and observation-only copy.
 */

test("the observations card renders one honest state with working mutes", async ({ page }) => {
  await page.goto("/insights");

  await expect(page.getByText("Observations", { exact: true })).toBeVisible();
  await expect(page.getByText(/observations, never diagnosis or advice/)).toBeVisible();

  const emptyState = page.getByText(/Baselines are still forming|Nothing unusual/);
  const dismissButtons = page.getByRole("button", { name: /^Dismiss / });

  if ((await dismissButtons.count()) === 0) {
    await expect(emptyState.first()).toBeVisible();
  }

  // The mute panel lists every category with a real switch.
  await page.getByRole("button", { name: "Mute" }).click();
  for (const label of [
    "Resting heart rate",
    "Sleep",
    "Habit streaks",
    "Training frequency",
    "Spending",
  ]) {
    await expect(
      page.getByRole("switch", { name: `Mute ${label} observations` }),
    ).toBeVisible();
  }
  await expect(page.getByText(/A muted category is not checked at all/)).toBeVisible();
});
