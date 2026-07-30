/**
 * Health read model — everything the Health page shows, assembled from the one
 * aggregation module in `src/lib/logic/health.ts`. Pages import this through
 * `queries.ts`-style server functions; nothing here writes.
 */
import { getCurrentUser, prisma } from "@/lib/db";
import { type DayKey, lastNDays, shiftDay } from "@/lib/date";
import { HEALTH_METRIC_META, type HealthMetricType } from "@/lib/enums";
import {
  aggregateDay,
  aggregateDayAll,
  aggregateSeries,
  HEALTH_METRIC_RULES,
  sourceLabel,
  toDisplay,
  type DailyMetricValue,
  type HealthRowLike,
} from "@/lib/logic/health";
import { scheduleSettingsFor } from "@/server/schedule";

/** The metrics the Health page surfaces, in display order. */
export const HEALTH_PAGE_METRICS: HealthMetricType[] = [
  "steps",
  "active_calories",
  "sleep_hours",
  "resting_hr",
  "heart_rate",
  "body_weight",
  "hydration_ml",
  "distance_km",
  "hrv",
  "body_fat",
];

export interface MetricToday {
  type: HealthMetricType;
  label: string;
  /** Display-converted value, or null when nothing was logged today. */
  value: number | null;
  unit: string;
  decimals: number;
  min: number | null;
  max: number | null;
  /** Human-readable source labels behind today's number. */
  sources: string[];
  stages: Array<{ stage: string; hours: number }> | null;
}

export interface MetricTrend {
  type: HealthMetricType;
  label: string;
  unit: string;
  decimals: number;
  days7: Array<{ date: DayKey; value: number | null }>;
  days30: Array<{ date: DayKey; value: number | null }>;
  /** 7-day summary: mean for point metrics, daily-average for cumulative. */
  average7: number | null;
  average30: number | null;
  latest: number | null;
}

export interface HealthOverview {
  date: DayKey;
  unitSystem: string;
  today: MetricToday[];
  trends: MetricTrend[];
  hasAnyData: boolean;
}

function displayRound(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function toTodayCard(
  type: HealthMetricType,
  unitSystem: string,
  aggregated: DailyMetricValue | undefined,
): MetricToday {
  const meta = HEALTH_METRIC_META[type];
  const display = aggregated ? toDisplay(type, aggregated.value, unitSystem) : null;
  const displayUnit = toDisplay(type, 0, unitSystem).unit;
  return {
    type,
    label: meta.label,
    value: display ? displayRound(display.value, meta.decimals) : null,
    unit: displayUnit,
    decimals: meta.decimals,
    min: aggregated?.min !== null && aggregated?.min !== undefined ? Math.round(aggregated.min) : null,
    max: aggregated?.max !== null && aggregated?.max !== undefined ? Math.round(aggregated.max) : null,
    sources: aggregated ? aggregated.sources.map(sourceLabel) : [],
    stages: aggregated?.stages
      ? Object.entries(aggregated.stages)
          .map(([stage, hours]) => ({ stage, hours: displayRound(hours, 1) }))
          .sort((a, b) => b.hours - a.hours)
      : null,
  };
}

export async function getHealthOverview(): Promise<HealthOverview> {
  const user = await getCurrentUser();
  // The user's today, resolved from their timezone — never the host clock.
  const date = scheduleSettingsFor(user).today;

  const from = shiftDay(date, -29);
  const rows = (await prisma.healthMetric.findMany({
    where: { userId: user.id, date: { gte: from, lte: date } },
    select: {
      date: true,
      type: true,
      subtype: true,
      value: true,
      unit: true,
      secondaryValue: true,
      minValue: true,
      maxValue: true,
      source: true,
      sourceApp: true,
      recordedAt: true,
      startAt: true,
      endAt: true,
      createdAt: true,
    },
  })) as HealthRowLike[];

  const todayRows = rows.filter((row) => row.date === date);
  const todayAggregated = aggregateDayAll(todayRows);

  const days30 = lastNDays(30, date);

  const trends: MetricTrend[] = HEALTH_PAGE_METRICS.map((type) => {
    const meta = HEALTH_METRIC_META[type];
    const series30 = aggregateSeries(type, rows, days30).map((point) => ({
      date: point.date,
      value:
        point.value === null
          ? null
          : displayRound(toDisplay(type, point.value, user.unitSystem).value, meta.decimals),
    }));
    const series7 = series30.slice(-7);
    const values7 = series7.map((p) => p.value).filter((v): v is number => v !== null);
    const values30 = series30.map((p) => p.value).filter((v): v is number => v !== null);
    const latest = [...series30].reverse().find((p) => p.value !== null)?.value ?? null;
    return {
      type,
      label: meta.label,
      unit: toDisplay(type, 0, user.unitSystem).unit,
      decimals: meta.decimals,
      days7: series7,
      days30: series30,
      average7:
        values7.length > 0
          ? displayRound(values7.reduce((sum, v) => sum + v, 0) / values7.length, meta.decimals)
          : null,
      average30:
        values30.length > 0
          ? displayRound(values30.reduce((sum, v) => sum + v, 0) / values30.length, meta.decimals)
          : null,
      latest,
    };
  });

  return {
    date,
    unitSystem: user.unitSystem,
    today: HEALTH_PAGE_METRICS.map((type) => toTodayCard(type, user.unitSystem, todayAggregated.get(type))),
    trends,
    hasAnyData: rows.length > 0,
  };
}

/**
 * Aggregated per-day series for a set of metrics over a range, in display
 * units — what Insights charts. One query, one aggregation path.
 */
export async function getMetricSeries(
  from: DayKey,
  to: DayKey,
  types: HealthMetricType[],
): Promise<Map<HealthMetricType, Array<{ date: DayKey; value: number | null }>>> {
  const user = await getCurrentUser();
  const rows = (await prisma.healthMetric.findMany({
    where: { userId: user.id, date: { gte: from, lte: to }, type: { in: types } },
    select: {
      date: true,
      type: true,
      subtype: true,
      value: true,
      unit: true,
      secondaryValue: true,
      minValue: true,
      maxValue: true,
      source: true,
      sourceApp: true,
      recordedAt: true,
      startAt: true,
      endAt: true,
      createdAt: true,
    },
  })) as HealthRowLike[];

  const days: DayKey[] = [];
  for (let day = from; day <= to; day = shiftDay(day, 1)) days.push(day);

  const result = new Map<HealthMetricType, Array<{ date: DayKey; value: number | null }>>();
  for (const type of types) {
    const meta = HEALTH_METRIC_META[type];
    result.set(
      type,
      aggregateSeries(type, rows, days).map((point) => ({
        date: point.date,
        value:
          point.value === null
            ? null
            : displayRound(toDisplay(type, point.value, user.unitSystem).value, meta.decimals),
      })),
    );
  }
  return result;
}

/**
 * Latest value per metric, aggregated and display-converted — what Settings
 * uses to prefill goal targets.
 */
export async function getLatestMetricValues(): Promise<
  Map<string, { value: number; unit: string; date: DayKey }>
> {
  const user = await getCurrentUser();
  const rows = (await prisma.healthMetric.findMany({
    where: { userId: user.id },
    orderBy: { date: "desc" },
    take: 600,
    select: {
      date: true,
      type: true,
      subtype: true,
      value: true,
      unit: true,
      secondaryValue: true,
      minValue: true,
      maxValue: true,
      source: true,
      sourceApp: true,
      recordedAt: true,
      startAt: true,
      endAt: true,
      createdAt: true,
    },
  })) as HealthRowLike[];

  const byTypeDay = new Map<string, HealthRowLike[]>();
  for (const row of rows) {
    if (!HEALTH_METRIC_RULES[row.type]) continue;
    const key = `${row.type}|${row.date}`;
    const group = byTypeDay.get(key);
    if (group) group.push(row);
    else byTypeDay.set(key, [row]);
  }

  const latest = new Map<string, { value: number; unit: string; date: DayKey }>();
  for (const [key, group] of byTypeDay) {
    const [type, date] = key.split("|") as [string, DayKey];
    const existing = latest.get(type);
    if (existing && existing.date >= date) continue;
    const aggregated = aggregateDay(type, group);
    if (!aggregated) continue;
    const meta = HEALTH_METRIC_META[type as HealthMetricType];
    const display = toDisplay(type, aggregated.value, user.unitSystem);
    latest.set(type, {
      value: displayRound(display.value, meta?.decimals ?? 1),
      unit: display.unit,
      date,
    });
  }
  return latest;
}
