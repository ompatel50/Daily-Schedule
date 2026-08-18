import type { DbClient } from "../db-client";

/**
 * Money → integer cents: fill any `*Cents` column still null from its legacy
 * float sibling, then VERIFY that every account's computed balance is
 * identical — to the cent — whichever set of columns computes it.
 *
 * The schema migration (20260818052025_money_integer_cents) already backfills
 * in SQL, so on a normally-migrated database this module only verifies. It
 * earns its keep on data that arrived AFTER that migration ran without cents —
 * a pre-upgrade backup restored by an older tool, or rows written by code
 * older than the deploy — and it uses the exact JS rounding the app itself
 * uses (`toCents` = Math.round(value × 100), the same half-up `moneyRound`
 * applied on every write), so backfill output matches what the app would
 * have computed.
 *
 * Idempotent: only null cents columns are written; verification writes
 * nothing. A verification mismatch FAILS the run loudly — that is the whole
 * point of running it before trusting the cents columns.
 */
export const id = "004-money-cents";
export const description =
  "Backfill integer-cents money columns and verify per-account balances to the cent";

const toCents = (amount: number): number => Math.round(amount * 100);

export async function run(prisma: DbClient): Promise<string[]> {
  const notes: string[] = [];

  // ---- fill anything the SQL backfill has not seen --------------------------
  let filled = 0;

  const transactions = await prisma.financeTransaction.findMany({
    where: { amountCents: null },
    select: { id: true, amount: true },
  });
  for (const row of transactions) {
    await prisma.financeTransaction.update({
      where: { id: row.id },
      data: { amountCents: toCents(row.amount) },
    });
    filled += 1;
  }

  const accounts = await prisma.financeAccount.findMany({
    select: {
      id: true,
      openingBalance: true,
      openingBalanceCents: true,
      lowBalanceThreshold: true,
      lowBalanceThresholdCents: true,
      creditLimit: true,
      creditLimitCents: true,
    },
  });
  for (const row of accounts) {
    const data: Record<string, number> = {};
    if (row.openingBalanceCents === null) data.openingBalanceCents = toCents(row.openingBalance);
    if (row.lowBalanceThresholdCents === null && row.lowBalanceThreshold !== null) {
      data.lowBalanceThresholdCents = toCents(row.lowBalanceThreshold);
    }
    if (row.creditLimitCents === null && row.creditLimit !== null) {
      data.creditLimitCents = toCents(row.creditLimit);
    }
    if (Object.keys(data).length > 0) {
      await prisma.financeAccount.update({ where: { id: row.id }, data });
      filled += 1;
    }
  }

  const bills = await prisma.bill.findMany({
    where: { amountCents: null },
    select: { id: true, amount: true },
  });
  for (const row of bills) {
    await prisma.bill.update({ where: { id: row.id }, data: { amountCents: toCents(row.amount) } });
    filled += 1;
  }

  const budgets = await prisma.budget.findMany({
    where: { amountCents: null },
    select: { id: true, amount: true },
  });
  for (const row of budgets) {
    await prisma.budget.update({
      where: { id: row.id },
      data: { amountCents: toCents(row.amount) },
    });
    filled += 1;
  }

  const goals = await prisma.savingsGoal.findMany({
    where: { OR: [{ targetAmountCents: null }, { currentAmountCents: null }] },
    select: {
      id: true,
      targetAmount: true,
      targetAmountCents: true,
      currentAmount: true,
      currentAmountCents: true,
    },
  });
  for (const row of goals) {
    await prisma.savingsGoal.update({
      where: { id: row.id },
      data: {
        targetAmountCents: row.targetAmountCents ?? toCents(row.targetAmount),
        currentAmountCents: row.currentAmountCents ?? toCents(row.currentAmount),
      },
    });
    filled += 1;
  }

  notes.push(
    filled === 0
      ? "money: nothing to fill — every money column already has its cents value"
      : `money: filled cents on ${filled} row(s)`,
  );

  // ---- verify: float balances and cents balances agree to the cent ----------
  const verifyAccounts = await prisma.financeAccount.findMany({
    select: { id: true, name: true, openingBalance: true, openingBalanceCents: true },
  });
  let verified = 0;
  for (const account of verifyAccounts) {
    const rows = await prisma.financeTransaction.findMany({
      where: { accountId: account.id },
      select: { amount: true, amountCents: true },
    });
    // The float computation the app used before the switch: round each write
    // to 2dp (they were), sum, round the display. Reproduced here.
    const floatBalance =
      Math.round(
        (account.openingBalance + rows.reduce((sum, row) => sum + row.amount, 0)) * 100,
      ) / 100;
    const centsBalance =
      (account.openingBalanceCents ?? toCents(account.openingBalance)) +
      rows.reduce((sum, row) => sum + (row.amountCents ?? toCents(row.amount)), 0);
    if (toCents(floatBalance) !== centsBalance) {
      throw new Error(
        `money: balance mismatch on account ${account.id} (“${account.name}”): ` +
          `float says ${floatBalance}, cents say ${centsBalance / 100}. ` +
          `Nothing was changed by verification — investigate before trusting the cents columns.`,
      );
    }
    verified += 1;
  }
  notes.push(`money: verified ${verified} account balance(s) identical to the cent`);

  return notes;
}
