import type { DayKey } from "@/lib/date";
import type { SleepStage } from "@/lib/logic/health";

/**
 * Shared shapes for the health import pipeline:
 *
 *   file → parse (apple-xml / csv) → ParsedFile → rollup → ImportPlan → write
 *
 * Everything up to ImportPlan is pure and fully testable; only the write step
 * touches the database. Nothing in this pipeline ever performs a network
 * request — health exports are parsed locally and go nowhere else.
 */

export type ImportKind = "apple_health" | "csv";

/** One record as it came out of the file, already mapped to our metric types. */
export interface RawSample {
  type: string;
  subtype: SleepStage | null;
  value: number;
  unit: string;
  /** Reporting day — start date for samples, end date for sleep intervals. */
  date: DayKey;
  startAt: string | null; // ISO 8601
  endAt: string | null;
  source: string;
  sourceApp: string | null;
  sourceDevice: string | null;
  externalId: string | null;
  notes: string | null;
}

/** A workout parsed from an Apple Health export. */
export interface RawWorkout {
  /** One of WORKOUT_TYPES. */
  type: string;
  name: string;
  date: DayKey;
  time: string | null; // HH:mm
  startAt: string;
  endAt: string;
  durationMin: number;
  distanceKm: number | null;
  caloriesBurned: number | null;
  sourceApp: string | null;
  externalId: string;
}

export interface ParsedFile {
  kind: ImportKind;
  samples: RawSample[];
  workouts: RawWorkout[];
  /** Record types the file contained that Personal OS does not track. */
  unsupported: Record<string, number>;
  /** Rows that failed validation. */
  invalid: number;
  /** Raw records looked at, valid or not. */
  examined: number;
  /** Fatal problems — an unreadable file, a missing header. */
  errors: string[];
  /** Non-fatal, user-facing notes (first N row problems, oddities). */
  warnings: string[];
}

export function emptyParse(kind: ImportKind): ParsedFile {
  return {
    kind,
    samples: [],
    workouts: [],
    unsupported: {},
    invalid: 0,
    examined: 0,
    errors: [],
    warnings: [],
  };
}

/** A database-ready health row, deduplicated by fingerprint. */
export interface NormalizedHealthRow {
  type: string;
  subtype: SleepStage | null;
  /** Canonical unit for the type. */
  value: number;
  unit: string;
  minValue: number | null;
  maxValue: number | null;
  date: DayKey;
  startAt: string | null;
  endAt: string | null;
  source: string;
  sourceApp: string | null;
  sourceDevice: string | null;
  externalId: string | null;
  notes: string | null;
  /** How many raw records were folded into this row. */
  sampleCount: number;
  fingerprint: string;
}

export interface ImportCategory {
  /** A metric type, or the special "workouts". */
  key: string;
  label: string;
  /** Raw records in the file for this category. */
  records: number;
  /** Normalised rows that would be written. */
  rows: number;
  dateFrom: DayKey | null;
  dateTo: DayKey | null;
}

export interface ImportPlan {
  kind: ImportKind;
  rows: NormalizedHealthRow[];
  workouts: RawWorkout[];
  categories: ImportCategory[];
  dateFrom: DayKey | null;
  dateTo: DayKey | null;
  examined: number;
  invalid: number;
  unsupported: Record<string, number>;
  errors: string[];
  warnings: string[];
}
