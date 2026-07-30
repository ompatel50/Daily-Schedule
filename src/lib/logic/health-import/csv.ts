import { isDayKey } from "@/lib/date";
import {
  HEALTH_METRIC_RULES,
  isSupportedUnit,
  SLEEP_STAGE_META,
  type SleepStage,
} from "@/lib/logic/health";
import { emptyParse, type ParsedFile } from "./types";

/**
 * CSV health import.
 *
 * ## The format (documented in the README, template in /health-template.csv)
 *
 * Header row required. Columns:
 *
 *   metricType   required  one of the Personal OS metric types (e.g. `steps`)
 *   value        required  non-negative number
 *   unit         optional  a supported unit for the metric; blank = canonical
 *   date         required  `YYYY-MM-DD` — nothing else. `3/4/2026` is refused
 *                          rather than guessed, because it means two dates.
 *   startTime    optional  ISO 8601 with a time, e.g. `2026-03-04T22:30:00`
 *   endTime      optional  ISO 8601; must not precede startTime
 *   subtype      optional  sleep stage (`in_bed|asleep|awake|core|deep|rem`)
 *   source       optional  `csv|manual|estimated|calculated` — default `csv`.
 *                          Import-claimed data can never be labelled as a
 *                          device measurement, so `apple_health` is refused.
 *   externalId   optional  stable id from the exporting system; drives dedup
 *   notes        optional  free text
 *
 * Rows with an unknown metricType are counted as unsupported (the rest of the
 * file still imports); rows with bad values are invalid with a per-row message.
 */

const REQUIRED_COLUMNS = ["metricType", "value", "date"] as const;

const COLUMN_ALIASES: Record<string, string> = {
  metrictype: "metricType",
  metric_type: "metricType",
  type: "metricType",
  metric: "metricType",
  value: "value",
  unit: "unit",
  date: "date",
  starttime: "startTime",
  start_time: "startTime",
  endtime: "endTime",
  end_time: "endTime",
  subtype: "subtype",
  stage: "subtype",
  source: "source",
  externalid: "externalId",
  external_id: "externalId",
  notes: "notes",
};

/** Sources a CSV may claim. Measured-device labels are deliberately absent. */
const CSV_SOURCES = new Set(["csv", "manual", "estimated", "calculated"]);

const MAX_ROW_ERRORS = 12;

/** RFC 4180-ish field splitting: quotes, escaped quotes, CRLF. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop fully blank lines.
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

/** Strict ISO 8601 timestamp with a time component. No format guessing. */
function parseIsoTimestamp(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(trimmed)) {
    return null;
  }
  return Number.isNaN(new Date(trimmed).getTime()) ? null : trimmed;
}

export function parseHealthCsv(text: string): ParsedFile {
  const result = emptyParse("csv");
  const rows = parseCsvRows(text);

  if (rows.length === 0) {
    result.errors.push("The file is empty.");
    return result;
  }

  // --- header ---------------------------------------------------------------
  const header = rows[0].map((cell) => COLUMN_ALIASES[cell.trim().toLowerCase()] ?? null);
  const columnIndex = new Map<string, number>();
  header.forEach((name, index) => {
    if (name && !columnIndex.has(name)) columnIndex.set(name, index);
  });

  const missing = REQUIRED_COLUMNS.filter((name) => !columnIndex.has(name));
  if (missing.length > 0) {
    result.errors.push(
      `Missing required column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. ` +
        "The header row must name metricType, value and date.",
    );
    return result;
  }

  const cell = (cells: string[], name: string): string => {
    const index = columnIndex.get(name);
    return index === undefined ? "" : (cells[index] ?? "").trim();
  };

  const rowError = (line: number, message: string): void => {
    result.invalid += 1;
    if (result.warnings.length < MAX_ROW_ERRORS) {
      result.warnings.push(`Row ${line}: ${message}`);
    }
  };

  // --- rows -----------------------------------------------------------------
  for (let index = 1; index < rows.length; index += 1) {
    const cells = rows[index];
    const line = index + 1;
    result.examined += 1;

    const type = cell(cells, "metricType");
    if (!type) {
      rowError(line, "metricType is empty.");
      continue;
    }
    if (!HEALTH_METRIC_RULES[type]) {
      result.unsupported[type] = (result.unsupported[type] ?? 0) + 1;
      continue;
    }

    const valueRaw = cell(cells, "value");
    const value = Number(valueRaw);
    if (valueRaw === "" || !Number.isFinite(value)) {
      rowError(line, `value "${valueRaw}" is not a number.`);
      continue;
    }
    if (value < 0) {
      rowError(line, "value cannot be negative.");
      continue;
    }

    const unit = cell(cells, "unit") || HEALTH_METRIC_RULES[type].canonicalUnit;
    if (!isSupportedUnit(type, unit)) {
      rowError(line, `unit "${unit}" is not supported for ${type}.`);
      continue;
    }

    const date = cell(cells, "date");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isDayKey(date)) {
      rowError(line, `date "${date}" must be YYYY-MM-DD.`);
      continue;
    }

    const startRaw = cell(cells, "startTime");
    const endRaw = cell(cells, "endTime");
    const startAt = startRaw ? parseIsoTimestamp(startRaw) : null;
    const endAt = endRaw ? parseIsoTimestamp(endRaw) : null;
    if (startRaw && !startAt) {
      rowError(line, `startTime "${startRaw}" is not an ISO 8601 timestamp.`);
      continue;
    }
    if (endRaw && !endAt) {
      rowError(line, `endTime "${endRaw}" is not an ISO 8601 timestamp.`);
      continue;
    }
    if (startAt && endAt && new Date(endAt).getTime() < new Date(startAt).getTime()) {
      rowError(line, "endTime is before startTime.");
      continue;
    }

    const subtypeRaw = cell(cells, "subtype");
    let subtype: SleepStage | null = null;
    if (subtypeRaw) {
      if (type !== "sleep_hours" || !SLEEP_STAGE_META[subtypeRaw as SleepStage]) {
        rowError(line, `subtype "${subtypeRaw}" is only valid as a sleep stage.`);
        continue;
      }
      subtype = subtypeRaw as SleepStage;
    }

    const sourceRaw = cell(cells, "source").toLowerCase();
    if (sourceRaw && !CSV_SOURCES.has(sourceRaw)) {
      rowError(
        line,
        `source "${sourceRaw}" is not allowed in a CSV — use csv, manual, estimated or calculated.`,
      );
      continue;
    }

    result.samples.push({
      type,
      subtype,
      value,
      unit,
      date,
      startAt,
      endAt,
      source: sourceRaw || "csv",
      // Rows from one file form their own aggregation group, so a CSV row
      // claiming `manual` never sums with a value typed into the app.
      sourceApp: "csv",
      sourceDevice: null,
      externalId: cell(cells, "externalId") || null,
      notes: cell(cells, "notes") || null,
    });
  }

  if (result.invalid > 0 && result.invalid >= result.examined) {
    result.errors.push("No row in the file passed validation.");
  }
  return result;
}
