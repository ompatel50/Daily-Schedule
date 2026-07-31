import type { Metadata } from "next";
import Link from "next/link";
import { LineChart } from "lucide-react";

import { MetricPanel } from "@/components/health/metric-panel";
import { RangePicker } from "@/components/health/range-picker";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/db";
import { formatDay } from "@/lib/date";
import { rangeFromParam } from "@/lib/health-ranges";
import type { HealthMetricType } from "@/lib/enums";
import { getMetricSeriesFor, resolveRange } from "@/server/health-module";
import { scheduleSettingsFor } from "@/server/schedule";

export const metadata: Metadata = { title: "Trends · Health" };
export const dynamic = "force-dynamic";

/**
 * The trends worth watching over a long window, in one place.
 *
 * Deliberately a fixed, curated list rather than "every metric you have":
 * a page of fifty charts is not a trend page, and these ten are the ones a
 * change in actually means something over months. Every other metric is
 * charted on its own group page.
 */
const TREND_METRICS: HealthMetricType[] = [
  "steps",
  "body_weight",
  "heart_rate",
  "resting_hr",
  "sleep_hours",
  "exercise_minutes",
  "active_calories",
  "hydration_ml",
  "body_fat",
  "vo2_max",
];

export default async function HealthTrendsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const range = rangeFromParam((await searchParams).range);
  const user = await getCurrentUser();
  const today = scheduleSettingsFor(user).today;
  const window = await resolveRange(user.id, range, today);
  const series = await getMetricSeriesFor(
    user.id,
    TREND_METRICS,
    window.from,
    window.to,
    user.unitSystem,
  );

  const withData = series.filter((entry) => entry.daysWithData > 0);

  return (
    <>
      <PageHeader
        title="Trends"
        description={`Steps, weight, heart rate, resting heart rate, sleep, exercise, calories, water, body fat and VO₂ max · ${formatDay(window.from, "MMM d, yyyy")} → ${formatDay(window.to, "MMM d, yyyy")}`}
        actions={<RangePicker current={range} />}
      />

      {withData.length === 0 ? (
        <EmptyState
          icon={LineChart}
          title="No trends in this range"
          description="Trends need at least a few days of data. Import an Apple Health export to fill in the history, or widen the range."
          action={
            <Button asChild>
              <Link href="/health/import">Import health data</Link>
            </Button>
          }
        />
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            {withData.map((entry) => (
              <MetricPanel
                key={entry.type}
                series={entry}
                chart={entry.goodDirection === "neutral" ? "line" : "area"}
              />
            ))}
          </div>
          {withData.length < series.length && (
            <p className="mt-6 text-xs text-muted-foreground">
              Not shown, because there is nothing recorded for them in this range:{" "}
              {series
                .filter((entry) => entry.daysWithData === 0)
                .map((entry) => entry.label)
                .join(", ")}
              .
            </p>
          )}
        </>
      )}
    </>
  );
}
