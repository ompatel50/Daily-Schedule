import { describe, expect, it } from "vitest";

import {
  CONFLICT_TOLERANCE_MINUTES,
  conflictsByItem,
  findConflicts,
  isSchedulingConflict,
  nextApplicationOrdinal,
  overlapMinutes,
  parseSourceKey,
  planMove,
  planTemplateApplication,
  spansOverlap,
  summarizeConflicts,
  templateSourceKey,
  type ConflictCandidate,
  type ExistingTemplateRow,
  type MoveSource,
  type TemplateRow,
  planDayCopy,
} from "@/lib/logic/planner";

const ROUTINE: TemplateRow[] = [
  { title: "Morning routine", startMinute: 390, endMinute: 435 },
  { title: "Deep work", startMinute: 540, endMinute: 690 },
  { title: "Shutdown", startMinute: 1020, endMinute: 1040 },
];

/** The rows a previous application of ROUTINE would have left behind. */
function applied(ordinal: number, count = ROUTINE.length): ExistingTemplateRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `row-${ordinal}-${index}`,
    sourceKey: templateSourceKey(ordinal, index),
  }));
}

describe("templateSourceKey / parseSourceKey", () => {
  it("round-trips an ordinal and a row index", () => {
    expect(templateSourceKey(1, 0)).toBe("1:0");
    expect(parseSourceKey("1:0")).toEqual({ ordinal: 1, index: 0 });
    expect(parseSourceKey(templateSourceKey(12, 340))).toEqual({ ordinal: 12, index: 340 });
  });

  it("rejects anything that is not a key", () => {
    expect(parseSourceKey(null)).toBeNull();
    expect(parseSourceKey(undefined)).toBeNull();
    expect(parseSourceKey("")).toBeNull();
    expect(parseSourceKey("1")).toBeNull();
    expect(parseSourceKey("a:b")).toBeNull();
    expect(parseSourceKey("1:0:0")).toBeNull();
  });
});

describe("nextApplicationOrdinal", () => {
  it("starts at 1 when the day is empty", () => {
    expect(nextApplicationOrdinal([])).toBe(1);
  });

  it("follows the highest ordinal already present", () => {
    expect(nextApplicationOrdinal(applied(1))).toBe(2);
    expect(nextApplicationOrdinal([...applied(1), ...applied(2)])).toBe(3);
  });

  it("treats pre-upgrade rows with no key as a first application", () => {
    const legacy: ExistingTemplateRow[] = [
      { id: "old-1", sourceKey: null },
      { id: "old-2", sourceKey: null },
    ];
    expect(nextApplicationOrdinal(legacy)).toBe(2);
  });
});

describe("planTemplateApplication", () => {
  it("applies every row when the routine is not on the day yet", () => {
    const plan = planTemplateApplication({ rows: ROUTINE, existing: [] });

    expect(plan.action).toBe("create");
    expect(plan.ordinal).toBe(1);
    expect(plan.existing).toBe(0);
    expect(plan.remove).toEqual([]);
    expect(plan.create.map((planned) => planned.sourceKey)).toEqual(["1:0", "1:1", "1:2"]);
    expect(plan.create.map((planned) => planned.row.title)).toEqual([
      "Morning routine",
      "Deep work",
      "Shutdown",
    ]);
  });

  it("writes nothing and asks when the routine is already there", () => {
    const plan = planTemplateApplication({ rows: ROUTINE, existing: applied(1) });

    expect(plan.action).toBe("ask");
    expect(plan.create).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(plan.existing).toBe(3);
  });

  it("keeps the day untouched when the user chooses to keep", () => {
    const plan = planTemplateApplication({ rows: ROUTINE, existing: applied(1), mode: "keep" });

    expect(plan.action).toBe("keep");
    expect(plan.create).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it("replaces by removing the old rows and re-using ordinal 1", () => {
    const existing = applied(1);
    const plan = planTemplateApplication({ rows: ROUTINE, existing, mode: "replace" });

    expect(plan.action).toBe("replace");
    expect(plan.ordinal).toBe(1);
    expect(plan.remove).toEqual(existing.map((row) => row.id));
    expect(plan.create.map((planned) => planned.sourceKey)).toEqual(["1:0", "1:1", "1:2"]);
  });

  it("allows a deliberate second copy under the next ordinal", () => {
    const plan = planTemplateApplication({ rows: ROUTINE, existing: applied(1), mode: "duplicate" });

    expect(plan.action).toBe("create");
    expect(plan.ordinal).toBe(2);
    expect(plan.remove).toEqual([]);
    expect(plan.create.map((planned) => planned.sourceKey)).toEqual(["2:0", "2:1", "2:2"]);
  });

  it("keeps stacking deliberate copies without ever re-using a key", () => {
    const existing = [...applied(1), ...applied(2)];
    const plan = planTemplateApplication({ rows: ROUTINE, existing, mode: "duplicate" });

    expect(plan.create.map((planned) => planned.sourceKey)).toEqual(["3:0", "3:1", "3:2"]);
    const keys = new Set([...existing.map((row) => row.sourceKey), ...plan.create.map((p) => p.sourceKey)]);
    expect(keys.size).toBe(9);
  });

  it("drops rows whose key already exists, so a half-finished apply can be retried", () => {
    // The first two rows were written, then the write failed.
    const partial = applied(1, 2);
    const plan = planTemplateApplication({ rows: ROUTINE, existing: partial, mode: "replace" });

    // Replace deletes them first, so all three are written again.
    expect(plan.create).toHaveLength(3);

    // Duplicate at ordinal 2 is untouched by the partial ordinal-1 rows.
    const retry = planTemplateApplication({ rows: ROUTINE, existing: partial, mode: "duplicate" });
    expect(retry.create.map((planned) => planned.sourceKey)).toEqual(["2:0", "2:1", "2:2"]);
  });

  it("re-applies cleanly once the day has been cleared", () => {
    const first = planTemplateApplication({ rows: ROUTINE, existing: [] });
    expect(first.create).toHaveLength(3);

    // User deleted the items; the day is empty again.
    const second = planTemplateApplication({ rows: ROUTINE, existing: [] });
    expect(second.action).toBe("create");
    expect(second.ordinal).toBe(1);
    expect(second.create).toHaveLength(3);
  });

  it("asks rather than duplicating when pre-upgrade rows carry no key", () => {
    const legacy: ExistingTemplateRow[] = [{ id: "old-1", sourceKey: null }];
    const plan = planTemplateApplication({ rows: ROUTINE, existing: legacy });
    expect(plan.action).toBe("ask");
    expect(plan.existing).toBe(1);
  });
});

// ---------------------------------------------------------------------------

function span(
  id: string,
  startMinute: number | null,
  endMinute: number | null,
  extra: Partial<ConflictCandidate> = {},
): ConflictCandidate {
  return { id, title: id, startMinute, endMinute, allDay: false, ...extra };
}

describe("spansOverlap", () => {
  it("detects a real overlap", () => {
    expect(spansOverlap(span("a", 540, 660), span("b", 600, 720))).toBe(true);
  });

  it("detects full containment", () => {
    expect(spansOverlap(span("a", 540, 720), span("b", 600, 660))).toBe(true);
    expect(spansOverlap(span("a", 600, 660), span("b", 540, 720))).toBe(true);
  });

  it("does not flag back-to-back items that touch at an endpoint", () => {
    expect(spansOverlap(span("a", 540, 600), span("b", 600, 660))).toBe(false);
    expect(spansOverlap(span("a", 600, 660), span("b", 540, 600))).toBe(false);
  });

  it("does not flag items that are simply apart", () => {
    expect(spansOverlap(span("a", 540, 600), span("b", 900, 960))).toBe(false);
  });

  it("never flags all-day items", () => {
    expect(spansOverlap(span("a", null, null, { allDay: true }), span("b", 540, 660))).toBe(false);
    expect(
      spansOverlap(
        span("a", null, null, { allDay: true }),
        span("b", null, null, { allDay: true }),
      ),
    ).toBe(false);
  });

  it("ignores items with no usable duration", () => {
    expect(spansOverlap(span("a", 540, null), span("b", 500, 600))).toBe(false);
    expect(spansOverlap(span("a", null, 600), span("b", 500, 600))).toBe(false);
    // Zero-length: start === end occupies no minutes.
    expect(spansOverlap(span("a", 600, 600), span("b", 540, 660))).toBe(false);
  });

  it("ignores skipped items, which are explicitly not happening", () => {
    expect(spansOverlap(span("a", 540, 660, { status: "skipped" }), span("b", 600, 720))).toBe(false);
    expect(spansOverlap(span("a", 540, 660), span("b", 600, 720, { status: "skipped" }))).toBe(false);
  });

  it("still flags a completed item, because it did occupy the time", () => {
    expect(spansOverlap(span("a", 540, 660, { status: "done" }), span("b", 600, 720))).toBe(true);
  });

  it("never conflicts with itself", () => {
    const item = span("a", 540, 660);
    expect(spansOverlap(item, item)).toBe(false);
  });
});

describe("overlapMinutes / the 1-minute conflict tolerance", () => {
  it("measures the exact half-open intersection", () => {
    expect(overlapMinutes(span("a", 540, 600), span("b", 600, 660))).toBe(0);
    expect(overlapMinutes(span("a", 540, 600), span("b", 599, 660))).toBe(1);
    expect(overlapMinutes(span("a", 540, 600), span("b", 598, 660))).toBe(2);
    expect(overlapMinutes(span("a", 540, 600), span("b", 540, 600))).toBe(60);
    expect(overlapMinutes(span("a", 540, 720), span("b", 600, 660))).toBe(60);
  });

  it("does not warn for adjacent blocks — the end minute is excluded", () => {
    // A ends 10:00, B starts 10:00 → back-to-back, not a double booking.
    expect(isSchedulingConflict(span("a", 540, 600), span("b", 600, 660))).toBe(false);
  });

  it("forgives a 1-minute brush but warns from 2 minutes on", () => {
    // A ends 10:00, B starts 9:59 → an exact overlap exists…
    expect(spansOverlap(span("a", 540, 600), span("b", 599, 660))).toBe(true);
    // …but it is under the tolerance, so no warning.
    expect(isSchedulingConflict(span("a", 540, 600), span("b", 599, 660))).toBe(false);
    // A ends 10:00, B starts 9:58 → a real double booking.
    expect(isSchedulingConflict(span("a", 540, 600), span("b", 598, 660))).toBe(true);
    // A ends 10:00, B starts 9:30 → obviously real.
    expect(isSchedulingConflict(span("a", 540, 600), span("b", 570, 660))).toBe(true);
  });

  it("warns for identical, contained and partially overlapping intervals", () => {
    expect(isSchedulingConflict(span("a", 540, 600), span("b", 540, 600))).toBe(true);
    expect(isSchedulingConflict(span("a", 540, 720), span("b", 600, 660))).toBe(true);
    expect(isSchedulingConflict(span("a", 540, 660), span("b", 600, 720))).toBe(true);
  });

  it("keeps the tolerance centralized in one named constant", () => {
    expect(CONFLICT_TOLERANCE_MINUTES).toBe(1);
  });

  it("a documented consequence: an intersection no longer than the tolerance never warns", () => {
    // A 1-minute block inside a longer one intersects for exactly 1 minute —
    // under the tolerance, so classified as noise, not a double booking.
    expect(isSchedulingConflict(span("a", 540, 541), span("b", 500, 600))).toBe(false);
  });

  it("point items occupy no minutes and never conflict with anything touching them", () => {
    const point = span("p", 540, 540);
    expect(isSchedulingConflict(point, span("before", 480, 540))).toBe(false);
    expect(isSchedulingConflict(point, span("after", 540, 600))).toBe(false);
    expect(isSchedulingConflict(point, span("around", 500, 600))).toBe(false);
    expect(spansOverlap(point, span("around", 500, 600))).toBe(false);
  });

  it("start-only items have no duration to clash with", () => {
    expect(isSchedulingConflict(span("a", 540, null), span("b", 500, 600))).toBe(false);
  });

  it("compares real minutes across an operational day's two calendar dates", () => {
    // Under a 4:00 AM reset one operational day holds its own date's
    // [4:00, 24:00) plus the next date's [0:00, 4:00). Those minute ranges
    // are disjoint, so a late-evening block and an after-midnight block can
    // never falsely conflict — matching their real instants.
    const evening = span("evening", 23 * 60, 23 * 60 + 59);
    const afterMidnight = span("night", 30, 90);
    expect(isSchedulingConflict(evening, afterMidnight)).toBe(false);
    expect(spansOverlap(evening, afterMidnight)).toBe(false);
  });
});

describe("cross-midnight spans in the conflict engine", () => {
  // 11:45 PM → 12:15 AM on Aug 17: a wrapped end (15 < 1425) means the block
  // really ends Aug 18 at 12:15 AM. Dated candidates are compared at their
  // real positions — one shared rule, no separate cross-midnight algorithm.
  const wrapped = span("wrapped", 1425, 15, { date: "2026-08-17" });

  it("a wrapped span is 30 real minutes, not zero and not negative", () => {
    // Same start, contained comparison: a same-date block 11:45 PM → 12:30 AM
    // (also wrapped) shares the first 30 minutes.
    const longer = span("longer", 1425, 30, { date: "2026-08-17" });
    expect(overlapMinutes(wrapped, longer)).toBe(30);
  });

  it("meets the next date's early blocks at its real position", () => {
    // 12:10 AM → 1:00 AM on Aug 18 overlaps the wrapped block's last 5 minutes.
    const nextMorning = span("morning", 10, 60, { date: "2026-08-18" });
    expect(overlapMinutes(wrapped, nextMorning)).toBe(5);
    expect(overlapMinutes(nextMorning, wrapped)).toBe(5);
    expect(isSchedulingConflict(wrapped, nextMorning)).toBe(true);
  });

  it("a block starting exactly where the wrapped one ends is adjacent, never a conflict", () => {
    // 12:15 AM → 1:00 AM on Aug 18: back-to-back with 11:45 PM → 12:15 AM.
    const adjacent = span("adjacent", 15, 60, { date: "2026-08-18" });
    expect(spansOverlap(wrapped, adjacent)).toBe(false);
    expect(isSchedulingConflict(wrapped, adjacent)).toBe(false);
  });

  it("keeps the 1-minute tolerance across midnight", () => {
    // B starts 12:14 AM against an end of 12:15 AM → 1 shared minute → quiet.
    const brushes = span("brushes", 14, 60, { date: "2026-08-18" });
    expect(spansOverlap(wrapped, brushes)).toBe(true);
    expect(isSchedulingConflict(wrapped, brushes)).toBe(false);
    // B starts 12:13 AM → 2 shared minutes → a real double booking.
    const collides = span("collides", 13, 60, { date: "2026-08-18" });
    expect(isSchedulingConflict(wrapped, collides)).toBe(true);
  });

  it("does not let a wrapped span reach same-clock blocks two days away", () => {
    const farMorning = span("far", 10, 60, { date: "2026-08-19" });
    expect(overlapMinutes(wrapped, farMorning)).toBe(0);
  });

  it("a block spanning the daily reset meets the next operational day's items", () => {
    // 11:45 PM Aug 17 → 5:00 AM Aug 18 crosses the 4:00 AM reset; a 4:30 AM
    // block on Aug 18 (the NEXT operational day) really is double-booked.
    const acrossReset = span("across", 1425, 300, { date: "2026-08-17" });
    const nextOpDay = span("next", 270, 330, { date: "2026-08-18" });
    expect(overlapMinutes(acrossReset, nextOpDay)).toBe(30);
    expect(isSchedulingConflict(acrossReset, nextOpDay)).toBe(true);
  });

  it("dateless candidates keep the long-standing same-date semantics", () => {
    // Without dates a wrapped end still resolves — 11:45 PM → 12:15 AM against
    // the same date's 11:50 PM → 11:55 PM overlaps for those 5 minutes.
    expect(overlapMinutes(span("a", 1425, 15), span("b", 1430, 1435))).toBe(5);
  });
});

describe("findConflicts / conflictsByItem", () => {
  it("reports each overlapping pair once", () => {
    const items = [span("a", 540, 660), span("b", 600, 720), span("c", 900, 960)];
    const pairs = findConflicts(items);

    expect(pairs).toHaveLength(1);
    expect([pairs[0].a.id, pairs[0].b.id].sort()).toEqual(["a", "b"]);
  });

  it("maps both sides of a conflict to the other's title", () => {
    const items = [
      { ...span("a", 540, 660), title: "Deep work" },
      { ...span("b", 600, 720), title: "Standup" },
      { ...span("c", 900, 960), title: "Gym" },
    ];
    const map = conflictsByItem(items);

    expect(map.get("a")).toEqual(["Standup"]);
    expect(map.get("b")).toEqual(["Deep work"]);
    // Non-overlapping items are absent, not mapped to an empty array.
    expect(map.has("c")).toBe(false);
  });

  it("handles one item clashing with several", () => {
    const items = [
      { ...span("long", 540, 900), title: "All morning" },
      { ...span("a", 560, 580), title: "Call" },
      { ...span("b", 600, 640), title: "Review" },
    ];
    const map = conflictsByItem(items);

    expect(map.get("long")).toHaveLength(2);
    expect(map.get("long")?.sort()).toEqual(["Call", "Review"]);
    expect(map.get("a")).toEqual(["All morning"]);
    expect(map.get("b")).toEqual(["All morning"]);
  });

  it("finds nothing in a day of back-to-back blocks", () => {
    const items = [span("a", 540, 600), span("b", 600, 660), span("c", 660, 720)];
    expect(findConflicts(items)).toEqual([]);
    expect(conflictsByItem(items).size).toBe(0);
  });

  it("finds nothing in the canonical adjacent morning", () => {
    // Wake Up → Leg Mobility → Get Ready → Breakfast, each starting the
    // minute the previous one ends. Zero pairs, zero badges.
    const items = [
      { ...span("wake", 8 * 60, 9 * 60), title: "Wake Up" },
      { ...span("legs", 9 * 60, 10 * 60), title: "Leg Mobility" },
      { ...span("ready", 10 * 60, 10 * 60 + 45), title: "Get Ready" },
      { ...span("food", 10 * 60 + 45, 11 * 60 + 30), title: "Breakfast" },
    ];
    expect(findConflicts(items)).toHaveLength(0);
    expect(conflictsByItem(items).size).toBe(0);
  });

  it("counts every conflicting pair exactly once", () => {
    // Two independent double bookings plus a triple stack: a+b, c+d, c+e, d+e.
    const items = [
      span("a", 540, 600),
      span("b", 570, 630),
      span("c", 900, 1020),
      span("d", 900, 1020),
      span("e", 930, 960),
    ];
    const pairs = findConflicts(items).map((pair) => [pair.a.id, pair.b.id].sort().join("+"));
    expect(pairs.sort()).toEqual(["a+b", "c+d", "c+e", "d+e"]);
  });

  it("uses the warning tolerance, so a 1-minute brush is not a pair", () => {
    const items = [span("a", 540, 600), span("b", 599, 660)];
    expect(findConflicts(items)).toHaveLength(0);
  });

  it("finds nothing in an empty or single-item day", () => {
    expect(findConflicts([])).toEqual([]);
    expect(findConflicts([span("a", 540, 600)])).toEqual([]);
  });
});

describe("summarizeConflicts", () => {
  it("is null when there is nothing to say", () => {
    expect(summarizeConflicts([])).toBeNull();
  });

  it("names a single clash verbatim", () => {
    expect(summarizeConflicts(["Standup"])).toBe("Standup");
  });

  it("compresses several into the first plus a count", () => {
    expect(summarizeConflicts(["Standup", "Review", "Gym"])).toBe("Standup and 2 more");
  });
});

describe("planMove", () => {
  /** A 09:00–11:00 block being moved. */
  const moving = (extra: Partial<MoveSource> = {}): MoveSource => ({
    id: "moving",
    date: "2026-07-20",
    startMinute: 540,
    endMinute: 660,
    allDay: false,
    status: "planned",
    ...extra,
  });

  it("flags a date-only move whose time-of-day lands on an occupied slot", () => {
    const plan = planMove({
      item: moving(),
      date: "2026-07-21",
      targetItems: [{ ...span("b", 600, 720), title: "Standup" }],
    });

    expect(plan.conflicts).toEqual(["Standup"]);
    // Time-of-day travels with the item.
    expect(plan.startMinute).toBe(540);
    expect(plan.endMinute).toBe(660);
    expect(plan.allDay).toBe(false);
  });

  it("keeps the duration when re-timing, across midnight when it no longer fits", () => {
    const retimed = planMove({ item: moving(), date: "2026-07-20", startMinute: 900, targetItems: [] });
    expect(retimed.startMinute).toBe(900);
    expect(retimed.endMinute).toBe(1020);

    // 11:00 PM + the item's 2 hours = 1:00 AM next day, stored as a wrapped
    // end (end < start means "ends next day") — never clamped to 11:59 PM.
    const late = planMove({ item: moving(), date: "2026-07-20", startMinute: 1380, targetItems: [] });
    expect(late.endMinute).toBe(60);
  });

  it("keeps a wrapped item's duration when re-timing it back into the day", () => {
    // 11:45 PM → 12:15 AM (30 minutes) re-timed to 9:00 AM is 9:00 → 9:30.
    const item = moving({ startMinute: 1425, endMinute: 15 });
    const plan = planMove({ item, date: "2026-07-20", startMinute: 540, targetItems: [] });
    expect(plan.startMinute).toBe(540);
    expect(plan.endMinute).toBe(570);
  });

  it("clears the time on an explicit null start, which cannot conflict", () => {
    const plan = planMove({
      item: moving(),
      date: "2026-07-21",
      startMinute: null,
      targetItems: [span("busy", 0, 1439)],
    });

    expect(plan).toEqual({ startMinute: null, endMinute: null, allDay: true, conflicts: [] });
  });

  it("moves an untimed item between days without conflicting", () => {
    const plan = planMove({
      item: moving({ startMinute: null, endMinute: null }),
      date: "2026-07-21",
      targetItems: [span("busy", 0, 1439)],
    });

    expect(plan.conflicts).toEqual([]);
    expect(plan.startMinute).toBeNull();
    // Mirrors the write: no start after a move means all-day.
    expect(plan.allDay).toBe(true);
  });

  it("reports nothing when the move leaves the item exactly where it is", () => {
    // The day already clashes; a no-op call is not creating that overlap, so
    // the badges keep the job and the confirm stays quiet.
    const plan = planMove({
      item: moving(),
      date: "2026-07-20",
      targetItems: [
        { ...span("moving", 540, 660), title: "Moving" },
        { ...span("b", 600, 720), title: "Standup" },
      ],
    });

    expect(plan.conflicts).toEqual([]);
  });

  it("never clashes with itself when re-timed within the same day", () => {
    const plan = planMove({
      item: moving(),
      date: "2026-07-20",
      startMinute: 600,
      targetItems: [
        { ...span("moving", 540, 660), title: "Moving" },
        { ...span("c", 900, 960), title: "Gym" },
      ],
    });

    expect(plan.conflicts).toEqual([]);
  });

  it("uses the warning tolerance: landing 1 minute into a block is not a conflict", () => {
    // The moved block runs 09:59–11:59 next to a 09:00–10:00 block — a
    // 1-minute brush, forgiven by the same rule every warning surface uses.
    const plan = planMove({
      item: moving(),
      date: "2026-07-21",
      startMinute: 599,
      targetItems: [{ ...span("early", 540, 600), title: "Early" }],
    });
    expect(plan.conflicts).toEqual([]);

    const real = planMove({
      item: moving(),
      date: "2026-07-21",
      startMinute: 598,
      targetItems: [{ ...span("early", 540, 600), title: "Early" }],
    });
    expect(real.conflicts).toEqual(["Early"]);
  });

  it("does not flag touching endpoints, zero-length or all-day items on the target day", () => {
    const plan = planMove({
      item: moving(),
      date: "2026-07-21",
      targetItems: [
        span("before", 480, 540),
        span("after", 660, 720),
        span("instant", 600, 600),
        span("allday", null, null, { allDay: true }),
      ],
    });

    expect(plan.conflicts).toEqual([]);
  });

  it("ignores skipped items on either side of the move", () => {
    expect(
      planMove({
        item: moving({ status: "skipped" }),
        date: "2026-07-21",
        targetItems: [span("b", 600, 720)],
      }).conflicts,
    ).toEqual([]);

    expect(
      planMove({
        item: moving(),
        date: "2026-07-21",
        targetItems: [span("b", 600, 720, { status: "skipped" })],
      }).conflicts,
    ).toEqual([]);
  });

  it("still flags a completed target, because it did occupy the time", () => {
    const plan = planMove({
      item: moving(),
      date: "2026-07-21",
      targetItems: [{ ...span("b", 600, 720, { status: "done" }), title: "Standup" }],
    });

    expect(plan.conflicts).toEqual(["Standup"]);
  });

  it("lists clashes earliest first regardless of input order", () => {
    const plan = planMove({
      item: moving(),
      date: "2026-07-21",
      targetItems: [
        { ...span("late", 620, 640), title: "Later" },
        { ...span("early", 560, 580), title: "Earlier" },
      ],
    });

    expect(plan.conflicts).toEqual(["Earlier", "Later"]);
  });
});

describe("planDayCopy", () => {
  let copySeq = 0;
  function sourceRow(
    overrides: Partial<import("@/lib/logic/planner").CopySourceRow> = {},
  ): import("@/lib/logic/planner").CopySourceRow {
    copySeq += 1;
    return {
      id: `src-${copySeq}`,
      title: `Block ${copySeq}`,
      notes: null,
      startMinute: 9 * 60,
      endMinute: 10 * 60,
      allDay: false,
      category: "work",
      priority: "medium",
      sortOrder: copySeq,
      seriesId: null,
      recurrenceRule: null,
      habitId: null,
      taskId: null,
      tagIds: [],
      ...overrides,
    };
  }

  it("copies one-off blocks and skips everything recurring, counted", () => {
    const plan = planDayCopy({
      source: [
        sourceRow({ title: "Plain" }),
        sourceRow({ title: "Series parent", recurrenceRule: '{"freq":"daily"}' }),
        sourceRow({ title: "Occurrence", seriesId: "parent" }),
      ],
      targetItems: [],
      targetDate: "2026-03-10",
    });
    expect(plan.copies.map((copy) => copy.title)).toEqual(["Plain"]);
    expect(plan.skippedRecurring).toBe(2);
    expect(plan.conflicts).toEqual([]);
  });

  it("meaning links travel; record links and identity do not", () => {
    const plan = planDayCopy({
      source: [sourceRow({ taskId: "task1", habitId: "habit1", tagIds: ["tag1"] })],
      targetItems: [],
      targetDate: "2026-03-10",
    });
    expect(plan.copies[0]).toMatchObject({
      taskId: "task1",
      habitId: "habit1",
      tagIds: ["tag1"],
    });
    // The planned copy simply has no workout/meal/template fields to carry.
    expect("workoutId" in plan.copies[0]).toBe(false);
  });

  it("reports overlaps on the target day with the planner's usual tolerance", () => {
    const plan = planDayCopy({
      source: [sourceRow({ startMinute: 9 * 60, endMinute: 10 * 60 })],
      targetItems: [
        {
          id: "t1",
          title: "Standup",
          date: "2026-03-10",
          startMinute: 9 * 60 + 30,
          endMinute: 10 * 60 + 30,
          allDay: false,
        },
        {
          id: "t2",
          title: "Back-to-back",
          date: "2026-03-10",
          startMinute: 10 * 60,
          endMinute: 11 * 60,
          allDay: false,
        },
      ],
      targetDate: "2026-03-10",
    });
    expect(plan.conflicts).toEqual(["Standup"]); // adjacency never warns
  });

  it("an all-day copy never conflicts, and a skipped target does not either", () => {
    const plan = planDayCopy({
      source: [sourceRow({ allDay: true, startMinute: null, endMinute: null })],
      targetItems: [
        {
          id: "t1",
          title: "Busy",
          date: "2026-03-10",
          startMinute: 0,
          endMinute: 1440,
          allDay: false,
        },
      ],
      targetDate: "2026-03-10",
    });
    expect(plan.conflicts).toEqual([]);
  });

  it("a before-reset copy compares on the next calendar date", () => {
    // A 1:00 AM block belongs to the target OPERATIONAL day but stores on the
    // next calendar date — it must clash with that date's small hours, not
    // the target date's.
    const plan = planDayCopy({
      source: [sourceRow({ startMinute: 60, endMinute: 120 })],
      targetItems: [
        {
          id: "t1",
          title: "Next-date early",
          date: "2026-03-11",
          startMinute: 60,
          endMinute: 120,
          allDay: false,
        },
      ],
      targetDate: "2026-03-10",
      resetMinute: 240,
    });
    expect(plan.conflicts).toEqual(["Next-date early"]);
  });
});
