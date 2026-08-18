/**
 * Planner rules that do not touch the database: routine (template) application
 * identity, and time-range conflict detection.
 *
 * Both live here, pure, for the same reason the schedule engine does — they are
 * decisions with edge cases worth testing directly, and the server action
 * should only be the part that reads and writes rows.
 *
 * `planTemplateApplication` is generic over the row type because "stamp a saved
 * set of rows onto a container, without doubling it by accident" is the same
 * problem for a planner routine and a meal template. Nutrition reuses it rather
 * than growing a second copy with its own edge cases.
 */

import { daysBetween } from "@/lib/date";
import { calendarDateForOperationalTime } from "./operational-day";
import {
  comparePlannerSpans,
  resolvedEndMinute,
  spanDurationMinutes,
} from "./schedule-span";

// ---------------------------------------------------------------------------
// Routine application
// ---------------------------------------------------------------------------

/**
 * What the caller wants to happen when a routine has already been stamped onto
 * the day. `auto` means "decide for me" — it applies cleanly when nothing is
 * there and otherwise reports back so the user can choose.
 */
export const TEMPLATE_APPLY_MODES = ["auto", "keep", "replace", "duplicate"] as const;
export type TemplateApplyMode = (typeof TEMPLATE_APPLY_MODES)[number];

export interface TemplateRow {
  title: string;
  startMinute?: number | null;
  endMinute?: number | null;
  allDay?: boolean;
  category?: string;
  priority?: string;
  notes?: string | null;
}

/** The already-present rows from this routine on this day. */
export interface ExistingTemplateRow {
  id: string;
  sourceKey: string | null;
}

export interface PlannedTemplateRow<TRow = TemplateRow> {
  row: TRow;
  index: number;
  sourceKey: string;
}

export interface TemplatePlan<TRow = TemplateRow> {
  /**
   * `create`  — write `create`, nothing was there (or the user asked for a
   *             deliberate second copy).
   * `ask`     — the routine is already on this day; the caller must offer the
   *             choice rather than silently doubling it.
   * `keep`    — leave the day exactly as it is.
   * `replace` — delete `remove`, then write `create`.
   */
  action: "create" | "ask" | "keep" | "replace";
  /** Application ordinal the new rows carry. 1 is a first application. */
  ordinal: number;
  create: PlannedTemplateRow<TRow>[];
  /** Ids to delete before writing. Only ever populated for `replace`. */
  remove: string[];
  /** How many rows from this routine already sit on the day. */
  existing: number;
}

/** `<application ordinal>:<row index>` — see `ScheduleItem.sourceKey`. */
export function templateSourceKey(ordinal: number, index: number): string {
  return `${ordinal}:${index}`;
}

export function parseSourceKey(key: string | null | undefined): { ordinal: number; index: number } | null {
  if (!key) return null;
  const match = /^(\d+):(\d+)$/.exec(key);
  if (!match) return null;
  return { ordinal: Number(match[1]), index: Number(match[2]) };
}

/**
 * The ordinal a fresh application should use. Rows written before this column
 * existed have a null key; they are still a first application, so they count as
 * ordinal 1 and the next deliberate copy becomes 2.
 */
export function nextApplicationOrdinal(existing: ExistingTemplateRow[]): number {
  if (existing.length === 0) return 1;
  const highest = existing.reduce((max, row) => {
    const parsed = parseSourceKey(row.sourceKey);
    return parsed ? Math.max(max, parsed.ordinal) : max;
  }, 1);
  return highest + 1;
}

/**
 * Decide what applying `rows` to a day should do, given what is already there.
 *
 * Rows whose source key is already present are dropped from the result, so a
 * retried or double-submitted application cannot write the same row twice even
 * before the database's unique constraint gets involved.
 */
export function planTemplateApplication<TRow = TemplateRow>({
  rows,
  existing,
  mode = "auto",
}: {
  rows: TRow[];
  existing: ExistingTemplateRow[];
  mode?: TemplateApplyMode;
}): TemplatePlan<TRow> {
  const build = (ordinal: number, skipKeys: Set<string>): PlannedTemplateRow<TRow>[] =>
    rows
      .map((row, index) => ({ row, index, sourceKey: templateSourceKey(ordinal, index) }))
      .filter((planned) => !skipKeys.has(planned.sourceKey));

  const presentKeys = new Set(
    existing.map((row) => row.sourceKey).filter((key): key is string => Boolean(key)),
  );

  if (existing.length === 0) {
    return { action: "create", ordinal: 1, create: build(1, presentKeys), remove: [], existing: 0 };
  }

  switch (mode) {
    case "keep":
      return { action: "keep", ordinal: 0, create: [], remove: [], existing: existing.length };

    case "replace":
      return {
        action: "replace",
        ordinal: 1,
        // The old rows go first, so ordinal 1 is free again.
        create: build(1, new Set()),
        remove: existing.map((row) => row.id),
        existing: existing.length,
      };

    case "duplicate": {
      const ordinal = nextApplicationOrdinal(existing);
      return {
        action: "create",
        ordinal,
        create: build(ordinal, presentKeys),
        remove: [],
        existing: existing.length,
      };
    }

    case "auto":
    default:
      return { action: "ask", ordinal: 0, create: [], remove: [], existing: existing.length };
  }
}

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

export interface ConflictCandidate {
  id: string;
  title: string;
  startMinute: number | null;
  endMinute: number | null;
  allDay: boolean;
  status?: string;
  /**
   * Calendar date (`YYYY-MM-DD`) of the span's start. When both candidates
   * carry one, overlap is computed across real dates: a cross-midnight block
   * meets the next date's early blocks at its real position, and a block that
   * spans the daily reset meets the following operational day's items. Absent
   * on both sides (legacy callers), the spans are assumed to share one date.
   */
  date?: string;
}

/**
 * Overlap semantics, in two deliberately separate concepts:
 *
 *  1. **Exact interval overlap** (`spansOverlap`) — do two spans share any
 *     minute at all, under half-open `[start, end)` semantics? This is the
 *     hard correctness rule: the end minute is excluded, so an item ending at
 *     9:00 AM and one starting at 9:00 AM are back-to-back, never overlapping.
 *
 *  2. **A scheduling conflict** (`isSchedulingConflict`) — the user-facing
 *     double-booking *warning*. It is the exact rule plus a small tolerance:
 *     an intersection of `CONFLICT_TOLERANCE_MINUTES` or less is treated as a
 *     rounding artefact, not a double booking, so a block ending 10:00 next
 *     to one starting 9:59 stays quiet while 9:58 warns.
 *
 * Every warning surface (banner, row badges, pair counts, timeline styling,
 * move/edit previews, assistant previews) goes through the conflict form.
 * The tolerance affects classification only — stored times are never touched
 * and nothing is ever snapped or moved.
 */

/**
 * Intersections of at most this many minutes are not worth a double-booking
 * warning. Classification only; never applied to stored timestamps.
 */
export const CONFLICT_TOLERANCE_MINUTES = 1;

/**
 * How many minutes two spans genuinely share, under `[start, end)` semantics —
 * 0 when they merely touch, are disjoint, or either has nothing to intersect:
 *  * all-day items span the whole day by definition and never clash;
 *  * an item without both a start and an end has no duration;
 *  * a zero-length point item (start === end) occupies no minutes;
 *  * a skipped item is explicitly not happening.
 *
 * Spans are compared at their REAL positions. Each candidate resolves to a
 * half-open interval on its start date's wall-clock axis — a wrapped end
 * (`endMinute < startMinute`, a cross-midnight block) extends past 1440 via
 * `resolvedEndMinute` — and when both candidates carry a `date`, the two
 * axes are aligned by their calendar-day distance. That one rule covers every
 * boundary case with no special-casing: 11:45 PM → 12:15 AM against the next
 * date's 12:15 AM → 1:00 AM is exactly adjacent, and a block spanning the
 * daily reset meets the next operational day's items where it really does.
 */
export function overlapMinutes(a: ConflictCandidate, b: ConflictCandidate): number {
  if (a.id === b.id) return 0;
  if (a.allDay || b.allDay) return 0;
  if (a.status === "skipped" || b.status === "skipped") return 0;

  const { startMinute: aStart, endMinute: aEnd } = a;
  const { startMinute: bStart, endMinute: bEnd } = b;
  if (aStart === null || aEnd === null || bStart === null || bEnd === null) return 0;

  const aRealEnd = resolvedEndMinute(aStart, aEnd);
  const bRealEnd = resolvedEndMinute(bStart, bEnd);
  // Zero-length point items occupy no minutes.
  if (aRealEnd <= aStart || bRealEnd <= bStart) return 0;

  // Align b's axis onto a's: one calendar day apart = 1440 wall minutes.
  const offset = a.date && b.date && a.date !== b.date ? daysBetween(a.date, b.date) * 1440 : 0;

  return Math.max(0, Math.min(aRealEnd, bRealEnd + offset) - Math.max(aStart, bStart + offset));
}

/** Exact half-open overlap: the spans share at least one minute. */
export function spansOverlap(a: ConflictCandidate, b: ConflictCandidate): boolean {
  return overlapMinutes(a, b) > 0;
}

/**
 * The user-facing double-booking test: a real overlap beyond the tolerance.
 * `spansOverlap` stays the exact rule for anything that needs precise
 * geometry; warnings all come through here.
 */
export function isSchedulingConflict(a: ConflictCandidate, b: ConflictCandidate): boolean {
  return overlapMinutes(a, b) > CONFLICT_TOLERANCE_MINUTES;
}

export interface ConflictPair {
  a: ConflictCandidate;
  b: ConflictCandidate;
}

/** Every conflicting pair on a day, each pair reported once — `a` is always
 * the chronologically earlier of the pair. */
export function findConflicts(items: ConflictCandidate[]): ConflictPair[] {
  const sorted = items.slice().sort((left, right) => comparePlannerSpans(left, right));

  const pairs: ConflictPair[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      if (isSchedulingConflict(sorted[i], sorted[j])) pairs.push({ a: sorted[i], b: sorted[j] });
    }
  }
  return pairs;
}

/**
 * Item id → the titles it clashes with, for rendering a per-row badge. Items
 * with no conflict are absent rather than mapped to an empty array, so
 * `map.get(id)` reads as "is this one in trouble?".
 */
export function conflictsByItem(items: ConflictCandidate[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const add = (id: string, title: string) => {
    const current = map.get(id);
    if (current) current.push(title);
    else map.set(id, [title]);
  };

  for (const { a, b } of findConflicts(items)) {
    add(a.id, b.title);
    add(b.id, a.title);
  }
  return map;
}

/**
 * "Deep work", or "Deep work and 2 more". The row badge, the timeline block
 * and the move confirmation all describe a clash with the same words; null
 * when there is nothing to say.
 */
export function summarizeConflicts(titles: string[]): string | null {
  if (titles.length === 0) return null;
  if (titles.length === 1) return titles[0];
  return `${titles[0]} and ${titles.length - 1} more`;
}

// ---------------------------------------------------------------------------
// Move pre-check
// ---------------------------------------------------------------------------

/** The fields of the item being moved that the decision needs. */
export interface MoveSource {
  id: string;
  date: string;
  startMinute: number | null;
  endMinute: number | null;
  allDay: boolean;
  status?: string;
}

export interface MovePlan {
  /** The span the item occupies after the move — exactly what the write sets. */
  startMinute: number | null;
  endMinute: number | null;
  allDay: boolean;
  /**
   * Titles on the target day the moved span would overlap, earliest first.
   * Empty means the move is clear to write without asking.
   */
  conflicts: string[];
}

/**
 * Decide what a move writes and what it would land on, before anything is
 * written.
 *
 * The span mirrors `moveScheduleItem`'s write: an explicit `startMinute`
 * re-times the item keeping its duration — across midnight when it no longer
 * fits the day (a 90-minute block moved to 11:00 PM ends 12:30 AM next day,
 * stored as a wrapped end) — `undefined` keeps its time-of-day, `null` clears
 * it to all-day.
 *
 * The clash test is `isSchedulingConflict`, so everything that engine
 * excuses — all-day items, missing or zero-length spans, touching or
 * tolerance-close endpoints, skipped items, the item itself — cannot flag
 * here either. A move that leaves the
 * item exactly where it already is reports nothing: the caller is not
 * creating an overlap, so there is nothing to confirm — a pre-existing clash
 * stays the badges' job.
 */
export function planMove({
  item,
  date,
  startMinute,
  targetItems,
}: {
  item: MoveSource;
  date: string;
  startMinute?: number | null;
  /** Everything already on the target day; may include `item` itself. */
  targetItems: ConflictCandidate[];
}): MovePlan {
  const duration = spanDurationMinutes(item.startMinute, item.endMinute);

  const nextStart = startMinute === undefined ? item.startMinute : startMinute;
  // The duration survives the move; an end past midnight wraps (mod 1440) —
  // end-before-start is the stored form of "ends next day".
  const nextEnd =
    nextStart !== null && duration !== null ? (nextStart + duration) % 1440 : item.endMinute;

  const span = {
    startMinute: nextStart,
    endMinute: nextStart === null ? null : nextEnd,
    allDay: nextStart === null,
  };

  const unchanged =
    date === item.date && span.startMinute === item.startMinute && span.endMinute === item.endMinute;
  if (unchanged) return { ...span, conflicts: [] };

  const moved: ConflictCandidate = { id: item.id, title: "", status: item.status, date, ...span };
  const conflicts = targetItems
    .filter((other) => isSchedulingConflict(moved, other))
    .sort((a, b) => comparePlannerSpans(a, b))
    .map((other) => other.title);

  return { ...span, conflicts };
}

// ---------------------------------------------------------------------------
// Copy day / copy week
// ---------------------------------------------------------------------------

/** The slice of a source row a copy needs — links included, identity not. */
export interface CopySourceRow {
  id: string;
  title: string;
  notes: string | null;
  startMinute: number | null;
  endMinute: number | null;
  allDay: boolean;
  category: string;
  priority: string;
  sortOrder: number;
  seriesId: string | null;
  recurrenceRule: string | null;
  habitId: string | null;
  taskId: string | null;
  /** Tag ids to re-link on the copy. */
  tagIds: string[];
}

/** One block the copy will create (dates and storage are the caller's job). */
export type PlannedCopyRow = Omit<CopySourceRow, "id" | "seriesId" | "recurrenceRule">;

export interface DayCopyPlan {
  /** Blocks to create on the target day, source order preserved. */
  copies: PlannedCopyRow[];
  /** Recurring rows (parents and occurrences) left out — they already recur. */
  skippedRecurring: number;
  /** Titles on the target day the copied spans would overlap, earliest first. */
  conflicts: string[];
}

/**
 * Decide what copying one day's layout onto another creates, before anything
 * is written.
 *
 *  * Only ONE-OFF blocks copy. A recurring series already covers the target
 *    day by its own rule — re-copying an occurrence would double it — so
 *    series parents and occurrences are counted in `skippedRecurring` for the
 *    UI to say so plainly.
 *  * A copy is a fresh planned block: `status` resets, completion stamps and
 *    template identity do not travel. Links that describe the block's
 *    MEANING (its task, its habit, its tags) travel; links that name another
 *    day's RECORD (a logged workout, a logged meal) cannot — those rows
 *    belong to the source day, and their planner mirrors are unique per row.
 *  * Conflicts use the same `isSchedulingConflict` rule as every other
 *    warning surface, against everything already on the target day. Like a
 *    move, the answer is a warning to confirm, never a block.
 */
export function planDayCopy({
  source,
  targetItems,
  targetDate,
  resetMinute = 0,
}: {
  source: CopySourceRow[];
  /** Everything already on the target day (its calendar dates ± 1). */
  targetItems: ConflictCandidate[];
  /** The target's calendar date for span alignment (the caller resolves
   *  operational storage per row afterwards). */
  targetDate: string;
  /** The user's daily reset — a before-reset copy lands on the NEXT calendar
   *  date, and its spans must be compared there. Default: midnight. */
  resetMinute?: number;
}): DayCopyPlan {
  const oneOff = source.filter((row) => !row.seriesId && !row.recurrenceRule);
  const copies = oneOff.map((row) => ({
    title: row.title,
    notes: row.notes,
    startMinute: row.allDay ? null : row.startMinute,
    endMinute: row.allDay ? null : row.endMinute,
    allDay: row.allDay,
    category: row.category,
    priority: row.priority,
    sortOrder: row.sortOrder,
    habitId: row.habitId,
    taskId: row.taskId,
    tagIds: row.tagIds,
  }));

  const conflictTitles = new Set<string>();
  const ordered: ConflictCandidate[] = [];
  for (const copy of copies) {
    const candidate: ConflictCandidate = {
      id: "__copy__",
      title: copy.title,
      date: calendarDateForOperationalTime(targetDate, copy.startMinute, resetMinute),
      startMinute: copy.startMinute,
      endMinute: copy.endMinute,
      allDay: copy.allDay,
    };
    for (const other of targetItems) {
      if (!isSchedulingConflict(candidate, other)) continue;
      if (conflictTitles.has(other.title)) continue;
      conflictTitles.add(other.title);
      ordered.push(other);
    }
  }

  return {
    copies,
    skippedRecurring: source.length - oneOff.length,
    conflicts: ordered.sort((a, b) => comparePlannerSpans(a, b)).map((other) => other.title),
  };
}
