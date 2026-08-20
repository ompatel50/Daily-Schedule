/**
 * Unified quick-capture — the server half.
 *
 * The grammar itself is unit-tested in tests/capture.test.ts; these tests pin
 * the routing contract: previewCapture resolves drafts against the USER's own
 * records, and commitCapture writes through each module's existing action —
 * same validation, same ownership rules, same day recomputes — never a second
 * write path.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { commitCapture, previewCapture } from "@/server/actions/capture";
import { quickAddScheduleItem } from "@/server/actions/planner";
import { actAs, resetDatabase, twoUsers, type User } from "./helpers";

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

describe("task capture", () => {
  it("creates a real task with due date, priority and tags", async () => {
    const result = await commitCapture({
      intent: "task",
      title: "call insurance",
      dueDate: DAY,
      priority: "high",
      tags: ["admin"],
    });
    expect(result.ok).toBe(true);

    const task = await prisma.task.findFirst({
      where: { userId: alice.id },
      include: { tags: { include: { tag: true } } },
    });
    expect(task).toMatchObject({ title: "call insurance", dueDate: DAY, priority: "high" });
    expect(task?.tags.map((link) => link.tag.name)).toEqual(["admin"]);
  });
});

describe("money capture", () => {
  it("expense writes a negative transaction through the finance action (cents dual-write)", async () => {
    const account = await prisma.financeAccount.create({
      data: { userId: alice.id, name: "Checking", type: "checking" },
    });
    const result = await commitCapture({
      intent: "expense",
      accountId: account.id,
      amount: 12.4,
      payee: "chipotle",
      category: "dining",
      date: DAY,
    });
    expect(result.ok).toBe(true);

    const transaction = await prisma.financeTransaction.findFirst({
      where: { userId: alice.id },
    });
    expect(transaction).toMatchObject({
      amount: -12.4,
      amountCents: -1240,
      payee: "chipotle",
      category: "dining",
    });
  });

  it("income writes a positive transaction", async () => {
    const account = await prisma.financeAccount.create({
      data: { userId: alice.id, name: "Checking", type: "checking" },
    });
    const result = await commitCapture({
      intent: "income",
      accountId: account.id,
      amount: 2500,
      payee: "salary",
      category: "income",
      date: DAY,
    });
    expect(result.ok).toBe(true);
    const transaction = await prisma.financeTransaction.findFirst({
      where: { userId: alice.id },
    });
    expect(transaction).toMatchObject({ amountCents: 250000, category: "income" });
  });

  it("another user's account is refused and writes nothing", async () => {
    const bobAccount = await prisma.financeAccount.create({
      data: { userId: bob.id, name: "Bob's", type: "checking" },
    });
    const result = await commitCapture({
      intent: "expense",
      accountId: bobAccount.id,
      amount: 10,
      payee: null,
      category: "other",
      date: DAY,
    });
    expect(result.ok).toBe(false);
    expect(await prisma.financeTransaction.count()).toBe(0);
  });

  it("previewCapture offers the user's accounts with the last-used default", async () => {
    const checking = await prisma.financeAccount.create({
      data: { userId: alice.id, name: "Checking", type: "checking" },
    });
    const card = await prisma.financeAccount.create({
      data: { userId: alice.id, name: "Card", type: "credit_card" },
    });
    await prisma.financeAccount.create({
      data: { userId: bob.id, name: "BobAccount", type: "checking" },
    });
    await prisma.financeTransaction.create({
      data: {
        userId: alice.id,
        accountId: card.id,
        date: DAY,
        amount: -5,
        amountCents: -500,
        category: "other",
      },
    });

    const preview = await previewCapture({ wantAccounts: true });
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      const names = preview.data.context.accounts.map((account) => account.name);
      expect(names).toContain("Checking");
      expect(names).toContain("Card");
      expect(names).not.toContain("BobAccount");
      expect(preview.data.context.defaultAccountId).toBe(card.id);
      expect([checking.id, card.id]).toContain(preview.data.context.defaultAccountId);
    }
  });
});

describe("health capture", () => {
  it("logs in the user's display unit (imperial lb → canonical kg)", async () => {
    const result = await commitCapture({
      intent: "health",
      metric: "body_weight",
      value: 178,
      unit: null,
      secondaryValue: null,
      date: DAY,
    });
    expect(result.ok).toBe(true);
    const metric = await prisma.healthMetric.findFirst({ where: { userId: alice.id } });
    expect(metric?.type).toBe("body_weight");
    expect(metric?.value).toBeCloseTo(80.7, 0); // 178 lb in kg
  });

  it("an explicit unit converts through the one health unit table", async () => {
    const result = await commitCapture({
      intent: "health",
      metric: "body_weight",
      value: 80,
      unit: "kg",
      secondaryValue: null,
      date: DAY,
    });
    expect(result.ok).toBe(true);
    const metric = await prisma.healthMetric.findFirst({ where: { userId: alice.id } });
    // 80 kg typed by an imperial user → displayed 176.4 lb → stored back ≈ 80 kg.
    expect(metric?.value).toBeCloseTo(80, 0);
  });

  it("a non-manual metric is refused", async () => {
    // protein_g is import-only (no manual flag) — capture must refuse it.
    const result = await commitCapture({
      intent: "health",
      metric: "protein_g",
      value: 120,
      unit: null,
      secondaryValue: null,
      date: DAY,
    });
    expect(result.ok).toBe(false);
  });
});

describe("nutrition capture", () => {
  it("resolves phrases against the catalogue and logs through logFood", async () => {
    const egg = await prisma.foodItem.create({
      data: {
        userId: alice.id,
        name: "Egg",
        searchKey: "egg",
        calories: 78,
        protein: 6,
        carbs: 0.6,
        fat: 5,
        isCustom: true,
        provider: "custom",
      },
    });

    const preview = await previewCapture({ foodPhrases: ["eggs"] });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const candidates = preview.data.foods["eggs"];
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].name).toBe("Egg");

    const result = await commitCapture({
      intent: "nutrition",
      date: DAY,
      mealType: "breakfast",
      items: [
        {
          foodItemId: egg.id,
          provider: null,
          externalId: null,
          quantity: 2,
          unit: "serving",
          idempotencyKey: "capture-test-eggs-1",
        },
      ],
    });
    expect(result.ok).toBe(true);

    const entry = await prisma.mealEntry.findFirst({
      where: { meal: { userId: alice.id, date: DAY } },
      include: { meal: true },
    });
    expect(entry).toMatchObject({ quantity: 2, foodItemId: egg.id });
    expect(entry?.meal.type).toBe("breakfast");
    expect(entry?.calories).toBeCloseTo(156, 0);
  });

  it("retrying the same idempotency key never double-logs", async () => {
    const food = await prisma.foodItem.create({
      data: {
        userId: alice.id,
        name: "Toast",
        searchKey: "toast",
        calories: 80,
        isCustom: true,
        provider: "custom",
      },
    });
    const payload = {
      intent: "nutrition" as const,
      date: DAY,
      mealType: "breakfast" as const,
      items: [
        {
          foodItemId: food.id,
          provider: null,
          externalId: null,
          quantity: 1,
          unit: "serving" as const,
          idempotencyKey: "capture-test-toast-1",
        },
      ],
    };
    expect((await commitCapture(payload)).ok).toBe(true);
    expect((await commitCapture(payload)).ok).toBe(true);
    expect(await prisma.mealEntry.count({ where: { meal: { userId: alice.id } } })).toBe(1);
  });
});

describe("workout capture", () => {
  it("strength shorthand expands to real sets with lb→kg conversion", async () => {
    const result = await commitCapture({
      intent: "workout",
      date: DAY,
      name: "Bench",
      type: "strength",
      durationMin: null,
      distanceKm: null,
      strength: { exercise: "Bench", sets: 3, reps: 8, weight: 135, weightUnit: null },
    });
    expect(result.ok).toBe(true);

    const workout = await prisma.workout.findFirst({
      where: { userId: alice.id },
      include: { sets: { orderBy: { setNumber: "asc" } } },
    });
    expect(workout?.sets).toHaveLength(3);
    expect(workout?.sets[0].reps).toBe(8);
    expect(workout?.sets[0].weightKg).toBeCloseTo(61.2, 0); // 135 lb
    // The workout mirrors into the planner, as saveWorkout always does.
    const mirror = await prisma.scheduleItem.findFirst({
      where: { userId: alice.id, workoutId: workout?.id },
    });
    expect(mirror).not.toBeNull();
  });

  it("cardio keeps distance and duration", async () => {
    const result = await commitCapture({
      intent: "workout",
      date: DAY,
      name: "Run",
      type: "running",
      durationMin: 28,
      distanceKm: 5.15,
      strength: null,
    });
    expect(result.ok).toBe(true);
    const workout = await prisma.workout.findFirst({ where: { userId: alice.id } });
    expect(workout).toMatchObject({ type: "running", durationMin: 28 });
    expect(workout?.distanceKm).toBeCloseTo(5.15, 2);
  });
});

describe("habit capture", () => {
  it("previewCapture matches habits both ways and reports today's log", async () => {
    const habit = await prisma.habit.create({
      data: { userId: alice.id, name: "Morning meditation", startDate: DAY },
    });
    await prisma.habit.create({
      data: { userId: bob.id, name: "Meditation (Bob)", startDate: DAY },
    });
    await prisma.habitLog.create({
      data: { userId: alice.id, habitId: habit.id, date: DAY, status: "done" },
    });

    const preview = await previewCapture({ habitQuery: "meditation", habitDate: DAY });
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      expect(preview.data.habits).toHaveLength(1);
      expect(preview.data.habits[0]).toMatchObject({
        id: habit.id,
        loggedStatus: "done",
      });
    }
  });

  it("commit routes through logHabit; another user's habit is refused", async () => {
    const habit = await prisma.habit.create({
      data: { userId: alice.id, name: "Reading", startDate: DAY },
    });
    const ok = await commitCapture({
      intent: "habit",
      habitId: habit.id,
      status: "skipped",
      date: DAY,
    });
    expect(ok.ok).toBe(true);
    expect(
      await prisma.habitLog.findFirst({ where: { habitId: habit.id, date: DAY } }),
    ).toMatchObject({ status: "skipped" });

    const bobHabit = await prisma.habit.create({
      data: { userId: bob.id, name: "Bob's habit", startDate: DAY },
    });
    const stolen = await commitCapture({
      intent: "habit",
      habitId: bobHabit.id,
      status: "done",
      date: DAY,
    });
    expect(stolen.ok).toBe(false);
    expect(await prisma.habitLog.count({ where: { habitId: bobHabit.id } })).toBe(0);
  });
});

describe("inbox + planner capture", () => {
  it("inbox capture keeps the raw text", async () => {
    const result = await commitCapture({
      intent: "inbox",
      title: "spent a lovely day at the park",
      notes: null,
    });
    expect(result.ok).toBe(true);
    const item = await prisma.inboxItem.findFirst({ where: { userId: alice.id } });
    expect(item?.title).toBe("spent a lovely day at the park");
  });

  it("planner capture creates a planned block", async () => {
    const result = await commitCapture({
      intent: "planner",
      title: "Deep work",
      date: DAY,
      startMinute: 540,
      endMinute: 660,
      allDay: false,
      category: "work",
      priority: "high",
    });
    expect(result.ok).toBe(true);
    const item = await prisma.scheduleItem.findFirst({ where: { userId: alice.id } });
    expect(item).toMatchObject({
      title: "Deep work",
      startMinute: 540,
      endMinute: 660,
      status: "planned",
    });
  });

  it("the historical text quick-add still works unchanged (regression baseline)", async () => {
    const result = await quickAddScheduleItem({
      text: "Gym 6:30-7:30pm #fitness !high",
      date: DAY,
    });
    expect(result.ok).toBe(true);
    const item = await prisma.scheduleItem.findFirst({
      where: { userId: alice.id, title: "Gym" },
    });
    expect(item).toMatchObject({
      category: "fitness",
      priority: "high",
      startMinute: 18.5 * 60,
      endMinute: 19.5 * 60,
    });
  });
});
