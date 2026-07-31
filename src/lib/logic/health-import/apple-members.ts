import type { DayKey } from "@/lib/date";
import type { RawHealthRecord } from "./apple-stream";

/**
 * The member files an Apple Health archive carries beside `export.xml`.
 *
 * A modern export is a folder, not a file:
 *
 *   apple_health_export/
 *     export.xml                    the record stream
 *     export_cda.xml                a clinical-document duplicate (ignored)
 *     electrocardiograms/*.csv      one ECG each: a header block, then voltages
 *     workout-routes/*.gpx          one GPS track per outdoor workout
 *     clinical-records/*.json       raw FHIR payloads (never opened)
 *
 * Only the *metadata* of the first two is read. An ECG's voltage series and a
 * route's coordinates are the most sensitive and least useful data in the
 * archive — this app cannot draw an ECG trace and will not map where you ran —
 * so the parsers below deliberately stop at the summary: classification and
 * average heart rate for an ECG, point count and distance for a route. No
 * coordinate and no voltage sample is ever stored.
 *
 * Everything here is pure: text in, records out. Unrecognised or damaged
 * member files are reported and skipped, never fatal.
 */

export const EXPORT_XML_NAMES = ["apple_health_export/export.xml", "export.xml"];
export const ECG_DIRECTORY = "electrocardiograms/";
export const ROUTE_DIRECTORY = "workout-routes/";

/** Member files this app knowingly does not read, so it can say so. */
export const IGNORED_MEMBER_PATTERNS: Array<{ test: RegExp; reason: string }> = [
  { test: /export_cda\.xml$/, reason: "clinical document duplicate of export.xml" },
  { test: /clinical-records\//, reason: "raw FHIR payloads — only their index is read" },
  { test: /\.(jpe?g|png|heic|pdf)$/i, reason: "attachments" },
];

// --- ECG ---------------------------------------------------------------------

/**
 * Apple writes an ECG CSV as a header block of `Label,Value` lines, a blank
 * line, then one voltage per line. Only the header is parsed; the scan stops
 * at the blank line, so a 30-second trace costs nothing to skip.
 *
 * Field names are localised, so lookup is by the English labels Apple uses
 * plus a positional fallback — an ECG whose header this cannot read is
 * reported and skipped rather than guessed at.
 */
export function parseEcgCsv(text: string, fileName: string): RawHealthRecord | null {
  const header: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.trim().length === 0) break; // header ends at the blank line
    const comma = line.indexOf(",");
    if (comma === -1) continue;
    const key = line.slice(0, comma).trim().toLowerCase();
    const value = line
      .slice(comma + 1)
      .trim()
      .replace(/^"|"$/g, "");
    if (key) header[key] = value.slice(0, 200);
  }

  const recorded = readEcgDate(header["recorded date"] ?? header["date"] ?? "");
  if (!recorded) return null;

  const classification = header["classification"] || "ECG";
  const averageHeartRate = readLeadingNumber(header["average heart rate"] ?? "");
  const symptoms = header["symptoms"] || null;

  return {
    kind: "ecg",
    date: recorded.day,
    recordedAt: recorded.iso,
    startAt: recorded.iso,
    endAt: null,
    title: classification,
    subtitle:
      averageHeartRate !== null ? `Average ${Math.round(averageHeartRate)} bpm` : "Electrocardiogram",
    value: averageHeartRate,
    unit: averageHeartRate !== null ? "bpm" : "",
    detail: {
      ...(symptoms ? { symptoms } : {}),
      ...(header["software version"] ? { softwareVersion: header["software version"] } : {}),
      ...(header["device"] ? { device: header["device"] } : {}),
    },
    sourceApp: header["device"] || null,
    externalId: fileName,
    // The file name is Apple's own per-ECG identity and is stable across
    // re-exports, which is exactly what dedup needs.
    fingerprint: `ahr|ecg|${fileName}`,
  };
}

/**
 * ECG headers date as `2026-03-14 07:31:02 -0400` or as a localised string.
 * Only the unambiguous forms are accepted — a date this cannot read means the
 * ECG is skipped, not filed under the wrong day.
 */
function readEcgDate(raw: string): { day: DayKey; iso: string } | null {
  const value = raw.trim();
  const spaced = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*([+-]\d{2}:?\d{2})?$/.exec(value);
  if (spaced) {
    const zone = spaced[3] ? spaced[3].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2") : "Z";
    const iso = `${spaced[1]}T${spaced[2]}${zone}`;
    if (!Number.isNaN(new Date(iso).getTime())) return { day: spaced[1] as DayKey, iso };
  }
  const dateOnly = /^(\d{4}-\d{2}-\d{2})$/.exec(value);
  if (dateOnly) return { day: dateOnly[1] as DayKey, iso: `${dateOnly[1]}T00:00:00Z` };
  return null;
}

function readLeadingNumber(raw: string): number | null {
  const match = /-?\d+(\.\d+)?/.exec(raw);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

// --- workout routes -----------------------------------------------------------

export interface RouteSummary {
  points: number;
  distanceKm: number;
  startAt: string | null;
  endAt: string | null;
}

/**
 * Summarise a route GPX **without keeping a single coordinate**.
 *
 * Consecutive points are folded into a running distance as they are read and
 * then discarded; what survives is a count, a length and a time span. That is
 * enough to say "a 10.2 km route was recorded" and not enough to say where.
 */
export function summarizeRouteGpx(text: string): RouteSummary | null {
  const pointPattern = /<trkpt\b[^>]*\blat="(-?\d+(?:\.\d+)?)"[^>]*\blon="(-?\d+(?:\.\d+)?)"/g;
  let match: RegExpExecArray | null;
  let previous: { lat: number; lon: number } | null = null;
  let points = 0;
  let distanceKm = 0;

  while ((match = pointPattern.exec(text)) !== null) {
    const lat = Number(match[1]);
    const lon = Number(match[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    points += 1;
    if (previous) distanceKm += haversineKm(previous.lat, previous.lon, lat, lon);
    previous = { lat, lon };
  }
  if (points === 0) return null;

  // Only the span matters, so the first and last `<time>` are read directly
  // rather than collecting every stamp in the track.
  const first = readTimeAt(text, text.indexOf("<time>"));
  const last = readTimeAt(text, text.lastIndexOf("<time>"));

  return {
    points,
    distanceKm: Math.round(distanceKm * 1000) / 1000,
    startAt: first,
    endAt: last,
  };
}

function readTimeAt(text: string, at: number): string | null {
  if (at === -1) return null;
  const close = text.indexOf("</time>", at);
  if (close === -1 || close - at > 60) return null;
  const parsed = new Date(text.slice(at + "<time>".length, close));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

const EARTH_RADIUS_KM = 6371.0088;

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Turn a route summary into the record the importer stores. */
export function routeRecord(
  summary: RouteSummary,
  fileName: string,
): RawHealthRecord | null {
  const iso = summary.startAt;
  const day = iso?.slice(0, 10) ?? readRouteDateFromName(fileName);
  if (!day) return null;
  return {
    kind: "workout_route",
    date: day as DayKey,
    recordedAt: iso,
    startAt: iso,
    endAt: summary.endAt,
    title: `Route · ${summary.distanceKm.toFixed(2)} km`,
    subtitle: `${summary.points} GPS points recorded`,
    value: summary.distanceKm,
    unit: "km",
    detail: { points: summary.points },
    sourceApp: null,
    externalId: fileName,
    fingerprint: `ahr|workout_route|${fileName}`,
  };
}

/** Apple names routes `route_2026-03-14_7.31am.gpx`. */
function readRouteDateFromName(fileName: string): string | null {
  return /(\d{4}-\d{2}-\d{2})/.exec(fileName)?.[1] ?? null;
}
