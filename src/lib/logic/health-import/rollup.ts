import type { DayKey } from "@/lib/date";
import {
  HEALTH_METRIC_RULES,
  intervalHours,
  mergeIntervals,
  toCanonical,
  type Interval,
  type SleepStage,
} from "@/lib/logic/health";
import type {
  ImportCategory,
  ImportPlan,
  NormalizedHealthRow,
  ParsedFile,
  RawSample,
} from "./types";

/**
 * Rollup: raw samples → database-ready rows.
 *
 * An Apple Health export carries every individual sensor reading — hundreds of
 * step samples and thousands of heart-rate samples per day. Storing them all
 * would swamp the database for no benefit the app can show, so the import
 * folds them into one row per (day, device[, stage]) here, deterministically:
 *
 *  * cumulative metrics (steps, calories, water, distance): per-day sum
 *  * heart rate: per-day average with the min/max preserved
 *  * resting HR / HRV: per-day average
 *  * weight / body fat / blood pressure: individual readings kept
 *  * sleep: per-day-per-stage union of intervals (overlaps merged, never
 *    double-counted), the day being the one the interval *ends* on
 *
 * CSV rows are already row-per-record and pass through unrolled.
 *
 * Because the rollup is deterministic, re-importing the same file reproduces
 * the same fingerprints, which is what makes re-import a no-op.
 */

/** The dedup key. Stable across re-exports of the same data. */
export function fingerprintFor(row: Omit<NormalizedHealthRow, "fingerprint">): string {
  if (row.source !== "apple_health" && row.externalId) {
    // A system that supplies its own stable id is the most reliable key.
    return `x|${row.source}|${row.externalId}`;
  }
  if (row.source === "apple_health") {
    const app = row.sourceApp ?? "-";
    const rule = HEALTH_METRIC_RULES[row.type];
    if (rule && (rule.kind === "cumulative" || rule.kind === "average" || rule.kind === "sample_range")) {
      return `ah|${row.type}|${row.date}|${app}`;
    }
    if (rule && rule.kind === "sleep") {
      return `ah|${row.type}|${row.subtype ?? "-"}|${row.date}|${app}`;
    }
    // Point readings: identity is the instant + the value.
    return `ah|${row.type}|${row.startAt ?? row.date}|${row.value}|${app}`;
  }
  // CSV without an external id: the full row is the identity.
  return [
    "csv",
    row.type,
    row.subtype ?? "-",
    row.date,
    row.startAt ?? "-",
    row.endAt ?? "-",
    row.value,
    row.source,
  ].join("|");
}

/** The fingerprint the manual-entry UI upserts on: one value per day per type. */
export function manualDailyFingerprint(type: string, date: DayKey): string {
  return `manual|${type}|${date}`;
}

function finalize(row: Omit<NormalizedHealthRow, "fingerprint">): NormalizedHealthRow {
  return { ...row, fingerprint: fingerprintFor(row) };
}

const round = (value: number, places = 3): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/** Roll one metric type's Apple samples into rows. */
function rollupAppleMetric(type: string, samples: RawSample[]): NormalizedHealthRow[] {
  const rule = HEALTH_METRIC_RULES[type];
  if (!rule) return [];
  const rows: NormalizedHealthRow[] = [];

  if (rule.kind === "latest") {
    // Individual readings kept as-is (weight, body fat) — converted to canonical.
    for (const sample of samples) {
      const value = toCanonical(type, sample.value, sample.unit);
      if (value === null) continue;
      rows.push(
        finalize({
          type,
          subtype: null,
          value: round(value),
          unit: rule.canonicalUnit,
          minValue: null,
          maxValue: null,
          date: sample.date,
          startAt: sample.startAt,
          endAt: sample.endAt,
          source: sample.source,
          sourceApp: sample.sourceApp,
          sourceDevice: sample.sourceDevice,
          externalId: sample.externalId,
          notes: sample.notes,
          sampleCount: 1,
        }),
      );
    }
    return rows;
  }

  if (rule.kind === "sleep") {
    // Group by (day, device, stage); union the intervals within each group.
    const groups = new Map<string, RawSample[]>();
    for (const sample of samples) {
      const key = `${sample.date}|${sample.sourceApp ?? ""}|${sample.subtype ?? ""}`;
      const group = groups.get(key);
      if (group) group.push(sample);
      else groups.set(key, [sample]);
    }
    for (const [, group] of groups) {
      const first = group[0];
      const intervals: Interval[] = group
        .filter((s) => s.startAt && s.endAt)
        .map((s) => ({ start: new Date(s.startAt!).getTime(), end: new Date(s.endAt!).getTime() }));
      const merged = mergeIntervals(intervals);
      const hours = merged.length > 0
        ? intervalHours(merged)
        : group.reduce((sum, s) => sum + (toCanonical(type, s.value, s.unit) ?? 0), 0);
      if (!(hours > 0)) continue;
      rows.push(
        finalize({
          type,
          subtype: (first.subtype ?? null) as SleepStage | null,
          value: round(hours),
          unit: rule.canonicalUnit,
          minValue: null,
          maxValue: null,
          date: first.date,
          startAt: merged.length > 0 ? new Date(merged[0].start).toISOString() : first.startAt,
          endAt:
            merged.length > 0
              ? new Date(merged[merged.length - 1].end).toISOString()
              : first.endAt,
          source: first.source,
          sourceApp: first.sourceApp,
          sourceDevice: first.sourceDevice,
          externalId: null,
          notes: null,
          sampleCount: group.length,
        }),
      );
    }
    return rows;
  }

  // Cumulative and averaged metrics: one row per (day, device).
  const groups = new Map<string, RawSample[]>();
  for (const sample of samples) {
    const key = `${sample.date}|${sample.sourceApp ?? ""}`;
    const group = groups.get(key);
    if (group) group.push(sample);
    else groups.set(key, [sample]);
  }

  for (const [, group] of groups) {
    const first = group[0];
    const values = group
      .map((s) => toCanonical(type, s.value, s.unit))
      .filter((v): v is number => v !== null);
    if (values.length === 0) continue;

    const value =
      rule.kind === "cumulative"
        ? values.reduce((sum, v) => sum + v, 0)
        : values.reduce((sum, v) => sum + v, 0) / values.length;

    const stamps = group
      .flatMap((s) => [s.startAt, s.endAt])
      .filter((s): s is string => s !== null)
      .sort();

    rows.push(
      finalize({
        type,
        subtype: null,
        value: round(value),
        unit: rule.canonicalUnit,
        minValue: rule.kind === "sample_range" ? round(Math.min(...values)) : null,
        maxValue: rule.kind === "sample_range" ? round(Math.max(...values)) : null,
        date: first.date,
        startAt: stamps[0] ?? null,
        endAt: stamps[stamps.length - 1] ?? null,
        source: first.source,
        sourceApp: first.sourceApp,
        sourceDevice: first.sourceDevice,
        externalId: null,
        notes: null,
        sampleCount: group.length,
      }),
    );
  }
  return rows;
}

/** CSV rows pass through one-to-one, converted to canonical units. */
function normalizeCsvSample(sample: RawSample): NormalizedHealthRow | null {
  const rule = HEALTH_METRIC_RULES[sample.type];
  if (!rule) return null;
  const value = toCanonical(sample.type, sample.value, sample.unit);
  if (value === null) return null;
  return finalize({
    type: sample.type,
    subtype: sample.subtype,
    value: round(value),
    unit: rule.canonicalUnit,
    minValue: null,
    maxValue: null,
    date: sample.date,
    startAt: sample.startAt,
    endAt: sample.endAt,
    source: sample.source,
    sourceApp: sample.sourceApp,
    sourceDevice: sample.sourceDevice,
    externalId: sample.externalId,
    notes: sample.notes,
    sampleCount: 1,
  });
}

export const WORKOUTS_CATEGORY = "workouts";

/** Build the staged plan the preview shows and the confirmation writes. */
export function buildImportPlan(parsed: ParsedFile): ImportPlan {
  const byType = new Map<string, RawSample[]>();
  for (const sample of parsed.samples) {
    const group = byType.get(sample.type);
    if (group) group.push(sample);
    else byType.set(sample.type, [sample]);
  }

  const rows: NormalizedHealthRow[] = [];
  const seen = new Set<string>();
  for (const [type, samples] of byType) {
    const typeRows =
      parsed.kind === "apple_health"
        ? rollupAppleMetric(type, samples)
        : samples.map(normalizeCsvSample).filter((row): row is NormalizedHealthRow => row !== null);
    // Within one file, identical fingerprints collapse (a truly duplicated CSV
    // row imports once); the DB upsert handles collisions across files.
    for (const row of typeRows) {
      if (seen.has(row.fingerprint)) continue;
      seen.add(row.fingerprint);
      rows.push(row);
    }
  }

  const categories: ImportCategory[] = [];
  for (const [type, samples] of byType) {
    const typeRows = rows.filter((row) => row.type === type);
    if (typeRows.length === 0) continue;
    const dates = typeRows.map((row) => row.date).sort();
    categories.push({
      key: type,
      label: type,
      records: samples.length,
      rows: typeRows.length,
      dateFrom: dates[0] ?? null,
      dateTo: dates[dates.length - 1] ?? null,
    });
  }
  if (parsed.workouts.length > 0) {
    const dates = parsed.workouts.map((workout) => workout.date).sort();
    categories.push({
      key: WORKOUTS_CATEGORY,
      label: "Workouts",
      records: parsed.workouts.length,
      rows: parsed.workouts.length,
      dateFrom: dates[0] ?? null,
      dateTo: dates[dates.length - 1] ?? null,
    });
  }
  categories.sort((a, b) => a.key.localeCompare(b.key));

  const allDates = [
    ...rows.map((row) => row.date),
    ...parsed.workouts.map((workout) => workout.date),
  ].sort();

  return {
    kind: parsed.kind,
    rows,
    workouts: parsed.workouts,
    categories,
    dateFrom: (allDates[0] as DayKey) ?? null,
    dateTo: (allDates[allDates.length - 1] as DayKey) ?? null,
    examined: parsed.examined,
    invalid: parsed.invalid,
    unsupported: parsed.unsupported,
    errors: parsed.errors,
    warnings: parsed.warnings,
  };
}
