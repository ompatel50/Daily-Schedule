import type { Metadata } from "next";
import Link from "next/link";
import {
  Activity,
  Brain,
  Dumbbell,
  Flame,
  HeartPulse,
  History,
  Moon,
  PencilLine,
  Scale,
  Stethoscope,
  Upload,
  Utensils,
} from "lucide-react";

import { MetricEntry } from "@/components/health/metric-entry";
import { ChangeBadge } from "@/components/health/metric-panel";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatCard } from "@/components/shared/stat-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDay, relativeDayLabel } from "@/lib/date";
import { SLEEP_STAGE_META, type SleepStage } from "@/lib/logic/health";
import { formatNumber } from "@/lib/utils";
import { getHealthDashboard, type OverviewMetric } from "@/server/health-module";

export const metadata: Metadata = { title: "Health" };
export const dynamic = "force-dynamic";

const GROUP_ICONS: Record<string, typeof Activity> = {
  activity: Activity,
  sleep: Moon,
  heart: HeartPulse,
  body: Scale,
  respiratory: Activity,
  nutrition: Utensils,
  vitals: Stethoscope,
  mind: Brain,
};

function statValue(metric: OverviewMetric | undefined): string {
  if (!metric || metric.value === null) return "—";
  return `${formatNumber(metric.value, metric.decimals)}${metric.unit ? ` ${metric.unit}` : ""}`;
}

function statHint(metric: OverviewMetric | undefined): string {
  if (!metric) return "";
  if (metric.value === null) {
    return metric.average30 !== null
      ? `30-day average ${formatNumber(metric.average30, metric.decimals)}`
      : "nothing logged today";
  }
  return metric.sources.length > 0 ? metric.sources.join(" · ") : "logged today";
}

/**
 * The direction-of-travel badge on a headline tile.
 *
 * `StatCard` colours a delta by sign, so a metric where *down* is better —
 * resting heart rate — has to say so or a falling number reads as bad news.
 * Neutral metrics show no delta at all rather than an arrow with no meaning.
 */
function statDelta(metric: OverviewMetric | undefined): {
  delta?: number;
  deltaInverted?: boolean;
} {
  if (!metric || metric.changePercent === null || metric.goodDirection === "neutral") return {};
  return { delta: metric.changePercent, deltaInverted: metric.goodDirection === "down" };
}

/** "3 days ago", in the words a person would use. */
function agoLabel(daysAgo: number): string {
  if (daysAgo <= 0) return "today";
  if (daysAgo === 1) return "yesterday";
  if (daysAgo < 31) return `${daysAgo} days ago`;
  if (daysAgo < 365) return `${Math.round(daysAgo / 30)} months ago`;
  return "over a year ago";
}

/** The subpages worth one click from the overview, in the section's own order. */
const QUICK_LINKS = [
  { href: "/health/activity", label: "Activity" },
  { href: "/health/sleep", label: "Sleep" },
  { href: "/health/heart", label: "Heart" },
  { href: "/health/body", label: "Body" },
  { href: "/health/trends", label: "Trends" },
  { href: "/health/imports", label: "Imports" },
] as const;

export default async function HealthPage() {
  const dashboard = await getHealthDashboard();
  const headline = new Map(dashboard.headline.map((metric) => [metric.type, metric]));

  if (!dashboard.hasAnyData) {
    return (
      <>
        <PageHeader
          title="Health"
          description="Activity, sleep, heart, body, nutrition and vitals — private to your account."
        />
        <div className="grid gap-6 lg:grid-cols-3">
          <EmptyState
            className="lg:col-span-2"
            icon={HeartPulse}
            title="No health data yet"
            description="Import an Apple Health export to fill in years of history in one go, or log a value by hand to start today."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button asChild>
                  <Link href="/health/import">Import Apple Health export</Link>
                </Button>
                <Button asChild variant="outline">
                  <Link href="/settings">Load sample data</Link>
                </Button>
              </div>
            }
          />
          {/* Deliberately offered even with nothing logged: an empty account
              still needs somewhere to start, and hiding the form behind an
              import would make the first entry the hardest one. */}
          <SectionCard title="Log health data" icon={PencilLine} accent="text-domain-health">
            <MetricEntry date={dashboard.date} unitSystem={dashboard.unitSystem} withDetails />
          </SectionCard>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Health"
        description={[
          formatDay(dashboard.date, "EEEE, MMMM d"),
          `${formatNumber(dashboard.totalMetrics)} readings`,
          dashboard.earliestDay ? `since ${formatDay(dashboard.earliestDay, "MMM yyyy")}` : null,
          `${dashboard.activeDays}/30 recent days with data`,
        ]
          .filter(Boolean)
          .join(" · ")}
        actions={
          <Button asChild size="sm">
            <Link href="/health/import">
              <Upload /> Import
            </Link>
          </Button>
        }
      />

      {/* One click to anywhere in the section, without going via the tab bar.
          Wraps and scrolls with the viewport rather than overflowing it. */}
      <nav aria-label="Health shortcuts" className="mb-6 flex flex-wrap gap-2">
        {QUICK_LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="rounded-lg border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {link.label}
          </Link>
        ))}
      </nav>

      <div className="stat-grid mb-6">
        <StatCard
          label="Steps today"
          value={statValue(headline.get("steps"))}
          hint={statHint(headline.get("steps"))}
          icon={Activity}
          accent="text-domain-habit"
          href="/health/activity"
          {...statDelta(headline.get("steps"))}
        />
        <StatCard
          label="Active calories"
          value={statValue(headline.get("active_calories"))}
          hint={statHint(headline.get("active_calories"))}
          icon={Flame}
          accent="text-domain-workout"
          href="/health/activity"
          {...statDelta(headline.get("active_calories"))}
        />
        <StatCard
          label="Sleep"
          value={statValue(headline.get("sleep_hours"))}
          hint={statHint(headline.get("sleep_hours"))}
          icon={Moon}
          accent="text-domain-planner"
          href="/health/sleep"
          {...statDelta(headline.get("sleep_hours"))}
        />
        <StatCard
          label="Resting HR"
          value={statValue(headline.get("resting_hr"))}
          hint={statHint(headline.get("resting_hr"))}
          icon={HeartPulse}
          accent="text-domain-health"
          href="/health/heart"
          {...statDelta(headline.get("resting_hr"))}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <div className="grid gap-4 sm:grid-cols-2">
            {dashboard.groups.map((group) => {
              const Icon = GROUP_ICONS[group.group] ?? Activity;
              const withValues = group.metrics.filter(
                (metric) => metric.value !== null || metric.average30 !== null,
              );
              return (
                <SectionCard
                  key={group.group}
                  title={group.label}
                  icon={Icon}
                  accent="text-domain-health"
                  action={
                    <Link
                      href={`/health/${group.slug}`}
                      className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                    >
                      Open
                    </Link>
                  }
                >
                  {withValues.length === 0 ? (
                    <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
                      Nothing recorded in the last 30 days.
                    </p>
                  ) : (
                    <dl className="space-y-1.5">
                      {withValues.map((metric) => (
                        <div
                          key={metric.type}
                          className="flex items-baseline justify-between gap-3 border-b pb-1.5 text-sm last:border-0 last:pb-0"
                        >
                          {/* Wraps instead of truncating: "Dietary calories"
                              and "Blood pressure" both lose their meaning at
                              the width these cards take on a narrow window. */}
                          <dt className="min-w-0 text-muted-foreground">{metric.label}</dt>
                          <dd className="tabular shrink-0 text-right">
                            {metric.value !== null
                              ? formatNumber(metric.value, metric.decimals)
                              : formatNumber(metric.average30 ?? 0, metric.decimals)}
                            {metric.unit && (
                              <span className="ml-1 text-xs text-muted-foreground">
                                {metric.unit}
                              </span>
                            )}
                            {metric.value === null && (
                              <span className="ml-1 text-[10px] text-muted-foreground">avg</span>
                            )}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </SectionCard>
              );
            })}
          </div>

          <SectionCard
            title="Last night"
            icon={Moon}
            accent="text-domain-planner"
            description="Derived from the sleep stages your device recorded"
            action={
              <Link
                href="/health/sleep"
                className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                All nights
              </Link>
            }
          >
            {dashboard.sleep ? (
              <div>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="tabular text-2xl font-semibold leading-none">
                    {formatNumber(dashboard.sleep.asleepHours, 1)}
                    <span className="ml-1 text-sm font-normal text-muted-foreground">h asleep</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {relativeDayLabel(dashboard.sleep.date, dashboard.date)}
                    {dashboard.sleep.inBedHours !== null &&
                      ` · ${formatNumber(dashboard.sleep.inBedHours, 1)}h in bed`}
                    {` · ${dashboard.sleep.source}`}
                  </p>
                </div>
                {dashboard.sleep.stages.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {dashboard.sleep.stages.map((entry) => (
                      <Badge key={entry.stage} variant="muted" className="text-[10px]">
                        {SLEEP_STAGE_META[entry.stage as SleepStage]?.label ?? entry.stage}{" "}
                        {formatNumber(entry.hours, 1)}h
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <p className="rounded-lg border border-dashed px-3 py-5 text-center text-xs text-muted-foreground">
                No sleep recorded in the last 30 days.
              </p>
            )}
          </SectionCard>

          <SectionCard
            title="Recent workouts"
            icon={Dumbbell}
            accent="text-domain-workout"
            action={
              <Link
                href="/health/workouts"
                className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                All workouts
              </Link>
            }
          >
            {dashboard.workouts.length === 0 ? (
              <p className="rounded-lg border border-dashed px-3 py-5 text-center text-xs text-muted-foreground">
                No workouts in the last 90 days.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {dashboard.workouts.map((workout) => (
                  <li
                    key={workout.id}
                    className="flex items-baseline justify-between gap-3 border-b pb-1.5 text-sm last:border-0 last:pb-0"
                  >
                    <span className="min-w-0 truncate">
                      {workout.name}
                      <span className="ml-2 text-xs text-muted-foreground">
                        {relativeDayLabel(workout.date, dashboard.date)}
                      </span>
                    </span>
                    <span className="tabular shrink-0 text-xs text-muted-foreground">
                      {workout.durationMin} min
                      {workout.distanceKm !== null && ` · ${formatNumber(workout.distanceKm, 1)} km`}
                      {workout.caloriesBurned !== null && ` · ${workout.caloriesBurned} kcal`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>

        <div className="space-y-6">
          <SectionCard
            title="Latest trends"
            icon={Activity}
            accent="text-domain-health"
            description="Last 15 days vs the 15 before them"
            action={
              <Link
                href="/health/trends"
                className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                All trends
              </Link>
            }
          >
            {dashboard.headline.every((metric) => metric.changePercent === null) ? (
              <p className="rounded-lg border border-dashed px-3 py-5 text-center text-xs text-muted-foreground">
                Trends appear after a few days of data.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {dashboard.headline
                  .filter((metric) => metric.changePercent !== null)
                  .map((metric) => (
                    <li
                      key={metric.type}
                      className="flex items-center justify-between gap-3 border-b pb-1.5 text-sm last:border-0 last:pb-0"
                    >
                      <span className="truncate text-muted-foreground">{metric.label}</span>
                      <ChangeBadge
                        change={metric.changePercent}
                        goodDirection={metric.goodDirection}
                        compact
                      />
                    </li>
                  ))}
              </ul>
            )}
          </SectionCard>

          {dashboard.recordCounts.length > 0 && (
            <SectionCard
              title="Health records"
              icon={Stethoscope}
              accent="text-domain-health"
              description="ECGs, medications, clinical records and routes"
              action={
                <Link
                  href="/health/vitals"
                  className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  Open
                </Link>
              }
            >
              <ul className="space-y-1.5 text-sm">
                {dashboard.recordCounts.map((entry) => (
                  <li key={entry.kind} className="flex justify-between gap-3">
                    <span className="text-muted-foreground">{entry.label}</span>
                    <span className="tabular">{formatNumber(entry.count)}</span>
                  </li>
                ))}
              </ul>
            </SectionCard>
          )}

          <SectionCard title="Log health data" icon={PencilLine} accent="text-domain-health">
            <MetricEntry date={dashboard.date} unitSystem={dashboard.unitSystem} withDetails />
          </SectionCard>

          <SectionCard
            title="Imports"
            icon={History}
            accent="text-muted-foreground"
            description={
              dashboard.importCount === 0
                ? "Every import can be undone as a unit"
                : `${formatNumber(dashboard.importCount)} ${dashboard.importCount === 1 ? "import" : "imports"} · each undoable as a unit`
            }
            action={
              <Link
                href="/health/imports"
                className="shrink-0 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                History
              </Link>
            }
          >
            {dashboard.lastImport ? (
              <div className="text-sm">
                {/* The name of a file the user chose — never elided into an
                    ellipsis they cannot expand. */}
                <p className="break-all font-medium">{dashboard.lastImport.fileName}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {/* Days-ago is computed against the user's own today on the
                      server; formatting the instant here would have used the
                      host's UTC day and been off by one either side of midnight. */}
                  {agoLabel(dashboard.lastImport.daysAgo)} ·{" "}
                  {formatNumber(dashboard.lastImport.imported)} new ·{" "}
                  {formatNumber(dashboard.lastImport.duplicates)} already present
                  {dashboard.lastImport.status === "removed" ? " · undone" : ""}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button asChild size="sm" variant="outline">
                    <Link href="/health/import">Import another export</Link>
                  </Button>
                  <Button asChild size="sm" variant="ghost">
                    <Link href="/health/imports">See all imports</Link>
                  </Button>
                </div>
              </div>
            ) : (
              <div className="text-sm">
                <p className="text-xs text-muted-foreground">
                  Nothing imported yet. An Apple Health export fills in years of history in one go,
                  and re-importing a later one only adds what is new.
                </p>
                <Button asChild size="sm" className="mt-3">
                  <Link href="/health/import">Import health data</Link>
                </Button>
              </div>
            )}
          </SectionCard>
        </div>
      </div>
    </>
  );
}
