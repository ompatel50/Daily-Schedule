import { expect, test, type Page } from "@playwright/test";

import { STORAGE } from "./auth";

/**
 * Task ↔ planner linking through the real UI against the production build:
 *
 *  * "Add to planner…" from a task creates a block that shows its task;
 *  * checking the block off OFFERS to complete the task (toast action) and
 *    accepting completes it;
 *  * completing the task from the task board marks its planned block done on
 *    the planner, and says so in the toast.
 *
 * Uses alice (the mutating-flows account). Every run works with run-unique
 * titles on its own quiet far-future day, and cleans up through the app's own
 * delete flows. Console/page errors fail the test.
 */

test.use({ storageState: STORAGE.alice });

const BASE = Date.UTC(2027, 5, 1); // 2027-06-01 — clear of the recurrence spec's window
const DAY_MS = 86_400_000;

function dayKey(offset: number): string {
  return new Date(BASE + offset * DAY_MS).toISOString().slice(0, 10);
}

function addDays(key: string, amount: number): string {
  const at = new Date(`${key}T12:00:00Z`).getTime();
  return new Date(at + amount * DAY_MS).toISOString().slice(0, 10);
}

/** A run-unique quiet day inside a ~2-year far-future window. */
const RUN_OFFSET = (Date.now() % 600) + 30;

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

/** Walk forward from the run's base day to a genuinely empty planner day. */
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

async function createTask(page: Page, title: string) {
  // `?new=1` opens the dialog on mount — the same path the header button
  // pushes, minus the pre-hydration click race.
  await page.goto("/tasks?new=1");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByRole("button", { name: "Create task" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: `Actions for ${title}` })).toBeVisible();
}

async function addToPlanner(page: Page, title: string, day: string, time?: string) {
  await page.getByRole("button", { name: `Actions for ${title}` }).click();
  await page.getByRole("menuitem", { name: "Add to planner…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Day").fill(day);
  if (time) await dialog.getByLabel("Start time (optional)").fill(time);
  await dialog.getByRole("button", { name: "Add to planner" }).click();
  await expect(dialog).toBeHidden();
}

/** Delete the (non-recurring) block with this title via its row menu. */
async function deleteBlock(page: Page, day: string, title: string) {
  await page.goto(`/planner?date=${day}`);
  const row = page.locator("div.group").filter({ hasText: title }).first();
  await row.hover();
  await row.getByRole("button", { name: "Item actions" }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await expect(page.locator("div.group").filter({ hasText: title })).toHaveCount(0);
}

test("checking the block off offers the task, and accepting completes it", async ({ page }) => {
  const errors = trackErrors(page);
  const salt = String(Date.now()).slice(-6);
  const title = `LNK offer ${salt}`;

  const day = await emptyPlannerDay(page, dayKey(RUN_OFFSET));
  await createTask(page, title);
  await addToPlanner(page, title, day);

  // The block is on the planner and shows the task it was scheduled from.
  await page.goto(`/planner?date=${day}`);
  const row = page.locator("div.group").filter({ hasText: title }).first();
  await expect(row).toBeVisible();
  await expect(row.locator(`[title^="Scheduled from the task"]`)).toBeVisible();

  // Checking it off offers — nothing happens to the task until we accept.
  await row.getByRole("checkbox", { name: "Mark as done" }).click();
  await expect(page.getByText(`Also complete the task “${title}”?`)).toBeVisible();
  await page.getByRole("button", { name: "Complete task" }).click();
  await expect(page.getByText("Task completed")).toBeVisible();

  // The task left the open board.
  await page.goto("/tasks");
  await expect(page.getByRole("button", { name: `Actions for ${title}` })).toHaveCount(0);

  await deleteBlock(page, day, title);
  expect(errors).toEqual([]);
});

test("completing the task from the board marks its planned block done", async ({ page }) => {
  const errors = trackErrors(page);
  const salt = String(Date.now()).slice(-6);
  const title = `LNK reflect ${salt}`;

  const day = await emptyPlannerDay(page, dayKey(RUN_OFFSET + 15));
  await createTask(page, title);
  await addToPlanner(page, title, day, "09:00");

  // The task card shows where it is scheduled.
  await expect(page.getByText(/Planned · /).first()).toBeVisible();

  await page.getByRole("button", { name: `Complete ${title}` }).click();
  await expect(page.getByText(/1 planner block marked done/)).toBeVisible();

  // The block reflects the completion on the planner.
  await page.goto(`/planner?date=${day}`);
  const row = page.locator("div.group").filter({ hasText: title }).first();
  await expect(row.getByRole("checkbox", { name: "Mark as not done" })).toBeChecked();

  await deleteBlock(page, day, title);
  expect(errors).toEqual([]);
});
