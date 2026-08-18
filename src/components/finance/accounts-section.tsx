"use client";

import * as React from "react";
import { Archive, Landmark, Pencil, Plus, Scale, TriangleAlert, Undo2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { EmptyState } from "@/components/shared/empty-state";
import { SectionCard } from "@/components/shared/section-card";
import { RowMenu } from "@/components/finance/row-menu";
import type { AccountView } from "@/components/finance/account-dialog";
import { formatDay } from "@/lib/date";
import { ACCOUNT_TYPE_META, type AccountType } from "@/lib/enums";
import { describeDueDistance, dueBucketOf } from "@/lib/logic/due";
import { creditUtilization, formatMoney, nextStatementDueDate } from "@/lib/logic/finance";
import { cn } from "@/lib/utils";

/** Same urgency colouring the bills list uses — one language for "due". */
const DUE_CLASSES: Record<string, string> = {
  overdue: "font-medium text-red-700 dark:text-red-400",
  today: "font-medium text-amber-800 dark:text-amber-400",
  soon: "font-medium text-amber-800 dark:text-amber-400",
  later: "text-muted-foreground",
};

const UTILIZATION_BAR: Record<string, string> = {
  ok: "bg-domain-finance",
  elevated: "bg-amber-500",
  high: "bg-red-500",
};

/**
 * Accounts, active first with the archived list folded away. The show/hide
 * toggle is this section's own state — nothing else on the page cares.
 */
export function AccountsSection({
  accounts,
  today,
  onNew,
  onEdit,
  onSetBalance,
  onArchive,
  onRestore,
  onDelete,
}: {
  /** All accounts, active and archived — the section splits them itself. */
  accounts: AccountView[];
  /** The user's operational today — anchors statement due distances. */
  today: string;
  onNew: () => void;
  onEdit: (account: AccountView) => void;
  onSetBalance: (account: AccountView) => void;
  onArchive: (account: AccountView) => void;
  onRestore: (account: AccountView) => void;
  onDelete: (account: AccountView) => void;
}) {
  const [showArchived, setShowArchived] = React.useState(false);
  const activeAccounts = accounts.filter((account) => !account.archived);
  const archivedAccounts = accounts.filter((account) => account.archived);

  return (
    <SectionCard
      title="Accounts"
      icon={Landmark}
      accent="text-domain-finance"
      action={
        <Button size="sm" variant="ghost" onClick={onNew}>
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
            <Button size="sm" onClick={onNew}>
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
              today={today}
              onEdit={() => onEdit(account)}
              onSetBalance={() => onSetBalance(account)}
              onArchive={() => onArchive(account)}
              onDelete={() => onDelete(account)}
            />
          ))}

          {archivedAccounts.length > 0 && (
            <button
              type="button"
              onClick={() => setShowArchived((current) => !current)}
              className="touch-target text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              {showArchived ? "Hide" : "Show"} {archivedAccounts.length} archived
            </button>
          )}
          {showArchived &&
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
                  items={[{ label: "Restore", icon: Undo2, onClick: () => onRestore(account) }]}
                  confirmLabel="Delete account + ledger"
                  onDelete={() => onDelete(account)}
                />
              </div>
            ))}
        </div>
      )}
    </SectionCard>
  );
}

function AccountRow({
  account,
  today,
  onEdit,
  onSetBalance,
  onArchive,
  onDelete,
}: {
  account: AccountView;
  today: string;
  onEdit: () => void;
  onSetBalance: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const typeMeta = ACCOUNT_TYPE_META[account.type as AccountType] ?? ACCOUNT_TYPE_META.other;
  const belowThreshold =
    account.lowBalanceThreshold !== null && account.balance < account.lowBalanceThreshold;
  const utilization = account.debt ? creditUtilization(account) : null;
  const statementDue =
    account.statementDueDay !== null ? nextStatementDueDate(account.statementDueDay, today) : null;

  return (
    <div className="rounded-lg border px-3 py-2">
      <div className="flex items-center gap-3">
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

      {utilization && (
        <div className="mt-1.5">
          <Progress
            value={Math.min(100, utilization.percent)}
            className="h-1"
            indicatorClassName={UTILIZATION_BAR[utilization.tone]}
            aria-label={`${utilization.percent}% of the credit limit used`}
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            <span
              className={cn(
                "tabular",
                utilization.tone === "high" && "font-medium text-red-700 dark:text-red-400",
                utilization.tone === "elevated" &&
                  "font-medium text-amber-800 dark:text-amber-400",
              )}
            >
              {utilization.percent}% used
            </span>{" "}
            · {formatMoney(utilization.owed, account.currency)} of{" "}
            {formatMoney(utilization.limit, account.currency)}
          </p>
        </div>
      )}
      {statementDue && (
        <p className="mt-1 text-[11px]">
          <span className={DUE_CLASSES[dueBucketOf(statementDue, today)]}>
            {describeDueDistance(statementDue, today)}
          </span>
          <span className="text-muted-foreground">
            {" "}
            · statement · {formatDay(statementDue, "MMM d")}
          </span>
        </p>
      )}
    </div>
  );
}
