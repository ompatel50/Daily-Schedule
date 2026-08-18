"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { AccountDialog, type AccountView } from "@/components/finance/account-dialog";
import { AccountsSection } from "@/components/finance/accounts-section";
import { AdjustGoalDialog } from "@/components/finance/adjust-goal-dialog";
import { BillDialog, type BillRowView } from "@/components/finance/bill-dialog";
import { BillsSection } from "@/components/finance/bills-section";
import { BudgetDialog, type BudgetView } from "@/components/finance/budget-dialog";
import { BudgetsSection } from "@/components/finance/budgets-section";
import {
  CategorySpendSection,
  type CategoryTotalView,
} from "@/components/finance/category-spend-section";
import { ImportCsvDialog } from "@/components/finance/import-csv-dialog";
import {
  ImportBatchesSection,
  type ImportBatchView,
} from "@/components/finance/import-batches-section";
import {
  SavingsGoalDialog,
  type SavingsGoalView,
} from "@/components/finance/savings-goal-dialog";
import { SavingsGoalsSection } from "@/components/finance/savings-goals-section";
import { SetBalanceDialog } from "@/components/finance/set-balance-dialog";
import {
  TransactionDialog,
  type TransactionView,
} from "@/components/finance/transaction-dialog";
import { TransactionsSection } from "@/components/finance/transactions-section";
import { TransferDialog } from "@/components/finance/transfer-dialog";
import { UndoImportDialog } from "@/components/finance/undo-import-dialog";
import { formatDay } from "@/lib/date";
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

export type { CategoryTotalView, ImportBatchView };

/**
 * The finance page's interactive body. Each section is its own component
 * (transactions, bills, accounts, savings goals, budgets, import history,
 * category spend) with data in and callbacks out; this board owns what genuinely
 * spans sections — which dialog is open, over which record, and the
 * mutate-toast-refresh cycle.
 */
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

  const activeAccounts = accounts.filter((account) => !account.archived);

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
        <TransactionsSection
          transactions={transactions}
          hasActiveAccounts={activeAccounts.length > 0}
          canTransfer={activeAccounts.length > 1}
          onImport={() => setImportOpen(true)}
          onTransfer={() => setTransferOpen(true)}
          onAdd={() => {
            setTxEditing(null);
            setTxOpen(true);
          }}
          onEdit={(transaction) => {
            setTxEditing(transaction);
            setTxOpen(true);
          }}
          onDelete={(transaction) =>
            run(() => deleteTransaction(transaction.id), "Transaction deleted")
          }
        />

        <BillsSection
          bills={bills}
          today={today}
          onNew={() => {
            setBillEditing(null);
            setBillOpen(true);
          }}
          onMarkPaid={markPaid}
          onEdit={(bill) => {
            setBillEditing(bill);
            setBillOpen(true);
          }}
          onArchive={(bill) => run(() => setBillArchived(bill.id, true), "Bill archived")}
          onDelete={(bill) => run(() => deleteBill(bill.id), "Bill deleted")}
        />
      </div>

      <div className="space-y-6">
        <AccountsSection
          accounts={accounts}
          onNew={() => {
            setAccountEditing(null);
            setAccountOpen(true);
          }}
          onEdit={(account) => {
            setAccountEditing(account);
            setAccountOpen(true);
          }}
          onSetBalance={setBalanceAccount}
          onArchive={(account) =>
            run(() => setFinanceAccountArchived(account.id, true), "Account archived")
          }
          onRestore={(account) =>
            run(() => setFinanceAccountArchived(account.id, false), "Account restored")
          }
          onDelete={(account) =>
            run(() => deleteFinanceAccount(account.id), "Account and its ledger deleted")
          }
        />

        <SavingsGoalsSection
          goals={goals}
          currency={primaryCurrency}
          onNew={() => {
            setGoalEditing(null);
            setGoalOpen(true);
          }}
          onAdjust={setAdjustingGoal}
          onEdit={(goal) => {
            setGoalEditing(goal);
            setGoalOpen(true);
          }}
          onArchive={(goal) => run(() => setSavingsGoalArchived(goal.id, true), "Goal archived")}
          onDelete={(goal) => run(() => deleteSavingsGoal(goal.id), "Goal deleted")}
        />

        <BudgetsSection
          budgets={budgets}
          currency={primaryCurrency}
          onNew={() => {
            setBudgetEditing(null);
            setBudgetOpen(true);
          }}
          onEdit={(budget) => {
            setBudgetEditing(budget);
            setBudgetOpen(true);
          }}
          onDelete={(budget) => run(() => deleteBudget(budget.id), "Budget deleted")}
        />

        <ImportBatchesSection batches={importBatches} onUndo={setUndoBatch} />

        <CategorySpendSection categories={byCategory} currency={primaryCurrency} />
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
