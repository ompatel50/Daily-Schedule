import "server-only";

import { cache } from "react";

import { getCurrentUser, prisma } from "@/lib/db";
import { monthRange, shiftDay, type DayKey } from "@/lib/date";
import {
  accountBalances,
  budgetFetchRange,
  budgetWindows,
  billsByUrgency,
  budgetProgress,
  moneyRound,
  savingsProgress,
  spendingByCategory,
  summarizeTransactions,
  upcomingBillsTotal,
  type AccountBalance,
  type BudgetWindow,
} from "@/lib/logic/finance";
import { scheduleSettingsFor } from "@/server/schedule";

/**
 * Finance read model. Everything here is user-scoped and bounded; the
 * arithmetic lives in the pure module (`src/lib/logic/finance.ts`) so the
 * finance page, the dashboard and the tests share one set of numbers.
 */

/** How far ahead the dashboard and the bill list flag "due soon". */
export const BILL_SOON_DAYS = 14;

/** Most rows a single ledger fetch will consider (a month of manual entry is
 *  a few hundred at most; the cap only guards against pathological data). */
const TRANSACTION_WINDOW_CAP = 2000;

// --- account balances (shared by page + dashboard, memoized per request) -----

async function accountBalancesImpl(userId: string) {
  const [accounts, totals] = await Promise.all([
    prisma.financeAccount.findMany({
      where: { userId },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    prisma.financeTransaction.groupBy({
      by: ["accountId"],
      where: { userId },
      _sum: { amount: true },
    }),
  ]);
  const totalByAccount = new Map(
    totals.map((row) => [row.accountId, row._sum.amount ?? 0]),
  );
  return accountBalances(accounts, totalByAccount);
}

const accountBalancesMemo = cache(accountBalancesImpl);

export type FinanceAccountBalance = Awaited<ReturnType<typeof accountBalancesImpl>>[number];

/** All accounts (archived included) with computed balances. */
export async function getAccountBalances(): Promise<FinanceAccountBalance[]> {
  const user = await getCurrentUser();
  return accountBalancesMemo(user.id);
}

/**
 * Net balance per currency across unarchived accounts, largest first. Mixed
 * currencies are never summed together — that would be a fictional number.
 */
export function netByCurrency(
  balances: AccountBalance[],
): Array<{ currency: string; net: number; accounts: number }> {
  const groups = new Map<string, { net: number; accounts: number }>();
  for (const entry of balances) {
    if (entry.account.archivedAt !== null) continue;
    const currency = (entry.account as { currency?: string }).currency ?? "USD";
    const group = groups.get(currency) ?? { net: 0, accounts: 0 };
    group.net += entry.balance;
    group.accounts += 1;
    groups.set(currency, group);
  }
  return Array.from(groups.entries())
    .map(([currency, group]) => ({ currency, net: moneyRound(group.net), accounts: group.accounts }))
    .sort((a, b) => b.accounts - a.accounts || Math.abs(b.net) - Math.abs(a.net));
}

// --- bills -------------------------------------------------------------------

async function billViewsImpl(userId: string, today: DayKey) {
  const bills = await prisma.bill.findMany({
    where: { userId, archivedAt: null, settledAt: null },
    include: { account: { select: { id: true, name: true, currency: true } } },
    orderBy: { nextDueDate: "asc" },
    take: 200,
  });
  return billsByUrgency(bills, today, BILL_SOON_DAYS);
}

const billViewsMemo = cache(billViewsImpl);

export type BillView = Awaited<ReturnType<typeof billViewsImpl>>[number];

/** Active bills annotated with due state, most urgent first. */
export async function getBillViews(): Promise<BillView[]> {
  const user = await getCurrentUser();
  const settings = scheduleSettingsFor(user);
  return billViewsMemo(user.id, settings.today);
}

// --- transactions ------------------------------------------------------------

export async function getTransactionsBetween(from: DayKey, to: DayKey) {
  const user = await getCurrentUser();
  return prisma.financeTransaction.findMany({
    where: { userId: user.id, date: { gte: from, lte: to } },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    take: TRANSACTION_WINDOW_CAP,
  });
}

export async function getRecentTransactions(limit = 50) {
  const user = await getCurrentUser();
  return prisma.financeTransaction.findMany({
    where: { userId: user.id },
    include: {
      account: { select: { id: true, name: true, currency: true } },
      bill: { select: { id: true, name: true } },
    },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    take: limit,
  });
}

export type TransactionWithRefs = Awaited<ReturnType<typeof getRecentTransactions>>[number];

// --- budgets -----------------------------------------------------------------

async function budgetsImpl(userId: string) {
  return prisma.budget.findMany({
    where: { userId },
    orderBy: { category: "asc" },
    take: 100,
  });
}

const budgetsMemo = cache(budgetsImpl);

export async function getBudgets() {
  const user = await getCurrentUser();
  return budgetsMemo(user.id);
}

export type BudgetRow = Awaited<ReturnType<typeof budgetsImpl>>[number];

// --- CSV import batches ------------------------------------------------------

/** How many import runs the finance page lists — an audit trail, not a log. */
export const IMPORT_BATCH_LIMIT = 10;

async function importBatchesImpl(userId: string, limit: number) {
  return prisma.financeImportBatch.findMany({
    where: { userId },
    include: {
      account: { select: { id: true, name: true } },
      // A live count, not the stored one: it is what undo can still reach.
      _count: { select: { transactions: true } },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

const importBatchesMemo = cache(importBatchesImpl);

/** Recent CSV imports, newest first — the surface the undo action hangs off. */
export async function getImportBatches(limit = IMPORT_BATCH_LIMIT) {
  const user = await getCurrentUser();
  return importBatchesMemo(user.id, limit);
}

export type ImportBatchRow = Awaited<ReturnType<typeof importBatchesImpl>>[number];

// --- savings goals -----------------------------------------------------------

export async function getSavingsGoals(includeArchived = false) {
  const user = await getCurrentUser();
  const goals = await prisma.savingsGoal.findMany({
    where: { userId: user.id, ...(includeArchived ? {} : { archivedAt: null }) },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    take: 100,
  });
  return goals.map((goal) => ({ ...goal, progress: savingsProgress(goal) }));
}

export type SavingsGoalWithProgress = Awaited<ReturnType<typeof getSavingsGoals>>[number];

// --- page + dashboard aggregates --------------------------------------------

/**
 * The one ledger window a finance surface needs: the calendar month (what the
 * month card and monthly budgets measure), the rolling last-7-days the week
 * card shows, and the user's current calendar week (what weekly budgets
 * measure). Fetched once, sliced three ways — a weekly budget must never cost
 * a second query, and the three views must never disagree about a row.
 */
function financeWindows(today: DayKey, weekStartsOn: 0 | 1) {
  const month = monthRange(today);
  const windows = budgetWindows(today, weekStartsOn);
  const rollingWeekStart = shiftDay(today, -6);
  const budgetRange = budgetFetchRange(windows) ?? month;
  const fetch: BudgetWindow = {
    start: [month.start, budgetRange.start, rollingWeekStart].reduce((min, day) =>
      day < min ? day : min,
    ),
    end: [month.end, budgetRange.end].reduce((max, day) => (day > max ? day : max)),
  };
  return { month, windows, rollingWeekStart, fetch };
}

/** Rows inside `[start, end]` — every slice below comes from the one fetch. */
function slice<T extends { date: DayKey }>(rows: T[], window: BudgetWindow): T[] {
  return rows.filter((row) => row.date >= window.start && row.date <= window.end);
}

/** Everything the finance page renders, in one round of bounded queries. */
export async function getFinanceOverview() {
  const user = await getCurrentUser();
  const settings = scheduleSettingsFor(user);
  const today = settings.today;
  const { month, windows, rollingWeekStart, fetch } = financeWindows(today, settings.weekStartsOn);

  const [
    balances,
    bills,
    ledger,
    recentTransactions,
    savingsGoals,
    budgets,
    importBatches,
  ] = await Promise.all([
    accountBalancesMemo(user.id),
    billViewsMemo(user.id, today),
    getTransactionsBetween(fetch.start, fetch.end),
    getRecentTransactions(50),
    getSavingsGoals(),
    budgetsMemo(user.id),
    importBatchesMemo(user.id, IMPORT_BATCH_LIMIT),
  ]);

  const monthTransactions = slice(ledger, month);
  // Bounded on BOTH sides so a future-dated entry (rent typed in ahead of
  // time) cannot inflate "the last 7 days".
  const weekTransactions = slice(ledger, { start: rollingWeekStart, end: today });

  return {
    today,
    balances,
    net: netByCurrency(balances),
    bills,
    billsDueSoonTotal: upcomingBillsTotal(bills, BILL_SOON_DAYS),
    month: {
      ...summarizeTransactions(monthTransactions),
      byCategory: spendingByCategory(monthTransactions),
    },
    week: summarizeTransactions(weekTransactions),
    recentTransactions,
    savingsGoals,
    // Budgets read the fetch already in hand and each filters to its own
    // period window — no extra ledger query for the progress bars.
    budgets: budgetProgress(budgets, ledger, windows),
    budgetWindows: windows,
    importBatches,
  };
}

export type FinanceOverview = Awaited<ReturnType<typeof getFinanceOverview>>;

/** The bounded slice of finance the dashboard shows. */
export async function getFinanceSummary() {
  const user = await getCurrentUser();
  const settings = scheduleSettingsFor(user);
  const { month, windows, fetch } = financeWindows(settings.today, settings.weekStartsOn);

  const [balances, bills, ledger, budgets] = await Promise.all([
    accountBalancesMemo(user.id),
    billViewsMemo(user.id, settings.today),
    getTransactionsBetween(fetch.start, fetch.end),
    budgetsMemo(user.id),
  ]);

  const monthTransactions = slice(ledger, month);
  const dueSoon = bills.filter((view) => view.daysUntilDue <= BILL_SOON_DAYS);
  const budgetViews = budgetProgress(budgets, ledger, windows);
  const overBudget = budgetViews.filter((view) => view.over);
  // Under target but past its own alert line — worth one dashboard word.
  const atThreshold = budgetViews.filter((view) => view.thresholdReached && !view.over);

  return {
    hasAccounts: balances.length > 0,
    net: netByCurrency(balances),
    month: summarizeTransactions(monthTransactions),
    billsDueSoon: dueSoon.slice(0, 3).map((view) => ({
      id: view.bill.id,
      name: view.bill.name,
      amount: view.bill.amount,
      nextDueDate: view.bill.nextDueDate,
      daysUntilDue: view.daysUntilDue,
      bucket: view.bucket,
    })),
    billsDueSoonCount: dueSoon.length,
    billsOverdueCount: bills.filter((view) => view.bucket === "overdue").length,
    billsDueSoonTotal: upcomingBillsTotal(bills, BILL_SOON_DAYS),
    budgets: {
      count: budgetViews.length,
      overCount: overBudget.length,
      atThresholdCount: atThreshold.length,
      /** The most-over budget, for the one-line dashboard callout. */
      worst: overBudget[0]
        ? { label: overBudget[0].label, percent: overBudget[0].percent, period: overBudget[0].period }
        : atThreshold[0]
          ? {
              label: atThreshold[0].label,
              percent: atThreshold[0].percent,
              period: atThreshold[0].period,
            }
          : null,
    },
  };
}

export type FinanceSummary = Awaited<ReturnType<typeof getFinanceSummary>>;
