/**
 * Presentation and statistics helpers for scores.
 *
 * The day score itself is *not* computed here — it lives in
 * src/lib/logic/day-score.ts, which returns the full explanation alongside the
 * number. This file used to hold a second, opaque `scoreDay()` with hard-coded
 * category weights that the Dashboard, Today and the seed script each called
 * with their own inputs; that is exactly the disagreement the central service
 * removed.
 */

/** Heatmap bucket for a 0–100 score. */
export type HeatLevel = 0 | 1 | 2 | 3 | 4;

export function heatLevel(score: number, hasData: boolean): HeatLevel {
  if (!hasData || score <= 0) return 0;
  if (score < 40) return 1;
  if (score < 65) return 2;
  if (score < 85) return 3;
  return 4;
}

export const HEAT_CLASSES: Record<HeatLevel, string> = {
  0: "bg-muted/60",
  1: "bg-emerald-500/20",
  2: "bg-emerald-500/40",
  3: "bg-emerald-500/65",
  4: "bg-emerald-500/90",
};

/** Compare two windows and return a signed percentage-point delta. */
export function trendDelta(current: number, previous: number): number {
  if (previous === 0) return current === 0 ? 0 : 100;
  return Math.round(((current - previous) / Math.abs(previous)) * 100);
}

/** Simple moving average, used to smooth noisy health series. */
export function movingAverage(values: Array<number | null>, window = 7): Array<number | null> {
  return values.map((_, index) => {
    const slice = values
      .slice(Math.max(0, index - window + 1), index + 1)
      .filter((value): value is number => value !== null && Number.isFinite(value));
    if (slice.length === 0) return null;
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
}

/** Least-squares slope per day; positive = improving over time. */
export function linearTrend(points: Array<{ x: number; y: number }>): number {
  if (points.length < 2) return 0;
  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return 0;
  return (n * sumXY - sumX * sumY) / denominator;
}
