import { expect, test, type Page } from "@playwright/test";

import { STORAGE } from "./auth";

/**
 * Global undo through the real UI against the production build: delete →
 * Trash → restore round trips in Tasks and Finance, and purge is final.
 *
 * Uses alice (the mutating-flows account) with run-unique names; stale rows
 * from crashed runs are swept from the board, the ledger and the Trash
 * itself. Console/page errors fail the test.
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

/** Purge every stale TRSH-prefixed leftover parked in the Trash. */
async function sweepTrash(page: Page) {
  await page.goto("/settings/trash");
  const purgeButtons = page.getByRole("button", { name: /^Delete TRSH .* forever$/ });
  let count = await purgeButtons.count();
  while (count > 0) {
    await purgeButtons.first().click();
    await expect(purgeButtons).toHaveCount(count - 1);
    count -= 1;
  }
}

/** Delete stale TRSH tasks and accounts left by crashed runs. */
async function sweepLive(page: Page) {
  await page.goto("/tasks");
  const taskMenus = page.getByRole("button", { name: /^Actions for TRSH task / });
  let tasks = await taskMenus.count();
  while (tasks > 0) {
    await taskMenus.first().click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await page.getByRole("menuitem", { name: "Really delete?" }).click();
    await expect(taskMenus).toHaveCount(tasks - 1);
    tasks -= 1;
  }
  await page.goto("/finance");
  const accountMenus = page.getByRole("button", { name: /^Actions for TRSH Acct / });
  let accounts = await accountMenus.count();
  while (accounts > 0) {
    await accountMenus.first().click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("menuitem", { name: "Delete account + ledger" }).click();
    await expect(accountMenus).toHaveCount(accounts - 1);
    accounts -= 1;
  }
}

test("a deleted task round-trips through the Trash, and purge is final", async ({ page }) => {
  const errors = trackErrors(page);
  const salt = String(Date.now()).slice(-6);
  const title = `TRSH task ${salt}`;

  await sweepLive(page);
  await sweepTrash(page);

  // Create, then delete from the board.
  await page.goto("/tasks?new=1");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByRole("button", { name: "Create task" }).click();
  await expect(dialog).toBeHidden();
  const menu = page.getByRole("button", { name: `Actions for ${title}` });
  await expect(menu).toBeVisible();
  await menu.click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await page.getByRole("menuitem", { name: "Really delete?" }).click();
  await expect(menu).toHaveCount(0);

  // It sits in the Trash, labeled with its module — restore it.
  await page.goto("/settings/trash");
  const row = page.locator("div.rounded-lg.border").filter({ hasText: title }).first();
  await expect(row).toBeVisible();
  await expect(row.getByText("Tasks")).toBeVisible();
  await row.getByRole("button", { name: `Restore ${title}` }).click();
  await expect(page.getByText(`Restored “${title}”`)).toBeVisible();

  // Back on the board, alive.
  await page.goto("/tasks");
  await expect(page.getByRole("button", { name: `Actions for ${title}` })).toBeVisible();

  // Delete again and purge — final this time.
  await menu.click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await page.getByRole("menuitem", { name: "Really delete?" }).click();
  await page.goto("/settings/trash");
  await page.getByRole("button", { name: `Delete ${title} forever` }).click();
  await expect(page.getByRole("button", { name: `Delete ${title} forever` })).toHaveCount(0);
  await page.goto("/tasks");
  await expect(page.getByRole("button", { name: `Actions for ${title}` })).toHaveCount(0);

  expect(errors).toEqual([]);
});

test("a deleted transaction round-trips through the Trash", async ({ page }) => {
  const errors = trackErrors(page);
  const salt = String(Date.now()).slice(-6);
  const account = `TRSH Acct ${salt}`;
  const payee = `TRSH Coffee ${salt}`;

  await sweepLive(page);
  await sweepTrash(page);

  // An account with one spent transaction.
  await page.goto("/finance");
  await page.getByRole("button", { name: "New account" }).first().click();
  const accountDialog = page.getByRole("dialog");
  await accountDialog.locator("#account-name").fill(account);
  await accountDialog.getByRole("button", { name: "Create account" }).click();
  await expect(accountDialog).toBeHidden();

  await page.getByRole("button", { name: "Add transaction" }).first().click();
  const txDialog = page.getByRole("dialog");
  await txDialog.getByRole("button", { name: "Spent" }).click();
  await txDialog.locator("#tx-amount").fill("4.20");
  await txDialog.locator("#tx-account").click();
  await page.getByRole("option", { name: account }).click();
  await txDialog.locator("#tx-payee").fill(payee);
  await txDialog.getByRole("button", { name: "Add transaction" }).click();
  await expect(txDialog).toBeHidden();

  const txRow = page
    .locator("div.rounded-lg.border")
    .filter({ has: page.getByRole("button", { name: "Transaction actions" }) })
    .filter({ hasText: payee })
    .first();
  await expect(txRow).toBeVisible();

  // Delete it from the ledger.
  await txRow.getByRole("button", { name: "Transaction actions" }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await page.getByRole("menuitem", { name: "Confirm delete" }).click();
  await expect(
    page
      .locator("div.rounded-lg.border")
      .filter({ has: page.getByRole("button", { name: "Transaction actions" }) })
      .filter({ hasText: payee }),
  ).toHaveCount(0);

  // Restore from the Trash, labeled Finance with the amount.
  await page.goto("/settings/trash");
  const row = page.locator("div.rounded-lg.border").filter({ hasText: payee }).first();
  await expect(row).toBeVisible();
  await expect(row.getByText("Finance")).toBeVisible();
  await expect(row.getByText("$4.20")).toBeVisible();
  await row.getByRole("button", { name: `Restore ${payee}` }).click();
  await expect(page.getByText(`Restored “${payee}”`)).toBeVisible();

  // Back in the ledger.
  await page.goto("/finance");
  await expect(
    page
      .locator("div.rounded-lg.border")
      .filter({ has: page.getByRole("button", { name: "Transaction actions" }) })
      .filter({ hasText: payee }),
  ).toHaveCount(1);

  // Cleanup: the account (and its ledger) to the Trash, then purge it there.
  const accountMenu = page.getByRole("button", { name: `Actions for ${account}` });
  await accountMenu.click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("menuitem", { name: "Delete account + ledger" }).click();
  await expect(accountMenu).toHaveCount(0);
  await sweepTrash(page);

  expect(errors).toEqual([]);
});
