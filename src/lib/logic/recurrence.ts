import { type DayKey, dayRange, daysBetween, formatDay, fromDayKey, isDayKey, shiftDay, weekdayOf } from "@/lib/date";

/**
 * A deliberately small recurrence model — enough for "workout Mon/Wed/Fri",
 * "meal prep every Sunday", "standup every weekday", "pay rent monthly" —
 * without dragging in a full RFC 5545 implementation.
 *
 * Stored as JSON in `ScheduleItem.recurrenceRule`.
 *
 * ## The series' active range
 *
 * A series always has an explicit range:
 *  * **Start date** — the anchor: the series parent's own (operational) day.
 *    Nothing is ever generated before it.
 *  * **End date** — `rule.until`, optional and INCLUSIVE: when the last day
 *    matches the pattern, that occurrence exists; nothing exists after it.
 *    Absent means open-ended ("no end date") — generation stays bounded by
 *    the materialisation horizon, never by an invented far-future date.
 *
 * Days here are OPERATIONAL days (see src/lib/logic/operational-day.ts): a
 * series repeating "Mondays at 1:00 AM" means Monday *nights*, and each
 * occurrence's stored calendar date is resolved from its operational day at
 * write time. Local wall-clock times are what recur — a 10:00 AM class is at
 * 10:00 AM local across DST transitions, because the rule expands over
 * calendar day keys and the minutes-from-midnight are stored per day, never
 * as fixed UTC offsets.
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

/**
 * The pattern without its range suffix — "Every Mon, Wed, Fri", never
 * "… until 2026-12-11". Pairs with `describeRuleRange` for compact displays.
 */
export function describeRulePattern(rule: RecurrenceRule | null, anchor?: DayKey): string {
  if (!rule) return "Does not repeat";
  return describeRule({ ...rule, until: undefined, count: undefined }, anchor);
}

/** "Aug 24 – Dec 11" for a bounded series, "Starting Aug 24" for open-ended. */
export function describeRuleRange(rule: RecurrenceRule, anchor: DayKey): string {
  if (rule.until) return `${formatDay(anchor, "MMM d")} – ${formatDay(rule.until, "MMM d")}`;
  return `Starting ${formatDay(anchor, "MMM d")} · No end date`;
}

/** "Every Mon, Wed, Fri · Aug 24 – Dec 11" — the one-line series summary. */
export function describeRecurrence(rule: RecurrenceRule | null, anchor: DayKey): string {
  if (!rule) return "Does not repeat";
  return `${describeRulePattern(rule, anchor)} · ${describeRuleRange(rule, anchor)}`;
}

// ---------------------------------------------------------------------------
// Skipped (deleted) occurrences
// ---------------------------------------------------------------------------

/**
 * "Delete this occurrence" is remembered on the series parent as a set of
 * skipped operational day keys (`ScheduleItem.skipDates`, JSON). The deleted
 * row is really gone; the skip entry is what stops regeneration from quietly
 * recreating it. Set semantics: sorted, deduplicated, malformed entries
 * dropped rather than kept as junk.
 */
export function parseSkipDates(raw: string | null | undefined): DayKey[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((day): day is DayKey => isDayKey(day)))].sort();
  } catch {
    return [];
  }
}

export function serializeSkipDates(dates: DayKey[]): string | null {
  const cleaned = [...new Set(dates.filter((day) => isDayKey(day)))].sort();
  return cleaned.length ? JSON.stringify(cleaned) : null;
}

/** The stored value after adding one skipped day — idempotent. */
export function withSkipDate(raw: string | null | undefined, day: DayKey): string | null {
  return serializeSkipDates([...parseSkipDates(raw), day]);
}

// ---------------------------------------------------------------------------
// Series editing — the pure halves of splitting and re-anchoring
// ---------------------------------------------------------------------------

/**
 * Pin the fields a rule silently derives from its anchor, so the rule keeps
 * meaning the same thing when its anchor moves (a series split re-anchors the
 * rule at the split day; a first-occurrence delete promotes a later row).
 * A weekly rule with no explicit weekdays means "the anchor's weekday"; a
 * monthly rule with no explicit day means "the anchor's day of month".
 */
export function materializeAnchorFields(rule: RecurrenceRule, anchor: DayKey): RecurrenceRule {
  const next = { ...rule };
  if (rule.freq === "weekly" && (!rule.byWeekday || rule.byWeekday.length === 0)) {
    next.byWeekday = [weekdayOf(anchor)];
  }
  if (rule.freq === "monthly" && rule.byMonthDay === undefined) {
    next.byMonthDay = fromDayKey(anchor).getDate();
  }
  return next;
}

/**
 * The old series' rule after a split at `splitDay`: it remains authoritative
 * through the day before. An `until` already earlier than that stays; `count`
 * is left alone — the new `until` bounds the series first either way.
 */
export function truncateRuleBefore(rule: RecurrenceRule, splitDay: DayKey): RecurrenceRule {
  const lastDay = shiftDay(splitDay, -1);
  const until = rule.until && daysBetween(rule.until, lastDay) > 0 ? rule.until : lastDay;
  return { ...rule, until };
}

/**
 * The occurrence slots a series is missing inside `[from, to]`: every day the
 * rule generates there, minus slots already represented by a row (materialised,
 * edited or moved — identity comes from `originalDate`), minus slots the user
 * deleted. This is the whole idempotency argument of regeneration in one pure,
 * testable function: re-running it after it has been applied returns nothing.
 */
export function missingSeriesSlots(options: {
  rule: RecurrenceRule;
  /** The series' start (the parent's operational day). */
  anchor: DayKey;
  from: DayKey;
  to: DayKey;
  /** Slots already occupied by an existing row of the series. */
  existingSlots: Iterable<DayKey>;
  /** The parent's stored skip list (see `parseSkipDates`). */
  skipDates?: string | null;
}): DayKey[] {
  const existing = new Set(options.existingSlots);
  const skips = new Set(parseSkipDates(options.skipDates));
  return expandRule(options.rule, options.anchor, options.from, options.to).filter(
    (slot) => !existing.has(slot) && !skips.has(slot),
  );
}

/**
 * Whether two rules describe the same pattern and range. Used to decide if an
 * edit actually changes the recurrence (which forces series-level scope).
 */
export function rulesEqual(a: RecurrenceRule | null, b: RecurrenceRule | null): boolean {
  if (a === null || b === null) return a === b;
  const days = (rule: RecurrenceRule) => [...(rule.byWeekday ?? [])].sort().join(",");
  return (
    a.freq === b.freq &&
    Math.max(1, a.interval) === Math.max(1, b.interval) &&
    days(a) === days(b) &&
    (a.byMonthDay ?? null) === (b.byMonthDay ?? null) &&
    (a.until ?? null) === (b.until ?? null) &&
    (a.count ?? null) === (b.count ?? null)
  );
}

// NOTE: habit recurrence used to live here as `isHabitDue`. It has moved to
// src/lib/logic/schedule.ts, which resolves goals and habits through one
// effective-dated engine. What remains in this file is planner-item recurrence
// only — a different problem (materialised occurrences on a timeline) with a
// different shape.
