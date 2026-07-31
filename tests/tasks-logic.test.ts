import { describe, expect, it } from "vitest";

import {
  bucketTasks,
  compareTasks,
  describeRepeat,
  filterByTags,
  nextDueAfterCompletion,
  normalizeTagName,
  normalizeTagNames,
  projectProgress,
  repeatCadence,
  tagUsage,
  TASK_TAG_LIMIT,
  TAG_NAME_MAX,
  tasksDueNow,
  type TaskLike,
} from "@/lib/logic/tasks";

const TODAY = "2026-07-31";

let seq = 0;
function task(partial: Partial<TaskLike> = {}): TaskLike {
  seq += 1;
  return {
    id: `task-${seq}`,
    title: "Task",
    status: "open",
    priority: "medium",
    dueDate: null,
    parentId: null,
    projectId: null,
    repeat: "none",
    repeatEvery: 1,
    repeatAnchor: null,
    sortOrder: 0,
    ...partial,
  };
}

describe("compareTasks", () => {
  it("orders by priority rank, urgent first", () => {
    const low = task({ id: "low", priority: "low" });
    const medium = task({ id: "medium", priority: "medium" });
    const high = task({ id: "high", priority: "high" });
    const urgent = task({ id: "urgent", priority: "urgent" });

    const sorted = [medium, low, urgent, high].sort(compareTasks);
    expect(sorted.map((t) => t.id)).toEqual(["urgent", "high", "medium", "low"]);
  });

  it("breaks a priority tie by the earlier due date, undated last", () => {
    const soon = task({ id: "soon", dueDate: "2026-08-01" });
    const later = task({ id: "later", dueDate: "2026-08-10" });
    const undated = task({ id: "undated", dueDate: null });

    const sorted = [undated, later, soon].sort(compareTasks);
    expect(sorted.map((t) => t.id)).toEqual(["soon", "later", "undated"]);
  });

  it("falls back to manual sort order, then title", () => {
    const second = task({ id: "second", title: "Zed", sortOrder: 2 });
    const first = task({ id: "first", title: "Alpha", sortOrder: 1 });
    expect([second, first].sort(compareTasks).map((t) => t.id)).toEqual(["first", "second"]);

    const bravo = task({ id: "bravo", title: "Bravo", sortOrder: 1 });
    const alpha = task({ id: "alpha", title: "Alpha", sortOrder: 1 });
    expect([bravo, alpha].sort(compareTasks).map((t) => t.id)).toEqual(["alpha", "bravo"]);
  });

  it("weighs priority above even a much earlier due date", () => {
    const urgentLater = task({ id: "urgent", priority: "urgent", dueDate: "2026-12-31" });
    const lowSoon = task({ id: "low", priority: "low", dueDate: "2026-08-01" });
    expect([lowSoon, urgentLater].sort(compareTasks).map((t) => t.id)).toEqual(["urgent", "low"]);
  });
});

describe("bucketTasks", () => {
  it("buckets open top-level tasks by due distance, with the week edge at +7", () => {
    const overdue = task({ id: "overdue", dueDate: "2026-07-30" });
    const dueToday = task({ id: "today", dueDate: TODAY });
    const tomorrow = task({ id: "tomorrow", dueDate: "2026-08-01" });
    const weekEdge = task({ id: "week-edge", dueDate: "2026-08-07" }); // +7 → still upcoming
    const nextWeek = task({ id: "next-week", dueDate: "2026-08-08" }); // +8 → later
    const someday = task({ id: "someday", dueDate: null });

    const buckets = bucketTasks([overdue, dueToday, tomorrow, weekEdge, nextWeek, someday], TODAY);

    expect(buckets.overdue.map((t) => t.id)).toEqual(["overdue"]);
    expect(buckets.today.map((t) => t.id)).toEqual(["today"]);
    expect(buckets.upcoming.map((t) => t.id)).toEqual(["tomorrow", "week-edge"]);
    expect(buckets.later.map((t) => t.id)).toEqual(["next-week"]);
    expect(buckets.someday.map((t) => t.id)).toEqual(["someday"]);
  });

  it("excludes done and dropped tasks and subtasks", () => {
    const parent = task({ id: "parent", dueDate: TODAY });
    const done = task({ id: "done", status: "done", dueDate: TODAY });
    const dropped = task({ id: "dropped", status: "dropped", dueDate: TODAY });
    const subtask = task({ id: "sub", parentId: "parent", dueDate: TODAY });

    const buckets = bucketTasks([parent, done, dropped, subtask], TODAY);
    const everyBucketed = Object.values(buckets).flat();
    expect(everyBucketed.map((t) => t.id)).toEqual(["parent"]);
  });

  it("sorts each bucket by compareTasks", () => {
    const lowFirstAdded = task({ id: "low", priority: "low", dueDate: TODAY });
    const urgentSecond = task({ id: "urgent", priority: "urgent", dueDate: TODAY });
    const buckets = bucketTasks([lowFirstAdded, urgentSecond], TODAY);
    expect(buckets.today.map((t) => t.id)).toEqual(["urgent", "low"]);
  });
});

describe("tasksDueNow", () => {
  it("lists overdue before today, even when today's tasks outrank them", () => {
    const overdueLow = task({ id: "overdue-low", priority: "low", dueDate: "2026-07-28" });
    const todayUrgent = task({ id: "today-urgent", priority: "urgent", dueDate: TODAY });
    const tomorrow = task({ id: "tomorrow", dueDate: "2026-08-01" });

    const now = tasksDueNow([todayUrgent, tomorrow, overdueLow], TODAY);
    expect(now.map((t) => t.id)).toEqual(["overdue-low", "today-urgent"]);
  });

  it("is empty when nothing is due yet", () => {
    expect(tasksDueNow([task({ dueDate: "2026-08-05" }), task()], TODAY)).toEqual([]);
  });
});

describe("repeatCadence", () => {
  it("maps repeat units, carrying `every` through", () => {
    expect(repeatCadence("daily", 1)).toEqual({ unit: "daily", every: 1 });
    expect(repeatCadence("weekly", 2)).toEqual({ unit: "weekly", every: 2 });
    expect(repeatCadence("monthly", 3)).toEqual({ unit: "monthly", every: 3 });
    expect(repeatCadence("yearly", 1)).toEqual({ unit: "yearly", every: 1 });
  });

  it("returns null for none and unknown units", () => {
    expect(repeatCadence("none", 1)).toBeNull();
    expect(repeatCadence("fortnightly", 1)).toBeNull();
  });
});

describe("nextDueAfterCompletion", () => {
  it("returns null for a non-repeating task", () => {
    expect(nextDueAfterCompletion(task({ dueDate: TODAY, repeat: "none" }), TODAY)).toBeNull();
  });

  it("returns null when there is no due date to advance", () => {
    expect(nextDueAfterCompletion(task({ dueDate: null, repeat: "weekly" }), TODAY)).toBeNull();
  });

  it("lands a long-overdue weekly task on ONE occurrence strictly after today", () => {
    // Due 3 weeks ago; the anchor grid is Jul 10, 17, 24, 31, Aug 7...
    const next = nextDueAfterCompletion(
      task({ dueDate: "2026-07-10", repeat: "weekly", repeatEvery: 1 }),
      TODAY,
    );
    // Not a march through the missed weeks, and not today itself (Jul 31 is on
    // the grid) — the single next occurrence in the future.
    expect(next).toBe("2026-08-07");
  });

  it("honours the repeat anchor over the drifted due date for monthly repeats", () => {
    // Anchored on the 31st; the current due date was clamped to Feb 28. The
    // next occurrence must come from the anchor and return to the 31st.
    const next = nextDueAfterCompletion(
      task({
        dueDate: "2026-02-28",
        repeat: "monthly",
        repeatEvery: 1,
        repeatAnchor: "2026-01-31",
      }),
      "2026-02-28",
    );
    expect(next).toBe("2026-03-31");
  });

  it("advances by repeatEvery periods", () => {
    const next = nextDueAfterCompletion(
      task({ dueDate: TODAY, repeat: "weekly", repeatEvery: 2 }),
      TODAY,
    );
    expect(next).toBe("2026-08-14");
  });

  it("advances a future-due task from its due date, not from today", () => {
    const next = nextDueAfterCompletion(
      task({ dueDate: "2026-08-10", repeat: "weekly", repeatEvery: 1 }),
      TODAY,
    );
    expect(next).toBe("2026-08-17");
  });

  it("treats repeatEvery below 1 as 1", () => {
    const next = nextDueAfterCompletion(
      task({ dueDate: TODAY, repeat: "daily", repeatEvery: 0 }),
      TODAY,
    );
    expect(next).toBe("2026-08-01");
  });
});

describe("describeRepeat", () => {
  it("uses exact wordings", () => {
    expect(describeRepeat("none", 1)).toBe("Does not repeat");
    expect(describeRepeat("daily", 1)).toBe("Daily");
    expect(describeRepeat("weekly", 1)).toBe("Weekly");
    expect(describeRepeat("weekly", 2)).toBe("Every 2 weeks");
    expect(describeRepeat("monthly", 3)).toBe("Every 3 months");
    expect(describeRepeat("yearly", 2)).toBe("Every 2 years");
  });

  it("treats unknown units as not repeating", () => {
    expect(describeRepeat("fortnightly", 2)).toBe("Does not repeat");
  });

  it("treats every <= 1 as the plain unit label", () => {
    expect(describeRepeat("weekly", 0)).toBe("Weekly");
  });
});

describe("projectProgress", () => {
  it("counts done against countable tasks, excluding dropped ones", () => {
    const progress = projectProgress([
      { status: "done" },
      { status: "done" },
      { status: "open" },
      { status: "dropped" },
    ]);
    expect(progress).toEqual({ total: 3, done: 2, open: 1, percent: 67 });
  });

  it("has no percent when there are no countable tasks", () => {
    expect(projectProgress([])).toEqual({ total: 0, done: 0, open: 0, percent: null });
    expect(projectProgress([{ status: "dropped" }])).toEqual({
      total: 0,
      done: 0,
      open: 0,
      percent: null,
    });
  });

  it("reaches 100 only when every countable task is done", () => {
    expect(projectProgress([{ status: "done" }, { status: "done" }]).percent).toBe(100);
    expect(projectProgress([{ status: "done" }, { status: "open" }]).percent).toBe(50);
  });
});

describe("tag names", () => {
  it("normalises to one spelling: trimmed, lower-case, single-spaced", () => {
    expect(normalizeTagName("  Deep   Work ")).toBe("deep work");
    expect(normalizeTagName("ADMIN")).toBe("admin");
    expect(normalizeTagName("\n\ttidy\t")).toBe("tidy");
  });

  it("normalises to empty for anything with no content", () => {
    expect(normalizeTagName("")).toBe("");
    expect(normalizeTagName("   ")).toBe("");
  });

  it("truncates rather than rejecting an over-long name", () => {
    expect(normalizeTagName("x".repeat(TAG_NAME_MAX + 20))).toHaveLength(TAG_NAME_MAX);
  });

  it("drops blanks and duplicates, keeping first-seen order", () => {
    expect(normalizeTagNames(["Admin", "", "  ", "admin", "Home"])).toEqual(["admin", "home"]);
  });

  it("caps the list so tags stay labels, not a hierarchy", () => {
    const many = Array.from({ length: TASK_TAG_LIMIT + 5 }, (_, index) => `tag${index}`);
    expect(normalizeTagNames(many)).toHaveLength(TASK_TAG_LIMIT);
  });
});

describe("filterByTags", () => {
  const items = [
    { id: "a", tags: ["admin", "money"] },
    { id: "b", tags: ["admin"] },
    { id: "c", tags: [] },
    { id: "d", tags: ["money", "home"] },
  ];

  it("an empty selection filters nothing", () => {
    expect(filterByTags(items, [])).toHaveLength(4);
  });

  it("one tag narrows to the items carrying it", () => {
    expect(filterByTags(items, ["admin"]).map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("two tags narrow further — AND, never OR", () => {
    expect(filterByTags(items, ["admin", "money"]).map((item) => item.id)).toEqual(["a"]);
  });

  it("matches regardless of how the filter was typed", () => {
    expect(filterByTags(items, [" ADMIN "]).map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("an unknown tag matches nothing rather than everything", () => {
    expect(filterByTags(items, ["nope"])).toEqual([]);
  });
});

describe("tagUsage", () => {
  it("counts each tag across the items, most-used first", () => {
    expect(
      tagUsage([
        { tags: ["admin", "money"] },
        { tags: ["admin"] },
        { tags: ["home"] },
      ]),
    ).toEqual([
      { name: "admin", count: 2 },
      { name: "home", count: 1 },
      { name: "money", count: 1 },
    ]);
  });

  it("returns nothing when no item carries a tag", () => {
    expect(tagUsage([{ tags: [] }, { tags: [] }])).toEqual([]);
  });
});
