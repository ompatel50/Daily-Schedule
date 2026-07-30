/**
 * Cross-user isolation — the tests that make multi-tenancy real.
 *
 * Every case is the same shape: Bob owns something; Alice, signed in as
 * herself, aims an action at Bob's record id. The action must either report
 * not-found/failure or silently do nothing — and Bob's data must be
 * byte-identical afterwards. A single passing "steal" here would mean the
 * hosted app cannot ship.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { actAs, resetDatabase, twoUsers } from "./helpers";

import { saveHabit } from "@/server/actions/habits";
import { saveWorkout, saveWorkoutTemplate, deleteWorkoutTemplate } from "@/server/actions/workouts";
import {
  createScheduleItem,
  toggleScheduleItem,
  updateScheduleItem,
  deleteScheduleItem,
  saveScheduleTemplate,
} from "@/server/actions/planner";
import { saveFoodItem, deleteFoodItem } from "@/server/actions/nutrition";
import { saveGoalWithSchedule, applyDateOverride, removeDateOverride } from "@/server/actions/goals";
import { deleteReminder } from "@/server/actions/health";
import { searchEverything } from "@/server/queries";

import type { User } from "@prisma/client";

let alice: User;
let bob: User;

const DAY = "2026-07-30";

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  ({ alice, bob } = await twoUsers());
  actAs(alice);
});

describe("unauthenticated requests", () => {
  it("actions redirect to sign-in instead of running", async () => {
    actAs(null);
    await expect(toggleScheduleItem("anything")).rejects.toThrowError(/NEXT_REDIRECT/);
  });

  it("queries redirect to sign-in instead of running", async () => {
    actAs(null);
    await expect(searchEverything("anything")).rejects.toThrowError(/NEXT_REDIRECT/);
  });
});

describe("habits", () => {
  it("editing another user's habit is refused and changes nothing", async () => {
    const habit = await prisma.habit.create({
      data: { userId: bob.id, name: "Bob's habit", startDate: DAY },
    });

    await expect(
      saveHabit({
        habit: { id: habit.id, name: "Stolen", startDate: DAY },
        schedule: { mode: "every_day" },
      }),
    ).rejects.toThrowError();

    const after = await prisma.habit.findUniqueOrThrow({ where: { id: habit.id } });
    expect(after.name).toBe("Bob's habit");
    expect(after.userId).toBe(bob.id);
  });
});

describe("workouts", () => {
  it("editing another user's workout is refused; its sets survive", async () => {
    const workout = await prisma.workout.create({
      data: {
        userId: bob.id,
        date: DAY,
        name: "Bob's workout",
        sets: { create: [{ exercise: "Squat", setNumber: 1, reps: 5, weightKg: 100 }] },
      },
    });

    await expect(
      saveWorkout({
        id: workout.id,
        date: DAY,
        name: "Stolen",
        type: "strength",
        durationMin: 30,
        intensity: "moderate",
        status: "completed",
        sets: [],
      }),
    ).rejects.toThrowError();

    const after = await prisma.workout.findUniqueOrThrow({
      where: { id: workout.id },
      include: { sets: true },
    });
    expect(after.name).toBe("Bob's workout");
    expect(after.userId).toBe(bob.id);
    expect(after.sets).toHaveLength(1);
  });

  it("editing another user's workout template is refused", async () => {
    const template = await prisma.workoutTemplate.create({
      data: { userId: bob.id, name: "Bob's template" },
    });

    await expect(
      saveWorkoutTemplate({ id: template.id, name: "Stolen", type: "strength", exercises: [] }),
    ).rejects.toThrowError();

    const after = await prisma.workoutTemplate.findUniqueOrThrow({ where: { id: template.id } });
    expect(after.name).toBe("Bob's template");
  });

  it("deleting another user's workout template deletes nothing", async () => {
    const template = await prisma.workoutTemplate.create({
      data: { userId: bob.id, name: "Bob's template" },
    });

    const result = await deleteWorkoutTemplate(template.id);
    expect(result.ok).toBe(true); // idempotent no-op, not an oracle

    expect(await prisma.workoutTemplate.findUnique({ where: { id: template.id } })).not.toBeNull();
  });
});

describe("planner", () => {
  it("toggling another user's item reports not-found and changes nothing", async () => {
    const item = await prisma.scheduleItem.create({
      data: { userId: bob.id, title: "Bob's block", date: DAY },
    });

    const result = await toggleScheduleItem(item.id);
    expect(result.ok).toBe(false);

    const after = await prisma.scheduleItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.status).toBe("planned");
  });

  it("editing another user's item reports not-found", async () => {
    const item = await prisma.scheduleItem.create({
      data: { userId: bob.id, title: "Bob's block", date: DAY },
    });

    const result = await updateScheduleItem({
      id: item.id,
      title: "Stolen",
      date: DAY,
      allDay: true,
      category: "personal",
      priority: "medium",
      status: "planned",
      tagIds: [],
    });
    expect(result.ok).toBe(false);

    const after = await prisma.scheduleItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.title).toBe("Bob's block");
  });

  it("deleting another user's item deletes nothing", async () => {
    const item = await prisma.scheduleItem.create({
      data: { userId: bob.id, title: "Bob's block", date: DAY },
    });

    await deleteScheduleItem(item.id).catch(() => undefined);
    expect(await prisma.scheduleItem.findUnique({ where: { id: item.id } })).not.toBeNull();
  });

  it("attaching another user's habit to a new item is refused", async () => {
    const habit = await prisma.habit.create({
      data: { userId: bob.id, name: "Bob's habit", startDate: DAY },
    });

    const result = await createScheduleItem({
      title: "Sneaky",
      date: DAY,
      allDay: true,
      category: "personal",
      priority: "medium",
      status: "planned",
      habitId: habit.id,
      tagIds: [],
    });
    expect(result.ok).toBe(false);
  });

  it("attaching another user's tag to a new item is refused", async () => {
    const tag = await prisma.tag.create({ data: { userId: bob.id, name: "bobs-tag" } });

    const result = await createScheduleItem({
      title: "Sneaky",
      date: DAY,
      allDay: true,
      category: "personal",
      priority: "medium",
      status: "planned",
      tagIds: [tag.id],
    });
    expect(result.ok).toBe(false);
  });

  it("editing another user's routine is refused", async () => {
    const template = await prisma.scheduleTemplate.create({
      data: { userId: bob.id, name: "Bob's routine" },
    });

    await expect(
      saveScheduleTemplate({
        id: template.id,
        name: "Stolen",
        category: "personal",
        items: [{ title: "x", category: "personal", priority: "medium" }],
      }),
    ).rejects.toThrowError();

    const after = await prisma.scheduleTemplate.findUniqueOrThrow({ where: { id: template.id } });
    expect(after.name).toBe("Bob's routine");
  });
});

describe("nutrition", () => {
  it("a bundled (global) food cannot be rewritten through saveFoodItem", async () => {
    const globalFood = await prisma.foodItem.create({
      data: { userId: null, name: "Bundled rice", calories: 130, searchKey: "bundled rice" },
    });

    await expect(
      saveFoodItem({ id: globalFood.id, name: "Poisoned", calories: 1, basis: "per_100g" }),
    ).rejects.toThrowError();

    const after = await prisma.foodItem.findUniqueOrThrow({ where: { id: globalFood.id } });
    expect(after.name).toBe("Bundled rice");
    expect(after.userId).toBeNull();
    expect(after.isCustom).toBe(false);
  });

  it("another user's custom food cannot be edited or deleted", async () => {
    const food = await prisma.foodItem.create({
      data: {
        userId: bob.id,
        name: "Bob's shake",
        calories: 200,
        isCustom: true,
        provider: "custom",
        searchKey: "bob's shake",
      },
    });

    await expect(
      saveFoodItem({ id: food.id, name: "Stolen", calories: 1, basis: "per_100g" }),
    ).rejects.toThrowError();

    const deletion = await deleteFoodItem(food.id);
    expect(deletion.ok).toBe(true); // scoped no-op
    expect(await prisma.foodItem.findUnique({ where: { id: food.id } })).not.toBeNull();
  });
});

describe("goals and overrides", () => {
  it("editing another user's goal is refused", async () => {
    const goal = await prisma.goal.create({
      data: { userId: bob.id, domain: "workout", metric: "workouts_per_week", label: "Bob's goal", target: 4 },
    });

    await expect(
      saveGoalWithSchedule({
        goal: {
          id: goal.id,
          domain: "workout",
          metric: "workouts_per_week",
          label: "Stolen",
          target: 1,
          direction: "gte",
          period: "weekly",
          source: "workout_count",
        },
        schedule: { mode: "every_day" },
      }),
    ).rejects.toThrowError();

    const after = await prisma.goal.findUniqueOrThrow({ where: { id: goal.id } });
    expect(after.label).toBe("Bob's goal");
  });

  it("a goal cannot source from another user's habit", async () => {
    const habit = await prisma.habit.create({
      data: { userId: bob.id, name: "Bob's habit", startDate: DAY },
    });

    const result = await saveGoalWithSchedule({
      goal: {
        domain: "habit",
        metric: "habit",
        label: "Leech",
        target: 1,
        direction: "gte",
        period: "daily",
        source: "habit",
        sourceRef: habit.id,
      },
      schedule: { mode: "every_day" },
    });
    expect(result.ok).toBe(false);
  });

  it("overrides on another user's goal are refused; theirs survive removal attempts", async () => {
    const goal = await prisma.goal.create({
      data: { userId: bob.id, domain: "workout", metric: "workouts_per_week", label: "Bob's goal", target: 4 },
    });
    await prisma.scheduleOverride.create({
      data: { userId: bob.id, ownerType: "goal", ownerId: goal.id, date: DAY, kind: "rest" },
    });

    const apply = await applyDateOverride({
      ownerType: "goal",
      ownerId: goal.id,
      date: DAY,
      kind: "cancel",
    });
    expect(apply.ok).toBe(false);

    await removeDateOverride("goal", goal.id, DAY);
    const still = await prisma.scheduleOverride.findFirst({
      where: { ownerId: goal.id, date: DAY },
    });
    expect(still).not.toBeNull();
    expect(still?.kind).toBe("rest");
  });
});

describe("reminders", () => {
  it("another user's reminder cannot be deleted", async () => {
    const reminder = await prisma.reminder.create({
      data: { userId: bob.id, title: "Bob's reminder", remindAt: new Date() },
    });

    const result = await deleteReminder(reminder.id);
    expect(result.ok).toBe(true); // scoped no-op
    expect(await prisma.reminder.findUnique({ where: { id: reminder.id } })).not.toBeNull();
  });
});

describe("search", () => {
  it("search results never span users", async () => {
    await prisma.scheduleItem.create({
      data: { userId: bob.id, title: "BobSecretMeeting", date: DAY },
    });
    await prisma.journalEntry.create({
      data: { userId: bob.id, date: DAY, content: "BobSecretDiary" },
    });

    const rows = await searchEverything("BobSecret");
    expect(rows.items).toHaveLength(0);
    expect(rows.journal).toHaveLength(0);
  });

  it("search is case-insensitive on Postgres (SQLite parity)", async () => {
    await prisma.scheduleItem.create({
      data: { userId: alice.id, title: "Quarterly Review", date: DAY },
    });

    const rows = await searchEverything("quarterly");
    expect(rows.items).toHaveLength(1);
  });
});
