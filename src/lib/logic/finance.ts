import type { DayKey } from "@/lib/date";
import type { AccountType, BillRecurrence, FinanceCategory } from "@/lib/enums";
import { ACCOUNT_TYPE_META, FINANCE_CATEGORY_META } from "@/lib/enums";
import {
  dueBucketOf,
  daysUntil,
  nextOccurrenceAfter,
  type Cadence,
  type DueBucket,
} from "@/lib/logic/due";
import { round, sum } from "@/lib/utils";

/**
 * Finance calculations — pure. The server fetches rows; everything that turns
 * them into balances, summaries and due states lives here so the finance page,
 * the dashboard and the tests all read the same arithmetic.
 *
 * Money is stored as floats and normalised to cents by `moneyRound` at every
 * boundary that produces a number a user will see. Amounts are SIGNED:
 * positive is money in, negative is money out.
 */

export function moneyRound(value: number): number {
  return round(value, 2);
}

/**
 * "$1,240.50" / "−$86.20". Locale is pinned so tests are deterministic and the
 * app renders identically everywhere; `currency` is display-only — nothing in
 * the app ever converts between currencies.
 */
export function formatMoney(value: number, currency = "USD"): string {
  const rounded = moneyRound(value);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: Number.isInteger(rounded) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(rounded);
  } catch {
    // An unknown currency code must never crash a page over a display detail.
    return `${rounded < 0 ? "-" : ""}${currency} ${Math.abs(rounded).toFixed(2)}`;
  }
}

// --- accounts ----------------------------------------------------------------

export interface AccountBalanceInput {
  id: string;
  type: string;
  openingBalance: number;
  archivedAt: Date | string | null;
}

export interface AccountBalance<A extends AccountBalanceInput = AccountBalanceInput> {
  account: A;
  /** openingBalance + every transaction on the account — never stored. */
  balance: number;
  /** True for credit_card / loan accounts, whose balance is normally owed. */
  debt: boolean;
}

/** Attach computed balances: `openingBalance + sum(transactions)` per account. */
export function accountBalances<A extends AccountBalanceInput>(
  accounts: A[],
  transactionTotals: ReadonlyMap<string, number>,
): AccountBalance<A>[] {
  return accounts.map((account) => ({
    account,
    balance: moneyRound(account.openingBalance + (transactionTotals.get(account.id) ?? 0)),
    debt: ACCOUNT_TYPE_META[account.type as AccountType]?.debt ?? false,
  }));
}

/** Net across unarchived accounts. Debt balances are already negative. */
export function netBalance(balances: AccountBalance[]): number {
  return moneyRound(
    sum(
      balances.filter(({ account }) => account.archivedAt === null),
      ({ balance }) => balance,
    ),
  );
}

// --- transaction summaries ---------------------------------------------------

export interface TransactionLike {
  amount: number;
  category: string;
}

export interface MoneySummary {
  /** Money in, as a positive number. */
  income: number;
  /** Money out, as a positive number. */
  spending: number;
  /** income − spending; negative when the window overspent. */
  net: number;
  count: number;
}

/**
 * Income / spending / net over any window — the month card and the week card
 * are this one function over different slices. Balance adjustments are
 * bookkeeping, not earning or spending, and stay out of both sides.
 */
export function summarizeTransactions(transactions: TransactionLike[]): MoneySummary {
  let income = 0;
  let spending = 0;
  let count = 0;
  for (const transaction of transactions) {
    if (transaction.category === "adjustment") continue;
    count += 1;
    if (transaction.amount >= 0) income += transaction.amount;
    else spending += -transaction.amount;
  }
  return {
    income: moneyRound(income),
    spending: moneyRound(spending),
    net: moneyRound(income - spending),
    count,
  };
}

export interface CategoryTotal {
  category: FinanceCategory | string;
  label: string;
  total: number;
}

/** Spending by category, largest first, bounded — for the summary cards. */
export function spendingByCategory(transactions: TransactionLike[], limit = 6): CategoryTotal[] {
  const totals = new Map<string, number>();
  for (const transaction of transactions) {
    if (transaction.amount >= 0 || transaction.category === "adjustment") continue;
    totals.set(transaction.category, (totals.get(transaction.category) ?? 0) - transaction.amount);
  }
  return Array.from(totals.entries())
    .map(([category, total]) => ({
      category,
      label: FINANCE_CATEGORY_META[category as FinanceCategory]?.label ?? category,
      total: moneyRound(total),
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

// --- bills -------------------------------------------------------------------

export interface BillLike {
  id: string;
  name: string;
  amount: number;
  recurrence: string;
  anchorDate: DayKey;
  nextDueDate: DayKey;
  settledAt: Date | string | null;
  archivedAt: Date | string | null;
}

/** The cadence a recurrence advances by; null for a one-time bill. */
export function billCadence(recurrence: string): Cadence | null {
  switch (recurrence as BillRecurrence) {
    case "weekly":
      return { unit: "weekly", every: 1 };
    case "monthly":
      return { unit: "monthly", every: 1 };
    case "quarterly":
      return { unit: "quarterly", every: 1 };
    case "yearly":
      return { unit: "yearly", every: 1 };
    default:
      return null;
  }
}

/**
 * Where the bill's pointer moves after a payment. A recurring bill advances to
 * the next occurrence after the one just paid — generated from the anchor, so
 * short months never shift the day. Paying early or late never skips an
 * occurrence, because the advance is relative to the due date, not the paid
 * date. A one-time bill settles instead.
 */
export function advanceBillAfterPayment(bill: {
  recurrence: string;
  anchorDate: DayKey;
  nextDueDate: DayKey;
}): { nextDueDate: DayKey; settled: boolean } {
  const cadence = billCadence(bill.recurrence);
  if (!cadence) return { nextDueDate: bill.nextDueDate, settled: true };
  return {
    nextDueDate: nextOccurrenceAfter(bill.anchorDate, cadence, bill.nextDueDate),
    settled: false,
  };
}

/** A bill still asking for money: not archived, not settled. */
export function billIsActive(bill: Pick<BillLike, "archivedAt" | "settledAt">): boolean {
  return bill.archivedAt === null && bill.settledAt === null;
}

export interface BillDueView<B extends BillLike = BillLike> {
  bill: B;
  bucket: DueBucket;
  /** Signed days to the due date: negative = overdue. */
  daysUntilDue: number;
}

/**
 * Active bills annotated with their due state, most urgent first. `soonDays`
 * widens the "soon" bucket — the dashboard looks two weeks out.
 */
export function billsByUrgency<B extends BillLike>(
  bills: B[],
  today: DayKey,
  soonDays?: number,
): BillDueView<B>[] {
  return bills
    .filter(billIsActive)
    .map((bill) => ({
      bill,
      bucket: dueBucketOf(bill.nextDueDate, today, soonDays),
      daysUntilDue: daysUntil(bill.nextDueDate, today),
    }))
    .sort((a, b) => a.daysUntilDue - b.daysUntilDue || a.bill.name.localeCompare(b.bill.name));
}

/** Total expected over the bills due in the next `soonDays` days (overdue included). */
export function upcomingBillsTotal(views: BillDueView[], soonDays = 14): number {
  return moneyRound(
    sum(
      views.filter((view) => view.daysUntilDue <= soonDays),
      (view) => view.bill.amount,
    ),
  );
}

// --- savings goals -----------------------------------------------------------

export interface SavingsGoalLike {
  targetAmount: number;
  currentAmount: number;
}

export function savingsProgress(goal: SavingsGoalLike): {
  /** 0–100, capped — an overfunded goal reads as complete, not 130%. */
  percent: number;
  remaining: number;
  complete: boolean;
} {
  const target = Math.max(0, goal.targetAmount);
  const current = Math.max(0, goal.currentAmount);
  const percent =
    target <= 0 ? 100 : Math.min(100, Math.round((current / target) * 100));
  return {
    percent,
    remaining: moneyRound(Math.max(0, target - current)),
    complete: current >= target && target > 0,
  };
}
