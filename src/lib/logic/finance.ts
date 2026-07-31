import { monthRange, weekRange, type DayKey } from "@/lib/date";
import type { AccountType, BillRecurrence, BudgetPeriod, FinanceCategory } from "@/lib/enums";
import { ACCOUNT_TYPE_META, FINANCE_CATEGORY_META, isBookkeepingCategory } from "@/lib/enums";
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
 * are this one function over different slices. Balance adjustments and
 * transfer legs are bookkeeping, not earning or spending, and stay out of
 * both sides — money moving between your own accounts changes no total.
 */
export function summarizeTransactions(transactions: TransactionLike[]): MoneySummary {
  let income = 0;
  let spending = 0;
  let count = 0;
  for (const transaction of transactions) {
    if (isBookkeepingCategory(transaction.category)) continue;
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
    if (transaction.amount >= 0 || isBookkeepingCategory(transaction.category)) continue;
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

// --- budgets -----------------------------------------------------------------

export interface BudgetWindow {
  start: DayKey;
  end: DayKey;
}

/**
 * The window one budget period covers *right now*. Monthly is the calendar
 * month; weekly is the user's own week (their `weekStartsOn` convention — the
 * same one the low-balance reminder and every week view already use), so
 * "this week" means the same seven days everywhere in the app.
 *
 * Unknown period strings fall back to monthly rather than throwing: a budget
 * row written by a newer version must still render, not blank the page.
 */
export function budgetPeriodWindow(
  period: string,
  today: DayKey,
  weekStartsOn: 0 | 1 = 1,
): BudgetWindow {
  return period === "weekly" ? weekRange(today, weekStartsOn) : monthRange(today);
}

/** Both windows at once — what a page fetching one ledger slice needs. */
export function budgetWindows(
  today: DayKey,
  weekStartsOn: 0 | 1 = 1,
): Record<BudgetPeriod, BudgetWindow> {
  return {
    monthly: budgetPeriodWindow("monthly", today, weekStartsOn),
    weekly: budgetPeriodWindow("weekly", today, weekStartsOn),
  };
}

/** The union of every budget window — the one ledger range a caller must load. */
export function budgetFetchRange(windows: Record<string, BudgetWindow>): BudgetWindow | null {
  const values = Object.values(windows);
  if (values.length === 0) return null;
  return {
    start: values.reduce((min, window) => (window.start < min ? window.start : min), values[0].start),
    end: values.reduce((max, window) => (window.end > max ? window.end : max), values[0].end),
  };
}

export interface BudgetLike {
  id: string;
  category: string;
  amount: number;
  /** monthly | weekly — anything else is treated as monthly. */
  period: string;
  /** Warn once per period at this share of the target; null = no alert. */
  alertThresholdPercent?: number | null;
}

/** A ledger row as budget arithmetic needs it: an amount, a category, a day. */
export interface DatedTransactionLike extends TransactionLike {
  date: DayKey;
}

export interface BudgetProgress<B extends BudgetLike = BudgetLike> {
  budget: B;
  label: string;
  /** Money out in the budget's category over the window, as a positive number. */
  spent: number;
  /** Target − spent, floored at zero — "how much room is left". */
  remaining: number;
  /** Spent ÷ target, uncapped and rounded — 130 means 30% over. */
  percent: number;
  over: boolean;
  /** The period this budget measures, normalised. */
  period: BudgetPeriod;
  /** The days that period currently covers. */
  window: BudgetWindow;
  /** The configured alert share, or null when the budget has no alert. */
  threshold: number | null;
  /** True once `percent` has reached that share — what the UI badges. */
  thresholdReached: boolean;
}

/** Normalise a stored period string to a period the app understands. */
export function budgetPeriodOf(period: string): BudgetPeriod {
  return period === "weekly" ? "weekly" : "monthly";
}

/**
 * Each budget against its OWN window. The caller passes one transaction slice
 * covering every window in play (see `budgetFetchRange`) plus the window per
 * period; each budget filters to the days it actually measures, so a weekly
 * and a monthly budget can be computed from a single ledger fetch without
 * either borrowing the other's days.
 *
 * Spending only: income never offsets a budget, and bookkeeping rows never
 * count against one. Most-spent-first, with anything over budget on top.
 */
export function budgetProgress<B extends BudgetLike>(
  budgets: B[],
  transactions: DatedTransactionLike[],
  windows: Record<string, BudgetWindow>,
): BudgetProgress<B>[] {
  // One pass over the ledger per period in play, not per budget — a hundred
  // budgets cost the same two passes as two do.
  const spentByPeriod = new Map<string, Map<string, number>>();
  const spentFor = (period: BudgetPeriod): Map<string, number> => {
    const cached = spentByPeriod.get(period);
    if (cached) return cached;
    const window = windows[period] ?? windows.monthly;
    const totals = new Map<string, number>();
    if (window) {
      for (const transaction of transactions) {
        if (transaction.amount >= 0 || isBookkeepingCategory(transaction.category)) continue;
        if (transaction.date < window.start || transaction.date > window.end) continue;
        totals.set(
          transaction.category,
          (totals.get(transaction.category) ?? 0) - transaction.amount,
        );
      }
    }
    spentByPeriod.set(period, totals);
    return totals;
  };

  return budgets
    .map((budget) => {
      const period = budgetPeriodOf(budget.period);
      const spent = moneyRound(spentFor(period).get(budget.category) ?? 0);
      const target = Math.max(0, budget.amount);
      const percent = target <= 0 ? (spent > 0 ? 999 : 0) : Math.round((spent / target) * 100);
      const threshold = budget.alertThresholdPercent ?? null;
      return {
        budget,
        label: FINANCE_CATEGORY_META[budget.category as FinanceCategory]?.label ?? budget.category,
        spent,
        remaining: moneyRound(Math.max(0, target - spent)),
        percent,
        over: spent > target,
        period,
        window: windows[period] ?? windows.monthly,
        threshold,
        thresholdReached: threshold !== null && target > 0 && percent >= threshold,
      };
    })
    .sort(
      (a, b) =>
        Number(b.over) - Number(a.over) || b.percent - a.percent || a.label.localeCompare(b.label),
    );
}

// --- transfers ---------------------------------------------------------------

/**
 * The two ledger rows one transfer writes: money out of the source, the same
 * money into the destination, both category `transfer` (excluded from every
 * income/spending summary) and sharing a `transferGroupId` so delete removes
 * the pair. Same-currency only — the caller enforces that; this function just
 * shapes the legs.
 */
export function transferLegs(input: {
  fromAccountId: string;
  toAccountId: string;
  fromAccountName: string;
  toAccountName: string;
  amount: number;
  date: DayKey;
  notes: string | null;
  transferGroupId: string;
}): Array<{
  accountId: string;
  date: DayKey;
  amount: number;
  category: "transfer";
  payee: string;
  notes: string | null;
  transferGroupId: string;
}> {
  const amount = moneyRound(Math.abs(input.amount));
  return [
    {
      accountId: input.fromAccountId,
      date: input.date,
      amount: -amount,
      category: "transfer",
      payee: `Transfer to ${input.toAccountName}`,
      notes: input.notes,
      transferGroupId: input.transferGroupId,
    },
    {
      accountId: input.toAccountId,
      date: input.date,
      amount,
      category: "transfer",
      payee: `Transfer from ${input.fromAccountName}`,
      notes: input.notes,
      transferGroupId: input.transferGroupId,
    },
  ];
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
