import { expect, test, type Page } from "@playwright/test";

import { STORAGE } from "./auth";

/**
 * Copy day through the real UI against the production build, plus the week
 * view's utilisation summary appearing over real data. Run-unique far-future
 * days; cleanup through the app's own delete flows; console errors fail.
 */

test.use({ storageState: STORAGE.alice });

const BASE = Date.UTC(2027, 8, 1); // 2027-09-01 — clear of the other specs' windows
const DAY_MS = 86_400_000;

function dayKey(offset: number): string {
  return new Date(BASE + offset * DAY_MS).toISOString().slice(0, 10);
}

function addDays(key: string, amount: number): string {
  return new Date(new Date(`${key}T12:00:00Z`).getTime() + amount * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

const RUN_OFFSET = (Date.now() % 500) + 30;

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (message.location().url.includes("/_vercel/insights/")) return;
    if (message.text().includes("/_vercel/insights/")) return;
    errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  return errors;
}

async function emptyPlannerDay(page: Page, start: string): Promise<string> {
  let day = start;
  for (let hop = 0; hop < 14; hop += 1) {
    await page.goto(`/planner?date=${day}`);
    await expect(page.getByRole("tab", { name: "Day" })).toBeVisible();
    if (await page.getByText("No items for this day").isVisible().catch(() => false)) return day;
    day = addDays(day, 1);
  }
  return day;
}

async function createItem(
  page: Page,
  fields: { title: string; date: string; start: string; end: string },
) {
  await page.getByRole("button", { name: "New item" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Title").fill(fields.title);
  await dialog.getByLabel("Date", { exact: true }).fill(fields.date);
  await dialog.getByLabel("Start").fill(fields.start);
  await dialog.getByLabel("End", { exact: true }).fill(fields.end);
  await dialog.getByRole("button", { name: "Add item" }).click();
  await expect(dialog).toBeHidden();
}

async function deleteAll(page: Page, day: string, title: string) {
  await page.goto(`/planner?date=${day}`);
  const rows = page.locator("div.group").filter({ hasText: title });
  let count = await rows.count();
  while (count > 0) {
    const row = rows.first();
    await row.hover();
    await row.getByRole("button", { name: "Item actions" }).click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await expect(rows).toHaveCount(count - 1);
    count -= 1;
  }
}

test("copy day duplicates one-off blocks and the utilisation card sums the week", async ({
  page,
}) => {
  const errors = trackErrors(page);
  const salt = String(Date.now()).slice(-6);
  const title = `CPY focus ${salt}`;

  const day = await emptyPlannerDay(page, dayKey(RUN_OFFSET));
  const target = await emptyPlannerDay(page, addDays(day, 1));

  await page.goto(`/planner?date=${day}`);
  await createItem(page, { title, date: day, start: "09:00", end: "11:00" });

  // Copy the day to the quiet target.
  await page.getByRole("button", { name: "Copy day…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Copy to day").fill(target);
  await dialog.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(page.getByText(/Copied 1 block/)).toBeVisible();

  await page.goto(`/planner?date=${target}`);
  await expect(page.locator("div.group").filter({ hasText: title })).toHaveCount(1);

  // The week view shows the utilisation summary for a week with planned time.
  await page.goto(`/planner?date=${day}&view=week`);
  const utilisation = page.getByRole("region", { name: "Week utilisation" });
  await expect(utilisation).toBeVisible();
  await expect(utilisation.getByText(/planned of/)).toBeVisible();
  // New-item defaults to the personal category; the row carries its label.
  await expect(utilisation.getByText("Personal")).toBeVisible();

  await deleteAll(page, day, title);
  await deleteAll(page, target, title);
  expect(errors).toEqual([]);
});
