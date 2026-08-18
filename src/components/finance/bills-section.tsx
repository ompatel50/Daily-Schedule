"use client";

import * as React from "react";
import { Archive, CalendarClock, Pencil, Plus, Repeat, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { SectionCard } from "@/components/shared/section-card";
import { RowMenu } from "@/components/finance/row-menu";
import type { BillRowView } from "@/components/finance/bill-dialog";
import { formatDay } from "@/lib/date";
import { BILL_RECURRENCE_META, type BillRecurrence } from "@/lib/enums";
import { describeDueDistance } from "@/lib/logic/due";
import { formatMoney } from "@/lib/logic/finance";
import type { RecurringSuggestion } from "@/lib/logic/recurring-detect";
import { pluralize } from "@/lib/utils";

/** How urgent a due date reads: overdue red, this fortnight amber, later quiet. */
const DUE_CLASSES: Record<BillRowView["bucket"], string> = {
  overdue: "font-medium text-red-700 dark:text-red-400",
  today: "font-medium text-amber-800 dark:text-amber-400",
  soon: "font-medium text-amber-800 dark:text-amber-400",
  later: "text-muted-foreground",
};

/** Bills & subscriptions, most urgent first. */
export function BillsSection({
  bills,
  suggestions,
  currency,
  today,
  onNew,
  onMarkPaid,
  onEdit,
  onArchive,
  onDelete,
  onTrackSuggestion,
  onDismissSuggestion,
}: {
  bills: BillRowView[];
  /** Recurring-cost patterns worth tracking as bills — accept or dismiss. */
  suggestions: RecurringSuggestion[];
  currency: string;
  today: string;
  onNew: () => void;
  onMarkPaid: (bill: BillRowView) => void;
  onEdit: (bill: BillRowView) => void;
  onArchive: (bill: BillRowView) => void;
  onDelete: (bill: BillRowView) => void;
  /** Open the bill dialog pre-filled from this suggestion. */
  onTrackSuggestion: (suggestion: RecurringSuggestion) => void;
  /** Never offer this payee again. */
  onDismissSuggestion: (suggestion: RecurringSuggestion) => void;
}) {
  return (
    <SectionCard
      title="Bills & subscriptions"
      icon={CalendarClock}
      accent="text-domain-finance"
      description="Most urgent first"
      action={
        <Button size="sm" variant="ghost" onClick={onNew}>
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
            <Button size="sm" onClick={onNew}>
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
              onMarkPaid={() => onMarkPaid(bill)}
              onEdit={() => onEdit(bill)}
              onArchive={() => onArchive(bill)}
              onDelete={() => onDelete(bill)}
            />
          ))}
        </div>
      )}

      {suggestions.length > 0 && (
        <div className="mt-3 space-y-2 border-t pt-3">
          <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Repeat className="h-3 w-3" aria-hidden="true" /> Looks recurring
          </p>
          {suggestions.map((suggestion) => (
            <div
              key={suggestion.payeeKey}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-dashed px-3 py-2"
            >
              <div className="min-w-0 flex-[1_1_10rem]">
                <p className="truncate text-sm font-medium">{suggestion.payee}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {formatMoney(suggestion.amount, currency)}{" "}
                  {suggestion.cadence === "weekly"
                    ? "every week"
                    : suggestion.cadence === "monthly"
                      ? "every month"
                      : "every year"}{" "}
                  · seen {suggestion.count} {pluralize(suggestion.count, "time")} · next around{" "}
                  {formatDay(suggestion.nextDueDate, "MMM d")}
                </p>
              </div>
              <div className="ml-auto flex items-center gap-1">
                <Button size="sm" variant="outline" onClick={() => onTrackSuggestion(suggestion)}>
                  <Plus /> Track as bill
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="touch-target"
                  aria-label={`Don't suggest tracking ${suggestion.payee}`}
                  onClick={() => onDismissSuggestion(suggestion)}
                >
                  <X />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
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
    // Phone widths can't fit name + amount + two controls on one line; the
    // basis lets the trailing cluster wrap under the name, right-aligned.
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2">
      <div className="min-w-0 flex-[1_1_10rem]">
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
      <div className="ml-auto flex items-center gap-3">
        <span className="tabular text-sm font-semibold">
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
    </div>
  );
}
