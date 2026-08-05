import {
  type DayKey,
  dayRange,
  daysBetween,
  fromDayKey,
  shiftDay,
  weekdayOf,
  weekRange,
} from "@/lib/date";

/**
 * THE schedule engine.
 *
 * Every question of the form "does this apply on this date?" — for goals,
 * habits, reminders, scoring, streaks, the calendar and insights — is answered
 * here and nowhere else. Before this module existed the answer was computed
 * independently in `isHabitDue`, in `recomputeDay`, in `getDayOverview` and
 * inline in the seed script, and they could disagree.
 *
 * The engine is pure: it takes plain data and returns plain data, so it is
 * fully testable without a database, and the same code runs on the server and
 * in the browser.
 *
 * ## The distinctions this module exists to preserve
 *
 * A day where nothing was scheduled is **not** a failure. Neither is a future
 * day, a cancelled occurrence, an excused one, or a rest day. The whole point
 * is that only a *scheduled opportunity that was actually missed* counts
 * against you. `Occurrence.state` carries that distinction end to end, so no
 * caller has to re-derive it and get it subtly wrong.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const SCHEDULE_MODES = [
  "every_day",
  "weekdays",
  "times_per_week",
  "one_time",
  "interval_days",
  "interval_weeks",
  "monthly",
] as const;
export type ScheduleMode = (typeof SCHEDULE_MODES)[number];

export const OVERRIDE_KINDS = ["rest", "excused", "activate", "cancel", "reschedule"] as const;
export type OverrideKind = (typeof OVERRIDE_KINDS)[number];

export const DAYPARTS = ["morning", "afternoon", "evening", "before_bed", "anytime"] as const;
export type Daypart = (typeof DAYPARTS)[number];

/** One effective-dated version of a schedule. */
export interface ScheduleRuleLike {
  id: string;
  effectiveFrom: DayKey;
  effectiveTo: DayKey | null;
  mode: string;
  interval: number;
  timesPerWeek: number | null;
  monthDay: number | null;
  enabled: boolean;
  daypart: string;
  timeMinute: number | null;
  reminderEnabled: boolean;
  reminderMinute: number | null;
  /** Flattened from ScheduleRuleDay rows. 0 = Sunday … 6 = Saturday. */
  weekdays: number[];
}

export interface ScheduleOverrideLike {
  date: DayKey;
  kind: string;
  movedToDate: DayKey | null;
  timeMinute: number | null;
  note: string | null;
}

/** Anything schedulable — a goal or a habit — reduced to what the engine needs. */
export interface SchedulableItem {
  id: string;
  /** The item's own lifespan, independent of schedule versioning. */
  startDate: DayKey | null;
  endDate: DayKey | null;
  /** Owner-level on/off: `Goal.active`, `!Habit.archived`. */
  enabled: boolean;
  rules: ScheduleRuleLike[];
  overrides: ScheduleOverrideLike[];
}

export interface ScheduleSettings {
  weekStartsOn: 0 | 1;
  timezone: string;
  /**
   * "Today" in the user's timezone. Injected rather than read from the clock so
   * that every caller in one render agrees on the date, and so tests are
   * deterministic. Since the operational-day work this is the *operational*
   * date — between midnight and the user's daily reset it is still the
   * previous calendar date (see src/lib/logic/operational-day.ts).
   */
  today: DayKey;
  /**
   * The user's daily reset, minutes after midnight (240 = 4:00 AM). Optional
   * so long-lived callers and tests that predate the setting keep working;
   * absent means the default reset. Read it via `resetMinuteOf`.
   */
  dayResetMinute?: number;
}

/**
 * Why a date is or is not an opportunity.
 *
 *  scheduled     — the schedule requires it on this date
 *  flexible      — a times-per-week item: available, but no single date is
 *                  required. Judged at the week level instead.
 *  not_scheduled — the recurring schedule simply does not land here
 *  rest          — scheduled, but the user converted this date to a rest day
 *  excused       — scheduled, but legitimately excused
 *  canceled      — this occurrence was cancelled outright
 *  moved         — this occurrence was rescheduled to another date
 *  before_start  — earlier than the item's start date
 *  after_end     — later than the item's end date
 *  disabled      — the item or its schedule version is switched off
 */
export type OccurrenceState =
  | "scheduled"
  | "flexible"
  | "not_scheduled"
  | "rest"
  | "excused"
  | "canceled"
  | "moved"
  | "before_start"
  | "after_end"
  | "disabled";

export interface Occurrence {
  date: DayKey;
  /** True only when this date is a real, required opportunity. */
  active: boolean;
  state: OccurrenceState;
  /** A times-per-week item on any in-window date. */
  flexible: boolean;
  /** Whether a miss here should break a streak. False for rest/excused/etc. */
  breaksStreakIfMissed: boolean;
  /** Whether this date belongs in a score or consistency denominator. */
  counts: boolean;
  rule: ScheduleRuleLike | null;
  override: ScheduleOverrideLike | null;
  timeMinute: number | null;
  daypart: string;
  /** Short human-readable explanation, shown directly in the UI. */
  reason: string;
}

/** How a scheduled opportunity actually turned out. */
export type CompletionStatus = "done" | "skipped" | "excused" | "missed";

export interface CompletionLike {
  date: DayKey;
  status: string;
  value?: number | null;
}

/**
 * The full resolved status of one date. This is what UIs render.
 *
 *  completed / missed / skipped / excused — the four real outcomes
 *  pending  — scheduled today, not yet done, day not over
 *  future   — scheduled later; never a failure
 *  rest / not_scheduled / canceled / inactive — neutral, no opportunity
 */
export type DayStatus =
  | "completed"
  | "missed"
  | "skipped"
  | "excused"
  | "pending"
  | "future"
  | "rest"
  | "not_scheduled"
  | "canceled"
  | "inactive";

export interface ResolvedDay {
  date: DayKey;
  status: DayStatus;
  occurrence: Occurrence;
  completion: CompletionLike | null;
  /** Reason text suitable for a tooltip or an empty-state line. */
  label: string;
}

// ---------------------------------------------------------------------------
// Timezone-aware date keys
// ---------------------------------------------------------------------------

/**
 * A calendar-day key for an instant, in a specific timezone.
 *
 * `en-CA` formats as `YYYY-MM-DD`, which is exactly the day-key shape, so this
 * needs no manual arithmetic and cannot drift the way `toISOString().slice(0,10)`
 * does (that silently reports the UTC day, which is the classic off-by-one).
 */
export function createStableDateKey(date: Date, timezone?: string | null): DayKey {
  if (!timezone) return localDateKey(date);
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    // An unknown or malformed timezone must never break the app; fall back to
    // the host's local calendar day.
    return localDateKey(date);
  }
}

function localDateKey(date: Date): DayKey {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Today's day key in the user's configured timezone. */
export function todayIn(timezone?: string | null, now: Date = new Date()): DayKey {
  return createStableDateKey(now, timezone);
}

/** Minutes from midnight *right now* in the user's timezone. */
export function nowMinuteIn(timezone?: string | null, now: Date = new Date()): number {
  if (!timezone) return now.getHours() * 60 + now.getMinutes();
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(now);
    const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
    const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
    return (hour % 24) * 60 + minute;
  } catch {
    return now.getHours() * 60 + now.getMinutes();
  }
}

/**
 * Turn a naive wall-clock string (`YYYY-MM-DDTHH:mm`) into the instant it
 * names *in the given timezone* — the inverse of `createStableDateKey`.
 *
 * `new Date("2026-08-02T09:00")` is parsed in whatever zone the machine
 * happens to be in, which on a hosted deployment is UTC — so a reminder the
 * user set for 9am would fire at 5am their time. This resolves the offset by
 * measuring it: format a first guess back in the target zone, and correct by
 * the difference. Two passes because the correction can itself cross a DST
 * boundary; the second pass settles it for every real-world zone.
 *
 * Returns null for a string that is not a wall clock, or an unusable zone —
 * callers must decide what to do rather than silently storing a wrong time.
 */
export function wallClockToInstant(wallClock: string, timezone?: string | null): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(wallClock.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;

  const wanted = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second ?? "0"),
  );
  if (Number.isNaN(wanted)) return null;
  if (!timezone) {
    const local = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second ?? "0"),
    );
    return Number.isNaN(local.getTime()) ? null : local;
  }

  try {
    let instant = new Date(wanted);
    for (let pass = 0; pass < 2; pass += 1) {
      // What wall clock does `instant` actually show in the target zone?
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).formatToParts(instant);
      const at = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
      const shown = Date.UTC(
        at("year"),
        at("month") - 1,
        at("day"),
        at("hour") % 24,
        at("minute"),
        at("second"),
      );
      const drift = wanted - shown;
      if (drift === 0) break;
      instant = new Date(instant.getTime() + drift);
    }
    return Number.isNaN(instant.getTime()) ? null : instant;
  } catch {
    // An unknown or malformed timezone must never break the app — the same
    // rule `createStableDateKey` follows. Fall back to the host's calendar,
    // which is what a zone-less app would have done anyway.
    const local = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second ?? "0"),
    );
    return Number.isNaN(local.getTime()) ? null : local;
  }
}

/** The browser's detected timezone, used to seed Settings on first run. */
export function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Week boundaries
// ---------------------------------------------------------------------------

export function getWeekBounds(
  date: DayKey,
  settings: Pick<ScheduleSettings, "weekStartsOn">,
): { start: DayKey; end: DayKey; days: DayKey[] } {
  const { start, end } = weekRange(date, settings.weekStartsOn);
  return { start, end, days: dayRange(start, end) };
}

// ---------------------------------------------------------------------------
// Rule resolution
// ---------------------------------------------------------------------------

/**
 * The schedule version in force on `date`.
 *
 * Rules are effective-dated, so editing a schedule today does not change what
 * last month's schedule was. When windows overlap (which a well-behaved writer
 * avoids) the latest `effectiveFrom` wins.
 */
export function resolveEffectiveSchedule(
  item: Pick<SchedulableItem, "rules">,
  date: DayKey,
): ScheduleRuleLike | null {
  let best: ScheduleRuleLike | null = null;

  for (const rule of item.rules) {
    if (daysBetween(rule.effectiveFrom, date) < 0) continue;
    if (rule.effectiveTo && daysBetween(rule.effectiveTo, date) > 0) continue;
    if (!best || daysBetween(best.effectiveFrom, rule.effectiveFrom) > 0) best = rule;
  }

  return best;
}

function findOverride(
  item: Pick<SchedulableItem, "overrides">,
  date: DayKey,
): ScheduleOverrideLike | null {
  return item.overrides.find((override) => override.date === date) ?? null;
}

/** An occurrence rescheduled *into* this date from somewhere else. */
function findMovedIn(
  item: Pick<SchedulableItem, "overrides">,
  date: DayKey,
): ScheduleOverrideLike | null {
  return (
    item.overrides.find(
      (override) => override.kind === "reschedule" && override.movedToDate === date,
    ) ?? null
  );
}

/** Does the recurring pattern itself land on this date, ignoring overrides? */
export function ruleMatchesDate(rule: ScheduleRuleLike, date: DayKey): boolean {
  const offset = daysBetween(rule.effectiveFrom, date);
  if (offset < 0) return false;
  const interval = Math.max(1, Math.round(rule.interval || 1));

  switch (rule.mode) {
    case "every_day":
      return true;

    case "weekdays":
      return rule.weekdays.includes(weekdayOf(date));

    case "times_per_week":
      // No individual date is required — handled at the week level.
      return false;

    case "one_time":
      return offset === 0;

    case "interval_days":
      return offset % interval === 0;

    case "interval_weeks": {
      const days = rule.weekdays.length > 0 ? rule.weekdays : [weekdayOf(rule.effectiveFrom)];
      if (!days.includes(weekdayOf(date))) return false;
      const weeksApart = alignedWeekIndex(date) - alignedWeekIndex(rule.effectiveFrom);
      return weeksApart >= 0 && weeksApart % interval === 0;
    }

    case "monthly": {
      const anchor = fromDayKey(rule.effectiveFrom);
      const target = rule.monthDay ?? anchor.getDate();
      const current = fromDayKey(date);
      const monthsApart =
        (current.getFullYear() - anchor.getFullYear()) * 12 +
        (current.getMonth() - anchor.getMonth());
      if (monthsApart < 0 || monthsApart % interval !== 0) return false;
      // Clamp so a "31st" schedule still fires in February.
      const lastDay = new Date(current.getFullYear(), current.getMonth() + 1, 0).getDate();
      return current.getDate() === Math.min(target, lastDay);
    }

    default:
      return false;
  }
}

/** Week index against a fixed Sunday epoch, so interval weeks align stably. */
function alignedWeekIndex(date: DayKey): number {
  const epoch = new Date(1970, 0, 4, 12, 0, 0, 0); // a Sunday
  return Math.floor((fromDayKey(date).getTime() - epoch.getTime()) / (7 * 86_400_000));
}

// ---------------------------------------------------------------------------
// Occurrence resolution — the core
// ---------------------------------------------------------------------------

const NEUTRAL: Pick<Occurrence, "active" | "flexible" | "breaksStreakIfMissed" | "counts"> = {
  active: false,
  flexible: false,
  breaksStreakIfMissed: false,
  counts: false,
};

export function getOccurrenceForDate(
  item: SchedulableItem,
  date: DayKey,
  _settings: ScheduleSettings,
): Occurrence {
  const base = { date, rule: null, override: null, timeMinute: null, daypart: "anytime" };

  if (!item.enabled) {
    return { ...base, ...NEUTRAL, state: "disabled", reason: "Turned off" };
  }
  if (item.startDate && daysBetween(item.startDate, date) < 0) {
    return { ...base, ...NEUTRAL, state: "before_start", reason: "Not started yet" };
  }
  if (item.endDate && daysBetween(item.endDate, date) > 0) {
    return { ...base, ...NEUTRAL, state: "after_end", reason: "Ended" };
  }

  const rule = resolveEffectiveSchedule(item, date);
  const override = findOverride(item, date);
  const withRule = {
    date,
    rule,
    override,
    timeMinute: override?.timeMinute ?? rule?.timeMinute ?? null,
    daypart: rule?.daypart ?? "anytime",
  };

  // --- overrides that answer the question outright --------------------------
  if (override) {
    switch (override.kind) {
      case "cancel":
        return { ...withRule, ...NEUTRAL, state: "canceled", reason: "Cancelled for this date" };
      case "rest":
        return { ...withRule, ...NEUTRAL, state: "rest", reason: "Rest day" };
      case "excused":
        return { ...withRule, ...NEUTRAL, state: "excused", reason: "Excused for this date" };
      case "reschedule":
        return {
          ...withRule,
          ...NEUTRAL,
          state: "moved",
          reason: override.movedToDate ? `Moved to ${override.movedToDate}` : "Moved",
        };
      case "activate":
        return {
          ...withRule,
          active: true,
          flexible: false,
          breaksStreakIfMissed: true,
          counts: true,
          state: "scheduled",
          reason: "Added for this date",
        };
      default:
        break;
    }
  }

  // An occurrence moved *into* this date is active here.
  const movedIn = findMovedIn(item, date);
  if (movedIn) {
    return {
      ...withRule,
      override: movedIn,
      timeMinute: movedIn.timeMinute ?? withRule.timeMinute,
      active: true,
      flexible: false,
      breaksStreakIfMissed: true,
      counts: true,
      state: "scheduled",
      reason: `Moved from ${movedIn.date}`,
    };
  }

  if (!rule) {
    return { ...withRule, ...NEUTRAL, state: "not_scheduled", reason: "No schedule for this date" };
  }
  if (!rule.enabled) {
    return { ...withRule, ...NEUTRAL, state: "disabled", reason: "Schedule turned off" };
  }

  // --- times per week -------------------------------------------------------
  if (rule.mode === "times_per_week") {
    return {
      ...withRule,
      active: false,
      flexible: true,
      breaksStreakIfMissed: false,
      counts: false,
      state: "flexible",
      reason: `${rule.timesPerWeek ?? 1}× per week — any day counts`,
    };
  }

  if (!ruleMatchesDate(rule, date)) {
    return { ...withRule, ...NEUTRAL, state: "not_scheduled", reason: "Not scheduled today" };
  }

  return {
    ...withRule,
    active: true,
    flexible: false,
    breaksStreakIfMissed: true,
    counts: true,
    state: "scheduled",
    reason: "Scheduled today",
  };
}

/** Convenience predicate — "does this apply on this date?". */
export function isItemActiveOnDate(
  item: SchedulableItem,
  date: DayKey,
  settings: ScheduleSettings,
): boolean {
  return getOccurrenceForDate(item, date, settings).active;
}

/** Filter a collection down to the items that apply on a date. */
export function getApplicableItemsForDate<T extends SchedulableItem>(
  items: T[],
  date: DayKey,
  settings: ScheduleSettings,
): Array<{ item: T; occurrence: Occurrence }> {
  return items
    .map((item) => ({ item, occurrence: getOccurrenceForDate(item, date, settings) }))
    .filter((entry) => entry.occurrence.active || entry.occurrence.flexible);
}

// ---------------------------------------------------------------------------
// Status resolution
// ---------------------------------------------------------------------------

export function isFutureOccurrence(date: DayKey, settings: ScheduleSettings): boolean {
  return daysBetween(settings.today, date) > 0;
}

/** 4:00 AM — the default daily reset (see src/lib/logic/operational-day.ts). */
export const DEFAULT_DAY_RESET_MINUTE = 4 * 60;

/** The daily reset for a settings object that may predate the setting. */
export function resetMinuteOf(settings: Pick<ScheduleSettings, "dayResetMinute">): number {
  return settings.dayResetMinute ?? DEFAULT_DAY_RESET_MINUTE;
}

/**
 * Overdue = a required occurrence, in the past or already past its time today,
 * with nothing recorded against it.
 */
export function isOverdueOccurrence(
  item: SchedulableItem,
  date: DayKey,
  settings: ScheduleSettings,
  options: { completion?: CompletionLike | null; nowMinute?: number } = {},
): boolean {
  const occurrence = getOccurrenceForDate(item, date, settings);
  if (!occurrence.active) return false;
  if (options.completion && options.completion.status !== "missed") return false;
  if (isFutureOccurrence(date, settings)) return false;

  if (date === settings.today) {
    if (occurrence.timeMinute === null) return false; // no time set — the day isn't over
    const now = options.nowMinute ?? nowMinuteIn(settings.timezone);
    // Compare on the operational day's extended axis: with a 4:00 AM reset,
    // 1:00 AM "now" sits at the *end* of today, past a 11:00 PM occurrence
    // but before a 1:30 AM one.
    const reset = resetMinuteOf(settings);
    const extend = (minute: number) => (reset > 0 && minute < reset ? minute + 1440 : minute);
    return extend(now) > extend(occurrence.timeMinute);
  }

  return true;
}

const STATUS_LABELS: Record<DayStatus, string> = {
  completed: "Completed",
  missed: "Missed",
  skipped: "Skipped",
  excused: "Excused",
  pending: "Due today",
  future: "Upcoming",
  rest: "Rest day",
  not_scheduled: "Not scheduled",
  canceled: "Cancelled",
  inactive: "Inactive",
};

export function getStatusForDate(
  item: SchedulableItem,
  date: DayKey,
  completion: CompletionLike | null,
  settings: ScheduleSettings,
): ResolvedDay {
  const occurrence = getOccurrenceForDate(item, date, settings);

  // A completion recorded on a non-scheduled date still counts as a completion
  // — the user did the thing. It just never becomes a *miss* there.
  if (completion?.status === "done") {
    return { date, status: "completed", occurrence, completion, label: STATUS_LABELS.completed };
  }

  if (!occurrence.active) {
    if (occurrence.flexible && completion?.status === "done") {
      return { date, status: "completed", occurrence, completion, label: STATUS_LABELS.completed };
    }
    const status: DayStatus =
      occurrence.state === "rest"
        ? "rest"
        : occurrence.state === "excused"
          ? "excused"
          : occurrence.state === "canceled" || occurrence.state === "moved"
            ? "canceled"
            : occurrence.state === "disabled" ||
                occurrence.state === "before_start" ||
                occurrence.state === "after_end"
              ? "inactive"
              : "not_scheduled";
    return { date, status, occurrence, completion, label: occurrence.reason };
  }

  if (completion?.status === "excused") {
    return { date, status: "excused", occurrence, completion, label: STATUS_LABELS.excused };
  }
  if (completion?.status === "skipped") {
    return { date, status: "skipped", occurrence, completion, label: STATUS_LABELS.skipped };
  }
  if (completion?.status === "missed") {
    return { date, status: "missed", occurrence, completion, label: STATUS_LABELS.missed };
  }

  // Nothing recorded.
  if (isFutureOccurrence(date, settings)) {
    return { date, status: "future", occurrence, completion, label: STATUS_LABELS.future };
  }
  if (date === settings.today) {
    return { date, status: "pending", occurrence, completion, label: STATUS_LABELS.pending };
  }
  return { date, status: "missed", occurrence, completion, label: STATUS_LABELS.missed };
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

const MAX_SCAN_DAYS = 400;

export function getNextScheduledDate(
  item: SchedulableItem,
  after: DayKey,
  settings: ScheduleSettings,
  maxScan = MAX_SCAN_DAYS,
): DayKey | null {
  for (let offset = 1; offset <= maxScan; offset += 1) {
    const date = shiftDay(after, offset);
    const occurrence = getOccurrenceForDate(item, date, settings);
    if (occurrence.active || occurrence.flexible) return date;
  }
  return null;
}

export function getPreviousScheduledDate(
  item: SchedulableItem,
  before: DayKey,
  settings: ScheduleSettings,
  maxScan = MAX_SCAN_DAYS,
): DayKey | null {
  for (let offset = 1; offset <= maxScan; offset += 1) {
    const date = shiftDay(before, -offset);
    if (item.startDate && daysBetween(item.startDate, date) < 0) return null;
    const occurrence = getOccurrenceForDate(item, date, settings);
    if (occurrence.active || occurrence.flexible) return date;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Aggregation over a range
// ---------------------------------------------------------------------------

/**
 * Every date in [from, to] that is a real opportunity.
 *
 * This is *the* denominator. Insights, completion rates and consistency all
 * derive from it, which is why "3 of 4 workouts" can never come out as
 * "3 of 7" again.
 */
export function calculateScheduledOpportunities(
  item: SchedulableItem,
  from: DayKey,
  to: DayKey,
  settings: ScheduleSettings,
): Occurrence[] {
  if (daysBetween(from, to) < 0) return [];
  return dayRange(from, to)
    .map((date) => getOccurrenceForDate(item, date, settings))
    .filter((occurrence) => occurrence.active);
}

export interface CompletionStats {
  /** Opportunities that have already come due (excludes future dates). */
  opportunities: number;
  completed: number;
  missed: number;
  skipped: number;
  excused: number;
  pending: number;
  future: number;
  /** rest + cancelled + excused-by-override, kept for explanations. */
  neutral: number;
  /** completed / opportunities, 0–100. `null` when there was no opportunity. */
  rate: number | null;
}

export function calculateCompletionRate(
  item: SchedulableItem,
  from: DayKey,
  to: DayKey,
  completions: CompletionLike[],
  settings: ScheduleSettings,
): CompletionStats {
  const byDate = new Map(completions.map((completion) => [completion.date, completion]));
  const stats: CompletionStats = {
    opportunities: 0,
    completed: 0,
    missed: 0,
    skipped: 0,
    excused: 0,
    pending: 0,
    future: 0,
    neutral: 0,
    rate: null,
  };

  if (daysBetween(from, to) < 0) return stats;

  for (const date of dayRange(from, to)) {
    const resolved = getStatusForDate(item, date, byDate.get(date) ?? null, settings);
    switch (resolved.status) {
      case "completed":
        // Only count as an opportunity if it was actually scheduled; an
        // opportunistic extra completion is a bonus, not a denominator entry.
        if (resolved.occurrence.active || resolved.occurrence.flexible) {
          stats.completed += 1;
          stats.opportunities += 1;
        } else {
          stats.completed += 1;
        }
        break;
      case "missed":
        stats.missed += 1;
        stats.opportunities += 1;
        break;
      case "skipped":
        stats.skipped += 1;
        stats.opportunities += 1;
        break;
      case "excused":
        stats.excused += 1;
        stats.neutral += 1;
        break;
      case "pending":
        stats.pending += 1;
        stats.opportunities += 1;
        break;
      case "future":
        stats.future += 1;
        break;
      case "rest":
      case "canceled":
        stats.neutral += 1;
        break;
      default:
        break;
    }
  }

  stats.rate =
    stats.opportunities === 0 ? null : Math.round((stats.completed / stats.opportunities) * 100);
  return stats;
}

// ---------------------------------------------------------------------------
// Streaks
// ---------------------------------------------------------------------------

export interface StreakResult {
  current: number;
  longest: number;
  /** The date the streak was last extended, if any. */
  lastCompleted: DayKey | null;
  /** Whether the current streak is measured in weeks (times-per-week items). */
  unit: "occurrences" | "weeks";
}

/**
 * Streaks count **consecutive scheduled opportunities**, not consecutive
 * calendar days. A Mon/Wed/Fri habit done six times in a row is a streak of 6,
 * and the Tuesdays in between neither extend nor break it.
 *
 * The rules, in one place so the UI can state them honestly:
 *  * completed          → extends the streak
 *  * missed             → breaks it
 *  * skipped            → breaks it (a deliberate skip is still a skip)
 *  * excused            → neutral, the streak survives
 *  * rest / cancelled   → neutral, not an opportunity at all
 *  * not scheduled      → neutral
 *  * pending today      → neutral; the day is not over yet
 *  * future             → never counted
 */
export function calculateScheduledStreak(
  item: SchedulableItem,
  throughDate: DayKey,
  completions: CompletionLike[],
  settings: ScheduleSettings,
  options: { since?: DayKey } = {},
): StreakResult {
  const rule = resolveEffectiveSchedule(item, throughDate);
  if (rule?.mode === "times_per_week") {
    return calculateWeeklyStreak(item, throughDate, completions, settings);
  }

  const byDate = new Map(completions.map((completion) => [completion.date, completion]));
  const earliest =
    options.since ??
    item.startDate ??
    item.rules.reduce<DayKey | null>(
      (min, candidate) =>
        min === null || daysBetween(candidate.effectiveFrom, min) > 0
          ? candidate.effectiveFrom
          : min,
      null,
    ) ??
    throughDate;

  const window = daysBetween(earliest, throughDate) < 0 ? [] : dayRange(earliest, throughDate);

  let longest = 0;
  let running = 0;
  let current = 0;
  let broken = false;
  let lastCompleted: DayKey | null = null;

  // Forward pass for `longest`.
  for (const date of window) {
    const resolved = getStatusForDate(item, date, byDate.get(date) ?? null, settings);
    if (resolved.status === "completed") {
      running += 1;
      longest = Math.max(longest, running);
      lastCompleted = date;
    } else if (resolved.status === "missed" || resolved.status === "skipped") {
      running = 0;
    }
    // everything else is neutral
  }

  // Backward pass for `current`.
  for (let index = window.length - 1; index >= 0; index -= 1) {
    const date = window[index];
    const resolved = getStatusForDate(item, date, byDate.get(date) ?? null, settings);
    if (resolved.status === "completed") {
      current += 1;
    } else if (resolved.status === "missed" || resolved.status === "skipped") {
      broken = true;
      break;
    }
  }
  void broken;

  return { current, longest: Math.max(longest, current), lastCompleted, unit: "occurrences" };
}

/** For times-per-week items a "streak" is consecutive weeks that hit target. */
function calculateWeeklyStreak(
  item: SchedulableItem,
  throughDate: DayKey,
  completions: CompletionLike[],
  settings: ScheduleSettings,
): StreakResult {
  const doneDates = new Set(
    completions.filter((completion) => completion.status === "done").map((c) => c.date),
  );

  let current = 0;
  let longest = 0;
  let cursor = getWeekBounds(throughDate, settings).start;
  let lastCompleted: DayKey | null = null;

  const currentWeekStart = getWeekBounds(settings.today, settings).start;

  for (let scanned = 0; scanned < 260; scanned += 1) {
    const bounds = getWeekBounds(cursor, settings);
    const rule = resolveEffectiveSchedule(item, bounds.start);
    if (!rule) break;
    if (item.startDate && daysBetween(item.startDate, bounds.end) < 0) break;

    const target = Math.max(1, rule.timesPerWeek ?? 1);
    const done = bounds.days.filter((day) => doneDates.has(day)).length;
    if (done > 0) lastCompleted = lastCompleted ?? bounds.days.filter((d) => doneDates.has(d)).pop() ?? null;

    if (done >= target) {
      current += 1;
      longest = Math.max(longest, current);
    } else if (bounds.start === currentWeekStart) {
      // The week is still running — an unfinished target is not a failure yet.
    } else {
      break;
    }

    cursor = shiftDay(bounds.start, -1);
  }

  return { current, longest, lastCompleted, unit: "weeks" };
}

// ---------------------------------------------------------------------------
// Weekly progress
// ---------------------------------------------------------------------------

export interface WeeklyProgress {
  start: DayKey;
  end: DayKey;
  /** How many completions the week asks for. */
  target: number;
  done: number;
  remaining: number;
  /** 0–100, capped. */
  percent: number;
  /** True once the week is over and the target was not reached. */
  failed: boolean;
  /** Days still available to hit the target (today onward, within the week). */
  daysLeft: number;
  mode: string;
}

/**
 * "3 of 4, 75%, one to go" — never "3 of 7".
 *
 * A times-per-week target is judged against the target, and it is *not* failed
 * before the week ends. A weekday-scheduled item is judged against how many of
 * its own scheduled days fall in the week.
 */
export function calculateWeeklyProgress(
  item: SchedulableItem,
  date: DayKey,
  completions: CompletionLike[],
  settings: ScheduleSettings,
): WeeklyProgress {
  const bounds = getWeekBounds(date, settings);
  const rule = resolveEffectiveSchedule(item, date) ?? resolveEffectiveSchedule(item, bounds.start);
  const doneDates = new Set(
    completions.filter((completion) => completion.status === "done").map((c) => c.date),
  );

  const done = bounds.days.filter((day) => doneDates.has(day)).length;

  const target =
    rule?.mode === "times_per_week"
      ? Math.max(1, rule.timesPerWeek ?? 1)
      : calculateScheduledOpportunities(item, bounds.start, bounds.end, settings).length;

  const weekIsOver = daysBetween(bounds.end, settings.today) > 0;
  const daysLeft = bounds.days.filter((day) => daysBetween(settings.today, day) >= 0).length;

  return {
    start: bounds.start,
    end: bounds.end,
    target,
    done,
    remaining: Math.max(0, target - done),
    percent: target === 0 ? 0 : Math.min(100, Math.round((done / target) * 100)),
    failed: weekIsOver && done < target,
    daysLeft,
    mode: rule?.mode ?? "every_day",
  };
}

// ---------------------------------------------------------------------------
// Descriptions
// ---------------------------------------------------------------------------

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_FULL = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export const WEEKDAY_NAMES = { short: WEEKDAY_SHORT, full: WEEKDAY_FULL };

const WEEKDAY_SET = [1, 2, 3, 4, 5];
const WEEKEND_SET = [0, 6];

function sameDays(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort((x, y) => x - y);
  const sortedB = [...b].sort((x, y) => x - y);
  return sortedA.every((value, index) => value === sortedB[index]);
}

/** "Every day", "Weekdays", "Mon, Wed, Fri", "4× per week", "Disabled". */
export function describeSchedule(rule: ScheduleRuleLike | null): string {
  if (!rule) return "No schedule";
  if (!rule.enabled) return "Disabled";

  switch (rule.mode) {
    case "every_day":
      return "Every day";
    case "weekdays": {
      const days = rule.weekdays;
      if (days.length === 0) return "No days selected";
      if (days.length === 7) return "Every day";
      if (sameDays(days, WEEKDAY_SET)) return "Weekdays";
      if (sameDays(days, WEEKEND_SET)) return "Weekends";
      return [...days]
        .sort((a, b) => a - b)
        .map((day) => WEEKDAY_SHORT[day])
        .join(", ");
    }
    case "times_per_week":
      return `${rule.timesPerWeek ?? 1}× per week`;
    case "one_time":
      return `Once on ${rule.effectiveFrom}`;
    case "interval_days":
      return rule.interval === 1 ? "Every day" : `Every ${rule.interval} days`;
    case "interval_weeks": {
      const days = rule.weekdays.length
        ? rule.weekdays
            .slice()
            .sort((a, b) => a - b)
            .map((day) => WEEKDAY_SHORT[day])
            .join(", ")
        : "";
      const every = rule.interval === 1 ? "Every week" : `Every ${rule.interval} weeks`;
      return days ? `${every} on ${days}` : every;
    }
    case "monthly":
      return rule.monthDay ? `Monthly on day ${rule.monthDay}` : "Monthly";
    default:
      return "Custom schedule";
  }
}

/** Convenience for an item rather than a bare rule. */
export function describeItemSchedule(item: SchedulableItem, date: DayKey): string {
  if (!item.enabled) return "Disabled";
  return describeSchedule(resolveEffectiveSchedule(item, date));
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export const SCHEDULE_PRESETS = {
  every_day: { label: "Every day", mode: "every_day" as const, weekdays: [0, 1, 2, 3, 4, 5, 6] },
  weekdays: { label: "Weekdays", mode: "weekdays" as const, weekdays: WEEKDAY_SET },
  weekends: { label: "Weekends", mode: "weekdays" as const, weekdays: WEEKEND_SET },
  custom: { label: "Custom days", mode: "weekdays" as const, weekdays: [] as number[] },
};

/**
 * Building a rule from form input, with the defaults that keep the engine
 * honest (a `weekdays` mode with no days selected would silently apply never).
 */
export function normalizeRuleInput(input: {
  mode: string;
  weekdays?: number[];
  interval?: number;
  timesPerWeek?: number | null;
  monthDay?: number | null;
}): { mode: ScheduleMode; weekdays: number[]; interval: number; timesPerWeek: number | null; monthDay: number | null } {
  const mode = (SCHEDULE_MODES as readonly string[]).includes(input.mode)
    ? (input.mode as ScheduleMode)
    : "every_day";

  const weekdays = Array.from(
    new Set((input.weekdays ?? []).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)),
  ).sort((a, b) => a - b);

  return {
    mode,
    weekdays: mode === "weekdays" || mode === "interval_weeks" ? weekdays : [],
    interval: Math.max(1, Math.round(input.interval ?? 1)),
    timesPerWeek:
      mode === "times_per_week"
        ? Math.min(7, Math.max(1, Math.round(input.timesPerWeek ?? 1)))
        : null,
    monthDay:
      mode === "monthly" ? Math.min(31, Math.max(1, Math.round(input.monthDay ?? 1))) : null,
  };
}
