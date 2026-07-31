import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  History,
  Upload,
} from "lucide-react";

import { ImportHistory } from "@/components/health/import-history";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/db";
import { formatBytes, formatNumber } from "@/lib/utils";
import { getImportDashboard, type ImportRecency } from "@/server/health-import";
import { getHealthIntegrityReport } from "@/server/health-integrity";
import { scheduleSettingsFor } from "@/server/schedule";

export const metadata: Metadata = { title: "Imports · Health" };
export const dynamic = "force-dynamic";

function formatDateTime(date: Date): string {
  return format(date, "MMM d, yyyy · h:mm a");
}

/** "3 days ago", in the words a person would use. */
function agoLabel(daysAgo: number): string {
  if (daysAgo <= 0) return "today";
  if (daysAgo === 1) return "yesterday";
  if (daysAgo < 31) return `${daysAgo} days ago`;
  if (daysAgo < 365) return `${Math.round(daysAgo / 30)} months ago`;
  return `over a year ago`;
}

const RECENCY_NOTE: Record<ImportRecency, string> = {
  never: "Nothing imported yet",
  today: "Up to date",
  week: "Imported this week",
  month: "Imported this month",
  stale: "Worth importing a fresh export",
};

export default async function HealthImportsPage() {
  const user = await getCurrentUser();
  const today = scheduleSettingsFor(user).today;

  const [dashboard, integrity] = await Promise.all([
    getImportDashboard(user.id, today),
    getHealthIntegrityReport(user.id, today),
  ]);

  // Timestamps are formatted here, on the server, so the client component
  // renders a plain string and cannot hydrate differently.
  const batches = dashboard.batches.map((batch) => ({
    ...batch,
    importedAtLabel: formatDateTime(batch.createdAt),
    undoneAtLabel: batch.undoneAt ? formatDateTime(batch.undoneAt) : null,
  }));

  const { totals, lastSuccessful } = dashboard;

  return (
    <>
      <PageHeader
        title="Import history"
        description="Every health import this account has run — what it read, what it wrote, and what it left alone because it was yours."
        actions={
          <Button asChild size="sm">
            <Link href="/health/import">
              <Upload /> New import
            </Link>
          </Button>
        }
      />

      {dashboard.pending > 0 && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
          <p className="text-sm">
            <span className="font-medium">
              {dashboard.pending} import{dashboard.pending === 1 ? "" : "s"} waiting to be confirmed.
            </span>{" "}
            <span className="text-muted-foreground">
              Nothing has been written yet. A staged import expires on its own after two hours.
            </span>
          </p>
          <Button asChild size="sm" variant="outline">
            <Link href="/health/import">Finish it</Link>
          </Button>
        </div>
      )}

      <div className="stat-grid mb-6">
        <StatTile
          label="Last import"
          value={lastSuccessful ? agoLabel(lastSuccessful.daysAgo) : "—"}
          hint={lastSuccessful ? RECENCY_NOTE[dashboard.recency] : "No successful import yet"}
        />
        <StatTile
          label="Imports run"
          value={formatNumber(totals.runs)}
          hint={
            totals.runs === 0
              ? "nothing yet"
              : [
                  `${formatNumber(totals.completed)} active`,
                  totals.undone > 0 ? `${formatNumber(totals.undone)} undone` : null,
                  totals.failed > 0 ? `${formatNumber(totals.failed)} failed` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
          }
        />
        <StatTile
          label="Readings written"
          value={formatNumber(totals.readingsWritten)}
          hint={
            totals.readingsMerged > 0
              ? `${formatNumber(totals.readingsMerged)} merged into existing days`
              : "across every import"
          }
        />
        <StatTile
          label="Kept as yours"
          value={formatNumber(totals.readingsProtected)}
          hint="never overwritten by a re-import"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <SectionCard
            title="Import history"
            icon={History}
            accent="text-muted-foreground"
            description={
              dashboard.truncated
                ? `Newest ${formatNumber(batches.length)} of ${formatNumber(totals.runs)} · each can be undone as a unit`
                : "Newest first · each can be undone as a unit"
            }
          >
            <ImportHistory batches={batches} />
          </SectionCard>
        </div>

        <div className="space-y-6">
          <SectionCard
            title="Data integrity"
            icon={integrity.clean ? CheckCircle2 : AlertTriangle}
            accent={integrity.clean ? "text-emerald-500" : "text-amber-500"}
            description={
              integrity.clean
                ? "Every check passed"
                : `${integrity.problems > 0 ? `${integrity.problems} to look at` : ""}${
                    integrity.problems > 0 && integrity.notes > 0 ? " · " : ""
                  }${integrity.notes > 0 ? `${integrity.notes} note${integrity.notes === 1 ? "" : "s"}` : ""}`
            }
          >
            {integrity.clean ? (
              <p className="text-xs text-muted-foreground">
                Every stored reading has a metric this app knows, a unit it can read back, a
                plausible value and a date that has already happened.
              </p>
            ) : (
              <ul className="space-y-3">
                {integrity.findings.map((finding) => (
                  <li key={finding.code} className="text-sm">
                    {/* A div, not a p: Badge renders a <div>, and a block
                        element inside a <p> is invalid HTML — the parser
                        hoists it out, the DOM stops matching what the server
                        sent, and React discards the whole tree and re-renders.
                        A click landing in that window is lost, which is how
                        this surfaced: the undo button on this page stopped
                        opening its dialog. */}
                    <div className="flex items-start gap-1.5 font-medium">
                      <Badge
                        variant={finding.severity === "problem" ? "warning" : "muted"}
                        className="mt-0.5 shrink-0 text-[10px]"
                      >
                        {finding.severity === "problem" ? "Check" : "Note"}
                      </Badge>
                      <span className="min-w-0">{finding.title}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{finding.detail}</p>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          {lastSuccessful && (
            <SectionCard title="Last successful import" icon={Clock} accent="text-domain-health">
              <p className="break-all text-sm font-medium">{lastSuccessful.fileName}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {formatDateTime(lastSuccessful.at)} · {formatNumber(lastSuccessful.imported)} new
                readings
              </p>
              <dl className="mt-3 space-y-1 text-xs">
                <Row label="Workouts imported" value={formatNumber(totals.workoutsWritten)} />
                <Row label="Health records imported" value={formatNumber(totals.recordsWritten)} />
                <Row label="File data read" value={formatBytes(totals.bytesRead)} />
              </dl>
            </SectionCard>
          )}

          <SectionCard title="How re-importing works" icon={ClipboardCheck} accent="text-domain-health">
            <ul className="space-y-2 text-xs text-muted-foreground">
              <li>
                <strong className="text-foreground">Import the same file twice</strong> and the
                second run writes nothing — every reading carries a stable fingerprint.
              </li>
              <li>
                <strong className="text-foreground">Import a newer export</strong> and only what is
                genuinely new is added; a day the first export caught half-way through is merged up
                to its fuller value.
              </li>
              <li>
                <strong className="text-foreground">A reading you edited stays yours.</strong> A
                later import will not write over it — it is reported as kept, and counted above.
              </li>
              <li>
                <strong className="text-foreground">Undo is per import.</strong> It removes what
                that import wrote and still owns, and keeps anything you have since changed or built
                on.
              </li>
            </ul>
          </SectionCard>
        </div>
      </div>
    </>
  );
}

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="tabular mt-2 text-2xl font-semibold leading-none">{value}</p>
      {hint && <p className="mt-2 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular">{value}</dd>
    </div>
  );
}
