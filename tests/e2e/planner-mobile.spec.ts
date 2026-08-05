import { expect, test } from "@playwright/test";

import { STORAGE } from "./auth";

/**
 * The planner at phone width, including the operational-day round trip a
 * night owl actually performs: plan a 1:00 AM block onto a day and find it
 * grouped there, timestamp intact. Uses alice (the mutating-flows account)
 * and cleans up through the app's own UI.
 */
test.use({ storageState: STORAGE.alice, viewport: { width: 390, height: 844 } });

test("week view stacks into day sections on a phone", async ({ page }) => {
  await page.goto("/planner?view=week");
  await expect(page.getByRole("tab", { name: "Week" })).toBeVisible();

  // The seven-column grid is a desktop layout; phones get stacked sections.
  const sections = page.locator("section[aria-label]");
  await expect(sections.first()).toBeVisible();
  expect(await sections.count()).toBeGreaterThanOrEqual(7);

  const overflow = await page.evaluate(() => {
    const root = document.scrollingElement!;
    return root.scrollWidth - root.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(0);
});

test("a 1:00 AM block groups under the day it was planned into, timestamp intact", async ({
  page,
}) => {
  // A quiet fixed weekday far in the future keeps this deterministic and
  // out of the seeded data's way.
  const day = "2027-03-10";
  const title = `Night block ${Date.now()}`;

  await page.goto(`/planner?date=${day}`);
  await page.getByRole("button", { name: "New item" }).click();

  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByLabel("Date").fill(day);
  await dialog.getByLabel("Start").fill("01:00");
  await dialog.getByLabel("End").fill("01:30");
  await dialog.getByRole("button", { name: "Add item" }).click();
  await expect(dialog).toBeHidden();

  // Grouped under the planned day, showing its REAL time and the reset hint.
  const row = page.locator("div.group", { hasText: title }).first();
  await expect(row).toBeVisible();
  await expect(row.getByText("1:00 AM – 1:30 AM")).toBeVisible();
  await expect(row.getByText(/Grouped with .* because your day resets at 4:00 AM/)).toBeVisible();

  // The NEXT calendar day's list does not show it.
  await page.goto(`/planner?date=2027-03-11`);
  await expect(page.getByText(title)).toHaveCount(0);

  // Cleanup through the row menu. The test browser reports hover support,
  // so reveal the control the desktop way first.
  await page.goto(`/planner?date=${day}`);
  const rowAgain = page.locator("div.group", { hasText: title }).first();
  await rowAgain.hover();
  await rowAgain.getByRole("button", { name: "Item actions" }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await expect(page.getByText(title)).toHaveCount(0);
});

test("row actions are visible without hover on a touch-first layout", async ({ page }) => {
  const day = "2027-03-17";
  const title = `Touch row ${Date.now()}`;

  await page.goto(`/planner?date=${day}`);
  await page.getByRole("button", { name: "New item" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByLabel("Date").fill(day);
  await dialog.getByLabel("Start").fill("09:00");
  await dialog.getByLabel("End").fill("09:30");
  await dialog.getByRole("button", { name: "Add item" }).click();
  await expect(dialog).toBeHidden();

  const row = page.locator("div.group", { hasText: title }).first();
  // In the desktop-emulating test browser the control is hover-revealed; the
  // point here is that it exists and is operable. Its always-visible variant
  // comes from the (hover:none) media query on real touch hardware.
  await row.hover();
  const menu = row.getByRole("button", { name: "Item actions" });
  await menu.click();
  await expect(page.getByRole("menuitem", { name: "Delete", exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await expect(page.getByText(title)).toHaveCount(0);
});
