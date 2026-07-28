"use client";

import * as React from "react";
import { CheckCircle2, CircleDashed, Clock, Info, MinusCircle, XCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import {
  EXCLUSION_LABELS,
  type DayScore,
  type ExclusionReason,
  type ScoreOpportunity,
} from "@/lib/logic/day-score";
import { formatDayLong } from "@/lib/date";
import { cn } from "@/lib/utils";

/**
 * "Why is my day score what it is?" — answered in full.
 *
 * Every applicable opportunity, every excluded record with its reason, and the
 * formula that combined them. A score the user cannot interrogate is a score
 * they cannot trust, and rest-day exclusions are exactly the thing people need
 * to see spelled out.
 */
export function ScoreExplanation({
  score,
  trigger,
}: {
  score: DayScore;
  trigger?: React.ReactNode;
}) {
  const grouped = React.useMemo(() => groupExclusions(score.exclusions), [score.exclusions]);

  return (
    <Dialog>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="ghost" size="sm" className="gap-1.5">
            <Info className="h-3.5 w-3.5" />
            Why this score?
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Day score · {score.score === null ? "No score" : `${score.score}%`}
          </DialogTitle>
          <DialogDescription>{formatDayLong(score.date)}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <p className="rounded-lg bg-muted/60 px-3 py-2.5 text-sm">{score.explanation}</p>

          {score.hasApplicable ? (
            <>
              <section className="space-y-3">
                <h3 className="section-title">Categories</h3>
                {score.categories
                  .filter((category) => category.applicable > 0)
                  .map((category) => (
                    <div key={category.category} className="rounded-lg border p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{category.label}</span>
                          <Badge variant="outline" className="text-[10px]">
                            weight {Math.round(category.weight)}%
                          </Badge>
                        </div>
                        <span className="tabular text-sm font-semibold">{category.percent}%</span>
                      </div>

                      <Progress value={category.percent ?? 0} className="mt-2 h-1.5" />

                      <p className="mt-2 text-xs text-muted-foreground">{category.explanation}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {category.pointsEarned} of {category.pointsAvailable} points
                      </p>

                      <ul className="mt-2 space-y-1">
                        {category.opportunities.map((opportunity) => (
                          <li
                            key={`${category.category}-${opportunity.id}`}
                            className="flex items-start gap-2 text-xs"
                          >
                            <OpportunityIcon opportunity={opportunity} />
                            <span className="min-w-0 flex-1">
                              <span className={cn(opportunity.met && "text-muted-foreground")}>
                                {opportunity.label}
                              </span>
                              <span className="block text-muted-foreground">
                                {opportunity.detail}
                              </span>
                            </span>
                            <span className="tabular shrink-0 text-muted-foreground">
                              {formatCredit(opportunity.credit)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
              </section>

              <section className="grid gap-2 sm:grid-cols-4">
                <Tally label="Applicable" value={score.totals.applicable} />
                <Tally label="Met" value={score.totals.completed} />
                <Tally label="Missed" value={score.totals.missed} />
                <Tally label="Still open" value={score.totals.pending} />
              </section>
            </>
          ) : (
            <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
              Nothing was scheduled for this day. An open day has no score — it is not a zero, and
              it does not affect your averages.
            </p>
          )}

          {score.exclusions.length > 0 && (
            <section className="space-y-2">
              <h3 className="section-title">
                Excluded from the score ({score.exclusions.length})
              </h3>
              <p className="text-xs text-muted-foreground">
                These were not counted, and not counted against you either.
              </p>
              {Object.entries(grouped).map(([reason, items]) => (
                <div key={reason} className="rounded-lg border border-dashed p-3">
                  <p className="text-xs font-medium">
                    {EXCLUSION_LABELS[reason as ExclusionReason]} · {items.length}
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {items.map((exclusion) => (
                      <li
                        key={`${exclusion.category}-${exclusion.id}`}
                        className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground"
                      >
                        <span className="truncate">{exclusion.label}</span>
                        <span className="shrink-0">{exclusion.detail}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          )}

          <section className="rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
            <p className="mb-1 font-medium text-foreground">How the score is calculated</p>
            <p>
              Each category scores the points it earned out of the points it offered. Categories
              with nothing applicable are left out entirely, and the remaining ones are combined
              {score.categories.filter((category) => category.applicable > 0).length > 1
                ? " using the weights shown above"
                : ""}
              . Partial credit is given only where a partial amount is genuinely partial progress —
              120 g toward a 160 g protein target counts as 75%, while a habit or a task is done or
              it is not.
            </p>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function OpportunityIcon({ opportunity }: { opportunity: ScoreOpportunity }) {
  if (opportunity.met) {
    return (
      <CheckCircle2
        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500"
        aria-label="Met"
      />
    );
  }
  if (opportunity.pending) {
    return <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Still open" />;
  }
  if (opportunity.credit > 0) {
    return (
      <CircleDashed className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-label="Partly done" />
    );
  }
  if (opportunity.status === "skipped") {
    return <MinusCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-label="Skipped" />;
  }
  return <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500/70" aria-label="Missed" />;
}

function Tally({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-muted/50 px-3 py-2 text-center">
      <p className="tabular text-lg font-semibold leading-none">{value}</p>
      <p className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  );
}

function formatCredit(credit: number): string {
  if (credit >= 1) return "1.0";
  if (credit <= 0) return "0.0";
  return credit.toFixed(1);
}

function groupExclusions(exclusions: DayScore["exclusions"]) {
  const grouped: Record<string, DayScore["exclusions"]> = {};
  for (const exclusion of exclusions) {
    grouped[exclusion.reason] = [...(grouped[exclusion.reason] ?? []), exclusion];
  }
  return grouped;
}
