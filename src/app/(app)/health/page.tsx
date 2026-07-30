import type { Metadata } from "next";
import { format } from "date-fns";
import {
  Activity,
  Droplets,
  Flame,
  HeartPulse,
  History,
  Moon,
  PencilLine,
  Scale,
  Upload,
} from "lucide-react";

import { ImportHistory } from "@/components/health/import-history";
import { ImportWizard } from "@/components/health/import-wizard";
import { MetricEntry } from "@/components/health/metric-entry";
import { TrendAreaChart, TrendLineChart } from "@/components/shared/charts";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatCard } from "@/components/shared/stat-card";
import { Badge } from "@/components/ui/badge";
import { formatDay } from "@/lib/date";
import { SLEEP_STAGE_META, type SleepStage } from "@/lib/logic/health";
import { formatNumber } from "@/lib/utils";
import { getCurrentUser } from "@/lib/db";
import { getHealthOverview, type MetricToday } from "@/server/health";
import { listImportBatches } from "@/server/health-import";

export const metadata: Metadata = { title: "Health" };
export const dynamic = "force-dynamic";

function formatDateTime(date: Date): string {
  return format(date, "MMM d, yyyy · h:mm a");
}

export default async function HealthPage() {
  const user = await getCurrentUser();
  const [overview, rawBatches] = await Promise.all([
    getHealthOverview(),
    listImportBatches(user.id),
  ]);
  // Timestamps are formatted here, on the server, so the client component
  // renders a plain string and cannot hydrate differently.
  const batches = rawBatches.map((batch) => ({
    ...batch,
    importedAtLabel: formatDateTime(batch.createdAt),
  }));

  const byType = new Map(overview.today.map((metric) => [metric.type, metric]));
  const trendByType = new Map(overview.trends.map((trend) => [trend.type, trend]));

  const chartData = (type: string, key: string) =>
    (trendByType.get(type as never)?.days30 ?? []).map((point) => ({
      label: formatDay(point.date, "M/d"),
      [key]: point.value,
    }));

  const sleepHrData = (trendByType.get("sleep_hours")?.days30 ?? []).map((point, index) => ({
    label: formatDay(point.date, "M/d"),
    sleep: point.value,
    hr: trendByType.get("resting_hr")?.days30[index]?.value ?? null,
  }));

  const weightTrend = trendByType.get("body_weight");
  const sleep = byType.get("sleep_hours");

  const statValue = (metric: MetricToday | undefined) =>
    metric?.value !== null && metric?.value !== undefined
      ? `${formatNumber(metric.value, metric.decimals)}${metric.unit ? ` ${metric.unit}` : ""}`
      : "—";
  const statHint = (metric: MetricToday | undefined) =>
    metric && metric.sources.length > 0 ? metric.sources.join(" · ") : "nothing logged today";

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Health"
        description="Today's metrics, trends, manual entry and imports — everything stays on this machine."
      />

      <div className="stat-grid mb-6">
        <StatCard
          label="Steps today"
          value={statValue(byType.get("steps"))}
          hint={statHint(byType.get("steps"))}
          icon={Activity}
          accent="text-domain-habit"
        />
        <StatCard
          label="Active calories"
          value={statValue(byType.get("active_calories"))}
          hint={statHint(byType.get("active_calories"))}
          icon={Flame}
          accent="text-domain-workout"
        />
        <StatCard
          label="Sleep"
          value={statValue(sleep)}
          hint={statHint(sleep)}
          icon={Moon}
          accent="text-domain-planner"
        />
        <StatCard
          label="Resting HR"
          value={statValue(byType.get("resting_hr"))}
          hint={statHint(byType.get("resting_hr"))}
          icon={HeartPulse}
          accent="text-domain-health"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <SectionCard
            title="Today"
            icon={Activity}
            accent="text-domain-health"
            description={`${formatDay(overview.date, "EEEE, MMMM d")} — each value says where it came from`}
          >
            {overview.today.every((metric) => metric.value === null) ? (
              <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                Nothing logged today yet. Log a value below, or import a health export to fill the
                last months in one go.
              </p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {overview.today
                  .filter((metric) => metric.value !== null)
                  .map((metric) => (
                    <div key={metric.type} className="rounded-lg border p-3">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="text-sm text-muted-foreground">{metric.label}</p>
                        <p className="tabular text-base font-semibold">
                          {formatNumber(metric.value!, metric.decimals)}
                          {metric.unit && (
                            <span className="ml-1 text-xs font-normal text-muted-foreground">
                              {metric.unit}
                            </span>
                          )}
                        </p>
                      </div>
                      {metric.type === "heart_rate" && metric.min !== null && metric.max !== null && (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          range {metric.min}–{metric.max} bpm
                        </p>
                      )}
                      {metric.stages && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {metric.stages.map((entry) => (
                            <Badge key={entry.stage} variant="muted" className="text-[10px]">
                              {SLEEP_STAGE_META[entry.stage as SleepStage]?.label ?? entry.stage}{" "}
                              {formatNumber(entry.hours, 1)}h
                            </Badge>
                          ))}
                        </div>
                      )}
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {metric.sources.map((source) => (
                          <Badge key={source} variant="outline" className="text-[10px]">
                            {source}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </SectionCard>

          <SectionCard title="Steps" icon={Activity} accent="text-domain-habit" description="Last 30 days">
            <TrendAreaChart
              data={chartData("steps", "steps")}
              dataKey="steps"
              color="hsl(var(--domain-habit))"
              height={170}
            />
          </SectionCard>

          <div className="grid gap-6 md:grid-cols-2">
            <SectionCard title="Sleep & resting HR" icon={Moon} accent="text-domain-planner" description="Last 30 days">
              <TrendLineChart
                data={sleepHrData}
                height={170}
                lines={[
                  { dataKey: "sleep", name: "Sleep (h)", color: "hsl(var(--domain-planner))" },
                  { dataKey: "hr", name: "Resting HR", color: "hsl(var(--destructive))" },
                ]}
              />
            </SectionCard>

            <SectionCard
              title="Body weight"
              icon={Scale}
              accent="text-domain-health"
              description={`Last 30 days (${weightTrend?.unit ?? "kg"})`}
            >
              <TrendLineChart
                data={chartData("body_weight", "weight")}
                height={170}
                lines={[
                  { dataKey: "weight", name: "Weight", color: "hsl(var(--domain-health))" },
                ]}
              />
            </SectionCard>
          </div>

          <SectionCard
            title="7 vs 30 days"
            icon={Droplets}
            accent="text-domain-planner"
            description="Daily averages — a quick read on which way things are moving"
          >
            <div className="grid gap-1.5 sm:grid-cols-2">
              {overview.trends
                .filter((trend) => trend.average30 !== null)
                .map((trend) => (
                  <div key={trend.type} className="flex items-center justify-between gap-3 border-b pb-1.5 text-sm last:border-0 sm:[&:nth-last-child(2)]:border-0">
                    <span className="text-muted-foreground">{trend.label}</span>
                    <span className="tabular">
                      {trend.average7 !== null ? formatNumber(trend.average7, trend.decimals) : "—"}
                      <span className="mx-1 text-xs text-muted-foreground">vs</span>
                      {formatNumber(trend.average30!, trend.decimals)}
                      {trend.unit && (
                        <span className="ml-1 text-xs text-muted-foreground">{trend.unit}</span>
                      )}
                    </span>
                  </div>
                ))}
            </div>
            {overview.trends.every((trend) => trend.average30 === null) && (
              <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                Trends appear after a few days of data.
              </p>
            )}
          </SectionCard>
        </div>

        <div className="space-y-6">
          <SectionCard title="Log health data" icon={PencilLine} accent="text-domain-health">
            <MetricEntry date={overview.date} unitSystem={overview.unitSystem} withDetails />
          </SectionCard>

          <SectionCard
            title="Import"
            icon={Upload}
            accent="text-domain-planner"
            description="Apple Health export or CSV — previewed before anything is saved"
          >
            <ImportWizard />
          </SectionCard>

          <SectionCard
            title="Import history"
            icon={History}
            accent="text-muted-foreground"
            description="Each import can be removed again as a unit"
          >
            <ImportHistory batches={batches} />
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
