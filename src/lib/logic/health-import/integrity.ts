/**
 * Integrity rules for imported health data — pure, so every judgement below is
 * testable without a database, and so the server module that runs them only has
 * to decide *which* cheap queries to ask.
 *
 * ## What this is for
 *
 * An import reads a file this app did not write, in a format Apple can change,
 * across a decade of a stranger's devices. Most of what goes wrong is caught at
 * parse time and refused. What survives that is the quiet kind: a unit the
 * metric cannot express, so the row stores fine and reads as null forever; a
 * reading dated in the future because a device's clock was wrong; a row with no
 * fingerprint, which a re-import can neither recognise nor skip.
 *
 * None of these are errors the user caused, and none of them announce
 * themselves. So the app looks, and says what it found.
 *
 * ## What it deliberately is not
 *
 * Not a repair tool. Every finding is read-only and states what it means; the
 * app never silently rewrites a stored reading on the strength of a heuristic.
 * Not a full-table scan either — see `src/server/health-integrity.ts`, where
 * every check is an aggregate the database answers from an index.
 */

import { HEALTH_METRIC_META, type HealthMetricType } from "@/lib/enums";
import { isSupportedUnit } from "@/lib/logic/health";

export type IntegritySeverity = "problem" | "note";

export interface IntegrityFinding {
  /** Stable key, so the UI can render and test can assert without prose. */
  code:
    | "unknown_metric_type"
    | "unreadable_unit"
    | "implausible_value"
    | "future_dated"
    | "missing_fingerprint"
    | "orphaned_batch"
    | "failed_import";
  severity: IntegritySeverity;
  /** How many rows (or batches) the finding covers. */
  count: number;
  title: string;
  /** What it means and what, if anything, to do — one or two sentences. */
  detail: string;
}

/**
 * Plausible bounds per metric, in the metric's **canonical** unit.
 *
 * Deliberately absurd rather than clinical: the job is to catch a unit mix-up
 * or a corrupt row, not to second-guess a real body. A resting heart rate of
 * 35 bpm is a well-trained athlete and must not be flagged; 4,000 bpm is a
 * parse error. Metrics without an entry are only checked for negativity.
 */
export const PLAUSIBLE_BOUNDS: Partial<Record<HealthMetricType, { min: number; max: number }>> = {
  steps: { min: 0, max: 300_000 },
  active_calories: { min: 0, max: 20_000 },
  resting_calories: { min: 0, max: 10_000 },
  distance_km: { min: 0, max: 1_000 },
  distance_cycling_km: { min: 0, max: 2_000 },
  distance_swimming_km: { min: 0, max: 100 },
  flights_climbed: { min: 0, max: 5_000 },
  exercise_minutes: { min: 0, max: 1_440 },
  stand_hours: { min: 0, max: 24 },
  // A sleep row is one stage of one night, so it cannot exceed a day.
  sleep_hours: { min: 0, max: 24 },
  resting_hr: { min: 20, max: 250 },
  heart_rate: { min: 20, max: 300 },
  walking_hr: { min: 20, max: 300 },
  hrv: { min: 0, max: 1_000 },
  vo2_max: { min: 0, max: 100 },
  body_weight: { min: 1, max: 700 },
  body_fat: { min: 0, max: 100 },
  bmi: { min: 5, max: 150 },
  lean_body_mass: { min: 1, max: 500 },
  height_cm: { min: 30, max: 280 },
  waist_cm: { min: 20, max: 300 },
  blood_oxygen: { min: 0, max: 100 },
  respiratory_rate: { min: 0, max: 200 },
  blood_pressure: { min: 20, max: 350 },
  blood_glucose: { min: 0, max: 1_500 },
  body_temperature: { min: 20, max: 50 },
  hydration_ml: { min: 0, max: 30_000 },
  dietary_calories: { min: 0, max: 30_000 },
  mindful_minutes: { min: 0, max: 1_440 },
};

/** A per-type min/max the database can produce in one aggregate query. */
export interface MetricExtent {
  type: string;
  min: number | null;
  max: number | null;
  count: number;
}

/** A per-(type, unit) row count, likewise one grouped query. */
export interface UnitUsage {
  type: string;
  unit: string;
  count: number;
}

function known(type: string): type is HealthMetricType {
  return Object.prototype.hasOwnProperty.call(HEALTH_METRIC_META, type);
}

function labelFor(type: string): string {
  return known(type) ? HEALTH_METRIC_META[type].label : type;
}

/**
 * Rows stored under a metric name this app has no rules for. They are invisible
 * everywhere — no page lists them, no aggregation reads them — so a count is
 * the only way anyone would ever know they exist.
 */
export function checkUnknownTypes(extents: MetricExtent[]): IntegrityFinding | null {
  const unknown = extents.filter((extent) => !known(extent.type));
  if (unknown.length === 0) return null;
  const count = unknown.reduce((sum, extent) => sum + extent.count, 0);
  const names = unknown
    .map((extent) => extent.type)
    .slice(0, 5)
    .join(", ");
  return {
    code: "unknown_metric_type",
    severity: "problem",
    count,
    title: `${count} reading${count === 1 ? "" : "s"} of ${unknown.length} unrecognised metric${unknown.length === 1 ? "" : "s"}`,
    detail:
      `Stored under ${names}${unknown.length > 5 ? ", and others" : ""}, which this app has no rules for — ` +
      "they are kept but never shown or counted anywhere. They usually arrive from a backup written by a different version.",
  };
}

/**
 * Rows whose unit the metric cannot convert. These are the dangerous ones:
 * the row stores, but every aggregation drops it, so a chart silently loses
 * days and an average is computed over the rows that happened to survive.
 */
export function checkUnreadableUnits(usage: UnitUsage[]): IntegrityFinding | null {
  const bad = usage.filter((entry) => known(entry.type) && !isSupportedUnit(entry.type, entry.unit));
  if (bad.length === 0) return null;
  const count = bad.reduce((sum, entry) => sum + entry.count, 0);
  const examples = bad
    .slice(0, 4)
    .map((entry) => `${labelFor(entry.type)} in "${entry.unit || "(no unit)"}"`)
    .join(", ");
  return {
    code: "unreadable_unit",
    severity: "problem",
    count,
    title: `${count} reading${count === 1 ? "" : "s"} stored in a unit that cannot be read back`,
    detail:
      `${examples}${bad.length > 4 ? ", and others" : ""}. These rows are skipped by every chart and average, ` +
      "so the numbers you see are computed without them. Re-importing the export they came from replaces them with readable rows.",
  };
}

/**
 * Readings outside any plausible range for their metric. Almost always a unit
 * mix-up upstream (grams recorded as milligrams) or a corrupt sample.
 */
export function checkImplausibleValues(extents: MetricExtent[]): IntegrityFinding | null {
  const offenders: string[] = [];
  let affected = 0;
  for (const extent of extents) {
    if (!known(extent.type)) continue;
    const bounds = PLAUSIBLE_BOUNDS[extent.type] ?? { min: 0, max: Number.POSITIVE_INFINITY };
    const belowMin = extent.min !== null && extent.min < bounds.min;
    const aboveMax = extent.max !== null && extent.max > bounds.max;
    if (!belowMin && !aboveMax) continue;
    // The extent is a min/max, so the exact number of offending rows is not
    // known without a scan. Reporting the metric — and the value that is out of
    // range — is what makes it actionable; the count stays honest as "at least".
    affected += 1;
    offenders.push(
      `${labelFor(extent.type)} ${belowMin ? `as low as ${round(extent.min as number)}` : `as high as ${round(extent.max as number)}`}`,
    );
  }
  if (offenders.length === 0) return null;
  return {
    code: "implausible_value",
    severity: "problem",
    count: affected,
    title: `${affected} metric${affected === 1 ? "" : "s"} hold${affected === 1 ? "s" : ""} a reading outside any plausible range`,
    detail:
      `${offenders.slice(0, 4).join(", ")}${offenders.length > 4 ? ", and others" : ""}. ` +
      "A single wrong row skews the average and the chart's scale for its whole range. Open the metric's page to find the day and correct or delete it.",
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function checkFutureDated(count: number, today: string): IntegrityFinding | null {
  if (count <= 0) return null;
  return {
    code: "future_dated",
    severity: "problem",
    count,
    title: `${count} reading${count === 1 ? "" : "s"} dated after today`,
    detail:
      `Dated later than ${today}. Usually a device whose clock or timezone was wrong when the export was taken. ` +
      "They sit outside every range the Health pages offer, so they are stored but never shown.",
  };
}

export function checkMissingFingerprints(count: number): IntegrityFinding | null {
  if (count <= 0) return null;
  return {
    code: "missing_fingerprint",
    severity: "note",
    count,
    title: `${count} reading${count === 1 ? "" : "s"} without a deduplication key`,
    detail:
      "These predate fingerprinting or arrived in an old backup. They display normally, but a future import cannot recognise them as already present, so it may add a second copy of the same day.",
  };
}

export function checkOrphanedBatchLinks(count: number): IntegrityFinding | null {
  if (count <= 0) return null;
  return {
    code: "orphaned_batch",
    severity: "note",
    count,
    title: `${count} reading${count === 1 ? "" : "s"} belong to an import that was undone`,
    detail:
      "The import was undone but these rows survived it — which is the intended behaviour for a row you had edited or built on. They are yours now; nothing further will remove them.",
  };
}

export function checkFailedImports(count: number): IntegrityFinding | null {
  if (count <= 0) return null;
  return {
    code: "failed_import",
    severity: "note",
    count,
    title: `${count} import${count === 1 ? "" : "s"} failed`,
    detail:
      "A failed import is rolled back whole, so nothing it read was written. They are listed below with their reference so a recurring failure can be traced.",
  };
}

export interface IntegrityReport {
  findings: IntegrityFinding[];
  problems: number;
  notes: number;
  /** True when every check passed — worth saying out loud. */
  clean: boolean;
}

export function buildIntegrityReport(
  findings: Array<IntegrityFinding | null>,
): IntegrityReport {
  const present = findings.filter((finding): finding is IntegrityFinding => finding !== null);
  // Problems first: a note is context, a problem is something to act on.
  present.sort((a, b) => (a.severity === b.severity ? b.count - a.count : a.severity === "problem" ? -1 : 1));
  const problems = present.filter((finding) => finding.severity === "problem").length;
  return {
    findings: present,
    problems,
    notes: present.length - problems,
    clean: present.length === 0,
  };
}
