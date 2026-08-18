import { expect, test, type Page } from "@playwright/test";

import { STORAGE } from "./auth";

/**
 * The weekly review page and the Settings data page through the real UI
 * against the production build: the review renders its sections and rolls an
 * unfinished task into next week; the data page lists modules read-only.
 * Run-unique titles; cleanup through the app's own flows.
 */

test.use({ storageState: STORAGE.alice });

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

async function deleteTask(page: Page, title: string) {
  await page.goto("/tasks");
  const menu = page.getByRole("button", { name: `Actions for ${title}` });
  if ((await menu.count()) === 0) return;
  await menu.first().click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await page.getByRole("menuitem", { name: "Really delete?" }).click();
  await expect(menu).toHaveCount(0);
}

test("the review page rolls an unfinished task into next week", async ({ page }) => {
  const errors = trackErrors(page);
  const salt = String(Date.now()).slice(-6);
  const title = `RVW task ${salt}`;

  // A task due today = unfinished this week.
  await page.goto("/tasks?new=1");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Title").fill(title);
  const today = new Date().toISOString().slice(0, 10);
  await dialog.getByLabel("Due date (optional)").fill(today);
  await dialog.getByRole("button", { name: "Create task" }).click();
  await expect(dialog).toBeHidden();

  await page.goto("/review");
  await expect(page.getByRole("heading", { name: "Weekly review" })).toBeVisible();
  await expect(page.getByText("How the week went")).toBeVisible();
  await expect(page.getByText("Money this month")).toBeVisible();
  await expect(page.getByText("Reflection", { exact: true })).toBeVisible();

  const row = page.locator("li").filter({ hasText: title }).first();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Next week" }).click();
  await expect(page.getByText(/rolled to the week of/)).toBeVisible();
  await expect(page.locator("li").filter({ hasText: title })).toHaveCount(0);

  await deleteTask(page, title);
  expect(errors).toEqual([]);
});

test("the Settings data page lists modules read-only", async ({ page }) => {
  const errors = trackErrors(page);

  await page.goto("/settings/data");
  await expect(page.getByRole("heading", { name: "Your data" })).toBeVisible();
  // The table names the core modules with their counts.
  for (const moduleName of ["Planner blocks", "Tasks", "Transactions", "Journal entries"]) {
    await expect(page.getByRole("cell", { name: moduleName, exact: true })).toBeVisible();
  }
  await expect(page.getByText("Last backup export")).toBeVisible();
  await expect(page.getByText(/Backup format/)).toBeVisible();

  // Reachable from Settings.
  await page.goto("/settings");
  await page.getByRole("link", { name: "View your data" }).click();
  await expect(page.getByRole("heading", { name: "Your data" })).toBeVisible();

  expect(errors).toEqual([]);
});
