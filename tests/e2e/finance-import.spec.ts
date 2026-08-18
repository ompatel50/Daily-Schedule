import { expect, test, type Page } from "@playwright/test";

import { STORAGE } from "./auth";

/**
 * Finance CSV import correctness, verified against the production build
 * through the real UI with a Chase-shaped card export:
 *
 *  * signed amounts are trusted — the card payment (type "Payment", +$300)
 *    stays money IN instead of being inverted by the type column;
 *  * card-issuer type values (Sale / Payment / Fee / Adjustment / Return)
 *    import instead of rejecting;
 *  * an unrecognised category value ("Payment") is offered in the preview,
 *    quick-mapped to Transfer, persisted, and re-applied on the next parse;
 *  * rows mapped to bookkeeping categories are clearly surfaced — they change
 *    balances but stay out of income and spending.
 *
 * Uses alice (the mutating-flows account), a run-unique account name, and
 * cleans up through the app's own delete flows (mapping removed, account and
 * its ledger deleted). Console/page errors fail the test.
 */

test.use({ storageState: STORAGE.alice });

const ACCOUNT_NAME = `Import Card ${(Date.now() % 100000).toString(36)}`;

const CHASE_CSV = [
  "Transaction Date,Post Date,Description,Category,Type,Amount,Memo",
  "07/01/2026,07/02/2026,AMAZON MKTPL*XY123,Shopping,Sale,-42.50,",
  "07/03/2026,07/03/2026,Payment Thank You-Mobile,Payment,Payment,300.00,",
  "07/05/2026,07/06/2026,ANNUAL MEMBERSHIP FEE,Fees,Fee,-95.00,",
  "07/07/2026,07/08/2026,STATEMENT CREDIT,,Adjustment,5.00,",
  "07/09/2026,07/10/2026,AMAZON MKTPL REFUND,Shopping,Return,15.00,card credit",
].join("\n");

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

/** Open the import dialog, pick the run's account, and attach the CSV. */
async function openImportWithFile(page: Page) {
  const trigger = page.getByRole("button", { name: "Import CSV" });
  await expect(async () => {
    await trigger.click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  const dialog = page.getByRole("dialog");

  await dialog.locator("#import-account").click();
  await page.getByRole("option", { name: new RegExp(ACCOUNT_NAME) }).click();

  await dialog.locator("#import-file").setInputFiles({
    name: "chase.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(CHASE_CSV, "utf-8"),
  });
  // The preview round-trips through a server action.
  await expect(dialog.getByText("of 5 rows")).toBeVisible();
  return dialog;
}

/**
 * Delete every account this spec's runs create (self-healing: a previously
 * FAILED run leaves its account and imported ledger behind, and the final
 * assertions need them gone).
 */
async function deleteImportCardAccounts(page: Page) {
  const actions = page.getByRole("button", { name: /^Actions for Import Card / });
  let count = await actions.count();
  while (count > 0) {
    await actions.first().click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("menuitem", { name: "Delete account + ledger" }).click();
    await expect(actions).toHaveCount(count - 1);
    count -= 1;
  }
}

/** If a previous run left the "payment" mapping behind, remove it first. */
async function removeStaleMapping(page: Page, dialog = page.getByRole("dialog")) {
  const remove = dialog.getByRole("button", { name: 'Remove the mapping for "Payment"' });
  if (await remove.isVisible().catch(() => false)) {
    await remove.click();
    await expect(dialog.getByText("Unrecognised categories")).toBeVisible();
  }
}

test("a Chase-shaped export imports with trusted signs and a quick-mapped Payment category", async ({
  page,
}) => {
  const errors = trackErrors(page);
  await page.goto("/finance");
  await deleteImportCardAccounts(page);

  // --- a fresh credit-card account for this run ------------------------------
  await page.getByRole("button", { name: "New account" }).first().click();
  const accountDialog = page.getByRole("dialog");
  await accountDialog.locator("#account-name").fill(ACCOUNT_NAME);
  await accountDialog.locator("#account-type").click();
  await page.getByRole("option", { name: "Credit card" }).click();
  await accountDialog.getByRole("button", { name: "Create account" }).click();
  await expect(accountDialog).toBeHidden();
  await expect(page.getByText(ACCOUNT_NAME).first()).toBeVisible();

  // --- preview: signs trusted, issuer types accepted, category offered -------
  const dialog = await openImportWithFile(page);
  await removeStaleMapping(page, dialog);

  await expect(dialog.getByText("5 new")).toBeVisible();
  await expect(dialog.getByText("0 invalid")).toBeVisible();
  // The payment arrives as money IN — the sign was trusted, not rewritten.
  await expect(dialog.getByText("+$300")).toBeVisible();
  // The unmatched category value is offered for mapping.
  await expect(dialog.getByText("Unrecognised categories")).toBeVisible();

  // --- quick-map "Payment" → Transfer ----------------------------------------
  await dialog.getByRole("combobox", { name: 'Map category "Payment"' }).click();
  await page.getByRole("option", { name: "Transfer", exact: true }).click();

  // The preview re-parses with the persisted mapping applied…
  await expect(dialog.getByText("Your saved category mappings")).toBeVisible();
  // …and the bookkeeping guard says exactly what such rows do.
  await expect(
    dialog.getByText("1 row will import as bookkeeping (transfer / balance adjustment)"),
  ).toBeVisible();
  await expect(dialog.getByText("balances only")).toBeVisible();

  // --- commit ---------------------------------------------------------------
  await dialog.getByRole("button", { name: "Import 5 rows" }).click();
  await expect(dialog.getByText("Import complete")).toBeVisible();
  await expect(dialog.getByText("5 created")).toBeVisible();
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();

  // --- the ledger agrees ----------------------------------------------------
  const paymentRow = page
    .locator("div")
    .filter({ hasText: /^Payment Thank You-Mobile/ })
    .filter({ has: page.getByText("+$300") })
    .first();
  await expect(paymentRow).toBeVisible();
  await expect(page.getByText("AMAZON MKTPL*XY123")).toBeVisible();

  // --- clean up: remove the mapping through the dialog's own control --------
  const again = await openImportWithFile(page);
  await expect(again.getByText("Your saved category mappings")).toBeVisible();
  await again.getByRole("button", { name: 'Remove the mapping for "Payment"' }).click();
  await expect(again.getByText("Unrecognised categories")).toBeVisible();
  await again.getByRole("button", { name: "Cancel" }).click();
  await expect(again).toBeHidden();

  // --- clean up: delete the account and its ledger --------------------------
  await deleteImportCardAccounts(page);
  await expect(page.getByRole("button", { name: `Actions for ${ACCOUNT_NAME}` })).toHaveCount(0);
  await expect(page.getByText("Payment Thank You-Mobile")).toHaveCount(0);

  expect(errors).toEqual([]);
});
