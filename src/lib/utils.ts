import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Round to `digits` decimals and drop trailing zeros. */
export function round(value: number, digits = 0): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 0–100 percentage of `value` against `target`, clamped. */
export function pct(value: number, target: number): number {
  if (!target || target <= 0) return 0;
  return clamp(Math.round((value / target) * 100), 0, 100);
}

export function formatNumber(value: number, digits = 0): string {
  return round(value, digits).toLocaleString(undefined, {
    maximumFractionDigits: digits,
  });
}

/** "1,240 kcal" style compact stat rendering. */
export function formatStat(value: number, unit?: string, digits = 0): string {
  return unit ? `${formatNumber(value, digits)} ${unit}` : formatNumber(value, digits);
}

export function titleCase(input: string): string {
  return input
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

/** Parse JSON stored in a TEXT column, falling back safely. */
export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export function groupBy<T, K extends string | number>(
  items: T[],
  key: (item: T) => K,
): Record<K, T[]> {
  return items.reduce(
    (acc, item) => {
      const k = key(item);
      (acc[k] ||= []).push(item);
      return acc;
    },
    {} as Record<K, T[]>,
  );
}

export function sum<T>(items: T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + (value(item) || 0), 0);
}

export function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
