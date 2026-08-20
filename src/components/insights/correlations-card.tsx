import { ArrowDownRight, ArrowUpRight, Waypoints } from "lucide-react";
import Link from "next/link";

import { SectionCard } from "@/components/shared/section-card";
import {
  CORRELATION_VARIABLES,
  MIN_PAIRED_OBSERVATIONS,
  type CorrelationFinding,
  type CorrelationReport,
  describeEvidence,
  describeFinding,
  describeSplit,
} from "@/lib/logic/correlations";

/**
 * The correlation findings, rendered exactly as the engine's honesty rules
 * demand: correlational sentences with effect size, sample size and window
 * on every finding; links into the underlying data; and an explicit
 * "not enough data yet" state instead of fabricated insight. Suppressed
 * pairs are simply absent — no hedged almost-findings.
 */
export function CorrelationsCard({ report }: { report: CorrelationReport }) {
  return (
    <SectionCard
      title="Patterns in your data"
      icon={Waypoints}
      accent="text-domain-goal"
      description={`Associations across your last ${report.windowDays} days — correlational only, never causal. Shown only when significant after correction across all ${report.tested + report.pending.length} candidate pairs.`}
    >
      {report.findings.length === 0 ? (
        <EmptyState report={report} />
      ) : (
        <div className="space-y-2">
          {report.findings.map((finding) => (
            <FindingRow key={finding.id} finding={finding} windowDays={report.windowDays} />
          ))}
          {report.pending.length > 0 && (
            <p className="px-1 pt-1 text-xs text-muted-foreground">
              {report.pending.length} more candidate {report.pending.length === 1 ? "pair" : "pairs"}{" "}
              {report.pending.length === 1 ? "hasn't" : "haven't"} reached {MIN_PAIRED_OBSERVATIONS}{" "}
              paired days yet.
            </p>
          )}
        </div>
      )}
    </SectionCard>
  );
}

function FindingRow({
  finding,
  windowDays,
}: {
  finding: CorrelationFinding;
  windowDays: number;
}) {
  const x = CORRELATION_VARIABLES[finding.x];
  const y = CORRELATION_VARIABLES[finding.y];
  const split = describeSplit(finding);
  return (
    <div className="rounded-lg border border-l-[3px] border-l-domain-goal/60 px-3 py-2.5">
      <div className="flex items-start gap-2">
        {finding.direction === "positive" ? (
          <ArrowUpRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ArrowDownRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium">{describeFinding(finding)}</p>
          {split && <p className="text-xs text-muted-foreground">{split}</p>}
          <p className="text-xs text-muted-foreground">{describeEvidence(finding, windowDays)}</p>
          <p className="text-xs">
            <span className="text-muted-foreground">Inspect: </span>
            <Link href={x.href} className="underline underline-offset-2 hover:text-foreground">
              {x.label}
            </Link>
            <span className="text-muted-foreground"> · </span>
            <Link href={y.href} className="underline underline-offset-2 hover:text-foreground">
              {y.label}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

/** Honest and specific: what exists, what is still needed. */
function EmptyState({ report }: { report: CorrelationReport }) {
  // The pairs closest to the observation floor, so "what is still needed"
  // is concrete rather than a shrug.
  const nearest = [...report.pending].sort((a, b) => b.n - a.n).slice(0, 4);
  return (
    <div className="rounded-lg border border-dashed px-4 py-5 text-sm text-muted-foreground">
      {report.tested > 0 ? (
        <p>
          {report.tested} candidate {report.tested === 1 ? "pair has" : "pairs have"} enough data,
          but no association is strong enough to clear the significance bar right now — nothing is
          shown rather than showing weak patterns.
        </p>
      ) : (
        <p>
          Not enough data yet. Each pattern needs {MIN_PAIRED_OBSERVATIONS} days where both
          measurements exist; keep logging and this fills in on its own.
        </p>
      )}
      {nearest.length > 0 && report.tested === 0 && (
        <ul className="mt-3 space-y-1 text-xs">
          {nearest.map((pending) => (
            <li key={pending.id} className="flex items-center justify-between gap-3">
              <span>
                {CORRELATION_VARIABLES[pending.x].label} ↔ {CORRELATION_VARIABLES[pending.y].label}
                {pending.lag > 0 ? " (next day)" : ""}
              </span>
              <span className="tabular shrink-0">
                {pending.n} of {MIN_PAIRED_OBSERVATIONS} days
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
