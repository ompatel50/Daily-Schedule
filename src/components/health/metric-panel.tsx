import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";

import { TrendAreaChart, TrendLineChart } from "@/components/shared/charts";
import { Badge } from "@/components/ui/badge";
import { formatDay } from "@/lib/date";
import { cn, formatNumber } from "@/lib/utils";
import type { MetricSeries } from "@/server/health-module";

/**
 * One metric, charted with the numbers that make the chart mean something.
 *
 * Two deliberate choices about honesty:
 *
 *  * a day with no reading is a **gap**, never a zero — "did not wear the
 *    watch" and "walked no steps" are different facts and must not look the
 *    same, so averages skip empty days and the chart leaves them blank;
 *  * a total is only offered where adding days together says something true
 *    (steps, calories, water), which the metric's own rule decides.
 */
export function MetricPanel({ series, chart = "area" }: { series: MetricSeries; chart?: "area" | "line" }) {
  const data = series.points.map((point) => ({
    label: formatDay(point.date, "M/d"),
    value: point.value,
  }));
  const hasData = series.daysWithData > 0;

  return (
    <section
      // min-w-0 lets the panel shrink inside its grid track instead of
      // widening the page at narrow viewports.
      className="min-w-0 rounded-xl border p-4"
      aria-label={series.label}
      data-testid={`metric-${series.type}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{series.label}</h3>
          <p className="text-xs text-muted-foreground">
            {hasData
              ? `${series.daysWithData} ${series.daysWithData === 1 ? "day" : "days"} with data`
              : "No readings in this range"}
          </p>
        </div>
        {hasData && series.latest && (
          <p className="tabular text-right text-lg font-semibold leading-none">
            {formatNumber(series.latest.value, series.decimals)}
            {series.unit && (
              <span className="ml-1 text-xs font-normal text-muted-foreground">{series.unit}</span>
            )}
          </p>
        )}
      </div>

      {hasData ? (
        <>
          <div className="mt-3 overflow-hidden">
            {chart === "area" ? (
              <TrendAreaChart
                data={data}
                dataKey="value"
                color="hsl(var(--domain-health))"
                height={140}
              />
            ) : (
              <TrendLineChart
                data={data}
                height={140}
                lines={[
                  { dataKey: "value", name: series.label, color: "hsl(var(--domain-health))" },
                ]}
              />
            )}
          </div>

          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
            <Figure label="Average" value={series.average} unit={series.unit} decimals={series.decimals} />
            {series.total !== null && (
              <Figure label="Total" value={series.total} unit={series.unit} decimals={series.decimals} />
            )}
            <Figure label="Low" value={series.min} unit={series.unit} decimals={series.decimals} />
            <Figure label="High" value={series.max} unit={series.unit} decimals={series.decimals} />
          </dl>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <ChangeBadge change={series.changePercent} goodDirection={series.goodDirection} />
            {series.sources.map((source) => (
              <Badge key={source} variant="outline" className="text-[10px]">
                {source}
              </Badge>
            ))}
          </div>
        </>
      ) : (
        <p className="mt-3 rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
          Nothing recorded for {series.label.toLowerCase()} yet. Import an Apple Health export, or
          log a value by hand.
        </p>
      )}
    </section>
  );
}

function Figure({
  label,
  value,
  unit,
  decimals,
}: {
  label: string;
  value: number | null;
  unit: string;
  decimals: number;
}) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular font-medium">
        {value === null ? "—" : formatNumber(value, decimals)}
        {value !== null && unit && (
          <span className="ml-0.5 text-[10px] font-normal text-muted-foreground">{unit}</span>
        )}
      </dd>
    </div>
  );
}

/**
 * The direction of travel over the window. "Good" depends on the metric —
 * resting heart rate falling is an improvement, steps falling is not — so the
 * colour comes from the metric's own `goodDirection` rather than the sign.
 */
export function ChangeBadge({
  change,
  goodDirection,
  compact = false,
}: {
  change: number | null;
  goodDirection: "up" | "down" | "neutral";
  /** Drop the "vs the first half" suffix where the column is too narrow for it. */
  compact?: boolean;
}) {
  if (change === null) return null;
  const Icon = change === 0 ? ArrowRight : change > 0 ? ArrowUpRight : ArrowDownRight;
  const good =
    goodDirection === "neutral" || change === 0 ? null : goodDirection === "up" ? change > 0 : change < 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-[11px] font-medium",
        good === null
          ? "text-muted-foreground"
          : good
            ? "text-emerald-700 dark:text-emerald-400"
            : "text-red-700 dark:text-red-400",
      )}
    >
      <Icon className="h-3 w-3 shrink-0" />
      {Math.abs(change)}%{compact ? "" : " vs the first half"}
    </span>
  );
}
