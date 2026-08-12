import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { shiftDay, weekdayOf, type DayKey } from "@/lib/date";
import { operationalDayOfRecord } from "@/lib/logic/operational-day";
import { parseRule, parseSkipDates } from "@/lib/logic/recurrence";
import { todayIn } from "@/lib/logic/schedule";
import {
  createScheduleItem,
  deleteScheduleItem,
  moveScheduleItem,
  previewScheduleItemConflicts,
  updateScheduleItem,
} from "@/server/actions/planner";
import { extendSeriesFor } from "@/server/series";

import { actAs, resetDatabase, twoUsers, type User } from "./helpers";

/**
 * Recurring series against a real database: bounded generation, occurrence
 * overrides, deletion tombstones, series splitting, and the promises that
 * hold them together — history never rewrites itself, regeneration never
 * resurrects what the user removed, and nothing crosses user boundaries.
 *
 * Days are derived from the user's timezone, never hardcoded, and anchored a
 * few days out so today/future status logic stays out of the way.
 */

let alice: User;
let bob: User;

const today = (): DayKey => todayIn("America/New_York");

/** The next Monday at least `after` days out — weekly fixtures stay stable. */
function nextMonday(after = 3): DayKey {
  let day = shiftDay(today(), after);
  while (weekdayOf(day) !== 1) day = shiftDay(day, 1);
  return day;
}

const baseItem = (overrides: Record<string, unknown> = {}) => ({
  title: "Workout",
  notes: null,
  startMinute: 9 * 60,
  endMinute: 10 * 60,
  allDay: false,
  category: "fitness",
  priority: "medium",
  status: "planned",
  tagIds: [],
  ...overrides,
});

/** All rows of a series (parent first, then occurrences by date). */
async function seriesRows(parentId: string) {
  return prisma.scheduleItem.findMany({
    where: { OR: [{ id: parentId }, { seriesId: parentId }] },
    orderBy: [{ date: "asc" }],
  });
}

async function createSeries(input: Record<string, unknown>): Promise<string> {
  const result = await createScheduleItem(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("createScheduleItem failed");
  return result.data.id;
}

beforeAll(async () => {
  await resetDatabase();
  ({ alice, bob } = await twoUsers());
});

beforeEach(() => {
  actAs(alice);
});

describe("bounded generation with an explicit range", () => {
  it("a bounded weekly series: nothing before the start, the inclusive end day included, nothing after", async () => {
    const start = nextMonday();
    const until = shiftDay(start, 18); // a Friday (start is a Monday)
    expect(weekdayOf(until)).toBe(5);

    const id = await createSeries(
      baseItem({
        title: "Semester class",
        date: start,
        recurrenceRule: JSON.stringify({
          freq: "weekly",
          interval: 1,
          byWeekday: [1, 3, 5],
          until,
        }),
      }),
    );

    const rows = await seriesRows(id);
    const days = rows.map((row) => operationalDayOfRecord(row, 240)).sort();

    // Mon/Wed/Fri for exactly three weeks: 9 occurrences, first on the start
    // date, last exactly ON the inclusive end date.
    expect(days).toHaveLength(9);
    expect(days[0]).toBe(start);
    expect(days[days.length - 1]).toBe(until);
    expect(days.every((day) => [1, 3, 5].includes(weekdayOf(day)))).toBe(true);

    // Regeneration is a no-op — same rows, same count.
    expect(await extendSeriesFor(alice.id)).toBe(0);
    expect(await seriesRows(id)).toHaveLength(9);
  });

  it("an open-ended series stays bounded by the horizon and tops up idempotently", async () => {
    const start = shiftDay(today(), 2);
    const id = await createSeries(
      baseItem({
        title: "Morning routine",
        date: start,
        recurrenceRule: JSON.stringify({ freq: "daily", interval: 1 }),
      }),
    );

    const count = await prisma.scheduleItem.count({
      where: { OR: [{ id }, { seriesId: id }] },
    });
    // Bounded: about HORIZON_DAYS rows, never thousands.
    expect(count).toBeGreaterThan(100);
    expect(count).toBeLessThan(140);

    expect(await extendSeriesFor(alice.id)).toBe(0);

    // A later "today" extends the horizon — and only forward.
    const created = await extendSeriesFor(alice.id, shiftDay(today(), 30));
    expect(created).toBeGreaterThan(0);
    expect(await extendSeriesFor(alice.id, shiftDay(today(), 30))).toBe(0);
  });

  it("a series anchored beyond the horizon still materialises its own first stretch", async () => {
    // A semester created months ahead: the horizon runs from the anchor, so
    // the first weeks exist immediately instead of appearing months later.
    const start = shiftDay(today(), 220);
    const until = shiftDay(start, 21);
    const id = await createSeries(
      baseItem({
        title: "Next-term class",
        date: start,
        recurrenceRule: JSON.stringify({ freq: "daily", interval: 1, until }),
      }),
    );
    expect(await seriesRows(id)).toHaveLength(22);
    // The routine top-up has nothing to add and nothing to resurrect.
    expect(await extendSeriesFor(alice.id)).toBe(0);
  });

  it("rejects an end date before the start date", async () => {
    const start = shiftDay(today(), 5);
    const result = await createScheduleItem(
      baseItem({
        date: start,
        recurrenceRule: JSON.stringify({
          freq: "daily",
          interval: 1,
          until: shiftDay(start, -3),
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/end date/i);
  });

  it("rejects malformed recurrence instead of silently dropping it", async () => {
    const result = await createScheduleItem(
      baseItem({ date: shiftDay(today(), 5), recurrenceRule: '{"freq":"yearly"}' }),
    );
    expect(result.ok).toBe(false);
  });
});

describe("edit this occurrence only", () => {
  it("changes exactly one occurrence and survives regeneration", async () => {
    const start = shiftDay(today(), 2);
    const id = await createSeries(
      baseItem({ date: start, recurrenceRule: JSON.stringify({ freq: "daily", interval: 1 }) }),
    );

    const rows = await seriesRows(id);
    const target = rows.find((row) => operationalDayOfRecord(row, 240) === shiftDay(start, 3))!;
    const before = rows.find((row) => operationalDayOfRecord(row, 240) === shiftDay(start, 2))!;
    const after = rows.find((row) => operationalDayOfRecord(row, 240) === shiftDay(start, 4))!;

    const result = await updateScheduleItem(
      baseItem({
        id: target.id,
        date: shiftDay(start, 3),
        startMinute: 10 * 60,
        endMinute: 11 * 60,
        recurrenceRule: null,
      }),
      "one",
    );
    expect(result.ok).toBe(true);

    const edited = await prisma.scheduleItem.findUniqueOrThrow({ where: { id: target.id } });
    expect(edited.startMinute).toBe(10 * 60);
    expect(edited.isException).toBe(true);
    expect(edited.originalDate).toBe(shiftDay(start, 3));

    // Surrounding occurrences are untouched.
    for (const row of [before, after]) {
      const untouched = await prisma.scheduleItem.findUniqueOrThrow({ where: { id: row.id } });
      expect(untouched.startMinute).toBe(9 * 60);
      expect(untouched.isException).toBe(false);
    }

    // Regeneration neither duplicates the slot nor reverts the override.
    expect(await extendSeriesFor(alice.id)).toBe(0);
    const slotRows = await prisma.scheduleItem.findMany({
      where: { seriesId: id, originalDate: shiftDay(start, 3) },
    });
    expect(slotRows).toHaveLength(1);
    expect(slotRows[0].startMinute).toBe(10 * 60);
  });

  it("editing the FIRST occurrence promotes the next one instead of rewriting the template", async () => {
    const start = shiftDay(today(), 2);
    const id = await createSeries(
      baseItem({ date: start, recurrenceRule: JSON.stringify({ freq: "daily", interval: 1 }) }),
    );

    const result = await updateScheduleItem(
      baseItem({
        id,
        title: "One-off variation",
        date: start,
        startMinute: 7 * 60,
        endMinute: 8 * 60,
        recurrenceRule: null,
      }),
      "one",
    );
    expect(result.ok).toBe(true);

    // The old parent is now a detached exception with no rule…
    const detached = await prisma.scheduleItem.findUniqueOrThrow({ where: { id } });
    expect(detached.recurrenceRule).toBeNull();
    expect(detached.isException).toBe(true);
    expect(detached.title).toBe("One-off variation");
    expect(detached.seriesId).not.toBeNull();

    // …and the series lives on under a promoted parent with the old template.
    const newParent = await prisma.scheduleItem.findUniqueOrThrow({
      where: { id: detached.seriesId as string },
    });
    expect(newParent.recurrenceRule).not.toBeNull();
    expect(newParent.title).toBe("Workout");
    expect(newParent.seriesId).toBeNull();

    // Future generation keeps using the original template.
    await extendSeriesFor(alice.id, shiftDay(today(), 10));
    const futureRows = await prisma.scheduleItem.findMany({
      where: { seriesId: newParent.id, isException: false },
    });
    expect(futureRows.every((row) => row.title === "Workout")).toBe(true);
  });
});

describe("edit this and all future occurrences — series splitting", () => {
  async function semesterSeries() {
    const start = nextMonday();
    const until = shiftDay(start, 32); // a Friday five weeks out
    const id = await createSeries(
      baseItem({
        title: "Aero class",
        date: start,
        startMinute: 10 * 60,
        endMinute: 10 * 60 + 50,
        recurrenceRule: JSON.stringify({ freq: "weekly", interval: 1, byWeekday: [1, 3, 5], until }),
      }),
    );
    return { id, start, until };
  }

  it("splits: history unchanged, future re-timed, end date INHERITED", async () => {
    const { id, start, until } = await semesterSeries();
    const rows = await seriesRows(id);
    const splitDay = shiftDay(start, 14); // the third Monday
    const target = rows.find((row) => operationalDayOfRecord(row, 240) === splitDay)!;

    const result = await updateScheduleItem(
      baseItem({
        id: target.id,
        title: "Aero class",
        date: splitDay,
        startMinute: 11 * 60,
        endMinute: 11 * 60 + 50,
        // The dialog pre-fills the stored rule — including the end date —
        // which is exactly how inheritance works.
        recurrenceRule: JSON.stringify({ freq: "weekly", interval: 1, byWeekday: [1, 3, 5], until }),
      }),
      "future",
    );
    expect(result.ok).toBe(true);

    // The old series is truncated to the day before the split…
    const oldParent = await prisma.scheduleItem.findUniqueOrThrow({ where: { id } });
    expect(parseRule(oldParent.recurrenceRule)?.until).toBe(shiftDay(splitDay, -1));

    // …its history keeps the old time…
    const history = await prisma.scheduleItem.findMany({ where: { OR: [{ id }, { seriesId: id }] } });
    expect(history.length).toBe(6); // 2 weeks × Mon/Wed/Fri
    expect(history.every((row) => row.startMinute === 10 * 60)).toBe(true);

    // …and the selected occurrence is now the parent of a new series that
    // inherits the ORIGINAL end date.
    const newParent = await prisma.scheduleItem.findUniqueOrThrow({ where: { id: target.id } });
    expect(newParent.seriesId).toBeNull();
    expect(newParent.isException).toBe(false);
    const newRule = parseRule(newParent.recurrenceRule);
    expect(newRule?.until).toBe(until);

    const future = await seriesRows(target.id);
    const futureDays = future.map((row) => operationalDayOfRecord(row, 240)).sort();
    expect(futureDays[0]).toBe(splitDay);
    expect(futureDays[futureDays.length - 1]).toBe(until);
    expect(future.every((row) => row.startMinute === 11 * 60)).toBe(true);
    // Together the two series still cover the whole semester: 15 slots.
    expect(history.length + future.length).toBe(15);

    // Idempotent: regeneration adds nothing and changes nothing.
    expect(await extendSeriesFor(alice.id)).toBe(0);
    expect(await seriesRows(target.id)).toHaveLength(future.length);
  });

  it("changes the recurrence pattern from the split point only", async () => {
    const { id, start, until } = await semesterSeries();
    const rows = await seriesRows(id);
    const splitDay = shiftDay(start, 7); // the second Monday
    const target = rows.find((row) => operationalDayOfRecord(row, 240) === splitDay)!;

    const result = await updateScheduleItem(
      baseItem({
        id: target.id,
        title: "Aero class",
        date: splitDay,
        startMinute: 10 * 60,
        endMinute: 10 * 60 + 50,
        recurrenceRule: JSON.stringify({ freq: "weekly", interval: 1, byWeekday: [2, 4], until }),
      }),
      "future",
    );
    expect(result.ok).toBe(true);

    // History: the first week's Mon/Wed/Fri.
    const history = await seriesRows(id);
    expect(history.map((row) => weekdayOf(operationalDayOfRecord(row, 240)))).toEqual([1, 3, 5]);

    // The future: the split Monday itself (the edited occurrence) plus
    // Tue/Thu onward, never Mon/Wed/Fri again.
    const future = await seriesRows(target.id);
    const futureDays = future.map((row) => operationalDayOfRecord(row, 240)).sort();
    expect(futureDays[0]).toBe(splitDay);
    expect(
      futureDays.slice(1).every((day) => [2, 4].includes(weekdayOf(day))),
    ).toBe(true);
    expect(futureDays[futureDays.length - 1] <= until).toBe(true);
  });

  it("extends and shortens the end date from the split point", async () => {
    const { id, start, until } = await semesterSeries();
    const rows = await seriesRows(id);
    const splitDay = shiftDay(start, 7);
    const target = rows.find((row) => operationalDayOfRecord(row, 240) === splitDay)!;

    // Extend by a week.
    const extended = shiftDay(until, 7);
    const extend = await updateScheduleItem(
      baseItem({
        id: target.id,
        title: "Aero class",
        date: splitDay,
        startMinute: 10 * 60,
        endMinute: 10 * 60 + 50,
        recurrenceRule: JSON.stringify({
          freq: "weekly",
          interval: 1,
          byWeekday: [1, 3, 5],
          until: extended,
        }),
      }),
      "future",
    );
    expect(extend.ok).toBe(true);

    let future = await seriesRows(target.id);
    let futureDays = future.map((row) => operationalDayOfRecord(row, 240)).sort();
    expect(futureDays[futureDays.length - 1]).toBe(extended);

    // Now shorten well inside the range: later occurrences disappear.
    const shortened = shiftDay(splitDay, 9);
    const shorten = await updateScheduleItem(
      baseItem({
        id: target.id,
        title: "Aero class",
        date: splitDay,
        startMinute: 10 * 60,
        endMinute: 10 * 60 + 50,
        recurrenceRule: JSON.stringify({
          freq: "weekly",
          interval: 1,
          byWeekday: [1, 3, 5],
          until: shortened,
        }),
      }),
      "future",
    );
    expect(shorten.ok).toBe(true);

    future = await seriesRows(target.id);
    futureDays = future.map((row) => operationalDayOfRecord(row, 240)).sort();
    expect(futureDays.every((day) => day <= shortened)).toBe(true);
    expect(await extendSeriesFor(alice.id)).toBe(0);
  });

  it("turns a bounded series open-ended, and back", async () => {
    const { id, start } = await semesterSeries();
    const rows = await seriesRows(id);
    const splitDay = shiftDay(start, 7);
    const target = rows.find((row) => operationalDayOfRecord(row, 240) === splitDay)!;

    // Bounded → open-ended: generation continues to the horizon, not forever.
    const open = await updateScheduleItem(
      baseItem({
        id: target.id,
        title: "Aero class",
        date: splitDay,
        startMinute: 10 * 60,
        endMinute: 10 * 60 + 50,
        recurrenceRule: JSON.stringify({ freq: "weekly", interval: 1, byWeekday: [1, 3, 5] }),
      }),
      "future",
    );
    expect(open.ok).toBe(true);
    const futureCount = await prisma.scheduleItem.count({
      where: { OR: [{ id: target.id }, { seriesId: target.id }] },
    });
    expect(futureCount).toBeGreaterThan(20); // past the old five-week bound
    expect(futureCount).toBeLessThan(80); // but bounded by the horizon

    // Open-ended → bounded again.
    const bounded = await updateScheduleItem(
      baseItem({
        id: target.id,
        title: "Aero class",
        date: splitDay,
        startMinute: 10 * 60,
        endMinute: 10 * 60 + 50,
        recurrenceRule: JSON.stringify({
          freq: "weekly",
          interval: 1,
          byWeekday: [1, 3, 5],
          until: shiftDay(splitDay, 7),
        }),
      }),
      "future",
    );
    expect(bounded.ok).toBe(true);
    const days = (await seriesRows(target.id)).map((row) => operationalDayOfRecord(row, 240));
    expect(days.every((day) => day <= shiftDay(splitDay, 7))).toBe(true);
  });

  it("removes recurrence from this point forward", async () => {
    const { id, start } = await semesterSeries();
    const rows = await seriesRows(id);
    const splitDay = shiftDay(start, 14);
    const target = rows.find((row) => operationalDayOfRecord(row, 240) === splitDay)!;

    const result = await updateScheduleItem(
      baseItem({
        id: target.id,
        title: "Aero class",
        date: splitDay,
        startMinute: 10 * 60,
        endMinute: 10 * 60 + 50,
        recurrenceRule: null,
      }),
      "future",
    );
    expect(result.ok).toBe(true);

    // History before the split survives; the selected day becomes a plain
    // one-off; nothing exists after it.
    const historyCount = await prisma.scheduleItem.count({
      where: { OR: [{ id }, { seriesId: id }] },
    });
    expect(historyCount).toBe(6);
    const standalone = await prisma.scheduleItem.findUniqueOrThrow({ where: { id: target.id } });
    expect(standalone.recurrenceRule).toBeNull();
    expect(standalone.seriesId).toBeNull();
    expect(
      await prisma.scheduleItem.count({ where: { seriesId: target.id } }),
    ).toBe(0);
    expect(await extendSeriesFor(alice.id)).toBe(0);
  });

  it("preserves completed future occurrences as exceptions instead of destroying them", async () => {
    const { id, start } = await semesterSeries();
    const rows = await seriesRows(id);
    const splitDay = shiftDay(start, 7);
    const target = rows.find((row) => operationalDayOfRecord(row, 240) === splitDay)!;
    const preDone = rows.find((row) => operationalDayOfRecord(row, 240) === shiftDay(start, 9))!;
    await prisma.scheduleItem.update({ where: { id: preDone.id }, data: { status: "done" } });

    const result = await updateScheduleItem(
      baseItem({
        id: target.id,
        title: "Aero class",
        date: splitDay,
        startMinute: 11 * 60,
        endMinute: 12 * 60,
        recurrenceRule: JSON.stringify({ freq: "weekly", interval: 1, byWeekday: [1, 3, 5] }),
      }),
      "future",
    );
    expect(result.ok).toBe(true);

    // The completed row still exists, repointed to the new series as an
    // exception, and its slot was not double-filled.
    const kept = await prisma.scheduleItem.findUniqueOrThrow({ where: { id: preDone.id } });
    expect(kept.status).toBe("done");
    expect(kept.seriesId).toBe(target.id);
    expect(kept.isException).toBe(true);
    const slotRows = await prisma.scheduleItem.findMany({
      where: {
        OR: [{ id: target.id }, { seriesId: target.id }],
        originalDate: shiftDay(start, 9),
      },
    });
    expect(slotRows).toHaveLength(1);
  });
});

describe("delete scopes", () => {
  it("delete one occurrence: gone, remembered, never regenerated", async () => {
    const start = shiftDay(today(), 2);
    const id = await createSeries(
      baseItem({ date: start, recurrenceRule: JSON.stringify({ freq: "daily", interval: 1 }) }),
    );
    const rows = await seriesRows(id);
    const targetDay = shiftDay(start, 3);
    const target = rows.find((row) => operationalDayOfRecord(row, 240) === targetDay)!;

    const result = await deleteScheduleItem(target.id, "one");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.deleted).toBe(1);

    // The slot is recorded on the parent and stays empty after regeneration.
    const parent = await prisma.scheduleItem.findUniqueOrThrow({ where: { id } });
    expect(parseSkipDates(parent.skipDates)).toContain(targetDay);
    expect(await extendSeriesFor(alice.id)).toBe(0);
    expect(
      await prisma.scheduleItem.count({ where: { seriesId: id, originalDate: targetDay } }),
    ).toBe(0);

    // Neighbours are untouched.
    expect(
      await prisma.scheduleItem.count({
        where: { seriesId: id, originalDate: { in: [shiftDay(start, 2), shiftDay(start, 4)] } },
      }),
    ).toBe(2);

    // Deleting it again fails safely — the row is gone.
    const again = await deleteScheduleItem(target.id, "one");
    expect(again.ok).toBe(false);
  });

  it("deleting the FIRST occurrence hands the series to the next one", async () => {
    const start = shiftDay(today(), 2);
    const id = await createSeries(
      baseItem({
        title: "Promotion series",
        date: start,
        recurrenceRule: JSON.stringify({ freq: "daily", interval: 1 }),
      }),
    );
    const before = await prisma.scheduleItem.count({ where: { OR: [{ id }, { seriesId: id }] } });

    const result = await deleteScheduleItem(id, "one");
    expect(result.ok).toBe(true);

    // Exactly one row went — not the whole series via cascade.
    expect(await prisma.scheduleItem.findUnique({ where: { id } })).toBeNull();
    const newParent = await prisma.scheduleItem.findFirst({
      where: {
        userId: alice.id,
        title: "Promotion series",
        recurrenceRule: { not: null },
        seriesId: null,
      },
    });
    expect(newParent).not.toBeNull();
    const remaining = await prisma.scheduleItem.count({
      where: { OR: [{ id: newParent!.id }, { seriesId: newParent!.id }] },
    });
    expect(remaining).toBe(before - 1);
    expect(await extendSeriesFor(alice.id)).toBe(0);
  });

  it("delete this and future: history kept, tail gone, nothing comes back", async () => {
    const start = shiftDay(today(), 2);
    const id = await createSeries(
      baseItem({ date: start, recurrenceRule: JSON.stringify({ freq: "daily", interval: 1 }) }),
    );
    const rows = await seriesRows(id);
    const cutDay = shiftDay(start, 5);
    const target = rows.find((row) => operationalDayOfRecord(row, 240) === cutDay)!;

    const result = await deleteScheduleItem(target.id, "future");
    expect(result.ok).toBe(true);

    const remaining = await seriesRows(id);
    const days = remaining.map((row) => operationalDayOfRecord(row, 240)).sort();
    expect(days).toHaveLength(5); // start .. start+4
    expect(days[days.length - 1]).toBe(shiftDay(cutDay, -1));

    // The rule is truncated, so regeneration cannot refill the tail.
    const parent = await prisma.scheduleItem.findUniqueOrThrow({ where: { id } });
    expect(parseRule(parent.recurrenceRule)?.until).toBe(shiftDay(cutDay, -1));
    expect(await extendSeriesFor(alice.id)).toBe(0);
    expect(await seriesRows(id)).toHaveLength(5);
  });

  it("delete this and future from the first occurrence removes the whole series", async () => {
    const start = shiftDay(today(), 2);
    const id = await createSeries(
      baseItem({ date: start, recurrenceRule: JSON.stringify({ freq: "daily", interval: 1 }) }),
    );
    const result = await deleteScheduleItem(id, "future");
    expect(result.ok).toBe(true);
    expect(
      await prisma.scheduleItem.count({ where: { OR: [{ id }, { seriesId: id }] } }),
    ).toBe(0);
  });

  it("delete the entire series stays available and complete", async () => {
    const start = shiftDay(today(), 2);
    const id = await createSeries(
      baseItem({ date: start, recurrenceRule: JSON.stringify({ freq: "daily", interval: 1 }) }),
    );
    const rows = await seriesRows(id);
    const mid = rows[Math.floor(rows.length / 2)];
    const result = await deleteScheduleItem(mid.id, "all");
    expect(result.ok).toBe(true);
    expect(
      await prisma.scheduleItem.count({ where: { OR: [{ id }, { seriesId: id }] } }),
    ).toBe(0);
  });
});

describe("moves, the operational day, and regeneration", () => {
  it("a moved occurrence leaves its vacated day empty after regeneration", async () => {
    const start = shiftDay(today(), 2);
    const id = await createSeries(
      baseItem({ date: start, recurrenceRule: JSON.stringify({ freq: "daily", interval: 1 }) }),
    );
    const rows = await seriesRows(id);
    const slotDay = shiftDay(start, 3);
    const target = rows.find((row) => operationalDayOfRecord(row, 240) === slotDay)!;

    const result = await moveScheduleItem(target.id, shiftDay(slotDay, 10), undefined, {
      confirm: true,
    });
    expect(result.ok).toBe(true);

    const moved = await prisma.scheduleItem.findUniqueOrThrow({ where: { id: target.id } });
    expect(moved.originalDate).toBe(slotDay);
    expect(moved.isException).toBe(true);

    expect(await extendSeriesFor(alice.id)).toBe(0);
    const onVacatedDay = await prisma.scheduleItem.count({
      where: { seriesId: id, date: slotDay },
    });
    expect(onVacatedDay).toBe(0);
  });

  it("a before-reset series recurs on OPERATIONAL weekdays and stores real calendar dates", async () => {
    // "Every Monday at 1:00 AM" means Monday nights — stored on Tuesday
    // calendar dates, grouped under operational Mondays, and generated on
    // that same operational axis.
    const monday = nextMonday();
    const id = await createSeries(
      baseItem({
        title: "Night stretch",
        date: monday,
        startMinute: 60,
        endMinute: 90,
        recurrenceRule: JSON.stringify({ freq: "weekly", interval: 1, byWeekday: [1] }),
      }),
    );

    const rows = await seriesRows(id);
    expect(rows.length).toBeGreaterThan(2);
    for (const row of rows) {
      // Real timestamp: 1:00 AM on a Tuesday calendar date, untouched.
      expect(row.startMinute).toBe(60);
      expect(weekdayOf(row.date)).toBe(2);
      // Grouping: the operational day is the Monday the user planned.
      expect(weekdayOf(operationalDayOfRecord(row, 240))).toBe(1);
    }
    expect(await extendSeriesFor(alice.id)).toBe(0);
  });
});

describe("the conflict preview", () => {
  it("stays quiet for adjacent blocks and names a real double booking", async () => {
    // Past the materialisation horizon, so the other suites' recurring
    // series cannot put anything on this day.
    const day = shiftDay(today(), 200);
    await createSeries(baseItem({ title: "Wake Up", date: day, startMinute: 8 * 60, endMinute: 9 * 60 }));

    // Adjacent: starts the minute Wake Up ends.
    const adjacent = await previewScheduleItemConflicts({
      date: day,
      startMinute: 9 * 60,
      endMinute: 10 * 60,
      allDay: false,
    });
    expect(adjacent.ok).toBe(true);
    if (adjacent.ok) expect(adjacent.data.conflicts).toEqual([]);

    // One-minute brush: forgiven.
    const brush = await previewScheduleItemConflicts({
      date: day,
      startMinute: 9 * 60 - 1,
      endMinute: 10 * 60,
      allDay: false,
    });
    expect(brush.ok).toBe(true);
    if (brush.ok) expect(brush.data.conflicts).toEqual([]);

    // A real overlap names the block.
    const real = await previewScheduleItemConflicts({
      date: day,
      startMinute: 8 * 60 + 30,
      endMinute: 9 * 60 + 30,
      allDay: false,
    });
    expect(real.ok).toBe(true);
    if (real.ok) expect(real.data.conflicts).toEqual(["Wake Up"]);
  });
});

describe("ownership isolation", () => {
  it("another user cannot edit, delete, or even see a recurrence", async () => {
    const start = shiftDay(today(), 2);
    const id = await createSeries(
      baseItem({ date: start, recurrenceRule: JSON.stringify({ freq: "daily", interval: 1 }) }),
    );
    const rows = await seriesRows(id);
    const occurrence = rows.find((row) => row.seriesId === id)!;

    actAs(bob);
    const edit = await updateScheduleItem(
      baseItem({ id: occurrence.id, date: start, title: "Hijack", recurrenceRule: null }),
      "future",
    );
    expect(edit.ok).toBe(false);

    const del = await deleteScheduleItem(occurrence.id, "future");
    expect(del.ok).toBe(false);

    actAs(alice);
    const untouched = await prisma.scheduleItem.findUniqueOrThrow({ where: { id: occurrence.id } });
    expect(untouched.title).toBe("Workout");
  });

  it("stale and malformed ids fail safely", async () => {
    const missingEdit = await updateScheduleItem(
      baseItem({ id: "no-such-row", date: today(), recurrenceRule: null }),
      "one",
    );
    expect(missingEdit.ok).toBe(false);

    const missingDelete = await deleteScheduleItem("no-such-row", "future");
    expect(missingDelete.ok).toBe(false);
  });
});
