import { expect, test } from "@playwright/test";

import { STORAGE } from "./auth";

test.use({ storageState: STORAGE.you });

/**
 * The correlation insights surface. Whatever the seed data supports, the
 * card must be in exactly one honest state: real findings (with effect
 * size, sample size and window on display) or the explicit not-enough-data
 * state — never hedged almost-insights, never causal phrasing.
 */

test("the patterns card renders one honest state", async ({ page }) => {
  await page.goto("/insights");

  await expect(page.getByText("Patterns in your data")).toBeVisible();
  // The framing is correlational up front.
  await expect(page.getByText(/correlational only, never causal/)).toBeVisible();

  const evidence = page.getByText(/paired days · last \d+ days/);
  const emptyState = page.getByText(/Not enough data yet|no association is strong enough/i);

  if ((await evidence.count()) > 0) {
    // Every finding carries its evidence line: ρ (effect size), n, window.
    await expect(evidence.first()).toContainText(/ρ = [+−]\d\.\d{2}/);
    // And links into the underlying data ("Inspect: …").
    await expect(page.getByText(/^Inspect:/).first()).toBeVisible();
    // Correlational phrasing only.
    for (const headline of await page.getByText(/moved together|moved in opposite/).all()) {
      expect(await headline.textContent()).not.toMatch(
        /because|causes|leads to|should|try to|makes you/i,
      );
    }
  } else {
    await expect(emptyState.first()).toBeVisible();
  }
});
