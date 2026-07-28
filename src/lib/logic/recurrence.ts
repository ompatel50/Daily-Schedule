import { type DayKey, dayRange, daysBetween, fromDayKey, weekdayOf } from "@/lib/date";

/**
 * A deliberately small recurrence model — enough for "workout Mon/Wed/Fri",
 * "meal prep every Sunday", "standup every weekday", "pay rent monthly" —
 * without dragging in a full RFC 5545 implementation.
 *
 * Stored as JSON in `ScheduleItem.recurrenceRule`.
 */
export type RecurrenceFreq = "daily" | "weekly" | "monthly";

export interface RecurrenceRule {
  freq: RecurrenceFreq;
  /** Every N days/weeks/months. */
  interval: number;
  /** For weekly: 0=Sun … 6=Sat. Empty means "same weekday as the anchor". */
  byWeekday?: number[];
  /** For monthly: day-of-month. Defaults to the anchor's day-of-month. */
  byMonthDay?: number;
  /** Inclusive last day the series may generate. */
  until?: DayKey;
  /** Alternative to `until`: stop after N occurrences. */
  count?: number;
}

export const DEFAULT_RULE: RecurrenceRule = { freq: "weekly", interval: 1, byWeekday: [] };

export function parseRule(raw: string | null | undefined): RecurrenceRule | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RecurrenceRule>;
    if (!parsed || typeof parsed !== "object") return null;
    if (!["daily", "weekly", "monthly"].includes(parsed.freq as string)) return null;
    return {
      freq: parsed.freq as RecurrenceFreq,
      interval: Math.max(1, Math.round(Number(parsed.interval) || 1)),
      byWeekday: Array.isArray(parsed.byWeekday)
        ? parsed.byWeekday.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
        : [],
      byMonthDay: typeof parsed.byMonthDay === "number" ? parsed.byMonthDay : undefined,
      until: typeof parsed.until === "string" ? parsed.until : undefined,
      count: typeof parsed.count === "number" ? parsed.count : undefined,
    };
  } catch {
    return null;
  }
}

export function serializeRule(rule: RecurrenceRule | null): string | null {
  return rule ? JSON.stringify(rule) : null;
}

/**
 * Does `day` fall on the series defined by `rule` anchored at `anchor`?
 * Pure and side-effect free so it is trivially testable.
 */
export function matchesRule(rule: RecurrenceRule, anchor: DayKey, day: DayKey): boolean {
  const offset = daysBetween(anchor, day);
  if (offset < 0) return false;
  if (rule.until && daysBetween(rule.until, day) > 0) return false;

  const interval = Math.max(1, rule.interval);

  switch (rule.freq) {
    case "daily":
      return offset % interval === 0;

    case "weekly": {
      const weekdays =
        rule.byWeekday && rule.byWeekday.length > 0 ? rule.byWeekday : [weekdayOf(anchor)];
      if (!weekdays.includes(weekdayOf(day))) return false;
      // Compare *aligned* week buckets so interval > 1 skips whole weeks.
      const weeksApart = Math.floor(alignedWeekIndex(day) - alignedWeekIndex(anchor));
      return weeksApart >= 0 && weeksApart % interval === 0;
    }

    case "monthly": {
      const anchorDate = fromDayKey(anchor);
      const target = rule.byMonthDay ?? anchorDate.getDate();
      const date = fromDayKey(day);
      const monthsApart =
        (date.getFullYear() - anchorDate.getFullYear()) * 12 +
        (date.getMonth() - anchorDate.getMonth());
      if (monthsApart < 0 || monthsApart % interval !== 0) return false;
      // Clamp to the last day of short months so "31st" still fires in February.
      const lastDayOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
      return date.getDate() === Math.min(target, lastDayOfMonth);
    }

    default:
      return false;
  }
}

/** Week index relative to a fixed epoch, using Sunday-start weeks. */
function alignedWeekIndex(day: DayKey): number {
  const date = fromDayKey(day);
  const epoch = new Date(1970, 0, 4, 12, 0, 0, 0); // a Sunday
  return Math.floor((date.getTime() - epoch.getTime()) / (7 * 24 * 60 * 60 * 1000));
}

/**
 * Expand a rule into concrete day keys inside [from, to].
 * `count` is honoured against occurrences from the anchor, not from `from`.
 */
export function expandRule(
  rule: RecurrenceRule,
  anchor: DayKey,
  from: DayKey,
  to: DayKey,
): DayKey[] {
  if (daysBetween(from, to) < 0) return [];

  const scanStart = daysBetween(anchor, from) > 0 ? from : anchor;
  const candidates = dayRange(scanStart, to).filter((day) => matchesRule(rule, anchor, day));

  if (rule.count && rule.count > 0) {
    // Count from the anchor, so we may need occurrences before `from`.
    const beforeWindow = daysBetween(anchor, from) > 0
      ? dayRange(anchor, from).slice(0, -1).filter((day) => matchesRule(rule, anchor, day)).length
      : 0;
    const remaining = Math.max(0, rule.count - beforeWindow);
    return candidates.slice(0, remaining).filter((day) => daysBetween(from, day) >= 0);
  }

  return candidates.filter((day) => daysBetween(from, day) >= 0);
}

/** Human-readable summary, e.g. "Every Mon, Wed, Fri". */
export function describeRule(rule: RecurrenceRule | null, anchor?: DayKey): string {
  if (!rule) return "Does not repeat";
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const every = rule.interval > 1 ? `Every ${rule.interval} ` : "Every ";

  let base: string;
  switch (rule.freq) {
    case "daily":
      base = rule.interval > 1 ? `${every}days` : "Every day";
      break;
    case "weekly": {
      const days = rule.byWeekday?.length
        ? rule.byWeekday
        : anchor
          ? [weekdayOf(anchor)]
          : [];
      if (days.length === 7) base = "Every day";
      else if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d)))
        base = "Every weekday";
      else if (days.length > 0)
        base = `${rule.interval > 1 ? `${every}weeks on ` : "Every "}${days
          .slice()
          .sort()
          .map((d) => names[d])
          .join(", ")}`;
      else base = rule.interval > 1 ? `${every}weeks` : "Every week";
      break;
    }
    case "monthly":
      base = rule.interval > 1 ? `${every}months` : "Every month";
      break;
    default:
      base = "Does not repeat";
  }

  if (rule.until) base += ` until ${rule.until}`;
  else if (rule.count) base += ` (${rule.count}x)`;
  return base;
}

// NOTE: habit recurrence used to live here as `isHabitDue`. It has moved to
// src/lib/logic/schedule.ts, which resolves goals and habits through one
// effective-dated engine. What remains in this file is planner-item recurrence
// only — a different problem (materialised occurrences on a timeline) with a
// different shape.
