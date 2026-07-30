import type { DayKey } from "@/lib/date";
import type { SleepStage } from "@/lib/logic/health";
import { emptyParse, type ParsedFile, type RawSample } from "./types";

/**
 * Apple Health `export.xml` parsing.
 *
 * The export is one huge flat XML file of `<Record …/>` and `<Workout …>`
 * elements. A DOM parse of a multi-hundred-megabyte file is exactly the wrong
 * tool, so this is a scanning parser: it walks the string looking for the two
 * element names it cares about, reads the attributes off the open tag, and
 * ignores everything else. Unknown record types are counted, never fatal — an
 * export full of audiograms and ECGs still imports its steps.
 *
 * Everything here is pure string work. The file never leaves the machine.
 */

/** HealthKit identifier → Personal OS metric type. */
export const APPLE_TYPE_MAP: Record<string, string> = {
  HKQuantityTypeIdentifierStepCount: "steps",
  HKQuantityTypeIdentifierActiveEnergyBurned: "active_calories",
  HKQuantityTypeIdentifierBasalEnergyBurned: "resting_calories",
  HKQuantityTypeIdentifierHeartRate: "heart_rate",
  HKQuantityTypeIdentifierRestingHeartRate: "resting_hr",
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN: "hrv",
  HKQuantityTypeIdentifierBodyMass: "body_weight",
  HKQuantityTypeIdentifierBodyFatPercentage: "body_fat",
  HKQuantityTypeIdentifierDietaryWater: "hydration_ml",
  HKQuantityTypeIdentifierDistanceWalkingRunning: "distance_km",
  HKCategoryTypeIdentifierSleepAnalysis: "sleep_hours",
};

/** HealthKit sleep values → our stages. Older exports say just "Asleep". */
const APPLE_SLEEP_MAP: Record<string, SleepStage> = {
  HKCategoryValueSleepAnalysisInBed: "in_bed",
  HKCategoryValueSleepAnalysisAsleep: "asleep",
  HKCategoryValueSleepAnalysisAsleepUnspecified: "asleep",
  HKCategoryValueSleepAnalysisAsleepCore: "core",
  HKCategoryValueSleepAnalysisAsleepDeep: "deep",
  HKCategoryValueSleepAnalysisAsleepREM: "rem",
  HKCategoryValueSleepAnalysisAwake: "awake",
};

/** HKWorkoutActivityType → Personal OS workout type. Unlisted → custom. */
export const APPLE_WORKOUT_MAP: Record<string, string> = {
  HKWorkoutActivityTypeRunning: "running",
  HKWorkoutActivityTypeWalking: "walking",
  HKWorkoutActivityTypeHiking: "walking",
  HKWorkoutActivityTypeCycling: "cycling",
  HKWorkoutActivityTypeSwimming: "swimming",
  HKWorkoutActivityTypeYoga: "yoga",
  HKWorkoutActivityTypeTraditionalStrengthTraining: "strength",
  HKWorkoutActivityTypeFunctionalStrengthTraining: "strength",
  HKWorkoutActivityTypeCoreTraining: "strength",
  HKWorkoutActivityTypeHighIntensityIntervalTraining: "hiit",
  HKWorkoutActivityTypeFlexibility: "mobility",
  HKWorkoutActivityTypeCooldown: "mobility",
  HKWorkoutActivityTypeElliptical: "cardio",
  HKWorkoutActivityTypeRowing: "cardio",
  HKWorkoutActivityTypeStairClimbing: "cardio",
  HKWorkoutActivityTypeJumpRope: "cardio",
  HKWorkoutActivityTypeMixedCardio: "cardio",
  HKWorkoutActivityTypePilates: "mobility",
  HKWorkoutActivityTypeDance: "cardio",
  HKWorkoutActivityTypeSoccer: "sport",
  HKWorkoutActivityTypeBasketball: "sport",
  HKWorkoutActivityTypeTennis: "sport",
  HKWorkoutActivityTypeGolf: "sport",
  HKWorkoutActivityTypeMartialArts: "sport",
};

const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&#x27;": "'",
};

function unescapeXml(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(/&[a-zA-Z#x0-9]+;/g, (entity) => ENTITY_MAP[entity] ?? entity);
}

/** Attributes from one open tag, e.g. `<Record type="…" value="…"`. */
function parseAttributes(openTag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([A-Za-z][\w:.-]*)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(openTag)) !== null) {
    attrs[match[1]] = unescapeXml(match[2]);
  }
  return attrs;
}

/**
 * Apple's timestamp format: `2026-03-14 07:31:02 -0400`. The day key is taken
 * from the string as written — the export was made in the device's timezone
 * and re-interpreting it through the server's clock would shift records that
 * happened near midnight onto the wrong day.
 */
export function parseAppleDate(raw: string | undefined): { day: DayKey; iso: string } | null {
  if (!raw) return null;
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const iso = `${match[1]}T${match[2]}${match[3]}${match[4]}:${match[5]}`;
  if (Number.isNaN(new Date(iso).getTime())) return null;
  return { day: match[1] as DayKey, iso };
}

/** Trims device attribute noise down to a short human-readable name. */
function deviceName(raw: string | undefined): string | null {
  if (!raw) return null;
  // The attribute looks like `<<HKDevice: 0x…>, name:Apple Watch, model:Watch, …>`.
  const name = /name:([^,>]+)/.exec(raw)?.[1]?.trim();
  return name ?? null;
}

const MAX_ROW_WARNINGS = 12;

/** Parse an Apple Health export. Never throws on content — bad records are counted. */
export function parseAppleHealthXml(xml: string): ParsedFile {
  const result = emptyParse("apple_health");

  if (!xml.includes("<HealthData")) {
    result.errors.push(
      "This does not look like an Apple Health export — the file has no <HealthData> element.",
    );
    return result;
  }

  let cursor = 0;
  // Cached next-occurrence positions. Refreshing them only once the cursor
  // passes them keeps the scan linear: re-running indexOf for a tag that
  // never appears again would otherwise walk the rest of the file on every
  // iteration — quadratic on a workout-free multi-year export.
  let recordAt = xml.indexOf("<Record ", cursor);
  let workoutAt = xml.indexOf("<Workout ", cursor);
  while (cursor < xml.length) {
    if (recordAt !== -1 && recordAt < cursor) recordAt = xml.indexOf("<Record ", cursor);
    if (workoutAt !== -1 && workoutAt < cursor) workoutAt = xml.indexOf("<Workout ", cursor);
    if (recordAt === -1 && workoutAt === -1) break;

    if (recordAt !== -1 && (workoutAt === -1 || recordAt < workoutAt)) {
      const tagEnd = xml.indexOf(">", recordAt);
      if (tagEnd === -1) break;
      handleRecord(xml.slice(recordAt, tagEnd + 1), result);
      cursor = tagEnd + 1;
    } else {
      const tagEnd = xml.indexOf(">", workoutAt);
      if (tagEnd === -1) break;
      const openTag = xml.slice(workoutAt, tagEnd + 1);
      // A workout may be self-closing or carry children (events, statistics).
      let bodyEnd = tagEnd + 1;
      let body = "";
      if (!openTag.endsWith("/>")) {
        const close = xml.indexOf("</Workout>", tagEnd);
        if (close !== -1) {
          body = xml.slice(tagEnd + 1, close);
          bodyEnd = close + "</Workout>".length;
        }
      }
      handleWorkout(openTag, body, result);
      cursor = bodyEnd;
    }
  }

  if (result.examined === 0 && result.workouts.length === 0) {
    result.errors.push("The export contains no records this app can read.");
  }
  return result;
}

function handleRecord(openTag: string, result: ParsedFile): void {
  result.examined += 1;
  const attrs = parseAttributes(openTag);
  const appleType = attrs.type ?? "";
  const type = APPLE_TYPE_MAP[appleType];

  if (!type) {
    const key = appleType || "(no type)";
    result.unsupported[key] = (result.unsupported[key] ?? 0) + 1;
    return;
  }

  const start = parseAppleDate(attrs.startDate);
  const end = parseAppleDate(attrs.endDate);

  if (type === "sleep_hours") {
    const stage = APPLE_SLEEP_MAP[attrs.value ?? ""];
    if (!stage || !start || !end) {
      markInvalid(result, `a sleep record had ${!stage ? "an unknown stage" : "no usable dates"}`);
      return;
    }
    const hours = (new Date(end.iso).getTime() - new Date(start.iso).getTime()) / 3_600_000;
    if (!(hours > 0) || hours > 48) {
      markInvalid(result, "a sleep record had a non-positive or absurd duration");
      return;
    }
    result.samples.push(
      sample({
        type,
        subtype: stage,
        value: hours,
        unit: "h",
        // Sleep belongs to the day it ends — the morning you woke up.
        date: end.day,
        startAt: start.iso,
        endAt: end.iso,
        attrs,
      }),
    );
    return;
  }

  const value = Number(attrs.value);
  if (!Number.isFinite(value) || value < 0) {
    markInvalid(result, `a ${appleType} record had a non-numeric value`);
    return;
  }
  if (!start) {
    markInvalid(result, `a ${appleType} record had no usable start date`);
    return;
  }

  // HealthKit expresses percentages as 0–1 scalars; our body_fat is 0–100.
  const adjusted = type === "body_fat" && value <= 1 ? value * 100 : value;

  result.samples.push(
    sample({
      type,
      subtype: null,
      value: adjusted,
      unit: attrs.unit ?? "",
      date: start.day,
      startAt: start.iso,
      endAt: end?.iso ?? null,
      attrs,
    }),
  );
}

function sample(input: {
  type: string;
  subtype: SleepStage | null;
  value: number;
  unit: string;
  date: DayKey;
  startAt: string | null;
  endAt: string | null;
  attrs: Record<string, string>;
}): RawSample {
  return {
    type: input.type,
    subtype: input.subtype,
    value: input.value,
    unit: input.unit,
    date: input.date,
    startAt: input.startAt,
    endAt: input.endAt,
    source: "apple_health",
    sourceApp: input.attrs.sourceName?.trim() || null,
    sourceDevice: deviceName(input.attrs.device),
    externalId: null,
    notes: null,
  };
}

function handleWorkout(openTag: string, body: string, result: ParsedFile): void {
  result.examined += 1;
  const attrs = parseAttributes(openTag);
  const start = parseAppleDate(attrs.startDate);
  const end = parseAppleDate(attrs.endDate);
  if (!start || !end) {
    markInvalid(result, "a workout had no usable dates");
    return;
  }

  const activity = attrs.workoutActivityType ?? "";
  const type = APPLE_WORKOUT_MAP[activity] ?? "custom";
  const label = activity.replace(/^HKWorkoutActivityType/, "") || "Workout";
  // Insert a space at lowercase→uppercase boundaries: "TraditionalStrengthTraining" → readable.
  const name = label.replace(/([a-z])([A-Z])/g, "$1 $2");

  let durationMin = readWorkoutMinutes(attrs);
  if (durationMin === null) {
    const elapsed = (new Date(end.iso).getTime() - new Date(start.iso).getTime()) / 60_000;
    durationMin = elapsed > 0 ? Math.round(elapsed) : null;
  }
  if (durationMin === null || durationMin <= 0 || durationMin > 24 * 60) {
    markInvalid(result, "a workout had a non-positive or absurd duration");
    return;
  }

  // Distance / energy live on the open tag in older exports, in
  // <WorkoutStatistics> children in newer ones. Read both, prefer the tag.
  const stats = parseWorkoutStatistics(body);
  const distanceKm =
    readDistanceKm(attrs.totalDistance, attrs.totalDistanceUnit) ?? stats.distanceKm;
  const calories =
    readCalories(attrs.totalEnergyBurned, attrs.totalEnergyBurnedUnit) ?? stats.calories;

  result.workouts.push({
    type,
    name,
    date: start.day,
    time: start.iso.slice(11, 16),
    startAt: start.iso,
    endAt: end.iso,
    durationMin,
    distanceKm,
    caloriesBurned: calories === null ? null : Math.round(calories),
    sourceApp: attrs.sourceName?.trim() || null,
    // The export carries no per-workout UUID; start + activity is stable
    // across re-exports of the same data, which is what dedup needs.
    externalId: `ah:${start.iso}:${activity}`,
  });
}

function readWorkoutMinutes(attrs: Record<string, string>): number | null {
  const value = Number(attrs.duration);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = (attrs.durationUnit ?? "min").toLowerCase();
  if (unit === "min") return Math.round(value);
  if (unit === "s" || unit === "sec") return Math.round(value / 60);
  if (unit === "hr" || unit === "h") return Math.round(value * 60);
  return null;
}

function readDistanceKm(raw: string | undefined, unit: string | undefined): number | null {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  const factor = { km: 1, mi: 1.609_344, m: 0.001 }[(unit ?? "km").toLowerCase()];
  return factor === undefined ? null : value * factor;
}

function readCalories(raw: string | undefined, unit: string | undefined): number | null {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  const factor = { kcal: 1, cal: 1, kj: 1 / 4.184 }[(unit ?? "kcal").toLowerCase()];
  return factor === undefined ? null : value * factor;
}

function parseWorkoutStatistics(body: string): { distanceKm: number | null; calories: number | null } {
  let distanceKm: number | null = null;
  let calories: number | null = null;
  if (!body) return { distanceKm, calories };

  let cursor = 0;
  while (true) {
    const at = body.indexOf("<WorkoutStatistics ", cursor);
    if (at === -1) break;
    const end = body.indexOf(">", at);
    if (end === -1) break;
    const attrs = parseAttributes(body.slice(at, end + 1));
    if (attrs.type === "HKQuantityTypeIdentifierDistanceWalkingRunning" || attrs.type === "HKQuantityTypeIdentifierDistanceCycling" || attrs.type === "HKQuantityTypeIdentifierDistanceSwimming") {
      distanceKm = readDistanceKm(attrs.sum, attrs.unit) ?? distanceKm;
    } else if (attrs.type === "HKQuantityTypeIdentifierActiveEnergyBurned") {
      calories = readCalories(attrs.sum, attrs.unit) ?? calories;
    }
    cursor = end + 1;
  }
  return { distanceKm, calories };
}

function markInvalid(result: ParsedFile, message: string): void {
  result.invalid += 1;
  if (result.warnings.length < MAX_ROW_WARNINGS) {
    result.warnings.push(`Skipped: ${message}.`);
  }
}
