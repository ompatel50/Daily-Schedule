import { expect, test } from "@playwright/test";

import { STORAGE } from "./auth";

test.use({ storageState: STORAGE.you });

/**
 * The spending-patterns surface: one honest state (findings with evidence,
 * or an explicit untracked / not-enough-data message), correlational and
 * descriptive copy only — never advice, never moralising.
 */

test("the spending patterns card renders one honest state", async ({ page }) => {
  await page.goto("/finance");

  await expect(page.getByText("Spending patterns")).toBeVisible();
  await expect(page.getByText(/never causes and never advice/)).toBeVisible();

  const evidence = page.getByText(/paired days · last \d+ days/);
  const emptyState = page.getByText(
    /Not enough ledger history|no association clears the significance bar|needs \d+ paired days/i,
  );

  if ((await evidence.count()) > 0) {
    await expect(evidence.first()).toContainText(/ρ = [+−]\d\.\d{2}/);
    for (const headline of await page.getByText(/moved together|moved in opposite/).all()) {
      const text = (await headline.textContent()) ?? "";
      expect(text).not.toMatch(/save|budget|cut back|should|overspend|advice/i);
    }
  } else {
    await expect(emptyState.first()).toBeVisible();
  }
});
