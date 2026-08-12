import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { shiftDay, type DayKey } from "@/lib/date";
import { operationalDayOfRecord } from "@/lib/logic/operational-day";
import { parseRule } from "@/lib/logic/recurrence";
import { todayIn } from "@/lib/logic/schedule";
import { crossesMidnight, spanDurationMinutes } from "@/lib/logic/schedule-span";
import { confirmAssistantProposal } from "@/server/actions/assistant";
import {
  createScheduleItem,
  deleteScheduleItem,
  moveScheduleItem,
  previewScheduleItemConflicts,
  rolloverUnfinished,
  updateScheduleItem,
} from "@/server/actions/planner";
import { buildProposalPreview } from "@/server/ai/proposals";
import { runTool } from "@/server/ai/tools";
import { getDaySchedule } from "@/server/queries";
import { scheduleSettingsFor } from "@/server/schedule";

import { actAs, resetDatabase, twoUsers, type User } from "./helpers";

/**
 * Cross-midnight planner blocks and same-start ordering against a real
 * database: an end clock earlier than the start is one continuous block
 * ending on the next calendar day, stored without bending any timestamp, and
 * every read model agrees on the one chronological order.
 *
 * Dates are derived from the user's timezone (never hardcoded); each scenario
 * uses its own far-future operational day so the serial suite cannot collide.
 */

let alice: User;
let bob: User;

const base = (): DayKey => shiftDay(todayIn("America/New_York"), 30);

beforeAll(async () => {
  await resetDatabase();
  ({ alice, bob } = await twoUsers());
});

beforeEach(() => {
  actAs(alice);
});

function block(day: DayKey, title: string, startMinute: number, endMinute: number) {
  return createScheduleItem({
    title,
    date: day,
    startMinute,
    endMinute,
    allDay: false,
    category: "personal",
    priority: "medium",
    status: "planned",
    tagIds: [],
  });
}

describe("cross-midnight blocks", () => {
  it("11:45 PM → 12:15 AM is accepted, stored on the start's real date, 30 minutes long", async () => {
    const day = shiftDay(base(), 0);
    const result = await block(day, "Mobility", 1425, 15);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = await prisma.scheduleItem.findUniqueOrThrow({ where: { id: result.data.id } });
    // The stored start date is the picked day; the wrapped end means the real
    // end instant is the FOLLOWING calendar day's 12:15 AM.
    expect(row.date).toBe(day);
    expect(row.startMinute).toBe(1425);
    expect(row.endMinute).toBe(15);
    expect(crossesMidnight(row.startMinute, row.endMinute)).toBe(true);
    expect(spanDurationMinutes(row.startMinute, row.endMinute)).toBe(30);
  });

  it("groups under the start's operational day and reads back there", async () => {
    const day = shiftDay(base(), 2);
    const created = await block(day, "Night cap", 1425, 15);
    expect(created.ok).toBe(true);

    const settings = scheduleSettingsFor(alice);
    const schedule = await getDaySchedule(day);
    const mine = schedule.find((item) => item.title === "Night cap");
    expect(mine).toBeDefined();
    expect(operationalDayOfRecord(mine!, settings.dayResetMinute ?? 240)).toBe(day);

    // Not on the next operational day, despite ending on its calendar date.
    const nextDay = await getDaySchedule(shiftDay(day, 1));
    expect(nextDay.find((item) => item.title === "Night cap")).toBeUndefined();
  });

  it("equal start and end stays a point item, never a 24-hour block", async () => {
    const day = shiftDay(base(), 4);
    const result = await block(day, "Checkpoint", 540, 540);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = await prisma.scheduleItem.findUniqueOrThrow({ where: { id: result.data.id } });
    expect(spanDurationMinutes(row.startMinute, row.endMinute)).toBe(0);
  });

  it("an adjacent block starting at the wrapped end is no conflict; the 1-minute tolerance holds across midnight", async () => {
    const day = shiftDay(base(), 6);
    expect((await block(day, "Wind down", 1425, 15)).ok).toBe(true);

    // 12:15 AM → 1:00 AM on the SAME operational day (stored next date).
    const adjacent = await previewScheduleItemConflicts({
      date: day,
      startMinute: 15,
      endMinute: 60,
      allDay: false,
    });
    expect(adjacent.ok).toBe(true);
    if (adjacent.ok) expect(adjacent.data.conflicts).toEqual([]);

    // 12:14 AM brushes one minute — under the tolerance, still quiet.
    const brushes = await previewScheduleItemConflicts({
      date: day,
      startMinute: 14,
      endMinute: 60,
      allDay: false,
    });
    expect(brushes.ok).toBe(true);
    if (brushes.ok) expect(brushes.data.conflicts).toEqual([]);

    // 12:13 AM shares two minutes — a real double booking.
    const collides = await previewScheduleItemConflicts({
      date: day,
      startMinute: 13,
      endMinute: 60,
      allDay: false,
    });
    expect(collides.ok).toBe(true);
    if (collides.ok) expect(collides.data.conflicts).toEqual(["Wind down"]);
  });

  it("moving a wrapped block keeps its duration; rollover carries it one night forward intact", async () => {
    const day = shiftDay(base(), 8);
    const created = await block(day, "Late stretch", 1425, 15);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Re-time to 9:00 AM: 30 minutes on one date again.
    const retimed = await moveScheduleItem(created.data.id, day, 540);
    expect(retimed.ok).toBe(true);
    let row = await prisma.scheduleItem.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(row.startMinute).toBe(540);
    expect(row.endMinute).toBe(570);

    // Back to 11:45 PM: the wrapped end returns.
    const late = await moveScheduleItem(created.data.id, day, 1425);
    expect(late.ok).toBe(true);
    row = await prisma.scheduleItem.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(row.endMinute).toBe(15);

    // Rollover pushes the whole span one calendar night; the wrapped end rides along.
    const moved = await rolloverUnfinished(day);
    expect(moved.ok).toBe(true);
    row = await prisma.scheduleItem.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(row.date).toBe(shiftDay(day, 1));
    expect(row.startMinute).toBe(1425);
    expect(row.endMinute).toBe(15);
  });
});

describe("same-start ordering through the read model", () => {
  it("Wake Up 9:00, Mobility 9:00–9:30, Cardio 9:00–10:00, Work 9:00–12:00 — in that order, from any insert order", async () => {
    const day = shiftDay(base(), 10);
    // Deliberately created longest-first, the order the bug report showed.
    expect((await block(day, "Work", 540, 720)).ok).toBe(true);
    expect((await block(day, "Cardio", 540, 600)).ok).toBe(true);
    expect((await block(day, "Wake Up", 540, 540)).ok).toBe(true);
    expect((await block(day, "Mobility", 540, 570)).ok).toBe(true);

    const titles = (await getDaySchedule(day)).map((item) => item.title);
    expect(titles).toEqual(["Wake Up", "Mobility", "Cardio", "Work"]);
  });

  it("orders the operational day's after-midnight tail after the evening, wrapped ends included", async () => {
    const day = shiftDay(base(), 12);
    expect((await block(day, "One AM", 60, 90)).ok).toBe(true); // stored next date
    expect((await block(day, "Crosser", 1425, 15)).ok).toBe(true);
    expect((await block(day, "Evening", 1380, 1410)).ok).toBe(true);

    const titles = (await getDaySchedule(day)).map((item) => item.title);
    expect(titles).toEqual(["Evening", "Crosser", "One AM"]);
  });
});

describe("cross-midnight recurring series", () => {
  it("each occurrence starts on its own date with the same wrapped 30-minute span", async () => {
    const day = shiftDay(base(), 14);
    const result = await createScheduleItem({
      title: "Nightly reset",
      date: day,
      startMinute: 1425,
      endMinute: 15,
      allDay: false,
      category: "personal",
      priority: "medium",
      status: "planned",
      recurrenceRule: JSON.stringify({ freq: "daily", interval: 1, until: shiftDay(day, 4) }),
      tagIds: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = await prisma.scheduleItem.findMany({
      where: { userId: alice.id, OR: [{ id: result.data.id }, { seriesId: result.data.id }] },
      orderBy: { date: "asc" },
    });
    // Bounded daily series, until inclusive: 5 occurrences.
    expect(rows).toHaveLength(5);
    rows.forEach((row, index) => {
      expect(row.date).toBe(shiftDay(day, index));
      expect(row.startMinute).toBe(1425);
      expect(row.endMinute).toBe(15);
      expect(spanDurationMinutes(row.startMinute, row.endMinute)).toBe(30);
    });
  });

  it("this-and-future re-times to a one-hour cross-midnight block; history keeps the old span", async () => {
    const day = shiftDay(base(), 21);
    const created = await createScheduleItem({
      title: "Wind down series",
      date: day,
      startMinute: 1425,
      endMinute: 15,
      allDay: false,
      category: "personal",
      priority: "medium",
      status: "planned",
      recurrenceRule: JSON.stringify({ freq: "daily", interval: 1, until: shiftDay(day, 4) }),
      tagIds: [],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const third = await prisma.scheduleItem.findFirstOrThrow({
      where: { seriesId: created.data.id, date: shiftDay(day, 2) },
    });

    // 11:30 PM → 12:30 AM from the third occurrence forward.
    const split = await updateScheduleItem(
      {
        id: third.id,
        title: "Wind down series",
        date: shiftDay(day, 2),
        startMinute: 1410,
        endMinute: 30,
        allDay: false,
        category: "personal",
        priority: "medium",
        status: "planned",
        recurrenceRule: JSON.stringify({ freq: "daily", interval: 1, until: shiftDay(day, 4) }),
        tagIds: [],
      },
      "future",
    );
    expect(split.ok).toBe(true);

    const rows = await prisma.scheduleItem.findMany({
      where: { userId: alice.id, title: "Wind down series" },
      orderBy: { date: "asc" },
    });
    expect(rows).toHaveLength(5);
    for (const row of rows.slice(0, 2)) {
      expect(row.startMinute).toBe(1425);
      expect(row.endMinute).toBe(15);
    }
    for (const row of rows.slice(2)) {
      expect(row.startMinute).toBe(1410);
      expect(row.endMinute).toBe(30);
      expect(spanDurationMinutes(row.startMinute, row.endMinute)).toBe(60);
    }
    // The old series is truncated to the day before the split.
    const oldParent = await prisma.scheduleItem.findUniqueOrThrow({
      where: { id: created.data.id },
    });
    expect(parseRule(oldParent.recurrenceRule)?.until).toBe(shiftDay(day, 1));
  });

  it("deleting one occurrence records its slot; regeneration never brings it back", async () => {
    const day = shiftDay(base(), 28);
    const created = await createScheduleItem({
      title: "Night walk",
      date: day,
      startMinute: 1425,
      endMinute: 15,
      allDay: false,
      category: "personal",
      priority: "medium",
      status: "planned",
      recurrenceRule: JSON.stringify({ freq: "daily", interval: 1, until: shiftDay(day, 3) }),
      tagIds: [],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const second = await prisma.scheduleItem.findFirstOrThrow({
      where: { seriesId: created.data.id, date: shiftDay(day, 1) },
    });
    const deleted = await deleteScheduleItem(second.id, "one");
    expect(deleted.ok).toBe(true);

    const parent = await prisma.scheduleItem.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(parent.skipDates).toContain(shiftDay(day, 1));
    const remaining = await prisma.scheduleItem.findMany({
      where: { userId: alice.id, title: "Night walk" },
    });
    expect(remaining.map((row) => row.date).sort()).toEqual([
      day,
      shiftDay(day, 2),
      shiftDay(day, 3),
    ]);
  });
});

describe("assistant proposals across midnight", () => {
  it("stages 11:45 PM → 12:15 AM as a 30-minute next-day block and executes it", async () => {
    const day = shiftDay(base(), 35);
    const preview = await buildProposalPreview(alice, "create_planner_block", {
      title: "Mobility",
      date: day,
      startMinute: 1425,
      endMinute: 15,
      category: "fitness",
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    // The preview names the resolved meaning before anything is written.
    expect(preview.proposal.summary).toContain("11:45 PM–12:15 AM");
    expect(preview.proposal.summary).toContain("ends next day, 30m");

    await prisma.user.update({ where: { id: alice.id }, data: { assistantMode: "confirm" } });
    const confirmed = await confirmAssistantProposal(preview.proposal.id);
    expect(confirmed.ok).toBe(true);

    const row = await prisma.scheduleItem.findFirstOrThrow({
      where: { userId: alice.id, title: "Mobility", date: day },
    });
    expect(row.startMinute).toBe(1425);
    expect(row.endMinute).toBe(15);
  });

  it("recurring cross-midnight proposals carry the pattern and the next-day time", async () => {
    const day = shiftDay(base(), 42);
    const preview = await buildProposalPreview(alice, "create_planner_block", {
      title: "Nightly mobility",
      date: day,
      startMinute: 1425,
      endMinute: 15,
      category: "fitness",
      recurrence: { repeat: "daily", endDate: shiftDay(day, 6) },
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.proposal.summary).toContain("ends next day, 30m");
    expect(preview.proposal.summary).toContain("repeats");
  });

  it("get_schedule marks wrapped blocks endsNextDay for the model", async () => {
    const day = shiftDay(base(), 49);
    expect((await block(day, "Flagged crosser", 1425, 15)).ok).toBe(true);

    const ctx = {
      user: alice as never,
      settings: scheduleSettingsFor(alice),
      mode: "readonly" as const,
    };
    const outcome = await runTool(ctx, "get_schedule", { from: day, to: day });
    expect(outcome.ok).toBe(true);
    const payload = outcome.result as {
      items?: Array<{ title: string; endsNextDay?: boolean }>;
    };
    const mine = payload.items?.find((item) => item.title === "Flagged crosser");
    expect(mine?.endsNextDay).toBe(true);
  });
});

describe("cross-user isolation still holds for wrapped blocks", () => {
  it("bob neither sees alice's cross-midnight block nor conflicts with it", async () => {
    const day = shiftDay(base(), 56);
    expect((await block(day, "Alice night block", 1425, 15)).ok).toBe(true);

    actAs(bob);
    const schedule = await getDaySchedule(day);
    expect(schedule.find((item) => item.title === "Alice night block")).toBeUndefined();

    const preview = await previewScheduleItemConflicts({
      date: day,
      startMinute: 1430,
      endMinute: 30,
      allDay: false,
    });
    expect(preview.ok).toBe(true);
    if (preview.ok) expect(preview.data.conflicts).toEqual([]);
  });
});
