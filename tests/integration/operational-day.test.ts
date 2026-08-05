import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { shiftDay, type DayKey } from "@/lib/date";
import { operationalDayOfRecord } from "@/lib/logic/operational-day";
import { todayIn } from "@/lib/logic/schedule";
import {
  createScheduleItem,
  moveScheduleItem,
  rolloverUnfinished,
  updateScheduleItem,
} from "@/server/actions/planner";
import { saveSettings } from "@/server/actions/health";
import { getDayScore } from "@/server/day-score";
import { getDaySchedule } from "@/server/queries";
import { scheduleSettingsFor } from "@/server/schedule";
import { runTool } from "@/server/ai/tools";

import { actAs, resetDatabase, twoUsers, type User } from "./helpers";

/**
 * The operational day against a real database: planner writes take an
 * operational day and store the true calendar date; every read groups it back.
 *
 * Dates are derived from the user's timezone (never hardcoded), and all times
 * used here are safely far from the reset boundary in wall-clock terms — the
 * boundary math itself is pinned by unit tests with injected clocks.
 */

let alice: User;
let bob: User;

/** A quiet future operational day, so "today/future" status logic stays out of the way. */
const opDay = (): DayKey => shiftDay(todayIn("America/New_York"), 7);

beforeAll(async () => {
  await resetDatabase();
  ({ alice, bob } = await twoUsers());
});

beforeEach(() => {
  actAs(alice);
});

describe("planner writes on operational days (default 4:00 AM reset)", () => {
  it("a 1:00 AM block stores on the next calendar date and reads back under its operational day", async () => {
    const day = opDay();
    const result = await createScheduleItem({
      title: "Night wind-down",
      date: day,
      startMinute: 60,
      endMinute: 90,
      allDay: false,
      category: "personal",
      priority: "medium",
      status: "planned",
      tagIds: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stored = await prisma.scheduleItem.findUniqueOrThrow({ where: { id: result.data.id } });
    // The actual timestamp is untouched: 1:00 AM on the NEXT calendar date.
    expect(stored.date).toBe(shiftDay(day, 1));
    expect(stored.startMinute).toBe(60);
    expect(stored.endMinute).toBe(90);
    expect(operationalDayOfRecord(stored, 240)).toBe(day);

    // Reads group it under the operational day it was planned into…
    const schedule = await getDaySchedule(day);
    expect(schedule.map((item) => item.id)).toContain(result.data.id);
    // …and NOT under the calendar date it is stored on.
    const nextDay = await getDaySchedule(shiftDay(day, 1));
    expect(nextDay.map((item) => item.id)).not.toContain(result.data.id);
  });

  it("an evening block stays on its own calendar date", async () => {
    const day = opDay();
    const result = await createScheduleItem({
      title: "Evening review",
      date: day,
      startMinute: 22 * 60,
      endMinute: 22 * 60 + 30,
      allDay: false,
      category: "personal",
      priority: "medium",
      status: "planned",
      tagIds: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stored = await prisma.scheduleItem.findUniqueOrThrow({ where: { id: result.data.id } });
    expect(stored.date).toBe(day);
  });

  it("editing a 1:00 AM block round-trips on the same operational day, and re-timing to the evening moves the calendar date back", async () => {
    const day = opDay();
    const created = await createScheduleItem({
      title: "Late block",
      date: day,
      startMinute: 75,
      endMinute: 105,
      allDay: false,
      category: "personal",
      priority: "medium",
      status: "planned",
      tagIds: [],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.data.id;

    // A no-change save from the dialog (which edits the operational day).
    const same = await updateScheduleItem({
      id,
      title: "Late block",
      date: day,
      startMinute: 75,
      endMinute: 105,
      allDay: false,
      category: "personal",
      priority: "medium",
      status: "planned",
      tagIds: [],
    });
    expect(same.ok).toBe(true);
    let stored = await prisma.scheduleItem.findUniqueOrThrow({ where: { id } });
    expect(stored.date).toBe(shiftDay(day, 1));
    expect(stored.startMinute).toBe(75);

    // Re-time to 11:00 PM: same operational day, previous calendar date.
    const retimed = await updateScheduleItem({
      id,
      title: "Late block",
      date: day,
      startMinute: 23 * 60,
      endMinute: 23 * 60 + 30,
      allDay: false,
      category: "personal",
      priority: "medium",
      status: "planned",
      tagIds: [],
    });
    expect(retimed.ok).toBe(true);
    stored = await prisma.scheduleItem.findUniqueOrThrow({ where: { id } });
    expect(stored.date).toBe(day);
    expect(stored.startMinute).toBe(23 * 60);
    expect(operationalDayOfRecord(stored, 240)).toBe(day);
  });

  it("pushing a 1:00 AM block to the next operational day moves it one night, not zero", async () => {
    const day = opDay();
    const created = await createScheduleItem({
      title: "Push me",
      date: day,
      startMinute: 60,
      endMinute: 90,
      allDay: false,
      category: "personal",
      priority: "medium",
      status: "planned",
      tagIds: [],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // What the row's "Push to tomorrow" sends: operational day + 1.
    const moved = await moveScheduleItem(created.data.id, shiftDay(day, 1));
    expect(moved.ok).toBe(true);
    const stored = await prisma.scheduleItem.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(stored.date).toBe(shiftDay(day, 2)); // 1:00 AM of the following night
    expect(stored.startMinute).toBe(60);
    expect(operationalDayOfRecord(stored, 240)).toBe(shiftDay(day, 1));
  });

  it("rollover carries the after-midnight tail forward one night with its time intact", async () => {
    const day = shiftDay(opDay(), 10);
    const late = await createScheduleItem({
      title: "Tail item",
      date: day,
      startMinute: 120,
      endMinute: 150,
      allDay: false,
      category: "personal",
      priority: "medium",
      status: "planned",
      tagIds: [],
    });
    const evening = await createScheduleItem({
      title: "Evening item",
      date: day,
      startMinute: 20 * 60,
      endMinute: 21 * 60,
      allDay: false,
      category: "personal",
      priority: "medium",
      status: "planned",
      tagIds: [],
    });
    expect(late.ok && evening.ok).toBe(true);
    if (!late.ok || !evening.ok) return;

    const rolled = await rolloverUnfinished(day);
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;
    expect(rolled.data.moved).toBe(2);

    const storedLate = await prisma.scheduleItem.findUniqueOrThrow({ where: { id: late.data.id } });
    const storedEvening = await prisma.scheduleItem.findUniqueOrThrow({
      where: { id: evening.data.id },
    });
    expect(storedEvening.date).toBe(shiftDay(day, 1));
    expect(storedLate.date).toBe(shiftDay(day, 2)); // still 2:00 AM, next night
    expect(storedLate.startMinute).toBe(120);
    expect(operationalDayOfRecord(storedLate, 240)).toBe(shiftDay(day, 1));
  });

  it("the day score counts a 1:00 AM block with the operational day it belongs to", async () => {
    const day = shiftDay(opDay(), 20);
    const created = await createScheduleItem({
      title: "Scored late block",
      date: day,
      startMinute: 60,
      endMinute: 120,
      allDay: false,
      category: "personal",
      priority: "high",
      status: "planned",
      tagIds: [],
    });
    expect(created.ok).toBe(true);

    const settings = scheduleSettingsFor(alice);
    const labelsOf = (score: Awaited<ReturnType<typeof getDayScore>>) => [
      ...score.categories.flatMap((category) => category.opportunities.map((o) => o.label)),
      ...score.exclusions.map((exclusion) => exclusion.label),
    ];
    const score = await getDayScore(alice.id, day, settings);
    expect(labelsOf(score)).toContain("Scored late block");

    const nextDayScore = await getDayScore(alice.id, shiftDay(day, 1), settings);
    expect(labelsOf(nextDayScore)).not.toContain("Scored late block");
  });

  it("the assistant's get_schedule reports the operational day alongside the real date", async () => {
    const day = shiftDay(opDay(), 30);
    const created = await createScheduleItem({
      title: "Assistant-visible night block",
      date: day,
      startMinute: 90,
      endMinute: 120,
      allDay: false,
      category: "personal",
      priority: "medium",
      status: "planned",
      tagIds: [],
    });
    expect(created.ok).toBe(true);

    const ctx = { user: alice, settings: scheduleSettingsFor(alice), mode: "readonly" as const };
    const outcome = await runTool(ctx, "get_schedule", { from: day, to: day });
    expect(outcome.ok).toBe(true);
    const result = outcome.result as {
      items: Array<{ title: string; day: string; date: string; startMinute: number | null }>;
    };
    const found = result.items.find((item) => item.title === "Assistant-visible night block");
    expect(found).toBeDefined();
    expect(found!.day).toBe(day);
    expect(found!.date).toBe(shiftDay(day, 1));
    expect(found!.startMinute).toBe(90);
  });

  it("cross-user isolation: bob never sees alice's operational-day records", async () => {
    const day = opDay();
    actAs(bob);
    const schedule = await getDaySchedule(day);
    expect(schedule).toHaveLength(0);
  });
});

describe("the daily-reset setting", () => {
  it("defaults to 240 and saves a valid change", async () => {
    expect(alice.dayResetMinute).toBe(240);
    const result = await saveSettings({
      name: alice.name,
      timezone: alice.timezone,
      activityLevel: "moderate",
      weekStartsOn: 1,
      unitSystem: "imperial",
      dayStartHour: 6,
      dayEndHour: 22,
      dayResetMinute: 300,
    });
    expect(result.ok).toBe(true);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: alice.id } });
    expect(row.dayResetMinute).toBe(300);

    // Changing the reset regroups: a 4:30 AM record belongs to the previous
    // day under a 5:00 AM reset, and to its own date under 4:00 AM.
    const record = { date: "2026-06-15", startMinute: 270 };
    expect(operationalDayOfRecord(record, 300)).toBe("2026-06-14");
    expect(operationalDayOfRecord(record, 240)).toBe("2026-06-15");

    // Restore the default for the rest of the suite.
    const restore = await saveSettings({
      name: alice.name,
      timezone: alice.timezone,
      activityLevel: "moderate",
      weekStartsOn: 1,
      unitSystem: "imperial",
      dayStartHour: 6,
      dayEndHour: 22,
      dayResetMinute: 240,
    });
    expect(restore.ok).toBe(true);
    alice = (await prisma.user.findUniqueOrThrow({ where: { id: alice.id } })) as User;
  });

  it("rejects a reset past 6:00 AM and non-integers", async () => {
    for (const bad of [361, 12 * 60, -5, 90.5]) {
      const result = await saveSettings({
        name: alice.name,
        timezone: alice.timezone,
        activityLevel: "moderate",
        weekStartsOn: 1,
        unitSystem: "imperial",
        dayStartHour: 6,
        dayEndHour: 22,
        dayResetMinute: bad,
      });
      expect(result.ok).toBe(false);
    }
    const row = await prisma.user.findUniqueOrThrow({ where: { id: alice.id } });
    expect(row.dayResetMinute).toBe(240);
  });
});
