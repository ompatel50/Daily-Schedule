/**
 * Planner rules that do not touch the database: routine (template) application
 * identity, and time-range conflict detection.
 *
 * Both live here, pure, for the same reason the schedule engine does — they are
 * decisions with edge cases worth testing directly, and the server action
 * should only be the part that reads and writes rows.
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

export interface PlannedTemplateRow {
  row: TemplateRow;
  index: number;
  sourceKey: string;
}

export interface TemplatePlan {
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
  create: PlannedTemplateRow[];
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
export function planTemplateApplication({
  rows,
  existing,
  mode = "auto",
}: {
  rows: TemplateRow[];
  existing: ExistingTemplateRow[];
  mode?: TemplateApplyMode;
}): TemplatePlan {
  const build = (ordinal: number, skipKeys: Set<string>): PlannedTemplateRow[] =>
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
