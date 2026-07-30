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
}

/**
 * Do two items genuinely occupy the same minutes?
 *
 * Deliberately conservative, because a conflict badge that cries wolf gets
 * ignored:
 *  * all-day items span the whole day by definition and never conflict;
 *  * an item without both a start and an end has no duration to clash with;
 *  * a zero-length item (start === end) occupies no minutes;
 *  * touching endpoints (09:00–10:00 and 10:00–11:00) are back-to-back, not
 *    overlapping;
 *  * a skipped item is explicitly not happening.
 */
export function spansOverlap(a: ConflictCandidate, b: ConflictCandidate): boolean {
  if (a.id === b.id) return false;
  if (a.allDay || b.allDay) return false;
  if (a.status === "skipped" || b.status === "skipped") return false;

  const { startMinute: aStart, endMinute: aEnd } = a;
  const { startMinute: bStart, endMinute: bEnd } = b;
  if (aStart === null || aEnd === null || bStart === null || bEnd === null) return false;
  if (aEnd <= aStart || bEnd <= bStart) return false;

  return aStart < bEnd && bStart < aEnd;
}

export interface ConflictPair {
  a: ConflictCandidate;
  b: ConflictCandidate;
}

/** Every overlapping pair on a day, each pair reported once. */
export function findConflicts(items: ConflictCandidate[]): ConflictPair[] {
  const sorted = items
    .slice()
    .sort((left, right) => (left.startMinute ?? 0) - (right.startMinute ?? 0));

  const pairs: ConflictPair[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      if (spansOverlap(sorted[i], sorted[j])) pairs.push({ a: sorted[i], b: sorted[j] });
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
 * re-times the item keeping its duration (clamped to midnight), `undefined`
 * keeps its time-of-day, `null` clears it to all-day.
 *
 * The clash test is `spansOverlap`, so everything that engine excuses —
 * all-day items, missing or zero-length spans, touching endpoints, skipped
 * items, the item itself — cannot flag here either. A move that leaves the
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
  const duration =
    item.startMinute !== null && item.endMinute !== null ? item.endMinute - item.startMinute : null;

  const nextStart = startMinute === undefined ? item.startMinute : startMinute;
  const nextEnd =
    nextStart !== null && duration !== null ? Math.min(1439, nextStart + duration) : item.endMinute;

  const span = {
    startMinute: nextStart,
    endMinute: nextStart === null ? null : nextEnd,
    allDay: nextStart === null,
  };

  const unchanged =
    date === item.date && span.startMinute === item.startMinute && span.endMinute === item.endMinute;
  if (unchanged) return { ...span, conflicts: [] };

  const moved: ConflictCandidate = { id: item.id, title: "", status: item.status, ...span };
  const conflicts = targetItems
    .filter((other) => spansOverlap(moved, other))
    .sort((a, b) => (a.startMinute ?? 0) - (b.startMinute ?? 0))
    .map((other) => other.title);

  return { ...span, conflicts };
}
