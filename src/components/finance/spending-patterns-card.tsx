import { ArrowDownRight, ArrowUpRight, Waypoints } from "lucide-react";
import Link from "next/link";

import { SectionCard } from "@/components/shared/section-card";
import { formatCents } from "@/lib/logic/money";
import {
  MIN_PAIRED_OBSERVATIONS,
  CORRELATION_WINDOW_DAYS,
} from "@/lib/logic/correlations";
import {
  SPENDING_CONTEXTS,
  SPENDING_TRACKED_MIN_DAYS,
  type SpendingFinding,
  type SpendingReport,
  describeSpendingEvidence,
  describeSpendingFinding,
  describeSpendingSplit,
} from "@/lib/logic/spending";

/**
 * Spending patterns, rendered under the engine's rules: correlational
 * sentences with effect size and sample size, links into the data, honest
 * untracked / not-enough-data states — and strictly descriptive copy.
 * Nothing here moralises about spending or offers savings advice; the app
 * is not a financial advisor and must never present itself as one.
 */
export function SpendingPatternsCard({
  report,
  currency,
}: {
  report: SpendingReport;
  currency: string;
}) {
  return (
    <SectionCard
      title="Spending patterns"
      icon={Waypoints}
      accent="text-domain-finance"
      description={`How spending moved with the rest of your days over the last ${report.windowDays} days — descriptive associations in your own ledger, never causes and never advice.`}
    >
      {report.untracked ? (
        <p className="rounded-lg border border-dashed px-4 py-5 text-sm text-muted-foreground">
          Not enough ledger history yet: patterns need at least {SPENDING_TRACKED_MIN_DAYS} days
          with a recorded transaction in the last {CORRELATION_WINDOW_DAYS} days
          {report.trackedDays > 0 ? ` (currently ${report.trackedDays})` : ""}. Keep recording and
          this fills in on its own.
        </p>
      ) : report.findings.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-5 text-sm text-muted-foreground">
          {report.tested > 0
            ? `${report.tested} context pairs have enough data (${report.trackedDays} ledger days), but no association clears the significance bar right now — nothing is shown rather than weak patterns.`
            : `Each pattern needs ${MIN_PAIRED_OBSERVATIONS} paired days; keep recording and this fills in on its own.`}
        </p>
      ) : (
        <div className="space-y-2">
          {report.findings.map((finding) => (
            <FindingRow
              key={`${finding.context}:${finding.target.key}`}
              finding={finding}
              windowDays={report.windowDays}
              currency={currency}
            />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function FindingRow({
  finding,
  windowDays,
  currency,
}: {
  finding: SpendingFinding;
  windowDays: number;
  currency: string;
}) {
  const context = SPENDING_CONTEXTS[finding.context];
  const split = describeSpendingSplit(finding, (cents) => formatCents(cents, currency));
  return (
    <div className="rounded-lg border border-l-[3px] border-l-domain-finance/60 px-3 py-2.5">
      <div className="flex items-start gap-2">
        {finding.direction === "positive" ? (
          <ArrowUpRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ArrowDownRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium">{describeSpendingFinding(finding)}</p>
          {split && <p className="text-xs text-muted-foreground">{split}</p>}
          <p className="text-xs text-muted-foreground">
            {describeSpendingEvidence(finding, windowDays)}
          </p>
          <p className="text-xs">
            <span className="text-muted-foreground">Inspect: </span>
            <Link href="/finance" className="underline underline-offset-2 hover:text-foreground">
              {finding.target.label}
            </Link>
            <span className="text-muted-foreground"> · </span>
            <Link
              href={context.href}
              className="underline underline-offset-2 hover:text-foreground"
            >
              {context.label}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
