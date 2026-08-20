import { expect, test } from "@playwright/test";

import { STORAGE } from "./auth";

test.use({ storageState: STORAGE.alice });

/**
 * The command palette's server-backed search, end to end: capture a record,
 * find it by typing, land on its surface with the KEYBOARD only. The full
 * per-module coverage (all 23 groups, ranking, trash exclusion) is pinned by
 * tests/search.test.ts and tests/integration/search.test.ts — what only a
 * browser can prove is the palette loop itself: debounce → server action →
 * grouped section → arrow-key selection → navigation.
 */

const NEEDLE = "E2E palette needle";

/** Remove every leftover copy of the needle so reruns start clean. */
async function deleteNeedleItems(page: import("@playwright/test").Page) {
  await page.goto("/inbox");
  await page.waitForLoadState("networkidle");
  for (;;) {
    const actions = page.getByRole("button", { name: `Actions for ${NEEDLE}` }).first();
    if ((await actions.count()) === 0) break;
    await actions.click();
    await page.getByRole("menuitem", { name: /Delete/ }).click();
    await page.waitForLoadState("networkidle");
  }
}

test("captured inbox item is findable and reachable from the palette by keyboard", async ({
  page,
}) => {
  await deleteNeedleItems(page);

  await page.goto("/inbox");
  const capture = page.getByLabel("Capture something");
  await capture.fill(NEEDLE);
  await capture.press("Enter");
  await expect(page.getByText(NEEDLE).first()).toBeVisible();

  // Open the palette from anywhere with the bare `/` shortcut.
  await page.goto("/");
  await page.keyboard.press("/");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByPlaceholder(/Search your data/)).toBeVisible();

  await dialog.getByPlaceholder(/Search your data/).fill("palette needle");
  // The grouped section renders with the module's name as its heading.
  await expect(dialog.getByText("Inbox", { exact: true })).toBeVisible();
  const hit = dialog.getByRole("option", { name: new RegExp(NEEDLE) }).first();
  await expect(hit).toBeVisible();

  // Keyboard only: cmdk pre-selects the top hit; Enter follows it.
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/inbox/);

  // Clean up so reruns stay idempotent.
  await deleteNeedleItems(page);
  await expect(page.getByRole("button", { name: `Actions for ${NEEDLE}` })).toHaveCount(0);
});
