/**
 * The time ranges every Health surface offers.
 *
 * Shared rather than server-only because the range is a URL parameter: the
 * picker (a client component) renders the same list the server resolves a
 * window from, so the two can never disagree about what `?range=90d` means.
 */
export const HEALTH_RANGES = ["7d", "30d", "90d", "1y", "all"] as const;
export type HealthRange = (typeof HEALTH_RANGES)[number];

export const HEALTH_RANGE_META: Record<
  HealthRange,
  { label: string; short: string; days: number | null }
> = {
  "7d": { label: "7 days", short: "7d", days: 7 },
  "30d": { label: "30 days", short: "30d", days: 30 },
  "90d": { label: "90 days", short: "90d", days: 90 },
  "1y": { label: "1 year", short: "1y", days: 365 },
  all: { label: "All time", short: "All", days: null },
};

export const DEFAULT_HEALTH_RANGE: HealthRange = "30d";

export function isHealthRange(value: unknown): value is HealthRange {
  return typeof value === "string" && (HEALTH_RANGES as readonly string[]).includes(value);
}

/** Read `?range=` from a page's searchParams, falling back to the default. */
export function rangeFromParam(value: string | string[] | undefined): HealthRange {
  const first = Array.isArray(value) ? value[0] : value;
  return isHealthRange(first) ? first : DEFAULT_HEALTH_RANGE;
}
