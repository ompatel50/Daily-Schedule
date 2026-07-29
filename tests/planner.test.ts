import { describe, expect, it } from "vitest";

import {
  conflictsByItem,
  findConflicts,
  nextApplicationOrdinal,
  parseSourceKey,
  planTemplateApplication,
  spansOverlap,
  templateSourceKey,
  type ConflictCandidate,
  type ExistingTemplateRow,
  type TemplateRow,
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

  it("finds nothing in an empty or single-item day", () => {
    expect(findConflicts([])).toEqual([]);
    expect(findConflicts([span("a", 540, 600)])).toEqual([]);
  });
});
