import type { Metadata } from "next";
import { Suspense } from "react";
import { CalendarClock, TrendingDown, TrendingUp, Wallet } from "lucide-react";

import type { AccountView } from "@/components/finance/account-dialog";
import { AddTransactionButton } from "@/components/finance/add-transaction-button";
import type { BillRowView } from "@/components/finance/bill-dialog";
import type { BudgetView } from "@/components/finance/budget-dialog";
import { FinanceBoard, type CategoryTotalView } from "@/components/finance/finance-board";
import type { SavingsGoalView } from "@/components/finance/savings-goal-dialog";
import type { TransactionView } from "@/components/finance/transaction-dialog";
import { PageHeader } from "@/components/shared/page-header";
import { StatCard } from "@/components/shared/stat-card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMoney } from "@/lib/logic/finance";
import { pluralize } from "@/lib/utils";
import { BILL_SOON_DAYS, getFinanceOverview } from "@/server/finance";

export const metadata: Metadata = { title: "Finance" };
export const dynamic = "force-dynamic";

export default async function FinancePage() {
  const overview = await getFinanceOverview();

  // The largest currency group leads the stats; other currencies are never
  // summed into it — that would be a fictional number.
  const primary = overview.net[0] ?? null;
  const primaryCurrency = primary?.currency ?? "USD";
  const otherCurrencies = overview.net.length - 1;
  const dueSoon = overview.bills.filter((view) => view.daysUntilDue <= BILL_SOON_DAYS);

  const accounts: AccountView[] = overview.balances.map(({ account, balance, debt }) => ({
    id: account.id,
    name: account.name,
    type: account.type,
    currency: account.currency,
    openingBalance: account.openingBalance,
    lowBalanceThreshold: account.lowBalanceThreshold,
    notes: account.notes,
    archived: account.archivedAt !== null,
    balance,
    debt,
  }));
  const activeAccounts = accounts.filter((account) => !account.archived);

  const transactions: TransactionView[] = overview.recentTransactions.map((transaction) => ({
    id: transaction.id,
    date: transaction.date,
    amount: transaction.amount,
    payee: transaction.payee,
    category: transaction.category,
    notes: transaction.notes,
    accountId: transaction.accountId,
    accountName: transaction.account.name,
    currency: transaction.account.currency,
    billId: transaction.billId,
    billName: transaction.bill?.name ?? null,
    transferGroupId: transaction.transferGroupId,
  }));

  const budgets: BudgetView[] = overview.budgets.map((view) => ({
    id: view.budget.id,
    category: view.budget.category,
    label: view.label,
    amount: view.budget.amount,
    spent: view.spent,
    remaining: view.remaining,
    percent: view.percent,
    over: view.over,
  }));

  const bills: BillRowView[] = overview.bills.map(({ bill, bucket, daysUntilDue }) => ({
    id: bill.id,
    name: bill.name,
    amount: bill.amount,
    kind: bill.kind,
    category: bill.category,
    accountId: bill.accountId,
    accountName: bill.account?.name ?? null,
    currency: bill.account?.currency ?? primaryCurrency,
    recurrence: bill.recurrence,
    nextDueDate: bill.nextDueDate,
    autoPay: bill.autoPay,
    reminderEnabled: bill.reminderEnabled,
    reminderDaysBefore: bill.reminderDaysBefore,
    notes: bill.notes,
    bucket,
    daysUntilDue,
  }));

  const goals: SavingsGoalView[] = overview.savingsGoals.map((goal) => ({
    id: goal.id,
    name: goal.name,
    targetAmount: goal.targetAmount,
    currentAmount: goal.currentAmount,
    targetDate: goal.targetDate,
    notes: goal.notes,
    percent: goal.progress.percent,
    remaining: goal.progress.remaining,
    complete: goal.progress.complete,
  }));

  const byCategory: CategoryTotalView[] = overview.month.byCategory.map((entry) => ({
    category: entry.category,
    label: entry.label,
    total: entry.total,
  }));

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Finance"
        description="Accounts, spending, bills and savings — entered by hand, private by design."
        actions={
          <Suspense fallback={null}>
            <AddTransactionButton accounts={activeAccounts} today={overview.today} />
          </Suspense>
        }
      />

      <div className="stat-grid mb-6">
        <StatCard
          label="Net balance"
          value={primary ? formatMoney(primary.net, primary.currency) : "—"}
          hint={
            otherCurrencies > 0
              ? `+${otherCurrencies} other ${pluralize(otherCurrencies, "currency", "currencies")}`
              : primary
                ? `across ${primary.accounts} ${pluralize(primary.accounts, "account")}`
                : "add an account to start"
          }
          icon={Wallet}
          accent="text-domain-finance"
        />
        <StatCard
          label="Spent this month"
          value={overview.month.count > 0 ? formatMoney(overview.month.spending, primaryCurrency) : "—"}
          hint={
            overview.month.count > 0
              ? `${formatMoney(overview.week.spending, primaryCurrency)} in the last 7 days`
              : "nothing recorded yet"
          }
          icon={TrendingDown}
          accent="text-red-500"
        />
        <StatCard
          label="Income this month"
          value={overview.month.count > 0 ? formatMoney(overview.month.income, primaryCurrency) : "—"}
          hint={
            overview.month.count > 0
              ? `${overview.month.net >= 0 ? "+" : ""}${formatMoney(overview.month.net, primaryCurrency)} net`
              : "nothing recorded yet"
          }
          icon={TrendingUp}
          accent="text-emerald-500"
        />
        <StatCard
          label={`Bills due · ${BILL_SOON_DAYS} days`}
          value={`${dueSoon.length}`}
          hint={
            dueSoon.length > 0
              ? `${formatMoney(overview.billsDueSoonTotal, primaryCurrency)} expected`
              : "all clear"
          }
          icon={CalendarClock}
          accent="text-amber-500"
        />
      </div>

      <Suspense fallback={<Skeleton className="h-96 w-full" />}>
        <FinanceBoard
          accounts={accounts}
          transactions={transactions}
          bills={bills}
          goals={goals}
          budgets={budgets}
          byCategory={byCategory}
          today={overview.today}
          primaryCurrency={primaryCurrency}
        />
      </Suspense>
    </div>
  );
}
