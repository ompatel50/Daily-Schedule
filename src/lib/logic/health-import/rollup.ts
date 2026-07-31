import type { DayKey } from "@/lib/date";
import { HEALTH_METRIC_META, type HealthMetricType } from "@/lib/enums";
import { HEALTH_METRIC_RULES, toCanonical } from "@/lib/logic/health";
import type { AppleParseResult } from "./apple-stream";
import {
  RECORDS_CATEGORY,
  WORKOUTS_CATEGORY,
  type ImportCategory,
  type ImportPlan,
  type NormalizedHealthRow,
  type ParsedFile,
  type RawSample,
} from "./types";

/**
 * Fingerprints and plan assembly.
 *
 * ## The fingerprint is the whole duplicate story
 *
 * Every row carries a key derived from its content, unique per user. Importing
 * the same export twice reproduces the same keys, so the second import writes
 * nothing; importing a *later* export reproduces the keys of the days it
 * shares and adds keys for the days it does not, which is what makes
 * incremental import work without the app tracking "what did I import last
 * time". Nothing about the identity depends on when the file was made or what
 * it was called.
 *
 * The key's shape depends on how the metric behaves:
 *
 *  * **rolled-up metrics** (steps, calories, heart rate, nutrition — anything
 *    summed or averaged over a day) → `ah|type|date|device`. One row per day
 *    per device, so a fuller re-export of the same day *updates* that row
 *    rather than adding a second one.
 *  * **sleep** → `ah|sleep_hours|stage|date|device`, one row per stage.
 *  * **point readings** (weight, blood pressure, VO₂ max…) → the instant and
 *    the value, because two weigh-ins on one day are two facts, not one.
 *  * **anything carrying its own stable id** (a CSV row's `externalId`) → that
 *    id, which is always the most reliable key available.
 *
 * The device is part of the key on purpose: a phone and a watch that both
 * counted the same walk are two independent measurements, and collapsing them
 * into one row would throw one away. Keeping them separate is what lets the
 * aggregation in `health.ts` take the fullest source instead of adding them up.
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

export { RECORDS_CATEGORY, WORKOUTS_CATEGORY };

function categoryLabelFor(key: string): string {
  if (key === WORKOUTS_CATEGORY) return "Workouts";
  if (key === RECORDS_CATEGORY) return "Health records";
  return HEALTH_METRIC_META[key as HealthMetricType]?.label ?? key;
}

/**
 * Group finished rows into the categories the preview offers, so the user
 * chooses per metric rather than all-or-nothing.
 */
function buildCategories(
  rows: NormalizedHealthRow[],
  recordsPerType: Map<string, number>,
  workoutDates: DayKey[],
  recordDates: DayKey[],
): ImportCategory[] {
  const byType = new Map<string, { rows: number; from: DayKey; to: DayKey }>();
  for (const row of rows) {
    const entry = byType.get(row.type);
    if (!entry) {
      byType.set(row.type, { rows: 1, from: row.date, to: row.date });
      continue;
    }
    entry.rows += 1;
    if (row.date < entry.from) entry.from = row.date;
    if (row.date > entry.to) entry.to = row.date;
  }

  const categories: ImportCategory[] = [...byType.entries()].map(([key, entry]) => ({
    key,
    label: categoryLabelFor(key),
    records: recordsPerType.get(key) ?? entry.rows,
    rows: entry.rows,
    dateFrom: entry.from,
    dateTo: entry.to,
  }));

  if (workoutDates.length > 0) {
    const sorted = [...workoutDates].sort();
    categories.push({
      key: WORKOUTS_CATEGORY,
      label: categoryLabelFor(WORKOUTS_CATEGORY),
      records: workoutDates.length,
      rows: workoutDates.length,
      dateFrom: sorted[0],
      dateTo: sorted[sorted.length - 1],
    });
  }
  if (recordDates.length > 0) {
    const sorted = [...recordDates].sort();
    categories.push({
      key: RECORDS_CATEGORY,
      label: categoryLabelFor(RECORDS_CATEGORY),
      records: recordDates.length,
      rows: recordDates.length,
      dateFrom: sorted[0],
      dateTo: sorted[sorted.length - 1],
    });
  }

  categories.sort((a, b) => a.key.localeCompare(b.key));
  return categories;
}

function spanOf(plan: Pick<ImportPlan, "rows" | "workouts" | "records">): {
  dateFrom: DayKey | null;
  dateTo: DayKey | null;
} {
  let from: DayKey | null = null;
  let to: DayKey | null = null;
  const consider = (date: DayKey) => {
    if (from === null || date < from) from = date;
    if (to === null || date > to) to = date;
  };
  for (const row of plan.rows) consider(row.date);
  for (const workout of plan.workouts) consider(workout.date);
  for (const record of plan.records) consider(record.date);
  return { dateFrom: from, dateTo: to };
}

/** Build the plan a CSV import previews and writes from. */
export function buildImportPlan(parsed: ParsedFile): ImportPlan {
  const rows: NormalizedHealthRow[] = [];
  const seen = new Set<string>();
  const recordsPerType = new Map<string, number>();

  for (const sample of parsed.samples) {
    recordsPerType.set(sample.type, (recordsPerType.get(sample.type) ?? 0) + 1);
    const row = normalizeCsvSample(sample);
    if (!row) continue;
    // Within one file, identical fingerprints collapse (a truly duplicated CSV
    // row imports once); the DB upsert handles collisions across files.
    if (seen.has(row.fingerprint)) continue;
    seen.add(row.fingerprint);
    rows.push(row);
  }

  const base = { rows, workouts: parsed.workouts, records: [] };
  const { dateFrom, dateTo } = spanOf(base);

  return {
    kind: parsed.kind,
    ...base,
    categories: buildCategories(
      rows,
      recordsPerType,
      parsed.workouts.map((workout) => workout.date),
      [],
    ),
    dateFrom,
    dateTo,
    examined: parsed.examined,
    invalid: parsed.invalid,
    unsupported: parsed.unsupported,
    errors: parsed.errors,
    warnings: parsed.warnings,
    truncated: false,
  };
}

/**
 * Build the plan an Apple Health import previews and writes from. The rollup
 * already happened during the scan (see `apple-stream.ts`), so this only has
 * to describe what the scan produced.
 */
export function buildApplePlan(parsed: AppleParseResult): ImportPlan {
  const recordsPerType = new Map<string, number>();
  for (const row of parsed.rows) {
    recordsPerType.set(row.type, (recordsPerType.get(row.type) ?? 0) + row.sampleCount);
  }

  const base = { rows: parsed.rows, workouts: parsed.workouts, records: parsed.records };
  const { dateFrom, dateTo } = spanOf(base);

  return {
    kind: "apple_health",
    ...base,
    categories: buildCategories(
      parsed.rows,
      recordsPerType,
      parsed.workouts.map((workout) => workout.date),
      parsed.records.map((record) => record.date),
    ),
    dateFrom,
    dateTo,
    examined: parsed.examined,
    invalid: parsed.invalid,
    unsupported: parsed.unsupported,
    errors: [],
    warnings: parsed.warnings,
    truncated: parsed.truncated,
  };
}
