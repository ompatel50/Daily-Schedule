"use client";

import * as React from "react";
import { ArrowLeftRight, FileUp, Pencil, Plus, Receipt, Unlink } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { SectionCard } from "@/components/shared/section-card";
import { RowMenu } from "@/components/finance/row-menu";
import type { TransactionView } from "@/components/finance/transaction-dialog";
import { formatDay } from "@/lib/date";
import { FINANCE_CATEGORY_META, type FinanceCategory } from "@/lib/enums";
import { formatMoney } from "@/lib/logic/finance";
import { cn } from "@/lib/utils";

/** The ledger list — newest first, every balance derives from it. */
export function TransactionsSection({
  transactions,
  hasActiveAccounts,
  canTransfer,
  onImport,
  onTransfer,
  onAdd,
  onEdit,
  onDelete,
  onMarkTransfer,
  onUnlinkTransfer,
}: {
  transactions: TransactionView[];
  hasActiveAccounts: boolean;
  /** Transfers need two unarchived accounts. */
  canTransfer: boolean;
  onImport: () => void;
  onTransfer: () => void;
  onAdd: () => void;
  onEdit: (transaction: TransactionView) => void;
  onDelete: (transaction: TransactionView) => void;
  /** Link this row to a counterpart in another account (or create one). */
  onMarkTransfer: (transaction: TransactionView) => void;
  /** Restore both legs of this row's transfer to ordinary rows. */
  onUnlinkTransfer: (transaction: TransactionView) => void;
}) {
  return (
    <SectionCard
      title="Transactions"
      icon={Receipt}
      accent="text-domain-finance"
      description="Newest first — the ledger every balance derives from"
      action={
        <div className="flex flex-wrap items-center justify-end gap-1">
          {hasActiveAccounts && (
            <Button size="sm" variant="ghost" onClick={onImport}>
              <FileUp /> Import CSV
            </Button>
          )}
          {canTransfer && (
            <Button size="sm" variant="ghost" onClick={onTransfer}>
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
            hasActiveAccounts ? (
              <Button size="sm" onClick={onAdd}>
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
              canTransfer={canTransfer}
              onEdit={() => onEdit(transaction)}
              onDelete={() => onDelete(transaction)}
              onMarkTransfer={() => onMarkTransfer(transaction)}
              onUnlinkTransfer={() => onUnlinkTransfer(transaction)}
            />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function TransactionRow({
  transaction,
  canTransfer,
  onEdit,
  onDelete,
  onMarkTransfer,
  onUnlinkTransfer,
}: {
  transaction: TransactionView;
  canTransfer: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onMarkTransfer: () => void;
  onUnlinkTransfer: () => void;
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
        // dialog would only half-change a transfer anyway. Unlinking restores
        // both legs to ordinary rows first.
        items={
          transfer
            ? [{ label: "Unlink transfer", icon: Unlink, onClick: onUnlinkTransfer }]
            : [
                { label: "Edit", icon: Pencil, onClick: onEdit },
                ...(canTransfer
                  ? [{ label: "Mark as transfer…", icon: ArrowLeftRight, onClick: onMarkTransfer }]
                  : []),
              ]
        }
        confirmLabel={transfer ? "Delete both legs" : "Confirm delete"}
        onDelete={onDelete}
      />
    </div>
  );
}
