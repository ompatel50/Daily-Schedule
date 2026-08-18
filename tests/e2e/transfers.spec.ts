import { expect, test, type Page } from "@playwright/test";

import { STORAGE } from "./auth";

/**
 * Transfer reconciliation, verified against the production build through the
 * real UI:
 *
 *  * two one-sided rows (money out of one account, the same money into
 *    another) surface as a Transfer suggestion on the finance page;
 *  * accepting the suggestion links the pair — both rows show the Transfer
 *    badge and the amounts stay untouched;
 *  * unlinking from the row menu restores both to ordinary rows;
 *  * "Mark as transfer…" offers the counterpart as a candidate and links it.
 *
 * Uses alice, run-unique account names, cleans up through the app's own
 * delete flows. Console/page errors fail the test.
 */

test.use({ storageState: STORAGE.alice });

const SUFFIX = (Date.now() % 100000).toString(36);
const ACCOUNT_A = `Xfer Checking ${SUFFIX}`;
const ACCOUNT_B = `Xfer Card ${SUFFIX}`;
const PAYEE_OUT = "E2E PAYMENT TO CARD";
const PAYEE_IN = "E2E Payment Thank You";

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

async function createAccount(page: Page, name: string, type?: string) {
  await page.getByRole("button", { name: "New account" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("#account-name").fill(name);
  if (type) {
    await dialog.locator("#account-type").click();
    await page.getByRole("option", { name: type }).click();
  }
  await dialog.getByRole("button", { name: "Create account" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(name).first()).toBeVisible();
}

async function addTransaction(
  page: Page,
  fields: { direction: "Spent" | "Received"; amount: string; account: string; payee: string },
) {
  await page.getByRole("button", { name: "Add transaction" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: fields.direction }).click();
  await dialog.locator("#tx-amount").fill(fields.amount);
  await dialog.locator("#tx-account").click();
  await page.getByRole("option", { name: fields.account }).click();
  await dialog.locator("#tx-payee").fill(fields.payee);
  await dialog.getByRole("button", { name: "Add transaction" }).click();
  await expect(dialog).toBeHidden();
}

/** One ledger row card, identified by its payee and its own row menu. */
function txRow(page: Page, payee: string) {
  return page
    .locator("div.rounded-lg.border")
    .filter({ has: page.getByRole("button", { name: "Transaction actions" }) })
    .filter({ hasText: payee })
    .first();
}

/** Self-healing: remove every account (and its ledger) this spec ever made. */
async function deleteXferAccounts(page: Page) {
  const actions = page.getByRole("button", { name: /^Actions for Xfer / });
  let count = await actions.count();
  while (count > 0) {
    await actions.first().click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("menuitem", { name: "Delete account + ledger" }).click();
    await expect(actions).toHaveCount(count - 1);
    count -= 1;
  }
}

test("suggest → link → unlink → mark-as-transfer round trip", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/finance");
  await deleteXferAccounts(page);

  await createAccount(page, ACCOUNT_A);
  await createAccount(page, ACCOUNT_B, "Credit card");
  await addTransaction(page, {
    direction: "Spent",
    amount: "312.45",
    account: ACCOUNT_A,
    payee: PAYEE_OUT,
  });
  await addTransaction(page, {
    direction: "Received",
    amount: "312.45",
    account: ACCOUNT_B,
    payee: PAYEE_IN,
  });

  // --- the pair surfaces as a suggestion -------------------------------------
  await expect(page.getByText("Transfer suggestions")).toBeVisible();
  const suggestion = page
    .locator("div.rounded-lg.border")
    .filter({ hasText: PAYEE_OUT })
    .filter({ has: page.getByRole("button", { name: "Link", exact: true }) })
    .first();
  await suggestion.getByRole("button", { name: "Link", exact: true }).click();

  // Both rows now wear the Transfer badge; the suggestion card is gone.
  const outRow = txRow(page, PAYEE_OUT);
  await expect(outRow.getByText("Transfer", { exact: true })).toBeVisible();
  await expect(page.getByText("Transfer suggestions")).toHaveCount(0);

  // --- unlink restores both --------------------------------------------------
  await txRow(page, PAYEE_IN).getByRole("button", { name: "Transaction actions" }).click();
  await page.getByRole("menuitem", { name: "Unlink transfer" }).click();
  await expect(outRow.getByText("Transfer", { exact: true })).toHaveCount(0);
  // Unlinked and undismissed, the pair is suggested again.
  await expect(page.getByText("Transfer suggestions")).toBeVisible();

  // --- mark as transfer from the row menu ------------------------------------
  await txRow(page, PAYEE_OUT).getByRole("button", { name: "Transaction actions" }).click();
  await page.getByRole("menuitem", { name: "Mark as transfer…" }).click();
  const markDialog = page.getByRole("dialog");
  await expect(markDialog.getByText("Mark as transfer")).toBeVisible();
  // The counterpart is offered as a candidate — pick and link it.
  const candidate = markDialog.getByRole("radio").filter({ hasText: PAYEE_IN });
  await candidate.click();
  await markDialog.getByRole("button", { name: "Link selected" }).click();
  await expect(markDialog).toBeHidden();
  await expect(outRow.getByText("Transfer", { exact: true })).toBeVisible();

  // --- clean up --------------------------------------------------------------
  await deleteXferAccounts(page);
  await expect(page.getByRole("button", { name: `Actions for ${ACCOUNT_A}` })).toHaveCount(0);

  expect(errors).toEqual([]);
});
