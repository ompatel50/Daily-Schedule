import type { DayKey } from "@/lib/date";
import type { HealthRecordKind } from "@/lib/enums";
import {
  HEALTH_METRIC_RULES,
  intervalHours,
  mergeIntervals,
  toCanonical,
  type Interval,
  type SleepStage,
} from "@/lib/logic/health";
import {
  ACTIVITY_SUMMARY_FIELDS,
  APPLE_DIASTOLIC,
  APPLE_SLEEP_MAP,
  APPLE_SYSTOLIC,
  APPLE_TYPE_MAP,
  APPLE_WORKOUT_MAP,
  appleTypeDisplayName,
  DURATION_CATEGORY_TYPES,
  WORKOUT_DISTANCE_STATS,
  WORKOUT_ENERGY_STAT,
  WORKOUT_HEART_RATE_STAT,
  workoutDisplayName,
} from "./apple-types";
import { fingerprintFor } from "./rollup";
import type { NormalizedHealthRow, RawWorkout } from "./types";
import { XmlScanner, type XmlStartEvent } from "./xml-scanner";

/**
 * Streaming Apple Health parsing: XML in, database-ready rows out, in bounded
 * memory.
 *
 * ## Why an accumulator rather than a list of samples
 *
 * An Apple Health export is one flat file of every individual sensor reading
 * a decade of watches produced — hundreds of step samples and tens of
 * thousands of heart-rate samples per day. The obvious pipeline (collect every
 * sample, then roll them up) needs memory proportional to the *file*, which
 * for a real ten-year export means many gigabytes and an immediate crash.
 *
 * So the rollup happens *during* the scan. Each record is folded straight into
 * an accumulator keyed by (metric, day, source app), and the accumulators are
 * all that is ever held: memory is proportional to **distinct days × metrics ×
 * devices**, not to the number of samples. A decade of data is a few hundred
 * thousand small objects regardless of whether the file is 200 MB or 8 GB.
 *
 * Three kinds of data do not fold that way and are kept individually, each
 * under an explicit cap so a hostile or broken file cannot exhaust memory:
 * point readings (weight, blood pressure, VO₂ max…), workouts, and the
 * non-numeric records (ECG, medication, clinical, route). Hitting a cap sets
 * `truncated` and is reported to the user rather than silently dropping data.
 *
 * ## What it never does
 *
 * No network access, no file access, no logging of record contents. Unknown
 * record types are counted and skipped; a malformed record is counted and
 * skipped. Only a structurally broken *document* is fatal, and that comes from
 * the scanner (see `xml-scanner.ts`, which is where the XXE and entity-
 * expansion defences live).
 */

// --- caps -------------------------------------------------------------------

/** Distinct (metric, day, device) buckets. A decade of data is far below this. */
export const MAX_ACCUMULATORS = 500_000;
/** Individual readings kept whole (weight, blood pressure, VO₂ max, …). */
export const MAX_POINT_ROWS = 250_000;
export const MAX_WORKOUTS = 100_000;
export const MAX_RECORDS = 100_000;
/** Stage intervals held per (night, device, stage) before the union is forced. */
const MAX_INTERVALS_PER_BUCKET = 2_000;
const MAX_WARNINGS = 25;

// --- output -----------------------------------------------------------------

export interface RawHealthRecord {
  kind: HealthRecordKind;
  date: DayKey;
  recordedAt: string | null;
  startAt: string | null;
  endAt: string | null;
  title: string;
  subtitle: string | null;
  value: number | null;
  unit: string;
  /** Kind-specific fields, display-only, bounded at write time. */
  detail: Record<string, string | number>;
  sourceApp: string | null;
  externalId: string | null;
  fingerprint: string;
}

export interface AppleParseResult {
  rows: NormalizedHealthRow[];
  workouts: RawWorkout[];
  records: RawHealthRecord[];
  /** Apple identifiers this app does not track → how many were seen. */
  unsupported: Record<string, number>;
  /** Records looked at, valid or not. */
  examined: number;
  /** Records that failed validation. */
  invalid: number;
  warnings: string[];
  /** True when a cap was hit and some data was deliberately not kept. */
  truncated: boolean;
}

// --- internal accumulators ---------------------------------------------------

interface MetricBucket {
  type: string;
  date: DayKey;
  sourceApp: string | null;
  sourceDevice: string | null;
  sum: number;
  count: number;
  min: number;
  max: number;
  firstStart: string | null;
  lastEnd: string | null;
}

interface SleepBucket {
  date: DayKey;
  sourceApp: string | null;
  sourceDevice: string | null;
  stage: SleepStage;
  intervals: Interval[];
  /** Hours already unioned away when the interval list was compacted. */
  compactedHours: number;
  count: number;
}

interface PendingBloodPressure {
  systolic: number | null;
  diastolic: number | null;
  date: DayKey;
  startAt: string;
  sourceApp: string | null;
  sourceDevice: string | null;
}

const round = (value: number, places = 3): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/**
 * Apple's timestamp format: `2026-03-14 07:31:02 -0400`.
 *
 * The day key is taken from the string *as written*. The export was made in
 * the device's timezone, and re-interpreting it through the server's clock
 * would move every record near midnight onto the wrong day — for a server in
 * UTC and a user in Los Angeles, that is a third of the evening's steps.
 */
export function parseAppleDate(raw: string | undefined): { day: DayKey; iso: string } | null {
  if (!raw) return null;
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const iso = `${match[1]}T${match[2]}${match[3]}${match[4]}:${match[5]}`;
  if (Number.isNaN(new Date(iso).getTime())) return null;
  return { day: match[1] as DayKey, iso };
}

/** Trims Apple's device attribute down to a short human-readable name. */
export function deviceName(raw: string | undefined): string | null {
  if (!raw) return null;
  // `<<HKDevice: 0x…>, name:Apple Watch, manufacturer:Apple Inc., model:Watch, …>`
  const name = /name:([^,>]+)/.exec(raw)?.[1]?.trim();
  return name ? name.slice(0, 120) : null;
}

export class AppleHealthAccumulator {
  private readonly scanner: XmlScanner;

  private readonly metrics = new Map<string, MetricBucket>();
  private readonly sleep = new Map<string, SleepBucket>();
  private readonly pointRows: NormalizedHealthRow[] = [];
  private readonly workouts: RawWorkout[] = [];
  private readonly records: RawHealthRecord[] = [];
  private readonly bloodPressure = new Map<string, PendingBloodPressure>();
  private readonly unsupported: Record<string, number> = {};
  private readonly warnings: string[] = [];

  private examined = 0;
  private invalid = 0;
  private truncated = false;
  private sawHealthData = false;

  /** The workout currently being read, so its children can be attached. */
  private openWorkout: {
    attributes: Record<string, string>;
    depth: number;
    distanceKm: number | null;
    calories: number | null;
    avgHeartRate: number | null;
    routes: number;
  } | null = null;

  constructor() {
    this.scanner = new XmlScanner({
      onStart: (event) => this.onStart(event),
      onEnd: (name, depth) => this.onEnd(name, depth),
    });
  }

  write(chunk: string): void {
    this.scanner.write(chunk);
  }

  end(): void {
    this.scanner.end();
  }

  /** True once the root `<HealthData>` element has been seen. */
  get looksLikeAppleExport(): boolean {
    return this.sawHealthData;
  }

  // --- events ---------------------------------------------------------------

  private onStart(event: XmlStartEvent): void {
    switch (event.name) {
      case "HealthData":
        this.sawHealthData = true;
        return;
      case "Record":
        this.handleRecord(event.attributes);
        return;
      case "Workout":
        this.handleWorkoutStart(event);
        return;
      case "WorkoutStatistics":
        this.handleWorkoutStatistics(event.attributes);
        return;
      case "WorkoutRoute":
        if (this.openWorkout) this.openWorkout.routes += 1;
        return;
      case "ActivitySummary":
        this.handleActivitySummary(event.attributes);
        return;
      case "ClinicalRecord":
        this.handleClinicalRecord(event.attributes);
        return;
      default:
        // Correlation wrappers (blood pressure) contain the Records that
        // matter and carry nothing of their own; Me, ExportDate, MetadataEntry
        // and the rest are structure, not data.
        return;
    }
  }

  private onEnd(name: string, depth: number): void {
    if (name === "Workout" && this.openWorkout && this.openWorkout.depth === depth) {
      this.flushWorkout();
    }
  }

  // --- records --------------------------------------------------------------

  private handleRecord(attributes: Record<string, string>): void {
    this.examined += 1;
    const appleType = attributes.type ?? "";

    if (appleType === APPLE_SYSTOLIC || appleType === APPLE_DIASTOLIC) {
      this.handleBloodPressure(appleType, attributes);
      return;
    }

    const type = APPLE_TYPE_MAP[appleType];
    if (!type) {
      this.countUnsupported(appleType || "(no type)");
      return;
    }

    const start = parseAppleDate(attributes.startDate);
    const end = parseAppleDate(attributes.endDate);
    if (!start) {
      this.markInvalid(`a ${appleTypeDisplayName(appleType)} record had no usable start date`);
      return;
    }

    if (type === "sleep_hours") {
      this.handleSleep(attributes, start, end);
      return;
    }

    // Stand hours are a category record whose value says whether the hour was
    // stood or idle. Only a stood hour counts, and it counts as one.
    if (appleType === "HKCategoryTypeIdentifierAppleStandHour") {
      if (attributes.value !== "HKCategoryValueAppleStandHourStood") return;
      this.addToBucket(type, start.day, attributes, 1, "count", start.iso, end?.iso ?? start.iso);
      return;
    }

    // Mindful sessions carry no value — the session's length is the datum.
    const durationRule = DURATION_CATEGORY_TYPES[appleType];
    if (durationRule) {
      if (!end) {
        this.markInvalid("a mindful session had no usable end date");
        return;
      }
      const minutes = (new Date(end.iso).getTime() - new Date(start.iso).getTime()) / 60_000;
      if (!(minutes > 0) || minutes > 24 * 60) {
        this.markInvalid("a mindful session had a non-positive or absurd duration");
        return;
      }
      this.addToBucket(type, start.day, attributes, minutes, durationRule.unit, start.iso, end.iso);
      return;
    }

    const value = Number(attributes.value);
    if (!Number.isFinite(value) || value < 0) {
      this.markInvalid(`a ${appleTypeDisplayName(appleType)} record had a non-numeric value`);
      return;
    }
    // HealthKit expresses proportions as 0–1 scalars; our percentages are 0–100.
    const adjusted =
      (type === "body_fat" || type === "blood_oxygen") && value <= 1 ? value * 100 : value;

    const rule = HEALTH_METRIC_RULES[type];
    if (!rule) return;
    if (rule.kind === "latest") {
      this.addPointRow(type, start.day, attributes, adjusted, attributes.unit ?? "", start.iso, end?.iso ?? null);
      return;
    }
    this.addToBucket(type, start.day, attributes, adjusted, attributes.unit ?? "", start.iso, end?.iso ?? null);
  }

  /**
   * Blood pressure arrives as two records that only mean something together.
   * They share a start instant, so that is the pairing key; a systolic reading
   * whose diastolic never arrives is dropped rather than reported half-read.
   */
  private handleBloodPressure(appleType: string, attributes: Record<string, string>): void {
    const start = parseAppleDate(attributes.startDate);
    const value = Number(attributes.value);
    if (!start || !Number.isFinite(value) || value <= 0) {
      this.markInvalid("a blood-pressure record had no usable date or value");
      return;
    }
    const app = attributes.sourceName?.trim() || null;
    const key = `${start.iso}|${app ?? ""}`;
    const pending = this.bloodPressure.get(key) ?? {
      systolic: null,
      diastolic: null,
      date: start.day,
      startAt: start.iso,
      sourceApp: app,
      sourceDevice: deviceName(attributes.device),
    };
    if (appleType === APPLE_SYSTOLIC) pending.systolic = value;
    else pending.diastolic = value;

    if (pending.systolic !== null && pending.diastolic !== null) {
      this.bloodPressure.delete(key);
      this.pushPointRow({
        type: "blood_pressure",
        subtype: null,
        value: round(pending.systolic),
        unit: "mmHg",
        minValue: null,
        maxValue: null,
        secondaryValue: round(pending.diastolic),
        date: pending.date,
        startAt: pending.startAt,
        endAt: null,
        source: "apple_health",
        sourceApp: pending.sourceApp,
        sourceDevice: pending.sourceDevice,
        externalId: null,
        notes: null,
        sampleCount: 1,
      });
    } else {
      this.bloodPressure.set(key, pending);
    }
  }

  private handleSleep(
    attributes: Record<string, string>,
    start: { day: DayKey; iso: string },
    end: { day: DayKey; iso: string } | null,
  ): void {
    const stage = APPLE_SLEEP_MAP[attributes.value ?? ""];
    if (!stage || !end) {
      this.markInvalid(`a sleep record had ${!stage ? "an unknown stage" : "no usable end date"}`);
      return;
    }
    const from = new Date(start.iso).getTime();
    const to = new Date(end.iso).getTime();
    const hours = (to - from) / 3_600_000;
    if (!(hours > 0) || hours > 48) {
      this.markInvalid("a sleep record had a non-positive or absurd duration");
      return;
    }

    // Sleep belongs to the day it *ends* — the morning you woke up on.
    const app = attributes.sourceName?.trim() || null;
    const key = `${end.day}|${app ?? ""}|${stage}`;
    let bucket = this.sleep.get(key);
    if (!bucket) {
      if (!this.reserveAccumulator()) return;
      bucket = {
        date: end.day,
        sourceApp: app,
        sourceDevice: deviceName(attributes.device),
        stage,
        intervals: [],
        compactedHours: 0,
        count: 0,
      };
      this.sleep.set(key, bucket);
    }
    bucket.intervals.push({ start: from, end: to });
    bucket.count += 1;
    if (bucket.intervals.length >= MAX_INTERVALS_PER_BUCKET) {
      // Union what is held and carry only the total forward. Overlaps within
      // the compacted span are already removed, so the night still cannot
      // double-count itself.
      bucket.compactedHours += intervalHours(mergeIntervals(bucket.intervals));
      bucket.intervals = [];
    }
  }

  // --- workouts -------------------------------------------------------------

  private handleWorkoutStart(event: XmlStartEvent): void {
    this.examined += 1;
    this.openWorkout = {
      attributes: event.attributes,
      depth: event.depth,
      distanceKm: null,
      calories: null,
      avgHeartRate: null,
      routes: 0,
    };
    // A self-closing `<Workout …/>` has no children and no matching onEnd.
    if (event.selfClosing) this.flushWorkout();
  }

  private handleWorkoutStatistics(attributes: Record<string, string>): void {
    const open = this.openWorkout;
    if (!open) return;
    const type = attributes.type ?? "";
    if (WORKOUT_DISTANCE_STATS.has(type)) {
      open.distanceKm = readDistanceKm(attributes.sum, attributes.unit) ?? open.distanceKm;
    } else if (type === WORKOUT_ENERGY_STAT) {
      open.calories = readCalories(attributes.sum, attributes.unit) ?? open.calories;
    } else if (type === WORKOUT_HEART_RATE_STAT) {
      const average = Number(attributes.average);
      if (Number.isFinite(average) && average > 0) open.avgHeartRate = Math.round(average);
    }
  }

  private flushWorkout(): void {
    const open = this.openWorkout;
    this.openWorkout = null;
    if (!open) return;

    const attributes = open.attributes;
    const start = parseAppleDate(attributes.startDate);
    const end = parseAppleDate(attributes.endDate);
    if (!start || !end) {
      this.markInvalid("a workout had no usable dates");
      return;
    }

    const activity = attributes.workoutActivityType ?? "";
    let durationMin = readWorkoutMinutes(attributes);
    if (durationMin === null) {
      const elapsed = (new Date(end.iso).getTime() - new Date(start.iso).getTime()) / 60_000;
      durationMin = elapsed > 0 ? Math.round(elapsed) : null;
    }
    if (durationMin === null || durationMin <= 0 || durationMin > 24 * 60) {
      this.markInvalid("a workout had a non-positive or absurd duration");
      return;
    }

    // Distance and energy live on the open tag in older exports and in
    // <WorkoutStatistics> children in newer ones. Read both, prefer the tag.
    const distanceKm =
      readDistanceKm(attributes.totalDistance, attributes.totalDistanceUnit) ?? open.distanceKm;
    const calories =
      readCalories(attributes.totalEnergyBurned, attributes.totalEnergyBurnedUnit) ?? open.calories;
    // The export carries no per-workout UUID; start + activity is stable
    // across re-exports of the same data, which is what dedup needs.
    const externalId = `ah:${start.iso}:${activity}`;

    if (this.workouts.length >= MAX_WORKOUTS) {
      this.truncated = true;
      return;
    }
    this.workouts.push({
      type: APPLE_WORKOUT_MAP[activity] ?? "custom",
      name: workoutDisplayName(activity),
      date: start.day,
      time: start.iso.slice(11, 16),
      startAt: start.iso,
      endAt: end.iso,
      durationMin,
      distanceKm,
      caloriesBurned: calories === null ? null : Math.round(calories),
      avgHeartRate: open.avgHeartRate,
      sourceApp: attributes.sourceName?.trim() || null,
      externalId,
    });

    // The route's *metadata* only: how many were recorded, and over what span.
    // Coordinates are never read from export.xml and never stored.
    if (open.routes > 0) {
      this.pushRecord({
        kind: "workout_route",
        date: start.day,
        recordedAt: start.iso,
        startAt: start.iso,
        endAt: end.iso,
        title: `${workoutDisplayName(activity)} route`,
        subtitle: distanceKm !== null ? `${round(distanceKm, 2)} km recorded` : "GPS route recorded",
        value: distanceKm,
        unit: distanceKm !== null ? "km" : "",
        detail: { routes: open.routes, durationMin },
        sourceApp: attributes.sourceName?.trim() || null,
        externalId,
        fingerprint: `ahr|workout_route|${externalId}`,
      });
    }
  }

  // --- activity summaries ----------------------------------------------------

  /**
   * `<ActivitySummary>` is one row per day carrying the ring totals Apple
   * itself computed. Using it is both cheaper and more faithful than
   * re-deriving stand hours from thousands of hourly category records — and it
   * is the only place a day's *goal* values appear.
   */
  private handleActivitySummary(attributes: Record<string, string>): void {
    this.examined += 1;
    const date = attributes.dateComponents;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      this.markInvalid("an activity summary had no usable date");
      return;
    }
    for (const field of ACTIVITY_SUMMARY_FIELDS) {
      const value = Number(attributes[field.attribute]);
      if (!Number.isFinite(value) || value <= 0) continue;
      const unit = (field.unitAttribute ? attributes[field.unitAttribute] : null) ?? field.fallbackUnit;
      this.addToBucket(
        field.type,
        date as DayKey,
        // Attributed to the ring summary rather than to a device, so it forms
        // its own source group and can never be summed with the watch's own
        // per-sample records for the same day.
        { sourceName: "Activity summary" },
        value,
        unit,
        null,
        null,
      );
    }
  }

  // --- clinical records -----------------------------------------------------

  /**
   * `<ClinicalRecord>` elements describe documents a connected health provider
   * shared. Only the metadata is read: the FHIR payload itself lives in a
   * separate JSON file inside the archive and is never opened, so diagnoses,
   * lab values and notes are not copied into this app.
   */
  private handleClinicalRecord(attributes: Record<string, string>): void {
    this.examined += 1;
    const identifier = attributes.identifier?.trim();
    const appleType = attributes.type?.trim() ?? "";
    const received = parseAppleDate(attributes.receivedDate);
    const day = received?.day ?? attributes.receivedDate?.slice(0, 10);
    if (!identifier || !day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      this.markInvalid("a clinical record had no usable identifier or date");
      return;
    }

    const isMedication = /medication/i.test(appleType);
    this.pushRecord({
      kind: isMedication ? "medication" : "clinical",
      date: day as DayKey,
      recordedAt: received?.iso ?? null,
      startAt: received?.iso ?? null,
      endAt: null,
      title: attributes.displayName?.trim() || appleTypeDisplayName(appleType) || "Clinical record",
      subtitle: attributes.sourceName?.trim() || null,
      value: null,
      unit: "",
      detail: {
        type: appleType,
        ...(attributes.fhirVersion ? { fhirVersion: attributes.fhirVersion } : {}),
      },
      sourceApp: attributes.sourceName?.trim() || null,
      externalId: identifier,
      fingerprint: `ahr|${isMedication ? "medication" : "clinical"}|${identifier}`,
    });
  }

  // --- record ingestion from sibling files ----------------------------------

  /**
   * Add a record parsed from a member file rather than from `export.xml`
   * (an ECG CSV, a route GPX). Same caps, same dedup contract.
   */
  addRecord(record: RawHealthRecord): void {
    this.examined += 1;
    this.pushRecord(record);
  }

  addWarning(message: string): void {
    if (this.warnings.length < MAX_WARNINGS) this.warnings.push(message);
  }

  // --- helpers --------------------------------------------------------------

  private addToBucket(
    type: string,
    date: DayKey,
    attributes: Record<string, string>,
    value: number,
    unit: string,
    startAt: string | null,
    endAt: string | null,
  ): void {
    const canonical = toCanonical(type, value, unit);
    if (canonical === null) {
      this.markInvalid(`a ${type} record used a unit this app cannot convert ("${unit}")`);
      return;
    }
    const app = attributes.sourceName?.trim() || null;
    const key = `${type}|${date}|${app ?? ""}`;
    let bucket = this.metrics.get(key);
    if (!bucket) {
      if (!this.reserveAccumulator()) return;
      bucket = {
        type,
        date,
        sourceApp: app,
        sourceDevice: deviceName(attributes.device),
        sum: 0,
        count: 0,
        min: Number.POSITIVE_INFINITY,
        max: Number.NEGATIVE_INFINITY,
        firstStart: null,
        lastEnd: null,
      };
      this.metrics.set(key, bucket);
    }
    bucket.sum += canonical;
    bucket.count += 1;
    if (canonical < bucket.min) bucket.min = canonical;
    if (canonical > bucket.max) bucket.max = canonical;
    if (startAt && (bucket.firstStart === null || startAt < bucket.firstStart)) {
      bucket.firstStart = startAt;
    }
    const last = endAt ?? startAt;
    if (last && (bucket.lastEnd === null || last > bucket.lastEnd)) bucket.lastEnd = last;
  }

  private addPointRow(
    type: string,
    date: DayKey,
    attributes: Record<string, string>,
    value: number,
    unit: string,
    startAt: string,
    endAt: string | null,
  ): void {
    const canonical = toCanonical(type, value, unit);
    if (canonical === null) {
      this.markInvalid(`a ${type} record used a unit this app cannot convert ("${unit}")`);
      return;
    }
    const rule = HEALTH_METRIC_RULES[type];
    this.pushPointRow({
      type,
      subtype: null,
      value: round(canonical),
      unit: rule?.canonicalUnit ?? unit,
      minValue: null,
      maxValue: null,
      date,
      startAt,
      endAt,
      source: "apple_health",
      sourceApp: attributes.sourceName?.trim() || null,
      sourceDevice: deviceName(attributes.device),
      externalId: null,
      notes: null,
      sampleCount: 1,
    });
  }

  private pushPointRow(row: Omit<NormalizedHealthRow, "fingerprint">): void {
    if (this.pointRows.length >= MAX_POINT_ROWS) {
      this.truncated = true;
      return;
    }
    this.pointRows.push({ ...row, fingerprint: fingerprintFor(row) });
  }

  private pushRecord(record: RawHealthRecord): void {
    if (this.records.length >= MAX_RECORDS) {
      this.truncated = true;
      return;
    }
    this.records.push(record);
  }

  private reserveAccumulator(): boolean {
    if (this.metrics.size + this.sleep.size >= MAX_ACCUMULATORS) {
      this.truncated = true;
      return false;
    }
    return true;
  }

  private countUnsupported(key: string): void {
    // Bounded: a file inventing a new type per record must not grow this map
    // without limit.
    if (this.unsupported[key] === undefined && Object.keys(this.unsupported).length >= 500) {
      this.unsupported["(other types)"] = (this.unsupported["(other types)"] ?? 0) + 1;
      return;
    }
    this.unsupported[key] = (this.unsupported[key] ?? 0) + 1;
  }

  private markInvalid(message: string): void {
    this.invalid += 1;
    if (this.warnings.length < MAX_WARNINGS) this.warnings.push(`Skipped: ${message}.`);
  }

  // --- result ---------------------------------------------------------------

  result(): AppleParseResult {
    const rows: NormalizedHealthRow[] = [];

    for (const bucket of this.metrics.values()) {
      const rule = HEALTH_METRIC_RULES[bucket.type];
      if (!rule || bucket.count === 0) continue;
      const value = rule.kind === "cumulative" ? bucket.sum : bucket.sum / bucket.count;
      rows.push(
        finalize({
          type: bucket.type,
          subtype: null,
          value: round(value),
          unit: rule.canonicalUnit,
          minValue: rule.kind === "sample_range" ? round(bucket.min) : null,
          maxValue: rule.kind === "sample_range" ? round(bucket.max) : null,
          date: bucket.date,
          startAt: bucket.firstStart,
          endAt: bucket.lastEnd,
          source: "apple_health",
          sourceApp: bucket.sourceApp,
          sourceDevice: bucket.sourceDevice,
          externalId: null,
          notes: null,
          sampleCount: bucket.count,
        }),
      );
    }

    for (const bucket of this.sleep.values()) {
      const merged = mergeIntervals(bucket.intervals);
      const hours = bucket.compactedHours + intervalHours(merged);
      if (!(hours > 0)) continue;
      rows.push(
        finalize({
          type: "sleep_hours",
          subtype: bucket.stage,
          value: round(hours),
          unit: "h",
          minValue: null,
          maxValue: null,
          date: bucket.date,
          startAt: merged.length > 0 ? new Date(merged[0].start).toISOString() : null,
          endAt: merged.length > 0 ? new Date(merged[merged.length - 1].end).toISOString() : null,
          source: "apple_health",
          sourceApp: bucket.sourceApp,
          sourceDevice: bucket.sourceDevice,
          externalId: null,
          notes: null,
          sampleCount: bucket.count,
        }),
      );
    }

    rows.push(...this.pointRows);

    // A half-read blood pressure is not a reading. Count them so the total is
    // honest rather than quietly dropping them.
    if (this.bloodPressure.size > 0) {
      this.invalid += this.bloodPressure.size;
      this.addWarning(
        `${this.bloodPressure.size} blood-pressure reading${this.bloodPressure.size === 1 ? "" : "s"} ` +
          "had only one of the two halves and were skipped.",
      );
    }

    // Identical fingerprints within one file collapse; the database upsert
    // handles collisions across files.
    const seen = new Set<string>();
    const deduped = rows.filter((row) => {
      if (seen.has(row.fingerprint)) return false;
      seen.add(row.fingerprint);
      return true;
    });

    const recordSeen = new Set<string>();
    const dedupedRecords = this.records.filter((record) => {
      if (recordSeen.has(record.fingerprint)) return false;
      recordSeen.add(record.fingerprint);
      return true;
    });

    if (this.truncated) {
      this.addWarning(
        "This export is larger than one import can hold. The oldest data was read; " +
          "some of the newest individual readings were not. Import again after this one to continue.",
      );
    }

    return {
      rows: deduped,
      workouts: this.workouts,
      records: dedupedRecords,
      unsupported: this.unsupported,
      examined: this.examined,
      invalid: this.invalid,
      warnings: this.warnings,
      truncated: this.truncated,
    };
  }
}

function finalize(row: Omit<NormalizedHealthRow, "fingerprint">): NormalizedHealthRow {
  return { ...row, fingerprint: fingerprintFor(row) };
}

function readWorkoutMinutes(attributes: Record<string, string>): number | null {
  const value = Number(attributes.duration);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = (attributes.durationUnit ?? "min").toLowerCase();
  if (unit === "min") return Math.round(value);
  if (unit === "s" || unit === "sec") return Math.round(value / 60);
  if (unit === "hr" || unit === "h") return Math.round(value * 60);
  return null;
}

function readDistanceKm(raw: string | undefined, unit: string | undefined): number | null {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  const factor = { km: 1, mi: 1.609_344, m: 0.001, yd: 0.000_914_4 }[(unit ?? "km").toLowerCase()];
  return factor === undefined ? null : value * factor;
}

function readCalories(raw: string | undefined, unit: string | undefined): number | null {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  const factor = { kcal: 1, cal: 1, kj: 1 / 4.184 }[(unit ?? "kcal").toLowerCase()];
  return factor === undefined ? null : value * factor;
}
