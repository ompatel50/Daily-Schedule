import { monthRange, shiftDay, weekRange, type DayKey } from "@/lib/date";
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
 * Money flows through this module as INTEGER CENTS (see
 * src/lib/logic/money.ts — the storage unit and the display boundary).
 * Everything here is sums, differences and ratios, which work identically on
 * any fixed unit; the remaining `moneyRound` calls are no-ops on integers and
 * survive only so the module still behaves for legacy float inputs until the
 * cleanup migration retires those columns. Amounts are SIGNED: positive is
 * money in, negative is money out.
 */

export function moneyRound(value: number): number {
  return round(value, 2);
}

// Display formatting lives in src/lib/logic/money.ts (`formatCents`) — the
// old dollar-float `formatMoney` was retired with the integer-cents switch.

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

// --- credit cards ------------------------------------------------------------

export type UtilizationTone = "ok" | "elevated" | "high";

export interface CreditUtilization {
  /** What is currently owed, as a positive number. */
  owed: number;
  limit: number;
  available: number;
  /** owed ÷ limit, rounded, uncapped — 104 means over the limit. */
  percent: number;
  /** <30% ok · 30–69% elevated · ≥70% high — the usual utilisation advice. */
  tone: UtilizationTone;
}

/**
 * Credit utilisation for a debt account with a tracked limit. Null when there
 * is no meaningful limit; a positive balance (the card owes YOU) is 0%.
 */
export function creditUtilization(account: {
  balance: number;
  creditLimit: number | null;
}): CreditUtilization | null {
  const limit = account.creditLimit ?? 0;
  if (limit <= 0) return null;
  const owed = moneyRound(Math.max(0, -account.balance));
  const percent = Math.round((owed / limit) * 100);
  return {
    owed,
    limit: moneyRound(limit),
    available: moneyRound(Math.max(0, limit - owed)),
    percent,
    tone: percent >= 70 ? "high" : percent >= 30 ? "elevated" : "ok",
  };
}

/**
 * The next date a day-of-month statement due day lands on, today included.
 * Days beyond a month's length clamp to its last day (31 → Feb 28), the
 * convention every "due on the Nth" card statement follows.
 */
export function nextStatementDueDate(dayOfMonth: number, today: DayKey): DayKey {
  const day = Math.min(31, Math.max(1, Math.round(dayOfMonth)));
  const clampInto = (window: { start: DayKey; end: DayKey }): DayKey => {
    const lastDay = Number(window.end.slice(8, 10));
    return `${window.end.slice(0, 8)}${String(Math.min(day, lastDay)).padStart(2, "0")}`;
  };
  const thisMonth = clampInto(monthRange(today));
  if (thisMonth >= today) return thisMonth;
  return clampInto(monthRange(shiftDay(monthRange(today).end, 1)));
}

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

export interface CategoryDelta {
  category: FinanceCategory | string;
  label: string;
  /** Spending this window / the previous one, as positive numbers. */
  current: number;
  previous: number;
  /** current − previous: positive = spending grew. */
  delta: number;
}

/**
 * Spending per category across two windows — the month-over-month report.
 * Every category that appears in either window is present; sorted by the
 * size of the change, biggest mover first, so `slice(0, n)` IS "top movers".
 * Built on the same bookkeeping-excluding arithmetic as spendingByCategory.
 */
export function compareSpendingByCategory(
  current: TransactionLike[],
  previous: TransactionLike[],
): CategoryDelta[] {
  const totals = new Map<string, { current: number; previous: number }>();
  const add = (transactions: TransactionLike[], side: "current" | "previous") => {
    for (const transaction of transactions) {
      if (transaction.amount >= 0 || isBookkeepingCategory(transaction.category)) continue;
      const entry = totals.get(transaction.category) ?? { current: 0, previous: 0 };
      entry[side] -= transaction.amount;
      totals.set(transaction.category, entry);
    }
  };
  add(current, "current");
  add(previous, "previous");

  return [...totals.entries()]
    .map(([category, entry]) => ({
      category,
      label: FINANCE_CATEGORY_META[category as FinanceCategory]?.label ?? category,
      current: moneyRound(entry.current),
      previous: moneyRound(entry.previous),
      delta: moneyRound(entry.current - entry.previous),
    }))
    .sort(
      (a, b) =>
        Math.abs(b.delta) - Math.abs(a.delta) ||
        b.current - a.current ||
        a.label.localeCompare(b.label),
    );
}

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

/**
 * The window immediately before one — where rollover carry is measured.
 * Weekly steps back seven days; monthly is the previous calendar month.
 */
export function previousBudgetWindow(period: BudgetPeriod, window: BudgetWindow): BudgetWindow {
  if (period === "weekly") {
    return { start: shiftDay(window.start, -7), end: shiftDay(window.end, -7) };
  }
  return monthRange(shiftDay(window.start, -1));
}

export interface BudgetLike {
  id: string;
  category: string;
  amount: number;
  /** monthly | weekly — anything else is treated as monthly. */
  period: string;
  /** Warn once per period at this share of the target; null = no alert. */
  alertThresholdPercent?: number | null;
  /** Opt-in: last period's unused amount adds to this period's room. */
  rollover?: boolean;
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
  /** Effective room (target + carry) − spent, floored at zero. */
  remaining: number;
  /** Spent ÷ effective room, uncapped and rounded — 130 means 30% over. */
  percent: number;
  over: boolean;
  /**
   * What last period's unused amount added to this one — zero unless the
   * budget opted into rollover. Capped at one period's target, and an
   * overspent previous period never claws room away (floor zero).
   */
  carry: number;
  /** target + carry — what spent/percent/over/remaining are measured against. */
  effectiveAmount: number;
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
  // One pass over the ledger per window in play, not per budget — a hundred
  // budgets cost the same few passes as two do.
  const spentByWindow = new Map<string, Map<string, number>>();
  const spentIn = (window: BudgetWindow | undefined): Map<string, number> => {
    if (!window) return new Map();
    const key = `${window.start}|${window.end}`;
    const cached = spentByWindow.get(key);
    if (cached) return cached;
    const totals = new Map<string, number>();
    for (const transaction of transactions) {
      if (transaction.amount >= 0 || isBookkeepingCategory(transaction.category)) continue;
      if (transaction.date < window.start || transaction.date > window.end) continue;
      totals.set(
        transaction.category,
        (totals.get(transaction.category) ?? 0) - transaction.amount,
      );
    }
    spentByWindow.set(key, totals);
    return totals;
  };

  return budgets
    .map((budget) => {
      const period = budgetPeriodOf(budget.period);
      const window = windows[period] ?? windows.monthly;
      const spent = moneyRound(spentIn(window).get(budget.category) ?? 0);
      const target = Math.max(0, budget.amount);

      // Opt-in rollover: last period's unused room joins this period's,
      // capped at one period's worth. An overspent previous period carries
      // zero — a budget is a ceiling, never a debt.
      let carry = 0;
      if (budget.rollover && target > 0 && window) {
        const previous = previousBudgetWindow(period, window);
        const previousSpent = moneyRound(spentIn(previous).get(budget.category) ?? 0);
        carry = moneyRound(Math.min(target, Math.max(0, target - previousSpent)));
      }
      const effectiveAmount = moneyRound(target + carry);

      const percent =
        effectiveAmount <= 0 ? (spent > 0 ? 999 : 0) : Math.round((spent / effectiveAmount) * 100);
      const threshold = budget.alertThresholdPercent ?? null;
      return {
        budget,
        label: FINANCE_CATEGORY_META[budget.category as FinanceCategory]?.label ?? budget.category,
        spent,
        remaining: moneyRound(Math.max(0, effectiveAmount - spent)),
        percent,
        over: spent > effectiveAmount,
        carry,
        effectiveAmount,
        period,
        window,
        threshold,
        thresholdReached: threshold !== null && effectiveAmount > 0 && percent >= threshold,
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
