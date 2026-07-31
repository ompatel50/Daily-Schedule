"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Archive,
  ArrowLeftRight,
  BellRing,
  CalendarClock,
  FileUp,
  Landmark,
  MoreHorizontal,
  Pencil,
  PieChart,
  PiggyBank,
  Plus,
  Receipt,
  Scale,
  Target,
  Trash2,
  TriangleAlert,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import { EmptyState } from "@/components/shared/empty-state";
import { SectionCard } from "@/components/shared/section-card";
import { AccountDialog, type AccountView } from "@/components/finance/account-dialog";
import { AdjustGoalDialog } from "@/components/finance/adjust-goal-dialog";
import { BillDialog, type BillRowView } from "@/components/finance/bill-dialog";
import { BudgetDialog, type BudgetView } from "@/components/finance/budget-dialog";
import { ImportCsvDialog } from "@/components/finance/import-csv-dialog";
import {
  SavingsGoalDialog,
  type SavingsGoalView,
} from "@/components/finance/savings-goal-dialog";
import { SetBalanceDialog } from "@/components/finance/set-balance-dialog";
import {
  TransactionDialog,
  type TransactionView,
} from "@/components/finance/transaction-dialog";
import { TransferDialog } from "@/components/finance/transfer-dialog";
import { UndoImportDialog } from "@/components/finance/undo-import-dialog";
import { formatDay } from "@/lib/date";
import {
  ACCOUNT_TYPE_META,
  BILL_RECURRENCE_META,
  FINANCE_CATEGORY_META,
  type AccountType,
  type BillRecurrence,
  type FinanceCategory,
} from "@/lib/enums";
import { describeDueDistance } from "@/lib/logic/due";
import { formatMoney } from "@/lib/logic/finance";
import { cn } from "@/lib/utils";
import {
  deleteBill,
  deleteBudget,
  deleteFinanceAccount,
  deleteSavingsGoal,
  deleteTransaction,
  markBillPaid,
  setBillArchived,
  setFinanceAccountArchived,
  setSavingsGoalArchived,
} from "@/server/actions/finance";

export interface CategoryTotalView {
  category: string;
  label: string;
  total: number;
}

/** One CSV import run, as the page serialises it for the history list. */
export interface ImportBatchView {
  id: string;
  fileName: string;
  accountName: string | null;
  importedDay: string;
  createdCount: number;
  skippedCount: number;
  rejectedCount: number;
  /** Ledger rows still linked to this batch right now. */
  remainingCount: number;
  undone: boolean;
  undoneCount: number;
  keptCount: number;
}

/** How urgent a due date reads: overdue red, this fortnight amber, later quiet. */
const DUE_CLASSES: Record<BillRowView["bucket"], string> = {
  overdue: "font-medium text-red-700 dark:text-red-400",
  today: "font-medium text-amber-800 dark:text-amber-400",
  soon: "font-medium text-amber-800 dark:text-amber-400",
  later: "text-muted-foreground",
};

export function FinanceBoard({
  accounts,
  transactions,
  bills,
  goals,
  budgets,
  importBatches,
  byCategory,
  today,
  primaryCurrency,
}: {
  accounts: AccountView[];
  transactions: TransactionView[];
  bills: BillRowView[];
  goals: SavingsGoalView[];
  budgets: BudgetView[];
  importBatches: ImportBatchView[];
  byCategory: CategoryTotalView[];
  today: string;
  /** Currency of the largest account group — used where no account is linked. */
  primaryCurrency: string;
}) {
  const router = useRouter();
  const [, startTransition] = React.useTransition();

  const [txOpen, setTxOpen] = React.useState(false);
  const [txEditing, setTxEditing] = React.useState<TransactionView | null>(null);
  const [accountOpen, setAccountOpen] = React.useState(false);
  const [accountEditing, setAccountEditing] = React.useState<AccountView | null>(null);
  const [billOpen, setBillOpen] = React.useState(false);
  const [billEditing, setBillEditing] = React.useState<BillRowView | null>(null);
  const [goalOpen, setGoalOpen] = React.useState(false);
  const [goalEditing, setGoalEditing] = React.useState<SavingsGoalView | null>(null);
  const [budgetOpen, setBudgetOpen] = React.useState(false);
  const [budgetEditing, setBudgetEditing] = React.useState<BudgetView | null>(null);
  const [undoBatch, setUndoBatch] = React.useState<ImportBatchView | null>(null);
  const [transferOpen, setTransferOpen] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);
  const [balanceAccount, setBalanceAccount] = React.useState<AccountView | null>(null);
  const [adjustingGoal, setAdjustingGoal] = React.useState<SavingsGoalView | null>(null);
  const [showArchivedAccounts, setShowArchivedAccounts] = React.useState(false);

  const activeAccounts = accounts.filter((account) => !account.archived);
  const archivedAccounts = accounts.filter((account) => account.archived);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, message: string) {
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        toast.success(message);
        router.refresh();
      } else {
        toast.error(result.error ?? "Something went wrong");
      }
    });
  }

  function markPaid(bill: BillRowView) {
    startTransition(async () => {
      const result = await markBillPaid({ billId: bill.id, date: today, recordTransaction: true });
      if (result.ok) {
        const { nextDueDate, settled, transactionRecorded } = result.data;
        toast.success(
          settled
            ? `${bill.name} settled — nothing further due`
            : `${bill.name} paid — next due ${nextDueDate ? formatDay(nextDueDate) : "later"}`,
          {
            description: transactionRecorded
              ? "The payment was written into the ledger."
              : "No account linked, so nothing was written into the ledger.",
          },
        );
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <SectionCard
          title="Transactions"
          icon={Receipt}
          accent="text-domain-finance"
          description="Newest first — the ledger every balance derives from"
          action={
            <div className="flex items-center gap-1">
              {activeAccounts.length > 0 && (
                <Button size="sm" variant="ghost" onClick={() => setImportOpen(true)}>
                  <FileUp /> Import CSV
                </Button>
              )}
              {activeAccounts.length > 1 && (
                <Button size="sm" variant="ghost" onClick={() => setTransferOpen(true)}>
                  <ArrowLeftRight /> Transfer
                </Button>
              )}
            </div>
          }
        >
          {transactions.length === 0 ? (
            <EmptyState
              icon={Receipt}
              title="No transactions yet"
              description="Everything here is entered by hand — record the first and the balances follow."
              action={
                activeAccounts.length > 0 ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      setTxEditing(null);
                      setTxOpen(true);
                    }}
                  >
                    <Plus /> Add transaction
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="space-y-2">
              {transactions.map((transaction) => (
                <TransactionRow
                  key={transaction.id}
                  transaction={transaction}
                  onEdit={() => {
                    setTxEditing(transaction);
                    setTxOpen(true);
                  }}
                  onDelete={() =>
                    run(() => deleteTransaction(transaction.id), "Transaction deleted")
                  }
                />
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Bills & subscriptions"
          icon={CalendarClock}
          accent="text-domain-finance"
          description="Most urgent first"
          action={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setBillEditing(null);
                setBillOpen(true);
              }}
            >
              <Plus /> New bill
            </Button>
          }
        >
          {bills.length === 0 ? (
            <EmptyState
              icon={CalendarClock}
              title="No bills tracked"
              description="Rent, utilities, subscriptions — track them here and marking one paid rolls it forward."
              action={
                <Button
                  size="sm"
                  onClick={() => {
                    setBillEditing(null);
                    setBillOpen(true);
                  }}
                >
                  <Plus /> Add a bill
                </Button>
              }
            />
          ) : (
            <div className="space-y-2">
              {bills.map((bill) => (
                <BillRow
                  key={bill.id}
                  bill={bill}
                  today={today}
                  onMarkPaid={() => markPaid(bill)}
                  onEdit={() => {
                    setBillEditing(bill);
                    setBillOpen(true);
                  }}
                  onArchive={() => run(() => setBillArchived(bill.id, true), "Bill archived")}
                  onDelete={() => run(() => deleteBill(bill.id), "Bill deleted")}
                />
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      <div className="space-y-6">
        <SectionCard
          title="Accounts"
          icon={Landmark}
          accent="text-domain-finance"
          action={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setAccountEditing(null);
                setAccountOpen(true);
              }}
            >
              <Plus /> New account
            </Button>
          }
        >
          {accounts.length === 0 ? (
            <EmptyState
              icon={Landmark}
              title="No accounts yet"
              description="Accounts hold the ledger — create one to start recording money."
              action={
                <Button
                  size="sm"
                  onClick={() => {
                    setAccountEditing(null);
                    setAccountOpen(true);
                  }}
                >
                  <Plus /> Create an account
                </Button>
              }
            />
          ) : (
            <div className="space-y-2">
              {activeAccounts.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  onEdit={() => {
                    setAccountEditing(account);
                    setAccountOpen(true);
                  }}
                  onSetBalance={() => setBalanceAccount(account)}
                  onArchive={() =>
                    run(() => setFinanceAccountArchived(account.id, true), "Account archived")
                  }
                  onDelete={() =>
                    run(
                      () => deleteFinanceAccount(account.id),
                      "Account and its ledger deleted",
                    )
                  }
                />
              ))}

              {archivedAccounts.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowArchivedAccounts((current) => !current)}
                  className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  {showArchivedAccounts ? "Hide" : "Show"} {archivedAccounts.length} archived
                </button>
              )}
              {showArchivedAccounts &&
                archivedAccounts.map((account) => (
                  <div
                    key={account.id}
                    className="flex items-center gap-3 rounded-lg border border-dashed px-3 py-2 opacity-70"
                  >
                    <p className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                      {account.name}
                    </p>
                    <span className="tabular shrink-0 text-sm text-muted-foreground">
                      {formatMoney(account.balance, account.currency)}
                    </span>
                    <RowMenu
                      label={`Actions for ${account.name}`}
                      items={[
                        {
                          label: "Restore",
                          icon: Undo2,
                          onClick: () =>
                            run(
                              () => setFinanceAccountArchived(account.id, false),
                              "Account restored",
                            ),
                        },
                      ]}
                      confirmLabel="Delete account + ledger"
                      onDelete={() =>
                        run(
                          () => deleteFinanceAccount(account.id),
                          "Account and its ledger deleted",
                        )
                      }
                    />
                  </div>
                ))}
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Savings goals"
          icon={PiggyBank}
          accent="text-domain-finance"
          action={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setGoalEditing(null);
                setGoalOpen(true);
              }}
            >
              <Plus /> New goal
            </Button>
          }
        >
          {goals.length === 0 ? (
            <EmptyState
              icon={PiggyBank}
              title="No savings goals"
              description="Set a target and chip away at it."
              action={
                <Button
                  size="sm"
                  onClick={() => {
                    setGoalEditing(null);
                    setGoalOpen(true);
                  }}
                >
                  <Plus /> Create a goal
                </Button>
              }
            />
          ) : (
            <div className="space-y-2">
              {goals.map((goal) => (
                <GoalRow
                  key={goal.id}
                  goal={goal}
                  currency={primaryCurrency}
                  onAdjust={() => setAdjustingGoal(goal)}
                  onEdit={() => {
                    setGoalEditing(goal);
                    setGoalOpen(true);
                  }}
                  onArchive={() =>
                    run(() => setSavingsGoalArchived(goal.id, true), "Goal archived")
                  }
                  onDelete={() => run(() => deleteSavingsGoal(goal.id), "Goal deleted")}
                />
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Budgets"
          icon={Target}
          accent="text-domain-finance"
          description="Monthly or weekly targets per category"
          action={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setBudgetEditing(null);
                setBudgetOpen(true);
              }}
            >
              <Plus /> New budget
            </Button>
          }
        >
          {budgets.length === 0 ? (
            <EmptyState
              icon={Target}
              title="No budgets yet"
              description="Set a monthly or weekly target for a category and watch spending against it."
              className="py-6"
            />
          ) : (
            <div className="space-y-2">
              {budgets.map((budget) => (
                <BudgetRow
                  key={budget.id}
                  budget={budget}
                  currency={primaryCurrency}
                  onEdit={() => {
                    setBudgetEditing(budget);
                    setBudgetOpen(true);
                  }}
                  onDelete={() => run(() => deleteBudget(budget.id), "Budget deleted")}
                />
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="CSV imports"
          icon={FileUp}
          accent="text-domain-finance"
          description="Every import run, and how to roll one back"
        >
          {importBatches.length === 0 ? (
            <EmptyState
              icon={FileUp}
              title="No imports yet"
              description="Import a CSV from an account's menu — you can undo it here afterwards."
              className="py-6"
            />
          ) : (
            <div className="space-y-2">
              {importBatches.map((batch) => (
                <ImportBatchRow
                  key={batch.id}
                  batch={batch}
                  onUndo={() => setUndoBatch(batch)}
                />
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="This month by category"
          icon={PieChart}
          accent="text-domain-finance"
          description="Spending only — income, transfers and adjustments stay out"
        >
          {byCategory.length === 0 ? (
            <EmptyState icon={PieChart} title="No spending recorded yet" className="py-6" />
          ) : (
            <CategoryBars categories={byCategory} currency={primaryCurrency} />
          )}
        </SectionCard>
      </div>

      <TransactionDialog
        open={txOpen}
        onOpenChange={setTxOpen}
        transaction={txEditing}
        accounts={activeAccounts}
        today={today}
      />
      <AccountDialog open={accountOpen} onOpenChange={setAccountOpen} account={accountEditing} />
      <BillDialog
        open={billOpen}
        onOpenChange={setBillOpen}
        bill={billEditing}
        accounts={activeAccounts}
        today={today}
      />
      <SavingsGoalDialog open={goalOpen} onOpenChange={setGoalOpen} goal={goalEditing} />
      <SetBalanceDialog
        account={balanceAccount}
        today={today}
        onClose={() => setBalanceAccount(null)}
      />
      <AdjustGoalDialog
        goal={adjustingGoal}
        currency={primaryCurrency}
        onClose={() => setAdjustingGoal(null)}
      />
      <BudgetDialog
        open={budgetOpen}
        onOpenChange={setBudgetOpen}
        budget={budgetEditing}
        takenCategories={budgets.map((budget) => budget.category)}
      />
      <UndoImportDialog batch={undoBatch} onClose={() => setUndoBatch(null)} />
      <TransferDialog
        open={transferOpen}
        onOpenChange={setTransferOpen}
        accounts={activeAccounts}
        today={today}
      />
      <ImportCsvDialog open={importOpen} onOpenChange={setImportOpen} accounts={activeAccounts} />
    </div>
  );
}

// --- rows --------------------------------------------------------------------

function TransactionRow({
  transaction,
  onEdit,
  onDelete,
}: {
  transaction: TransactionView;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const categoryLabel =
    FINANCE_CATEGORY_META[transaction.category as FinanceCategory]?.label ?? transaction.category;
  const received = transaction.amount > 0;
  const transfer = transaction.transferGroupId !== null;

  return (
    <div className="flex items-center gap-3 rounded-lg border px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium">{transaction.payee ?? categoryLabel}</p>
          {transfer ? (
            <Badge variant="outline" className="gap-1 text-[10px]">
              <ArrowLeftRight className="h-2.5 w-2.5" aria-hidden="true" /> Transfer
            </Badge>
          ) : (
            transaction.payee && (
              <Badge variant="outline" className="text-[10px]">
                {categoryLabel}
              </Badge>
            )
          )}
          <Badge variant="muted" className="text-[10px]">
            {transaction.accountName}
          </Badge>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {formatDay(transaction.date)}
          {transaction.billName ? ` · ${transaction.billName}` : ""}
        </p>
      </div>
      <span
        className={cn(
          "tabular shrink-0 text-sm font-semibold",
          received && !transfer && "text-emerald-700 dark:text-emerald-400",
          transfer && "text-muted-foreground",
        )}
      >
        {received ? "+" : ""}
        {formatMoney(transaction.amount, transaction.currency)}
      </span>
      <RowMenu
        label="Transaction actions"
        // One leg cannot be edited alone — delete removes the pair, and the
        // dialog would only half-change a transfer anyway.
        items={transfer ? [] : [{ label: "Edit", icon: Pencil, onClick: onEdit }]}
        confirmLabel={transfer ? "Delete both legs" : "Confirm delete"}
        onDelete={onDelete}
      />
    </div>
  );
}

function BudgetRow({
  budget,
  currency,
  onEdit,
  onDelete,
}: {
  budget: BudgetView;
  currency: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const periodLabel = budget.period === "weekly" ? "Weekly" : "Monthly";
  return (
    <div className="rounded-lg border px-3 py-2.5">
      <div className="flex items-center gap-1">
        <p className="min-w-0 flex-1 truncate text-sm font-medium">{budget.label}</p>
        <Badge variant="muted" className="text-[10px]">
          {periodLabel}
        </Badge>
        {budget.over ? (
          <Badge variant="outline" className="gap-1 border-red-500/30 text-[10px] text-red-700 dark:text-red-400">
            <TriangleAlert className="h-2.5 w-2.5" aria-hidden="true" />
            Over by {formatMoney(budget.spent - budget.amount, currency)}
          </Badge>
        ) : budget.thresholdReached ? (
          <Badge
            variant="outline"
            className="gap-1 border-amber-500/30 text-[10px] text-amber-800 dark:text-amber-400"
          >
            <BellRing className="h-2.5 w-2.5" aria-hidden="true" />
            Past {budget.threshold}%
          </Badge>
        ) : null}
        <RowMenu
          label={`Actions for the ${budget.label} budget`}
          items={[{ label: "Edit", icon: Pencil, onClick: onEdit }]}
          onDelete={onDelete}
        />
      </div>
      <Progress
        value={Math.min(100, budget.percent)}
        className="mt-2 h-1.5"
        indicatorClassName={
          budget.over ? "bg-red-500" : budget.thresholdReached ? "bg-amber-500" : "bg-domain-finance"
        }
      />
      <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="tabular">
          {formatMoney(budget.spent, currency)} / {formatMoney(budget.amount, currency)}
        </span>
        <span className={cn("tabular", budget.over && "font-medium text-red-700 dark:text-red-400")}>
          {budget.over ? `${budget.percent}% spent` : `${formatMoney(budget.remaining, currency)} left`}
        </span>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {budget.period === "weekly" ? "This week" : "This month"} ·{" "}
        {formatDay(budget.windowStart, "MMM d")} – {formatDay(budget.windowEnd, "MMM d")}
        {budget.threshold !== null ? ` · alerts at ${budget.threshold}%` : ""}
      </p>
    </div>
  );
}

/**
 * The CSV import history — the surface undo hangs off. Bounded to the most
 * recent runs; an import that has been rolled back stays listed (as an audit
 * record) rather than disappearing.
 */
function ImportBatchRow({
  batch,
  onUndo,
}: {
  batch: ImportBatchView;
  onUndo: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium">{batch.fileName}</p>
          {batch.undone && (
            <Badge variant="muted" className="gap-1 text-[10px]">
              <Undo2 className="h-2.5 w-2.5" aria-hidden="true" />
              Undone
            </Badge>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {formatDay(batch.importedDay)}
          {batch.accountName ? ` · ${batch.accountName}` : ""} · {batch.createdCount} imported
          {batch.skippedCount > 0 ? `, ${batch.skippedCount} skipped` : ""}
          {batch.rejectedCount > 0 ? `, ${batch.rejectedCount} rejected` : ""}
          {batch.undone
            ? ` · ${batch.undoneCount} removed${batch.keptCount > 0 ? `, ${batch.keptCount} kept` : ""}`
            : ""}
        </p>
      </div>
      {!batch.undone && batch.remainingCount > 0 && (
        <Button size="sm" variant="outline" onClick={onUndo}>
          <Undo2 /> Undo
        </Button>
      )}
    </div>
  );
}

function BillRow({
  bill,
  today,
  onMarkPaid,
  onEdit,
  onArchive,
  onDelete,
}: {
  bill: BillRowView;
  today: string;
  onMarkPaid: () => void;
  onEdit: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const recurrenceLabel =
    BILL_RECURRENCE_META[bill.recurrence as BillRecurrence]?.label ?? bill.recurrence;

  return (
    <div className="flex items-center gap-3 rounded-lg border px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium">{bill.name}</p>
          {bill.kind === "subscription" && (
            <Badge variant="muted" className="text-[10px]">
              Subscription
            </Badge>
          )}
          {bill.autoPay && (
            <Badge variant="outline" className="text-[10px]">
              Auto-pay
            </Badge>
          )}
        </div>
        <p className="mt-0.5 text-xs">
          <span className={DUE_CLASSES[bill.bucket]}>
            {describeDueDistance(bill.nextDueDate, today)}
          </span>
          <span className="text-muted-foreground">
            {" · "}
            {formatDay(bill.nextDueDate, "MMM d")} · {recurrenceLabel}
          </span>
        </p>
      </div>
      <span className="tabular shrink-0 text-sm font-semibold">
        {formatMoney(bill.amount, bill.currency)}
      </span>
      <Button size="sm" variant="outline" className="shrink-0" onClick={onMarkPaid}>
        Mark paid
      </Button>
      <RowMenu
        label={`Actions for ${bill.name}`}
        items={[
          { label: "Edit", icon: Pencil, onClick: onEdit },
          { label: "Archive", icon: Archive, onClick: onArchive },
        ]}
        onDelete={onDelete}
      />
    </div>
  );
}

function AccountRow({
  account,
  onEdit,
  onSetBalance,
  onArchive,
  onDelete,
}: {
  account: AccountView;
  onEdit: () => void;
  onSetBalance: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const typeMeta = ACCOUNT_TYPE_META[account.type as AccountType] ?? ACCOUNT_TYPE_META.other;
  const belowThreshold =
    account.lowBalanceThreshold !== null && account.balance < account.lowBalanceThreshold;

  return (
    <div className="flex items-center gap-3 rounded-lg border px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium">{account.name}</p>
          <Badge variant="outline" className={cn("text-[10px]", typeMeta.chip)}>
            {typeMeta.label}
          </Badge>
          {belowThreshold && (
            <Badge
              variant="outline"
              className="gap-1 border-amber-500/30 text-[10px] text-amber-800 dark:text-amber-400"
              title={`Below your ${formatMoney(account.lowBalanceThreshold ?? 0, account.currency)} alert level`}
            >
              <TriangleAlert className="h-2.5 w-2.5" aria-hidden="true" /> Low
            </Badge>
          )}
        </div>
      </div>
      <span
        className={cn(
          "tabular shrink-0 text-sm font-semibold",
          account.debt && account.balance < 0 && "text-red-700 dark:text-red-400",
        )}
      >
        {formatMoney(account.balance, account.currency)}
      </span>
      <RowMenu
        label={`Actions for ${account.name}`}
        items={[
          { label: "Edit", icon: Pencil, onClick: onEdit },
          { label: "Set balance…", icon: Scale, onClick: onSetBalance },
          { label: "Archive", icon: Archive, onClick: onArchive },
        ]}
        confirmLabel="Delete account + ledger"
        onDelete={onDelete}
      />
    </div>
  );
}

function GoalRow({
  goal,
  currency,
  onAdjust,
  onEdit,
  onArchive,
  onDelete,
}: {
  goal: SavingsGoalView;
  currency: string;
  onAdjust: () => void;
  onEdit: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="rounded-lg border px-3 py-2.5">
      <div className="flex items-center gap-1">
        <p className="min-w-0 flex-1 truncate text-sm font-medium">{goal.name}</p>
        {goal.complete && (
          <Badge variant="success" className="text-[10px]">
            Funded
          </Badge>
        )}
        <Button size="sm" variant="ghost" onClick={onAdjust}>
          <Plus /> Add
        </Button>
        <RowMenu
          label={`Actions for ${goal.name}`}
          items={[
            { label: "Edit", icon: Pencil, onClick: onEdit },
            { label: "Archive", icon: Archive, onClick: onArchive },
          ]}
          onDelete={onDelete}
        />
      </div>
      <Progress value={goal.percent} className="mt-2 h-1.5" indicatorClassName="bg-domain-finance" />
      <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="tabular">
          {formatMoney(goal.currentAmount, currency)} / {formatMoney(goal.targetAmount, currency)}
        </span>
        <span className="tabular">
          {goal.complete ? "complete" : `${formatMoney(goal.remaining, currency)} to go`}
        </span>
      </div>
    </div>
  );
}

function CategoryBars({
  categories,
  currency,
}: {
  categories: CategoryTotalView[];
  currency: string;
}) {
  const max = Math.max(...categories.map((category) => category.total), 1);

  return (
    <div className="space-y-3">
      {categories.map((category) => (
        <div key={category.category}>
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="truncate">{category.label}</span>
            <span className="tabular shrink-0 font-medium">
              {formatMoney(category.total, currency)}
            </span>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-domain-finance"
              style={{ width: `${Math.max(2, (category.total / max) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

// --- row menu ----------------------------------------------------------------

/**
 * The per-row overflow menu: regular actions, then a two-step delete — the
 * first click flips the item to a confirm, the second commits. Closing the
 * menu resets the confirmation, so a stray click never destroys anything.
 */
function RowMenu({
  label,
  items,
  onDelete,
  confirmLabel = "Confirm delete",
}: {
  label: string;
  items: Array<{ label: string; icon: LucideIcon; onClick: () => void }>;
  onDelete: () => void;
  confirmLabel?: string;
}) {
  const [confirming, setConfirming] = React.useState(false);

  return (
    <DropdownMenu onOpenChange={(open) => !open && setConfirming(false)}>
      <DropdownMenuTrigger asChild>
        <Button size="icon-sm" variant="ghost" className="shrink-0" aria-label={label}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {items.map(({ label: itemLabel, icon: Icon, onClick }) => (
          <DropdownMenuItem key={itemLabel} onClick={onClick}>
            <Icon /> {itemLabel}
          </DropdownMenuItem>
        ))}
        {items.length > 0 && <DropdownMenuSeparator />}
        {confirming ? (
          <DropdownMenuItem destructive onClick={onDelete}>
            <Trash2 /> {confirmLabel}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            destructive
            onSelect={(event) => {
              event.preventDefault();
              setConfirming(true);
            }}
          >
            <Trash2 /> Delete
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
