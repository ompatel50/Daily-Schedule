/**
 * Phase-8 quality features against real PostgreSQL: copy day / copy week
 * (one-off blocks only, conflict manners, links that travel), the habit
 * pause window flowing through views and the day score, goal milestones
 * (actions, automatic reach-stamping, the reminder feed) and backup
 * coverage of the new pieces.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { shiftDay, weekRange, type DayKey } from "@/lib/date";
import { exportBackup, importBackup } from "@/server/actions/backup";
import { saveGoalMilestone, deleteGoalMilestone } from "@/server/actions/goals";
import { saveHabit } from "@/server/actions/habits";
import {
  copyPlannerDay,
  copyPlannerWeek,
  createScheduleItem,
} from "@/server/actions/planner";
import { scheduleTaskOnPlanner } from "@/server/actions/tasks";
import { evaluateGoalsForDate } from "@/server/goals";
import { getHabitViews } from "@/server/habits";
import { getDayScore } from "@/server/day-score";
import { getReminderFeedFor } from "@/server/reminders";
import { scheduleSettingsFor } from "@/server/schedule";
import { actAs, resetDatabase, twoUsers, type User } from "./helpers";

let alice: User;
let bob: User;

const today = (): DayKey => scheduleSettingsFor(alice).today;

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  ({ alice, bob } = await twoUsers());
  actAs(alice);
});

const baseItem = (overrides: Record<string, unknown> = {}) => ({
  title: "Focus",
  notes: null,
  startMinute: 9 * 60,
  endMinute: 10 * 60,
  allDay: false,
  category: "work",
  priority: "medium",
  status: "planned",
  tagIds: [],
  ...overrides,
});

describe("copy day", () => {
  it("copies one-off blocks as fresh planned blocks; recurring are skipped and counted", async () => {
    const from = shiftDay(today(), 3);
    const to = shiftDay(today(), 5);
    await createScheduleItem(baseItem({ date: from, title: "One-off" }));
    await createScheduleItem(
      baseItem({
        date: from,
        title: "Daily thing",
        startMinute: 11 * 60,
        endMinute: 12 * 60,
        recurrenceRule: JSON.stringify({ freq: "daily", interval: 1 }),
      }),
    );

    const result = await copyPlannerDay({ from, to });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ status: "copied", created: 1, skippedRecurring: 1 });

    const copied = await prisma.scheduleItem.findMany({
      where: { userId: alice.id, date: to, title: "One-off" },
    });
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatchObject({ status: "planned", seriesId: null, recurrenceRule: null });
    // The daily series already covers the target day by itself — exactly one.
    expect(
      await prisma.scheduleItem.count({
        where: { userId: alice.id, date: to, title: "Daily thing" },
      }),
    ).toBe(1);
  });

  it("task and tag links travel; completion state does not", async () => {
    const from = shiftDay(today(), 3);
    const to = shiftDay(today(), 6);
    const task = await prisma.task.create({ data: { userId: alice.id, title: "Deep work" } });
    const scheduled = await scheduleTaskOnPlanner({
      taskId: task.id,
      date: from,
      startMinute: 9 * 60,
      endMinute: 10 * 60,
    });
    if (!scheduled.ok) throw new Error("schedule failed");
    await prisma.scheduleItem.update({
      where: { id: scheduled.data.scheduleItemId },
      data: { status: "done", completedAt: new Date() },
    });

    const result = await copyPlannerDay({ from, to });
    expect(result.ok && result.data.status).toBe("copied");
    const copy = await prisma.scheduleItem.findFirstOrThrow({
      where: { userId: alice.id, date: to },
    });
    expect(copy.taskId).toBe(task.id);
    expect(copy.status).toBe("planned");
    expect(copy.completedAt).toBeNull();
  });

  it("overlaps warn first and write only on confirm", async () => {
    const from = shiftDay(today(), 3);
    const to = shiftDay(today(), 5);
    await createScheduleItem(baseItem({ date: from, title: "Morning block" }));
    await createScheduleItem(
      baseItem({ date: to, title: "Already there", startMinute: 9 * 60 + 30, endMinute: 11 * 60 }),
    );

    const first = await copyPlannerDay({ from, to });
    expect(first.ok && first.data).toMatchObject({
      status: "conflict",
      conflicts: ["Already there"],
    });
    expect(
      await prisma.scheduleItem.count({ where: { userId: alice.id, date: to } }),
    ).toBe(1);

    const confirmed = await copyPlannerDay({ from, to, confirm: true });
    expect(confirmed.ok && confirmed.data.status).toBe("copied");
    expect(
      await prisma.scheduleItem.count({ where: { userId: alice.id, date: to } }),
    ).toBe(2);
  });

  it("an empty source day says so; copying onto itself is refused", async () => {
    const from = shiftDay(today(), 3);
    const empty = await copyPlannerDay({ from, to: shiftDay(from, 1) });
    expect(empty.ok && empty.data.status).toBe("empty");
    expect((await copyPlannerDay({ from, to: from })).ok).toBe(false);
  });
});

describe("copy week", () => {
  it("copies weekday-for-weekday into the target week", async () => {
    const weekStartsOn = alice.weekStartsOn === 0 ? 0 : 1;
    const thisWeek = weekRange(shiftDay(today(), 14), weekStartsOn);
    const nextWeek = weekRange(shiftDay(thisWeek.start, 7), weekStartsOn);

    await createScheduleItem(baseItem({ date: thisWeek.start, title: "Monday planning" }));
    await createScheduleItem(
      baseItem({ date: shiftDay(thisWeek.start, 2), title: "Midweek review" }),
    );

    const result = await copyPlannerWeek({ from: thisWeek.start, to: nextWeek.start });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ status: "copied", created: 2 });

    expect(
      (await prisma.scheduleItem.findFirstOrThrow({
        where: { userId: alice.id, title: "Monday planning", date: nextWeek.start },
      })).date,
    ).toBe(nextWeek.start);
    expect(
      await prisma.scheduleItem.count({
        where: { userId: alice.id, title: "Midweek review", date: shiftDay(nextWeek.start, 2) },
      }),
    ).toBe(1);
  });

  it("the same week is refused; any day inside the week addresses it", async () => {
    const weekStartsOn = alice.weekStartsOn === 0 ? 0 : 1;
    const week = weekRange(shiftDay(today(), 14), weekStartsOn);
    const sameWeek = await copyPlannerWeek({
      from: week.start,
      to: shiftDay(week.start, 3),
    });
    expect(sameWeek.ok).toBe(false);
  });
});

describe("habit pause", () => {
  async function makePausedHabit(pausedFrom: string, pausedUntil: string | null) {
    const result = await saveHabit({
      habit: {
        name: "Reading",
        startDate: shiftDay(today(), -30),
        pausedFrom,
        pausedUntil,
      },
      schedule: {
        mode: "every_day",
        weekdays: [],
        interval: 1,
        timesPerWeek: null,
        monthDay: null,
        enabled: true,
        daypart: "anytime",
        timeMinute: null,
        reminderEnabled: false,
        reminderMinute: null,
      },
      apply: { mode: "forward" },
    });
    if (!result.ok) throw new Error(`habit: ${result.error}`);
    return result.data.id;
  }

  it("a paused habit is neither due nor missed, and the day score excludes it", async () => {
    await makePausedHabit(shiftDay(today(), -2), shiftDay(today(), 2));
    const settings = scheduleSettingsFor(alice);

    const [view] = await getHabitViews(alice.id, today(), settings);
    expect(view.status).toBe("paused");
    expect(view.dueToday).toBe(false);
    expect(view.statusLabel).toContain("Paused until");

    const score = await getDayScore(alice.id, today(), settings);
    expect(score.exclusions.some((exclusion) => exclusion.reason === "paused")).toBe(true);
    expect(
      score.exclusions.filter((exclusion) => exclusion.reason === "paused")[0].label,
    ).toContain("Reading");
  });

  it("the pause ends by itself: the day after the range is due again", async () => {
    await makePausedHabit(shiftDay(today(), -5), shiftDay(today(), -1));
    const [view] = await getHabitViews(alice.id, today(), scheduleSettingsFor(alice));
    expect(view.status).not.toBe("paused");
    expect(view.dueToday).toBe(true);
  });

  it("an inverted pause range is refused", async () => {
    const result = await saveHabit({
      habit: {
        name: "Bad",
        startDate: today(),
        pausedFrom: shiftDay(today(), 5),
        pausedUntil: today(),
      },
      schedule: {
        mode: "every_day",
        weekdays: [],
        interval: 1,
        timesPerWeek: null,
        monthDay: null,
        enabled: true,
        daypart: "anytime",
        timeMinute: null,
        reminderEnabled: false,
        reminderMinute: null,
      },
      apply: { mode: "forward" },
    });
    expect(result.ok).toBe(false);
  });
});

describe("goal milestones", () => {
  async function makeWorkoutGoal() {
    return prisma.goal.create({
      data: {
        userId: alice.id,
        domain: "workout",
        metric: "workout_session",
        label: "Train",
        target: 1,
        direction: "gte",
        unit: "",
        period: "daily",
        source: "workout_count",
        active: true,
      },
    });
  }

  it("actions are user-scoped; editing the target clears the reached stamp", async () => {
    const goal = await makeWorkoutGoal();
    const saved = await saveGoalMilestone({ goalId: goal.id, targetValue: 1, label: "First" });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    actAs(bob);
    expect(
      (await saveGoalMilestone({ goalId: goal.id, targetValue: 2 })).ok,
    ).toBe(false);
    expect((await deleteGoalMilestone(saved.data.id)).ok).toBe(true); // scoped no-op
    expect(await prisma.goalMilestone.count()).toBe(1);

    actAs(alice);
    await prisma.goalMilestone.update({
      where: { id: saved.data.id },
      data: { reachedAt: new Date() },
    });
    const edited = await saveGoalMilestone({
      id: saved.data.id,
      goalId: goal.id,
      targetValue: 5,
      label: "First",
    });
    expect(edited.ok).toBe(true);
    expect(
      (await prisma.goalMilestone.findUniqueOrThrow({ where: { id: saved.data.id } })).reachedAt,
    ).toBeNull();
  });

  it("reaching a milestone stamps it during evaluation, and it stays stamped", async () => {
    const goal = await makeWorkoutGoal();
    const saved = await saveGoalMilestone({ goalId: goal.id, targetValue: 1, label: "First workout" });
    if (!saved.ok) throw new Error("milestone");
    await prisma.workout.create({
      data: { userId: alice.id, name: "Strength", date: today(), type: "strength", durationMin: 30 },
    });

    const settings = scheduleSettingsFor(alice);
    const [evaluation] = await evaluateGoalsForDate(alice.id, today(), settings);
    expect(evaluation.milestones).toMatchObject({ total: 1, reached: 1, next: null });

    // The stamp is written asynchronously (best-effort) — wait for it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const row = await prisma.goalMilestone.findUniqueOrThrow({ where: { id: saved.data.id } });
    expect(row.reachedAt).not.toBeNull();
  });

  it("an unreached milestone with a near target date reminds through the feed", async () => {
    const goal = await makeWorkoutGoal();
    await saveGoalMilestone({
      goalId: goal.id,
      targetValue: 10,
      label: "Ten sessions",
      targetDate: shiftDay(today(), 3),
      reminderEnabled: true,
    });

    const feed = await getReminderFeedFor(alice);
    const occurrence = feed.find((entry) => entry.kind === "milestone");
    expect(occurrence).toBeDefined();
    expect(occurrence?.title).toContain("Ten sessions");

    // Bob's feed carries nothing of alice's milestones.
    const bobFeed = await getReminderFeedFor(bob);
    expect(bobFeed.some((entry) => entry.kind === "milestone")).toBe(false);
  });

  it("milestones and the habit pause round-trip through a backup", async () => {
    const goal = await makeWorkoutGoal();
    await saveGoalMilestone({ goalId: goal.id, targetValue: 3, label: "Trio" });
    await prisma.habit.create({
      data: {
        userId: alice.id,
        name: "Paused habit",
        startDate: today(),
        pausedFrom: today(),
        pausedUntil: shiftDay(today(), 7),
      },
    });

    const exported = await exportBackup();
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.data.version).toBe(12);
    expect(exported.data.data.goalMilestones).toHaveLength(1);

    actAs(bob);
    const restored = await importBackup(exported.data, "merge");
    expect(restored.ok).toBe(true);
    const milestone = await prisma.goalMilestone.findFirstOrThrow({
      where: { userId: bob.id },
      include: { goal: true },
    });
    expect(milestone.label).toBe("Trio");
    expect(milestone.goal.userId).toBe(bob.id);
    const habit = await prisma.habit.findFirstOrThrow({
      where: { userId: bob.id, name: "Paused habit" },
    });
    expect(habit.pausedUntil).toBe(shiftDay(today(), 7));
  });
});
