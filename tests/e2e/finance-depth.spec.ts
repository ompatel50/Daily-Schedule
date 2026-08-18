import { expect, test, type Page } from "@playwright/test";

import { STORAGE } from "./auth";

/**
 * Phase-4 finance depth, verified against the production build through the
 * real UI:
 *
 *  * a credit-card account with a tracked limit shows utilisation on its
 *    card, moving as spending lands; a statement due day shows with the
 *    bills' own due language;
 *  * three same-payee monthly charges surface a "Looks recurring" suggestion
 *    whose "Track as bill" opens the bill dialog pre-filled; creating the
 *    bill suppresses the suggestion;
 *  * a rollover budget says so on its row;
 *  * the "Month over month" report section renders with totals.
 *
 * Uses alice, run-unique names, cleans up through the app's own delete
 * flows. Console/page errors fail the test.
 */

test.use({ storageState: STORAGE.alice });

const SUFFIX = (Date.now() % 100000).toString(36);
const ACCOUNT_NAME = `Depth Card ${SUFFIX}`;
const GYM_PAYEE = "E2E GYM MEMBERSHIP";

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

/** The 10th of each of the last three months, oldest first (gaps 28–31 days). */
function monthlyDates(): string[] {
  const dates: string[] = [];
  for (let monthsBack = 3; monthsBack >= 1; monthsBack -= 1) {
    const at = new Date();
    at.setUTCDate(1);
    at.setUTCMonth(at.getUTCMonth() - monthsBack);
    at.setUTCDate(10);
    dates.push(at.toISOString().slice(0, 10));
  }
  return dates;
}

async function addTransaction(
  page: Page,
  fields: { amount: string; account: string; payee: string; date?: string },
) {
  await page.getByRole("button", { name: "Add transaction" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Spent" }).click();
  await dialog.locator("#tx-amount").fill(fields.amount);
  if (fields.date) await dialog.locator("#tx-date").fill(fields.date);
  await dialog.locator("#tx-account").click();
  await page.getByRole("option", { name: fields.account }).click();
  await dialog.locator("#tx-payee").fill(fields.payee);
  await dialog.getByRole("button", { name: "Add transaction" }).click();
  await expect(dialog).toBeHidden();
}

/** Self-healing cleanup for everything this spec's runs create. */
async function cleanUp(page: Page) {
  // Bills named after the gym payee.
  const billMenus = page.getByRole("button", { name: /^Actions for E2E GYM/ });
  let bills = await billMenus.count();
  while (bills > 0) {
    await billMenus.first().click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("menuitem", { name: "Confirm delete" }).click();
    await expect(billMenus).toHaveCount(bills - 1);
    bills -= 1;
  }
  // The travel budget this spec creates.
  const budgetMenu = page.getByRole("button", { name: "Actions for the Travel budget" });
  if (await budgetMenu.isVisible().catch(() => false)) {
    await budgetMenu.click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("menuitem", { name: "Confirm delete" }).click();
    await expect(budgetMenu).toHaveCount(0);
  }
  // Depth accounts and their ledgers.
  const accountMenus = page.getByRole("button", { name: /^Actions for Depth Card / });
  let accounts = await accountMenus.count();
  while (accounts > 0) {
    await accountMenus.first().click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("menuitem", { name: "Delete account + ledger" }).click();
    await expect(accountMenus).toHaveCount(accounts - 1);
    accounts -= 1;
  }
}

test("utilisation, statement day, recurring suggestion and rollover budget", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/finance");
  await cleanUp(page);

  // --- credit card with limit + statement day --------------------------------
  await page.getByRole("button", { name: "New account" }).first().click();
  const accountDialog = page.getByRole("dialog");
  await accountDialog.locator("#account-name").fill(ACCOUNT_NAME);
  await accountDialog.locator("#account-type").click();
  await page.getByRole("option", { name: "Credit card" }).click();
  await accountDialog.locator("#account-credit-limit").fill("1000");
  await accountDialog.locator("#account-statement-day").fill("25");
  await accountDialog.getByRole("button", { name: "Create account" }).click();
  await expect(accountDialog).toBeHidden();

  const accountRow = page
    .locator("div.rounded-lg.border")
    .filter({ has: page.getByRole("button", { name: `Actions for ${ACCOUNT_NAME}` }) })
    .first();
  await expect(accountRow.getByText("0% used")).toBeVisible();
  await expect(accountRow.getByText("· statement ·")).toBeVisible();

  // Spending moves the bar.
  await addTransaction(page, { amount: "300", account: ACCOUNT_NAME, payee: "BIG PURCHASE" });
  await expect(accountRow.getByText("30% used")).toBeVisible();
  await expect(accountRow.getByText("$300 of $1,000")).toBeVisible();

  // --- recurring detection → track as bill -----------------------------------
  for (const date of monthlyDates()) {
    await addTransaction(page, {
      amount: "45",
      account: ACCOUNT_NAME,
      payee: GYM_PAYEE,
      date,
    });
  }
  await expect(page.getByText("Looks recurring")).toBeVisible();
  const suggestion = page
    .locator("div.rounded-lg")
    .filter({ has: page.getByRole("button", { name: "Track as bill" }) })
    .filter({ hasText: GYM_PAYEE })
    .first();
  await expect(suggestion.getByText(/every month/)).toBeVisible();
  await suggestion.getByRole("button", { name: "Track as bill" }).click();

  const billDialog = page.getByRole("dialog");
  await expect(billDialog.locator("#bill-name")).toHaveValue(GYM_PAYEE);
  await expect(billDialog.locator("#bill-amount")).toHaveValue("45");
  await billDialog.getByRole("button", { name: "Create bill" }).click();
  await expect(billDialog).toBeHidden();

  // The bill exists; the suggestion is suppressed by its name.
  await expect(
    page.getByRole("button", { name: `Actions for ${GYM_PAYEE}` }),
  ).toBeVisible();
  await expect(page.getByText("Looks recurring")).toHaveCount(0);

  // --- rollover budget -------------------------------------------------------
  await page.getByRole("button", { name: "New budget" }).click();
  const budgetDialog = page.getByRole("dialog");
  await budgetDialog.locator("#budget-category").click();
  await page.getByRole("option", { name: "Travel" }).click();
  await budgetDialog.locator("#budget-amount").fill("100");
  await budgetDialog.locator("#budget-rollover").click();
  await budgetDialog.getByRole("button", { name: "Create budget" }).click();
  await expect(budgetDialog).toBeHidden();
  const budgetRow = page
    .locator("div.rounded-lg.border")
    .filter({ has: page.getByRole("button", { name: "Actions for the Travel budget" }) })
    .first();
  await expect(budgetRow.getByText(/rolled over|rollover on/)).toBeVisible();

  // --- the month-over-month report renders -----------------------------------
  await expect(page.getByText("Month over month")).toBeVisible();
  await expect(page.getByText("This calendar month against the last")).toBeVisible();

  // --- clean up --------------------------------------------------------------
  await cleanUp(page);
  expect(errors).toEqual([]);
});
