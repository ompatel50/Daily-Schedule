"use client";

import * as React from "react";
import { BarChart3, MoveDownRight, MoveUpRight } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { SectionCard } from "@/components/shared/section-card";
import type { CategoryDelta } from "@/lib/logic/finance";
import { formatMoney } from "@/lib/logic/finance";
import { cn } from "@/lib/utils";

/** The month card's summary numbers, serialised flat for the client. */
export interface MonthTotalsView {
  income: number;
  spending: number;
  net: number;
  count: number;
}

const TOP_MOVER_COUNT = 5;

/**
 * Month over month: this month's totals against last month's, and the
 * categories whose spending moved the most. Same arithmetic as the summary
 * cards (summarizeTransactions / compareSpendingByCategory) over the two
 * calendar-month slices.
 */
export function MonthlyReportSection({
  month,
  previousMonth,
  deltas,
  currency,
}: {
  month: MonthTotalsView;
  previousMonth: MonthTotalsView;
  deltas: CategoryDelta[];
  currency: string;
}) {
  const movers = deltas.filter((delta) => delta.delta !== 0).slice(0, TOP_MOVER_COUNT);
  const spendingDelta = month.spending - previousMonth.spending;
  const incomeDelta = month.income - previousMonth.income;
  const empty = month.count === 0 && previousMonth.count === 0;

  return (
    <SectionCard
      title="Month over month"
      icon={BarChart3}
      accent="text-domain-finance"
      description="This calendar month against the last"
    >
      {empty ? (
        <EmptyState
          icon={BarChart3}
          title="Nothing to compare yet"
          description="Record or import two months of transactions and the movement shows up here."
          className="py-6"
        />
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <TotalsTile
              label="Spending"
              current={month.spending}
              previous={previousMonth.spending}
              delta={spendingDelta}
              currency={currency}
              // Spending going UP is the bad direction.
              deltaTone={spendingDelta > 0 ? "bad" : spendingDelta < 0 ? "good" : "flat"}
            />
            <TotalsTile
              label="Income"
              current={month.income}
              previous={previousMonth.income}
              delta={incomeDelta}
              currency={currency}
              deltaTone={incomeDelta > 0 ? "good" : incomeDelta < 0 ? "bad" : "flat"}
            />
          </div>

          {movers.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Top movers
              </p>
              <ul className="space-y-1">
                {movers.map((mover) => (
                  <li
                    key={mover.category}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <span className="min-w-0 truncate">{mover.label}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="tabular text-muted-foreground">
                        {formatMoney(mover.previous, currency)} →{" "}
                        {formatMoney(mover.current, currency)}
                      </span>
                      <DeltaChip delta={mover.delta} currency={currency} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}

function TotalsTile({
  label,
  current,
  previous,
  delta,
  currency,
  deltaTone,
}: {
  label: string;
  current: number;
  previous: number;
  delta: number;
  currency: string;
  deltaTone: "good" | "bad" | "flat";
}) {
  return (
    <div className="rounded-lg border px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="tabular mt-0.5 text-lg font-semibold">{formatMoney(current, currency)}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        <span className="tabular">{formatMoney(previous, currency)}</span> last month
        {delta !== 0 && (
          <>
            {" · "}
            <span
              className={cn(
                "tabular font-medium",
                deltaTone === "bad" && "text-red-700 dark:text-red-400",
                deltaTone === "good" && "text-emerald-700 dark:text-emerald-400",
              )}
            >
              {delta > 0 ? "+" : "−"}
              {formatMoney(Math.abs(delta), currency)}
            </span>
          </>
        )}
      </p>
    </div>
  );
}

function DeltaChip({ delta, currency }: { delta: number; currency: string }) {
  const up = delta > 0;
  return (
    <span
      className={cn(
        "tabular inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-medium",
        up
          ? "bg-red-500/10 text-red-700 dark:text-red-400"
          : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
      )}
      title={up ? "Spending grew" : "Spending shrank"}
    >
      {up ? (
        <MoveUpRight className="h-3 w-3" aria-hidden="true" />
      ) : (
        <MoveDownRight className="h-3 w-3" aria-hidden="true" />
      )}
      {up ? "+" : "−"}
      {formatMoney(Math.abs(delta), currency)}
    </span>
  );
}
