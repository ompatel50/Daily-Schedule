import { expect, test, type Page } from "@playwright/test";

import { STORAGE } from "./auth";

test.use({ storageState: STORAGE.you });

async function openNewItemDialog(page: Page) {
  await page.goto("/planner");
  const trigger = page.getByRole("button", { name: "New item" });
  // Retried: a click before hydration is dispatched into a void.
  await expect(async () => {
    await trigger.click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  return trigger;
}

test("the new-item dialog traps focus and closes on Escape", async ({ page }) => {
  await openNewItemDialog(page);
  const dialog = page.getByRole("dialog");

  // Focus lands inside the dialog — on the autofocused title field.
  await expect(dialog.locator("#item-title")).toBeFocused();

  // Tabbing must cycle within the dialog, never back into the page behind it.
  for (let press = 0; press < 12; press++) {
    await page.keyboard.press("Tab");
    const focusInsideDialog = await page.evaluate(() => {
      const open = document.querySelector('[role="dialog"]');
      return open !== null && open.contains(document.activeElement);
    });
    expect(focusInsideDialog, `focus escaped the dialog after ${press + 1} Tab presses`).toBe(true);
  }

  // Escape closes without creating anything, and focus must not be marooned
  // inside the removed dialog subtree.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  const focusConnected = await page.evaluate(
    () => document.activeElement !== null && document.activeElement.isConnected,
  );
  expect(focusConnected).toBe(true);
});

test("Escape returns focus to the New item trigger", async ({ page }) => {
  // Known gap in the app, not test flake: ScheduleItemDialog is a controlled
  // Radix Dialog rendered without a DialogTrigger, so Radix has no trigger ref
  // to restore and focus falls back to <body> on close (verified manually with
  // both mouse and keyboard activation). Unskip once the dialog restores focus
  // (e.g. via onCloseAutoFocus to the opening button).
  test.fixme();

  const trigger = await openNewItemDialog(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(trigger).toBeFocused();
});
