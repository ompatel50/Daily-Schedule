import "server-only";

import { getCurrentUser, prisma } from "@/lib/db";
import { dayRange, shiftDay, type DayKey } from "@/lib/date";
import { HEALTH_RANGE_META, type HealthRange } from "@/lib/health-ranges";
import {
  HEALTH_GROUP_META,
  HEALTH_METRIC_META,
  HEALTH_RECORD_KIND_META,
  metricsInGroup,
  type HealthMetricGroup,
  type HealthMetricType,
  type HealthRecordKind,
} from "@/lib/enums";
import {
  aggregateDay,
  aggregateSeries,
  ASLEEP_STAGES,
  displayUnitFor,
  HEALTH_METRIC_RULES,
  sourceLabel,
  toCanonical,
  toDisplay,
  type HealthRowLike,
  type SleepStage,
} from "@/lib/logic/health";
import { scheduleSettingsFor } from "@/server/schedule";

/**
 * The Health module's read model.
 *
 * Everything the Health section renders is assembled here, and every number it
 * produces goes through the one aggregation module in `src/lib/logic/health.ts`
 * — the same path the day score, the calendar and Insights use. Nothing in
 * this file decides what a measurement means; it decides which measurements to
 * fetch and how to shape them for a page.
 *
 * ## Bounded by construction
 *
 * A health table can hold a decade of daily rows per metric, so every query
 * here is bounded by an explicit day window and a metric list, and the "all
 * time" range resolves to the user's actual first day rather than scanning
 * from the epoch. Series are built per day, so a chart over a year is 365
 * points regardless of how many rows fed it.
 */

/** The columns every aggregation needs, and no more. */
const ROW_SELECT = {
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
} as const;

/**
 * Resolve a range to a concrete day window. "All time" asks the database for
 * the user's earliest health day rather than guessing a start, so the window
 * is never larger than the data — and is capped so a single stray row dated
 * 1970 cannot turn a chart into 20,000 points.
 */
export async function resolveRange(
  userId: string,
  range: HealthRange,
  today: DayKey,
): Promise<{ from: DayKey; to: DayKey; days: number }> {
  const preset = HEALTH_RANGE_META[range].days;
  if (preset !== null) {
    return { from: shiftDay(today, -(preset - 1)), to: today, days: preset };
  }
  const earliest = await prisma.healthMetric.findFirst({
    where: { userId },
    orderBy: { date: "asc" },
    select: { date: true },
  });
  const MAX_ALL_TIME_DAYS = 3650;
  const floor = shiftDay(today, -(MAX_ALL_TIME_DAYS - 1));
  const from = earliest && earliest.date > floor ? (earliest.date as DayKey) : floor;
  return { from, to: today, days: 0 };
}

function displayRound(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// --- metric series ------------------------------------------------------------

export interface MetricSeries {
  type: HealthMetricType;
  label: string;
  unit: string;
  decimals: number;
  goodDirection: "up" | "down" | "neutral";
  /** One point per day in the window; null means "nothing was logged". */
  points: Array<{ date: DayKey; value: number | null; min: number | null; max: number | null }>;
  /** Mean of the days that have a value — never counting empty days as zero. */
  average: number | null;
  /** Sum over the window, for metrics where a total means something. */
  total: number | null;
  min: number | null;
  max: number | null;
  latest: { value: number; date: DayKey } | null;
  /** Days in the window that carry a value. */
  daysWithData: number;
  /** Mean of the first half vs the second half, for a direction of travel. */
  changePercent: number | null;
  sources: string[];
}

/**
 * Per-day series for a set of metrics over a window, in display units.
 *
 * One query for all of them: pulling each metric separately would multiply
 * round trips by the size of a group, and the aggregation already partitions
 * rows by type.
 */
export async function getMetricSeriesFor(
  userId: string,
  types: HealthMetricType[],
  from: DayKey,
  to: DayKey,
  unitSystem: string,
): Promise<MetricSeries[]> {
  if (types.length === 0) return [];
  const rows = (await prisma.healthMetric.findMany({
    where: { userId, type: { in: types }, date: { gte: from, lte: to } },
    select: ROW_SELECT,
  })) as HealthRowLike[];

  const days = dayRange(from, to);
  const sourcesByType = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = sourcesByType.get(row.type) ?? new Set<string>();
    set.add(sourceLabel(row.source));
    sourcesByType.set(row.type, set);
  }

  return types.map((type) => buildSeries(type, rows, days, unitSystem, sourcesByType.get(type)));
}

function buildSeries(
  type: HealthMetricType,
  rows: HealthRowLike[],
  days: DayKey[],
  unitSystem: string,
  sources: Set<string> | undefined,
): MetricSeries {
  const meta = HEALTH_METRIC_META[type];
  const rule = HEALTH_METRIC_RULES[type];
  const points = aggregateSeries(type, rows, days).map((point) => ({
    date: point.date,
    value:
      point.value === null
        ? null
        : displayRound(toDisplay(type, point.value, unitSystem).value, meta.decimals),
    min: point.min === null ? null : displayRound(toDisplay(type, point.min, unitSystem).value, meta.decimals),
    max: point.max === null ? null : displayRound(toDisplay(type, point.max, unitSystem).value, meta.decimals),
  }));

  const values = points.map((point) => point.value).filter((value): value is number => value !== null);
  const withValue = points.filter((point) => point.value !== null);
  const latest = [...withValue].reverse()[0];

  return {
    type,
    label: meta.label,
    unit: displayUnitFor(type, unitSystem),
    decimals: meta.decimals,
    goodDirection: meta.goodDirection,
    points,
    average:
      values.length > 0
        ? displayRound(values.reduce((sum, value) => sum + value, 0) / values.length, meta.decimals)
        : null,
    // A total is only offered where adding days up says something true: a
    // week's steps is a number, a week's body weight is not.
    total:
      rule?.additiveAcrossDays && values.length > 0
        ? displayRound(values.reduce((sum, value) => sum + value, 0), meta.decimals)
        : null,
    min: values.length > 0 ? Math.min(...values) : null,
    max: values.length > 0 ? Math.max(...values) : null,
    latest: latest?.value != null ? { value: latest.value, date: latest.date } : null,
    daysWithData: values.length,
    changePercent: halfOverHalfChange(withValue.map((point) => point.value as number)),
    sources: sources ? [...sources] : [],
  };
}

/**
 * Direction of travel: the mean of the window's second half against its first.
 * Only the days that carry a value take part, so a gap in wearing the watch
 * does not read as a collapse. Needs at least four readings to say anything.
 */
function halfOverHalfChange(values: number[]): number | null {
  if (values.length < 4) return null;
  const half = Math.floor(values.length / 2);
  const mean = (list: number[]) => list.reduce((sum, value) => sum + value, 0) / list.length;
  const first = mean(values.slice(0, half));
  const second = mean(values.slice(half));
  if (first === 0) return null;
  return Math.round(((second - first) / Math.abs(first)) * 100);
}

// --- group pages ---------------------------------------------------------------

export interface GroupView {
  group: HealthMetricGroup;
  range: HealthRange;
  from: DayKey;
  to: DayKey;
  unitSystem: string;
  series: MetricSeries[];
  /** True when no metric in the group has a single reading in the window. */
  empty: boolean;
}

/** Everything one Health sub-page needs for its metrics. */
export async function getGroupView(
  group: HealthMetricGroup,
  range: HealthRange,
): Promise<GroupView> {
  const user = await getCurrentUser();
  const today = scheduleSettingsFor(user).today;
  const { from, to } = await resolveRange(user.id, range, today);
  const types = metricsInGroup(group);
  const series = await getMetricSeriesFor(user.id, types, from, to, user.unitSystem);
  return {
    group,
    range,
    from,
    to,
    unitSystem: user.unitSystem,
    series,
    empty: series.every((entry) => entry.daysWithData === 0),
  };
}

// --- sleep sessions -------------------------------------------------------------

export interface SleepSession {
  date: DayKey;
  source: string;
  /** Hours in the asleep-ish stages. */
  asleepHours: number;
  /** Hours in bed, where the source recorded it. */
  inBedHours: number | null;
  stages: Array<{ stage: SleepStage; hours: number }>;
  /** The night's bounds, from the earliest stage start to the latest end. */
  startAt: string | null;
  endAt: string | null;
}

/**
 * One row per night, derived from the stage rows rather than stored twice.
 *
 * A night is (day, source): two devices that both recorded the same night are
 * two sessions, and the page shows the fullest — the same rule the day
 * aggregation uses, applied to a list instead of a number.
 */
export async function getSleepSessions(
  userId: string,
  from: DayKey,
  to: DayKey,
  limit = 120,
): Promise<SleepSession[]> {
  const rows = await prisma.healthMetric.findMany({
    where: { userId, type: "sleep_hours", date: { gte: from, lte: to } },
    select: {
      date: true,
      subtype: true,
      value: true,
      unit: true,
      source: true,
      sourceApp: true,
      startAt: true,
      endAt: true,
    },
    orderBy: { date: "desc" },
    take: limit * 12,
  });

  const byNight = new Map<string, SleepSession>();
  for (const row of rows) {
    const key = `${row.date}|${row.source}|${row.sourceApp ?? ""}`;
    const hours = toCanonical("sleep_hours", row.value, row.unit) ?? 0;
    const session =
      byNight.get(key) ??
      ({
        date: row.date as DayKey,
        source: sourceLabel(row.source),
        asleepHours: 0,
        inBedHours: null,
        stages: [],
        startAt: null,
        endAt: null,
      } satisfies SleepSession);

    const stage = (row.subtype ?? null) as SleepStage | null;
    if (stage) {
      session.stages.push({ stage, hours: Math.round(hours * 100) / 100 });
      if ((ASLEEP_STAGES as readonly string[]).includes(stage)) session.asleepHours += hours;
      if (stage === "in_bed") session.inBedHours = (session.inBedHours ?? 0) + hours;
    } else {
      // A plain total (manual or CSV) with no stage breakdown.
      session.asleepHours += hours;
    }
    const start = row.startAt?.toISOString() ?? null;
    const end = row.endAt?.toISOString() ?? null;
    if (start && (session.startAt === null || start < session.startAt)) session.startAt = start;
    if (end && (session.endAt === null || end > session.endAt)) session.endAt = end;
    byNight.set(key, session);
  }

  // One session per night: the source that recorded the most sleep.
  const best = new Map<DayKey, SleepSession>();
  for (const session of byNight.values()) {
    session.asleepHours = Math.round(session.asleepHours * 100) / 100;
    if (session.inBedHours !== null) {
      session.inBedHours = Math.round(session.inBedHours * 100) / 100;
    }
    session.stages.sort((a, b) => b.hours - a.hours);
    const current = best.get(session.date);
    if (!current || session.asleepHours > current.asleepHours) best.set(session.date, session);
  }

  return [...best.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
}

// --- health records --------------------------------------------------------------

export interface HealthRecordView {
  id: string;
  kind: HealthRecordKind;
  kindLabel: string;
  date: DayKey;
  title: string;
  subtitle: string | null;
  value: number | null;
  unit: string;
  sourceApp: string | null;
  detail: Record<string, string | number>;
}

export async function getHealthRecords(
  userId: string,
  options: { kinds?: HealthRecordKind[]; from?: DayKey; to?: DayKey; limit?: number } = {},
): Promise<HealthRecordView[]> {
  const rows = await prisma.healthRecord.findMany({
    where: {
      userId,
      ...(options.kinds && options.kinds.length > 0 ? { kind: { in: options.kinds } } : {}),
      ...(options.from && options.to ? { date: { gte: options.from, lte: options.to } } : {}),
    },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    take: options.limit ?? 50,
  });

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as HealthRecordKind,
    kindLabel: HEALTH_RECORD_KIND_META[row.kind as HealthRecordKind]?.label ?? row.kind,
    date: row.date as DayKey,
    title: row.title,
    subtitle: row.subtitle,
    value: row.value,
    unit: row.unit,
    sourceApp: row.sourceApp,
    detail: safeDetail(row.detail),
  }));
}

function safeDetail(raw: string): Record<string, string | number> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" || typeof value === "number") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export async function countHealthRecordsByKind(
  userId: string,
): Promise<Array<{ kind: HealthRecordKind; label: string; count: number }>> {
  const groups = await prisma.healthRecord.groupBy({
    by: ["kind"],
    where: { userId },
    _count: { _all: true },
  });
  return groups
    .map((group) => ({
      kind: group.kind as HealthRecordKind,
      label: HEALTH_RECORD_KIND_META[group.kind as HealthRecordKind]?.plural ?? group.kind,
      count: group._count._all,
    }))
    .sort((a, b) => b.count - a.count);
}

// --- workouts ------------------------------------------------------------------

export interface HealthWorkout {
  id: string;
  date: DayKey;
  time: string | null;
  name: string;
  type: string;
  durationMin: number;
  distanceKm: number | null;
  caloriesBurned: number | null;
  avgHeartRate: number | null;
  source: string;
  imported: boolean;
}

export async function getHealthWorkouts(
  userId: string,
  from: DayKey,
  to: DayKey,
  limit = 100,
): Promise<HealthWorkout[]> {
  const rows = await prisma.workout.findMany({
    where: { userId, date: { gte: from, lte: to } },
    orderBy: [{ date: "desc" }, { time: "desc" }],
    take: limit,
    select: {
      id: true,
      date: true,
      time: true,
      name: true,
      type: true,
      durationMin: true,
      distanceKm: true,
      caloriesBurned: true,
      avgHeartRate: true,
      source: true,
      importBatchId: true,
    },
  });
  return rows.map((row) => ({
    id: row.id,
    date: row.date as DayKey,
    time: row.time,
    name: row.name,
    type: row.type,
    durationMin: row.durationMin,
    distanceKm: row.distanceKm,
    caloriesBurned: row.caloriesBurned,
    avgHeartRate: row.avgHeartRate,
    source: sourceLabel(row.source),
    imported: row.importBatchId !== null,
  }));
}

// --- the overview --------------------------------------------------------------

export interface OverviewMetric {
  type: HealthMetricType;
  label: string;
  value: number | null;
  unit: string;
  decimals: number;
  /** Mean over the last 30 days, for context under today's number. */
  average30: number | null;
  changePercent: number | null;
  goodDirection: "up" | "down" | "neutral";
  sources: string[];
}

export interface HealthDashboard {
  date: DayKey;
  unitSystem: string;
  /** Headline metrics, one per area. */
  headline: OverviewMetric[];
  /** Per-area summaries, each with its own small set of metrics. */
  groups: Array<{
    group: HealthMetricGroup;
    label: string;
    slug: string;
    metrics: OverviewMetric[];
  }>;
  sleep: SleepSession | null;
  workouts: HealthWorkout[];
  records: HealthRecordView[];
  recordCounts: Array<{ kind: HealthRecordKind; label: string; count: number }>;
  lastImport: {
    id: string;
    fileName: string;
    createdAt: Date;
    status: string;
    imported: number;
    duplicates: number;
  } | null;
  importCount: number;
  totalMetrics: number;
  hasAnyData: boolean;
}

/** The metrics the overview leads with, in display order. */
const HEADLINE_METRICS: HealthMetricType[] = [
  "steps",
  "active_calories",
  "sleep_hours",
  "resting_hr",
];

/** What each area's summary card shows. Kept short on purpose. */
const GROUP_SUMMARY_METRICS: Record<HealthMetricGroup, HealthMetricType[]> = {
  activity: ["steps", "distance_km", "exercise_minutes", "flights_climbed", "stand_hours"],
  sleep: ["sleep_hours"],
  heart: ["resting_hr", "heart_rate", "hrv", "vo2_max", "walking_hr"],
  body: ["body_weight", "body_fat", "bmi", "lean_body_mass"],
  respiratory: ["blood_oxygen", "respiratory_rate"],
  nutrition: ["dietary_calories", "protein_g", "carbs_g", "fat_g", "hydration_ml"],
  vitals: ["blood_pressure", "blood_glucose", "body_temperature"],
  mind: ["mindful_minutes", "mood", "energy"],
};

export async function getHealthDashboard(): Promise<HealthDashboard> {
  const user = await getCurrentUser();
  const date = scheduleSettingsFor(user).today;
  const from = shiftDay(date, -29);

  const wanted = [
    ...new Set([...HEADLINE_METRICS, ...Object.values(GROUP_SUMMARY_METRICS).flat()]),
  ];

  const [rows, sleepSessions, workouts, records, recordCounts, batches, totalMetrics] =
    await Promise.all([
      prisma.healthMetric.findMany({
        where: { userId: user.id, type: { in: wanted }, date: { gte: from, lte: date } },
        select: ROW_SELECT,
      }) as Promise<HealthRowLike[]>,
      getSleepSessions(user.id, from, date, 1),
      getHealthWorkouts(user.id, shiftDay(date, -89), date, 5),
      getHealthRecords(user.id, { limit: 5 }),
      countHealthRecordsByKind(user.id),
      prisma.healthImportBatch.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true,
          fileName: true,
          createdAt: true,
          status: true,
          imported: true,
          duplicates: true,
        },
      }),
      prisma.healthMetric.count({ where: { userId: user.id } }),
    ]);

  const importCount = await prisma.healthImportBatch.count({ where: { userId: user.id } });
  const days = dayRange(from, date);
  const todayRows = rows.filter((row) => row.date === date);

  const metricFor = (type: HealthMetricType): OverviewMetric => {
    const meta = HEALTH_METRIC_META[type];
    const todayValue = aggregateDay(type, todayRows);
    const series = buildSeries(type, rows, days, user.unitSystem, undefined);
    return {
      type,
      label: meta.label,
      value: todayValue
        ? displayRound(toDisplay(type, todayValue.value, user.unitSystem).value, meta.decimals)
        : null,
      unit: displayUnitFor(type, user.unitSystem),
      decimals: meta.decimals,
      average30: series.average,
      changePercent: series.changePercent,
      goodDirection: meta.goodDirection,
      sources: todayValue ? todayValue.sources.map(sourceLabel) : [],
    };
  };

  const groups = (Object.keys(GROUP_SUMMARY_METRICS) as HealthMetricGroup[]).map((group) => ({
    group,
    label: HEALTH_GROUP_META[group].label,
    slug: HEALTH_GROUP_META[group].slug,
    metrics: GROUP_SUMMARY_METRICS[group].map(metricFor),
  }));

  return {
    date,
    unitSystem: user.unitSystem,
    headline: HEADLINE_METRICS.map(metricFor),
    groups,
    sleep: sleepSessions[0] ?? null,
    workouts,
    records,
    recordCounts,
    lastImport: batches[0] ?? null,
    importCount,
    totalMetrics,
    hasAnyData: totalMetrics > 0 || workouts.length > 0 || records.length > 0,
  };
}
