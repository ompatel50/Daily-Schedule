import type { DayKey } from "@/lib/date";

/**
 * THE health aggregation module.
 *
 * Every surface that turns health-metric rows into a number for a day — goal
 * facts, the day score, the Health page, trends, insights, the dashboard —
 * calls this module. Nothing else may combine health rows, for the same reason
 * nothing else may compute a day score: two formulas drift.
 *
 * Pure: rows in, numbers out. The server measures; this module decides what
 * the measurements mean.
 *
 * ## The aggregation rule, per metric
 *
 * | Metric            | Within one source group        | Across source groups |
 * |-------------------|--------------------------------|----------------------|
 * | steps             | sum                            | max (fullest device) |
 * | active_calories   | sum                            | max                  |
 * | resting_calories  | sum                            | max                  |
 * | hydration_ml      | sum (entries add up)           | max                  |
 * | distance_km       | sum                            | max                  |
 * | sleep_hours       | stage-aware (see below)        | max (fullest source) |
 * | body_weight       | latest reading of the day      | latest overall       |
 * | body_fat          | latest                         | latest overall       |
 * | resting_hr        | average                        | average of groups    |
 * | heart_rate        | avg + preserved min/max        | avg; min/max merged  |
 * | hrv               | average                        | average of groups    |
 * | blood_pressure    | latest (value + secondary)     | latest overall       |
 * | mood / energy     | latest                         | latest overall       |
 *
 * The table lists the original vocabulary; the Apple Health phase added
 * activity, body, heart, respiratory, nutrition, vitals and mindfulness
 * metrics that all reuse those same five kinds — `HEALTH_METRIC_RULES` below
 * is the complete, authoritative list, and nothing outside this module may
 * decide how a metric aggregates.
 *
 * A "source group" is `source + sourceApp` — your watch, your phone, a CSV, a
 * manual entry. Cumulative metrics are summed *within* a group because one
 * device's records genuinely add up, and the *best* group wins across devices
 * because a phone and a watch both counting the same walk must not be added
 * together. This mirrors how Apple Health itself de-duplicates.
 *
 * ## Sleep
 *
 * Sleep rows carry a `subtype` stage (in_bed | asleep | awake | core | deep |
 * rem) and interval bounds. The import rolls raw stage records up into one
 * merged row per (day, source, stage) with overlaps unioned away, and assigns
 * an interval that crosses midnight to the day it *ends* — the night belongs
 * to the morning you woke up. Time asleep is the sum of the asleep-ish stages
 * (asleep, core, deep, rem); `awake` and `in_bed` never count toward it, which
 * is what stops "8h in bed + 7.5h asleep" reading as 15.5 hours. A source with
 * only in-bed records (older watches) falls back to in-bed time. Manual and
 * CSV entries are plain hour totals with no stage.
 */

// --- sources ----------------------------------------------------------------

export const HEALTH_SOURCES = [
  "manual",
  "apple_health",
  "csv",
  "workout",
  "calculated",
  "estimated",
  // Legacy value written by the pre-Phase-11 bulk action; treated like csv.
  "import",
] as const;
export type HealthSource = (typeof HEALTH_SOURCES)[number];

export const HEALTH_SOURCE_META: Record<HealthSource, { label: string; measured: boolean }> = {
  manual: { label: "Manual", measured: false },
  apple_health: { label: "Apple Health", measured: true },
  csv: { label: "CSV import", measured: false },
  workout: { label: "From workouts", measured: false },
  calculated: { label: "Calculated", measured: false },
  estimated: { label: "Estimated", measured: false },
  import: { label: "Import", measured: false },
};

export function sourceLabel(source: string): string {
  return HEALTH_SOURCE_META[source as HealthSource]?.label ?? source;
}

// --- sleep stages -----------------------------------------------------------

export const SLEEP_STAGES = ["in_bed", "asleep", "awake", "core", "deep", "rem"] as const;
export type SleepStage = (typeof SLEEP_STAGES)[number];

/** Stages that count as actually being asleep. */
export const ASLEEP_STAGES: readonly SleepStage[] = ["asleep", "core", "deep", "rem"];

export const SLEEP_STAGE_META: Record<SleepStage, { label: string; asleep: boolean }> = {
  in_bed: { label: "In bed", asleep: false },
  asleep: { label: "Asleep", asleep: true },
  awake: { label: "Awake", asleep: false },
  core: { label: "Core", asleep: true },
  deep: { label: "Deep", asleep: true },
  rem: { label: "REM", asleep: true },
};

// --- units ------------------------------------------------------------------

/**
 * Conversion factors *to* each metric's canonical unit. Adding a unit here is
 * the only step needed to accept it everywhere — the CSV validator, the Apple
 * parser and the aggregator all read this table.
 */
const UNIT_FACTORS: Record<string, Record<string, number>> = {
  mass_kg: { kg: 1, kgs: 1, kilogram: 1, kilograms: 1, lb: 0.453_592_37, lbs: 0.453_592_37, pound: 0.453_592_37, pounds: 0.453_592_37, g: 0.001, st: 6.350_293_18, stone: 6.350_293_18 },
  volume_ml: { ml: 1, milliliter: 1, milliliters: 1, l: 1000, liter: 1000, liters: 1000, litre: 1000, litres: 1000, fl_oz_us: 29.573_529_562_5, floz: 29.573_529_562_5, "fl oz": 29.573_529_562_5, oz: 29.573_529_562_5, cup: 236.588 },
  energy_kcal: { kcal: 1, cal: 1, calories: 1, kj: 1 / 4.184, kilojoule: 1 / 4.184, kilojoules: 1 / 4.184 },
  duration_h: { h: 1, hr: 1, hrs: 1, hour: 1, hours: 1, min: 1 / 60, mins: 1 / 60, minute: 1 / 60, minutes: 1 / 60, s: 1 / 3600, sec: 1 / 3600 },
  duration_min: { min: 1, mins: 1, minute: 1, minutes: 1, h: 60, hr: 60, hrs: 60, hour: 60, hours: 60, s: 1 / 60, sec: 1 / 60, "": 1 },
  distance_km: { km: 1, kilometer: 1, kilometers: 1, mi: 1.609_344, mile: 1.609_344, miles: 1.609_344, m: 0.001, meter: 0.001, meters: 0.001, yd: 0.000_914_4, ft: 0.000_304_8 },
  length_cm: { cm: 1, centimeter: 1, centimeters: 1, m: 100, meter: 100, meters: 100, mm: 0.1, in: 2.54, inch: 2.54, inches: 2.54, ft: 30.48, foot: 30.48, feet: 30.48 },
  // Nutrition arrives in whichever prefix HealthKit chose per nutrient, so the
  // gram/milligram/microgram families each accept all three.
  mass_g: { g: 1, gram: 1, grams: 1, mg: 0.001, mcg: 0.000_001, µg: 0.000_001, ug: 0.000_001, kg: 1000, oz: 28.349_523_125 },
  mass_mg: { mg: 1, milligram: 1, milligrams: 1, g: 1000, gram: 1000, grams: 1000, mcg: 0.001, µg: 0.001, ug: 0.001 },
  mass_mcg: { mcg: 1, µg: 1, ug: 1, microgram: 1, micrograms: 1, mg: 1000, g: 1_000_000 },
  volume_l: { l: 1, liter: 1, liters: 1, litre: 1, litres: 1, ml: 0.001, dl: 0.1, cl: 0.01 },
  flow_l_min: { "l/min": 1, "l/mins": 1, "liters/min": 1, "litres/min": 1, "l/s": 60, "ml/min": 0.001 },
  count: { "": 1, count: 1, steps: 1 },
  bpm: { "": 1, bpm: 1, "count/min": 1, "br/min": 1, "breaths/min": 1 },
  // One "stand hour" is one counted hour, so the count and the hour are the
  // same number — the family accepts both spellings rather than pretending
  // steps could be measured in hours.
  stand_h: { "": 1, count: 1, h: 1, hr: 1, hour: 1, hours: 1 },
  ms: { "": 1, ms: 1, s: 1000, sec: 1000 },
  percent: { "": 1, "%": 1, percent: 1 },
  mmhg: { "": 1, mmhg: 1 },
  score5: { "": 1, "/5": 1 },
  // Ratios and indices HealthKit reports as a bare "count".
  index: { "": 1, count: 1 },
  vo2: { "": 1, "ml/kg·min": 1, "ml/kg*min": 1, "ml/kg/min": 1, "ml/(kg*min)": 1, "ml/(kg·min)": 1, "ml/min·kg": 1 },
  glucose_mgdl: { "": 1, "mg/dl": 1, mgdl: 1, "mmol/l": 18.018_2, mmoll: 18.018_2 },
  // Temperature is the one affine family: degF converts through an offset, not
  // a factor, so it is handled explicitly in `toCanonical` rather than here.
  temp_c: { "": 1, c: 1, degc: 1, "°c": 1, celsius: 1 },
};

type UnitFamily = keyof typeof UNIT_FACTORS;

/** Fahrenheit → Celsius is affine, so it cannot live in the factor table. */
const FAHRENHEIT_UNITS = new Set(["f", "degf", "°f", "fahrenheit"]);

export type HealthAggregationKind = "cumulative" | "latest" | "average" | "sample_range" | "sleep";

export interface HealthMetricRule {
  kind: HealthAggregationKind;
  /** The unit new rows are stored in and aggregation reports in. */
  canonicalUnit: string;
  family: UnitFamily;
  /** Whether summing day values across a week/month means anything. */
  additiveAcrossDays: boolean;
}

export const HEALTH_METRIC_RULES: Record<string, HealthMetricRule> = {
  steps: { kind: "cumulative", canonicalUnit: "", family: "count", additiveAcrossDays: true },
  active_calories: { kind: "cumulative", canonicalUnit: "kcal", family: "energy_kcal", additiveAcrossDays: true },
  resting_calories: { kind: "cumulative", canonicalUnit: "kcal", family: "energy_kcal", additiveAcrossDays: true },
  hydration_ml: { kind: "cumulative", canonicalUnit: "ml", family: "volume_ml", additiveAcrossDays: true },
  distance_km: { kind: "cumulative", canonicalUnit: "km", family: "distance_km", additiveAcrossDays: true },
  sleep_hours: { kind: "sleep", canonicalUnit: "h", family: "duration_h", additiveAcrossDays: true },
  body_weight: { kind: "latest", canonicalUnit: "kg", family: "mass_kg", additiveAcrossDays: false },
  body_fat: { kind: "latest", canonicalUnit: "%", family: "percent", additiveAcrossDays: false },
  resting_hr: { kind: "average", canonicalUnit: "bpm", family: "bpm", additiveAcrossDays: false },
  heart_rate: { kind: "sample_range", canonicalUnit: "bpm", family: "bpm", additiveAcrossDays: false },
  hrv: { kind: "average", canonicalUnit: "ms", family: "ms", additiveAcrossDays: false },
  blood_pressure: { kind: "latest", canonicalUnit: "mmHg", family: "mmhg", additiveAcrossDays: false },
  mood: { kind: "latest", canonicalUnit: "/5", family: "score5", additiveAcrossDays: false },
  energy: { kind: "latest", canonicalUnit: "/5", family: "score5", additiveAcrossDays: false },

  // --- activity ---------------------------------------------------------------
  flights_climbed: { kind: "cumulative", canonicalUnit: "", family: "count", additiveAcrossDays: true },
  exercise_minutes: { kind: "cumulative", canonicalUnit: "min", family: "duration_min", additiveAcrossDays: true },
  stand_hours: { kind: "cumulative", canonicalUnit: "h", family: "stand_h", additiveAcrossDays: true },
  distance_cycling_km: { kind: "cumulative", canonicalUnit: "km", family: "distance_km", additiveAcrossDays: true },
  distance_swimming_km: { kind: "cumulative", canonicalUnit: "km", family: "distance_km", additiveAcrossDays: true },

  // --- body -------------------------------------------------------------------
  height_cm: { kind: "latest", canonicalUnit: "cm", family: "length_cm", additiveAcrossDays: false },
  bmi: { kind: "latest", canonicalUnit: "", family: "index", additiveAcrossDays: false },
  lean_body_mass: { kind: "latest", canonicalUnit: "kg", family: "mass_kg", additiveAcrossDays: false },
  waist_cm: { kind: "latest", canonicalUnit: "cm", family: "length_cm", additiveAcrossDays: false },

  // --- heart ------------------------------------------------------------------
  walking_hr: { kind: "average", canonicalUnit: "bpm", family: "bpm", additiveAcrossDays: false },
  vo2_max: { kind: "latest", canonicalUnit: "ml/kg·min", family: "vo2", additiveAcrossDays: false },

  // --- respiratory ------------------------------------------------------------
  respiratory_rate: { kind: "average", canonicalUnit: "br/min", family: "bpm", additiveAcrossDays: false },
  blood_oxygen: { kind: "average", canonicalUnit: "%", family: "percent", additiveAcrossDays: false },
  peak_flow: { kind: "latest", canonicalUnit: "L/min", family: "flow_l_min", additiveAcrossDays: false },
  forced_vital_capacity: { kind: "latest", canonicalUnit: "L", family: "volume_l", additiveAcrossDays: false },
  fev1: { kind: "latest", canonicalUnit: "L", family: "volume_l", additiveAcrossDays: false },

  // --- nutrition --------------------------------------------------------------
  dietary_calories: { kind: "cumulative", canonicalUnit: "kcal", family: "energy_kcal", additiveAcrossDays: true },
  protein_g: { kind: "cumulative", canonicalUnit: "g", family: "mass_g", additiveAcrossDays: true },
  fat_g: { kind: "cumulative", canonicalUnit: "g", family: "mass_g", additiveAcrossDays: true },
  saturated_fat_g: { kind: "cumulative", canonicalUnit: "g", family: "mass_g", additiveAcrossDays: true },
  carbs_g: { kind: "cumulative", canonicalUnit: "g", family: "mass_g", additiveAcrossDays: true },
  fiber_g: { kind: "cumulative", canonicalUnit: "g", family: "mass_g", additiveAcrossDays: true },
  sugar_g: { kind: "cumulative", canonicalUnit: "g", family: "mass_g", additiveAcrossDays: true },
  cholesterol_mg: { kind: "cumulative", canonicalUnit: "mg", family: "mass_mg", additiveAcrossDays: true },
  sodium_mg: { kind: "cumulative", canonicalUnit: "mg", family: "mass_mg", additiveAcrossDays: true },
  potassium_mg: { kind: "cumulative", canonicalUnit: "mg", family: "mass_mg", additiveAcrossDays: true },
  calcium_mg: { kind: "cumulative", canonicalUnit: "mg", family: "mass_mg", additiveAcrossDays: true },
  iron_mg: { kind: "cumulative", canonicalUnit: "mg", family: "mass_mg", additiveAcrossDays: true },
  magnesium_mg: { kind: "cumulative", canonicalUnit: "mg", family: "mass_mg", additiveAcrossDays: true },
  zinc_mg: { kind: "cumulative", canonicalUnit: "mg", family: "mass_mg", additiveAcrossDays: true },
  caffeine_mg: { kind: "cumulative", canonicalUnit: "mg", family: "mass_mg", additiveAcrossDays: true },
  vitamin_a_mcg: { kind: "cumulative", canonicalUnit: "µg", family: "mass_mcg", additiveAcrossDays: true },
  vitamin_c_mg: { kind: "cumulative", canonicalUnit: "mg", family: "mass_mg", additiveAcrossDays: true },
  vitamin_d_mcg: { kind: "cumulative", canonicalUnit: "µg", family: "mass_mcg", additiveAcrossDays: true },
  vitamin_e_mg: { kind: "cumulative", canonicalUnit: "mg", family: "mass_mg", additiveAcrossDays: true },
  vitamin_b6_mg: { kind: "cumulative", canonicalUnit: "mg", family: "mass_mg", additiveAcrossDays: true },
  vitamin_b12_mcg: { kind: "cumulative", canonicalUnit: "µg", family: "mass_mcg", additiveAcrossDays: true },
  folate_mcg: { kind: "cumulative", canonicalUnit: "µg", family: "mass_mcg", additiveAcrossDays: true },

  // --- vitals -----------------------------------------------------------------
  blood_glucose: { kind: "latest", canonicalUnit: "mg/dL", family: "glucose_mgdl", additiveAcrossDays: false },
  body_temperature: { kind: "latest", canonicalUnit: "°C", family: "temp_c", additiveAcrossDays: false },

  // --- mindfulness ------------------------------------------------------------
  mindful_minutes: { kind: "cumulative", canonicalUnit: "min", family: "duration_min", additiveAcrossDays: true },
};

export function metricRule(type: string): HealthMetricRule | null {
  return HEALTH_METRIC_RULES[type] ?? null;
}

/**
 * Convert a stored value to the metric's canonical unit. Returns null for a
 * unit the metric cannot express — the caller decides whether that means an
 * invalid CSV row or a legacy row to skip; nothing here guesses.
 */
export function toCanonical(type: string, value: number, unit: string): number | null {
  const rule = HEALTH_METRIC_RULES[type];
  if (!rule || !Number.isFinite(value)) return null;
  const normalized = normalizeUnit(unit);
  // Temperature is affine, not proportional: 98.6 °F is 37 °C, not 98.6 × k.
  if (rule.family === "temp_c" && FAHRENHEIT_UNITS.has(normalized)) {
    return ((value - 32) * 5) / 9;
  }
  const factor = UNIT_FACTORS[rule.family][normalized];
  if (factor === undefined) return null;
  return value * factor;
}

export function isSupportedUnit(type: string, unit: string): boolean {
  const rule = HEALTH_METRIC_RULES[type];
  if (!rule) return false;
  const normalized = normalizeUnit(unit);
  if (rule.family === "temp_c" && FAHRENHEIT_UNITS.has(normalized)) return true;
  return UNIT_FACTORS[rule.family][normalized] !== undefined;
}

function normalizeUnit(unit: string): string {
  return unit.trim().toLowerCase();
}

/**
 * Convert a canonical value into the user's display unit.
 *
 * Only mass, distance, length and temperature differ between the two systems;
 * everything else (bpm, %, mg, kcal) reads the same either way and is returned
 * in its canonical unit. The imperial table is keyed by unit *family* rather
 * than by metric so a metric added to a family it already covers — another
 * body measurement in centimetres, say — converts without a second edit.
 */
const IMPERIAL_DISPLAY: Partial<Record<UnitFamily, { unit: string; convert: (value: number) => number }>> = {
  mass_kg: { unit: "lb", convert: (value) => value / 0.453_592_37 },
  distance_km: { unit: "mi", convert: (value) => value / 1.609_344 },
  length_cm: { unit: "in", convert: (value) => value / 2.54 },
  temp_c: { unit: "°F", convert: (value) => (value * 9) / 5 + 32 },
};

export function toDisplay(
  type: string,
  canonicalValue: number,
  unitSystem: string,
): { value: number; unit: string } {
  const rule = HEALTH_METRIC_RULES[type];
  if (!rule) return { value: canonicalValue, unit: "" };
  if (unitSystem !== "metric") {
    const imperial = IMPERIAL_DISPLAY[rule.family];
    if (imperial) return { value: imperial.convert(canonicalValue), unit: imperial.unit };
  }
  return { value: canonicalValue, unit: rule.canonicalUnit };
}

/**
 * The unit a value is shown in — and therefore the unit a manual entry is
 * typed in. The entry form labels the field with this and the server converts
 * from it, so the two can never disagree about what "175" meant.
 */
export function displayUnitFor(type: string, unitSystem: string): string {
  return toDisplay(type, 0, unitSystem).unit;
}

// --- intervals --------------------------------------------------------------

export interface Interval {
  /** Epoch milliseconds. */
  start: number;
  end: number;
}

/** Union of possibly-overlapping intervals — the tool that stops sleep stages double-counting. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const valid = intervals
    .filter((iv) => Number.isFinite(iv.start) && Number.isFinite(iv.end) && iv.end > iv.start)
    .sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const iv of valid) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else merged.push({ ...iv });
  }
  return merged;
}

export function intervalHours(intervals: Interval[]): number {
  return intervals.reduce((total, iv) => total + (iv.end - iv.start), 0) / 3_600_000;
}

// --- daily aggregation ------------------------------------------------------

/** The subset of a HealthMetric row aggregation needs. Dates may arrive as strings straight from JSON. */
export interface HealthRowLike {
  type: string;
  subtype?: string | null;
  value: number;
  unit: string;
  secondaryValue?: number | null;
  minValue?: number | null;
  maxValue?: number | null;
  source: string;
  sourceApp?: string | null;
  date: string;
  recordedAt?: Date | string | null;
  startAt?: Date | string | null;
  endAt?: Date | string | null;
  createdAt?: Date | string | null;
}

export interface DailyMetricValue {
  type: string;
  /** In the metric's canonical unit. */
  value: number;
  unit: string;
  min: number | null;
  max: number | null;
  /** Diastolic for blood pressure; null elsewhere. */
  secondary: number | null;
  /** Every source that reported this metric today, for labelling. */
  sources: string[];
  /** For cumulative metrics: the group whose total was used. */
  usedSource: string | null;
  /** Sleep only: canonical hours per stage from the winning source. */
  stages: Partial<Record<SleepStage, number>> | null;
  /** Raw rows behind the number (for detail views). */
  rowCount: number;
}

function timestampOf(row: HealthRowLike): number {
  const stamp = row.recordedAt ?? row.startAt ?? row.endAt ?? row.createdAt;
  if (!stamp) return 0;
  const time = stamp instanceof Date ? stamp.getTime() : new Date(stamp).getTime();
  return Number.isFinite(time) ? time : 0;
}

function groupKey(row: HealthRowLike): string {
  return `${row.source}|${row.sourceApp ?? ""}`;
}

function groupBySource(rows: HealthRowLike[]): Map<string, HealthRowLike[]> {
  const groups = new Map<string, HealthRowLike[]>();
  for (const row of rows) {
    const key = groupKey(row);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

function distinctSources(rows: HealthRowLike[]): string[] {
  return [...new Set(rows.map((row) => row.source))];
}

/**
 * One day, one metric type → one value, or null when nothing usable was
 * logged. Rows whose unit cannot be converted are ignored rather than poisoning
 * the day — a legacy row in pounds still counts; a row in furlongs does not.
 */
export function aggregateDay(type: string, rows: HealthRowLike[]): DailyMetricValue | null {
  const rule = HEALTH_METRIC_RULES[type];
  if (!rule) return null;

  const usable = rows.filter(
    (row) => row.type === type && toCanonical(type, row.value, row.unit) !== null,
  );
  if (usable.length === 0) return null;

  const base: DailyMetricValue = {
    type,
    value: 0,
    unit: rule.canonicalUnit,
    min: null,
    max: null,
    secondary: null,
    sources: distinctSources(usable),
    usedSource: null,
    stages: null,
    rowCount: usable.length,
  };

  switch (rule.kind) {
    case "cumulative": {
      let best: { total: number; source: string } | null = null;
      for (const [, group] of groupBySource(usable)) {
        const total = group.reduce(
          (sum, row) => sum + (toCanonical(type, row.value, row.unit) ?? 0),
          0,
        );
        if (!best || total > best.total) best = { total, source: group[0].source };
      }
      base.value = best?.total ?? 0;
      base.usedSource = best?.source ?? null;
      return base;
    }
    case "latest": {
      const latest = [...usable].sort((a, b) => timestampOf(a) - timestampOf(b))[usable.length - 1];
      base.value = toCanonical(type, latest.value, latest.unit) ?? 0;
      base.secondary = latest.secondaryValue ?? null;
      base.usedSource = latest.source;
      return base;
    }
    case "average": {
      const values = usable.map((row) => toCanonical(type, row.value, row.unit) ?? 0);
      base.value = values.reduce((sum, v) => sum + v, 0) / values.length;
      return base;
    }
    case "sample_range": {
      const values = usable.map((row) => toCanonical(type, row.value, row.unit) ?? 0);
      base.value = values.reduce((sum, v) => sum + v, 0) / values.length;
      base.min = Math.min(...usable.map((row) => row.minValue ?? row.value));
      base.max = Math.max(...usable.map((row) => row.maxValue ?? row.value));
      return base;
    }
    case "sleep": {
      let best: { total: number; source: string; stages: Partial<Record<SleepStage, number>> } | null =
        null;
      for (const [, group] of groupBySource(usable)) {
        const summary = sleepGroupSummary(group);
        if (!best || summary.total > best.total) {
          best = { total: summary.total, source: group[0].source, stages: summary.stages };
        }
      }
      base.value = best?.total ?? 0;
      base.usedSource = best?.source ?? null;
      base.stages = best && Object.keys(best.stages).length > 0 ? best.stages : null;
      return base;
    }
  }
}

/**
 * Time asleep for one source's day. Stage rows arrive already union-merged per
 * stage (the import does that), so summing the asleep-ish stages is summing
 * disjoint spans. Plain rows (no stage) are manual/CSV hour totals.
 */
function sleepGroupSummary(group: HealthRowLike[]): {
  total: number;
  stages: Partial<Record<SleepStage, number>>;
} {
  const stages: Partial<Record<SleepStage, number>> = {};
  let asleep = 0;
  let plain = 0;
  let inBed = 0;

  for (const row of group) {
    const hours = toCanonical("sleep_hours", row.value, row.unit) ?? 0;
    const stage = (row.subtype ?? null) as SleepStage | null;
    if (stage && SLEEP_STAGE_META[stage]) {
      stages[stage] = (stages[stage] ?? 0) + hours;
      if (SLEEP_STAGE_META[stage].asleep) asleep += hours;
      if (stage === "in_bed") inBed += hours;
    } else {
      plain += hours;
    }
  }

  // Preference order: real asleep stages, then a plain total, then in-bed time.
  const total = asleep > 0 ? asleep : plain > 0 ? plain : inBed;
  return { total, stages };
}

/** Aggregate every metric present in a day's rows. */
export function aggregateDayAll(rows: HealthRowLike[]): Map<string, DailyMetricValue> {
  const byType = new Map<string, HealthRowLike[]>();
  for (const row of rows) {
    const group = byType.get(row.type);
    if (group) group.push(row);
    else byType.set(row.type, [row]);
  }
  const result = new Map<string, DailyMetricValue>();
  for (const [type, group] of byType) {
    const value = aggregateDay(type, group);
    if (value) result.set(type, value);
  }
  return result;
}

/**
 * Per-day series over a range, for trends. Days with no data are null, never
 * zero — "didn't wear the watch" and "walked 0 steps" must chart differently.
 */
export function aggregateSeries(
  type: string,
  rows: HealthRowLike[],
  days: DayKey[],
): Array<{ date: DayKey; value: number | null; min: number | null; max: number | null }> {
  const byDay = new Map<string, HealthRowLike[]>();
  for (const row of rows) {
    if (row.type !== type) continue;
    const group = byDay.get(row.date);
    if (group) group.push(row);
    else byDay.set(row.date, [row]);
  }
  return days.map((date) => {
    const value = aggregateDay(type, byDay.get(date) ?? []);
    return {
      date,
      value: value ? round2(value.value) : null,
      min: value?.min ?? null,
      max: value?.max ?? null,
    };
  });
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
