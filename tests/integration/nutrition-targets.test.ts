/**
 * Nutrition targets — goals with day-type variants, end to end: the editor's
 * write path, the day-aware goal map, the Targets view-model, the day score's
 * treatment (adherence scored through the goals category; missing data
 * excluded, never failed), and the v13 backup round trip for `dayType`.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { setDayTypeOverride } from "@/server/actions/day-type";
import { saveGoalWithSchedule } from "@/server/actions/goals";
import { logFood } from "@/server/actions/nutrition";
import { exportBackup, importBackup } from "@/server/actions/backup";
import { getDayScore } from "@/server/day-score";
import { scheduleSettingsFor } from "@/server/schedule";
import { getGoalMap, getNutritionTargets } from "@/server/queries";
import { actAs, resetDatabase, twoUsers, type User } from "./helpers";

let alice: User;
let bob: User;

const DAY = "2026-07-30";

const EVERY_DAY = {
  mode: "every_day",
  weekdays: [] as number[],
  interval: 1,
  timesPerWeek: null,
  monthDay: null,
  enabled: true,
  daypart: "anytime",
  timeMinute: null,
  reminderEnabled: false,
  reminderMinute: null,
};

function targetPayload(overrides: Record<string, unknown> = {}) {
  return {
    goal: {
      domain: "nutrition",
      metric: "calories",
      label: "Calories",
      target: 2200,
      unit: "kcal",
      direction: "lte",
      period: "daily",
      source: "calories",
      dayType: "all",
      active: true,
      // The fixture DAY is fixed in the past; without this the action would
      // default startDate to the real today and the goal would read inactive.
      startDate: "2026-07-01",
      ...overrides,
    },
    schedule: EVERY_DAY,
  };
}

async function logMeal(calories: number) {
  const food = await prisma.foodItem.create({
    data: {
      userId: alice.id,
      name: `Meal ${calories}`,
      searchKey: `meal ${calories}`,
      calories,
      protein: 10,
      isCustom: true,
      provider: "custom",
    },
  });
  const result = await logFood({
    date: DAY,
    mealType: "lunch",
    foodItemId: food.id,
    quantity: 1,
    unit: "serving",
  });
  expect(result.ok).toBe(true);
}

async function settingsForAlice() {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: alice.id } });
  return scheduleSettingsFor(user);
}

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  ({ alice, bob } = await twoUsers());
  actAs(alice);
});

describe("target creation", () => {
  it("writes the goal with its day type through the one goal action", async () => {
    const result = await saveGoalWithSchedule(targetPayload({ dayType: "training" }));
    expect(result.ok).toBe(true);
    const goal = await prisma.goal.findFirst({ where: { userId: alice.id } });
    expect(goal).toMatchObject({
      domain: "nutrition",
      source: "calories",
      dayType: "training",
      direction: "lte",
    });
  });
});

describe("day-aware goal map", () => {
  it("prefers the day's variant and falls back to 'all'", async () => {
    await saveGoalWithSchedule(targetPayload({ target: 2000 })); // all days
    await saveGoalWithSchedule(
      targetPayload({ label: "Calories (training)", target: 2600, dayType: "training" }),
    );

    // No workout on DAY → rest day → the "all" target applies.
    const restMap = await getGoalMap(DAY);
    expect(restMap.get("calories")?.target).toBe(2000);

    await prisma.workout.create({
      data: { userId: alice.id, date: DAY, name: "Lift", status: "completed" },
    });
    const trainingMap = await getGoalMap(DAY);
    expect(trainingMap.get("calories")?.target).toBe(2600);
  });
});

describe("targets view-model", () => {
  it("reports consumed against each target, with unlogged as null", async () => {
    await saveGoalWithSchedule(targetPayload({ target: 2200 }));
    await saveGoalWithSchedule(
      targetPayload({
        metric: "hydration",
        label: "Water",
        target: 2000,
        unit: "ml",
        direction: "gte",
        source: "hydration",
      }),
    );

    const before = await getNutritionTargets(DAY);
    expect(before.dayType).toBe("rest");
    const calorieRow = before.rows.find((row) => row.metric === "calories");
    expect(calorieRow?.consumed).toBeNull(); // nothing logged = unknown, not 0
    expect(before.rows.find((row) => row.metric === "hydration")?.consumed).toBeNull();

    await logMeal(650);
    const after = await getNutritionTargets(DAY);
    expect(after.rows.find((row) => row.metric === "calories")?.consumed).toBeCloseTo(650, 0);
  });

  it("flags which variant applies on the day", async () => {
    await saveGoalWithSchedule(
      targetPayload({ label: "Calories (training)", target: 2600, dayType: "training" }),
    );
    const view = await getNutritionTargets(DAY);
    expect(view.hasVariants).toBe(true);
    expect(view.rows[0].applies).toBe(false); // rest day, training-only target
  });
});

describe("day score integration (adherence through the goals category)", () => {
  it("a met calorie target scores; an unlogged day is excluded as no-data", async () => {
    await saveGoalWithSchedule(targetPayload({ target: 2200, direction: "lte" }));
    const settings = await settingsForAlice();

    const unlogged = await getDayScore(alice.id, DAY, settings);
    const excluded = unlogged.exclusions.find((exclusion) => exclusion.label === "Calories");
    expect(excluded?.reason).toBe("no_data");
    expect(
      unlogged.categories
        .find((category) => category.category === "goals")
        ?.opportunities.some((opportunity) => opportunity.label === "Calories"),
    ).toBe(false);

    await logMeal(1850);
    const logged = await getDayScore(alice.id, DAY, settings);
    const opportunity = logged.categories
      .find((category) => category.category === "goals")
      ?.opportunities.find((entry) => entry.label === "Calories");
    expect(opportunity?.met).toBe(true);
  });

  it("a training-day target on a rest day is excluded as a rest day, never missed", async () => {
    await saveGoalWithSchedule(
      targetPayload({
        metric: "protein",
        label: "Protein (training)",
        target: 180,
        unit: "g",
        direction: "gte",
        source: "protein",
        dayType: "training",
      }),
    );
    await logMeal(600); // protein logged, but it is a rest day

    const settings = await settingsForAlice();
    const score = await getDayScore(alice.id, DAY, settings);
    const exclusion = score.exclusions.find((entry) => entry.label === "Protein (training)");
    expect(exclusion?.reason).toBe("rest_day");

    // A completed workout flips the day to training — now it applies.
    await prisma.workout.create({
      data: { userId: alice.id, date: DAY, name: "Lift", status: "completed" },
    });
    const trained = await getDayScore(alice.id, DAY, settings);
    const opportunity = trained.categories
      .find((category) => category.category === "goals")
      ?.opportunities.find((entry) => entry.label === "Protein (training)");
    expect(opportunity).toBeDefined();
  });
});

describe("backup v13", () => {
  it("round-trips dayType through export and restore", async () => {
    await saveGoalWithSchedule(
      targetPayload({ label: "Calories (training)", target: 2600, dayType: "training" }),
    );
    const exported = await exportBackup();
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const file = exported.data as {
      version: number;
      data: Record<string, Array<{ dayType?: string }>>;
    };
    expect(file.version).toBe(13);
    expect(file.data.goals[0]?.dayType).toBe("training");

    // Restore into the OTHER account and confirm the column survives.
    actAs(bob);
    const restored = await importBackup(file, "merge");
    expect(restored.ok).toBe(true);
    const bobGoal = await prisma.goal.findFirst({ where: { userId: bob.id } });
    expect(bobGoal?.dayType).toBe("training");
  });
});

describe("isolation", () => {
  it("targets never cross users", async () => {
    await saveGoalWithSchedule(targetPayload());
    actAs(bob);
    const view = await getNutritionTargets(DAY);
    expect(view.rows).toHaveLength(0);
  });
});

describe("day-type override (nutrition ↔ workout linkage)", () => {
  it("flips the resolved day type, the goal map and the targets view", async () => {
    await saveGoalWithSchedule(targetPayload({ target: 2000 })); // all days
    await saveGoalWithSchedule(
      targetPayload({ label: "Calories (training)", target: 2600, dayType: "training" }),
    );

    // Derived: no workout → rest.
    expect((await getNutritionTargets(DAY)).dayType).toBe("rest");
    expect((await getGoalMap(DAY)).get("calories")?.target).toBe(2000);

    // Manual: treat as a training day.
    const set = await setDayTypeOverride({ date: DAY, dayType: "training" });
    expect(set.ok).toBe(true);
    const overridden = await getNutritionTargets(DAY);
    expect(overridden.dayType).toBe("training");
    expect(overridden.overridden).toBe(true);
    expect((await getGoalMap(DAY)).get("calories")?.target).toBe(2600);

    // Clearing falls back to derivation.
    const cleared = await setDayTypeOverride({ date: DAY, dayType: null });
    expect(cleared.ok).toBe(true);
    const back = await getNutritionTargets(DAY);
    expect(back.dayType).toBe("rest");
    expect(back.overridden).toBe(false);
  });

  it("gates the day score through the override", async () => {
    await saveGoalWithSchedule(
      targetPayload({
        metric: "protein",
        label: "Protein (training)",
        target: 100,
        unit: "g",
        direction: "gte",
        source: "protein",
        dayType: "training",
      }),
    );
    await logMeal(600); // logs 10g protein via the fixture food

    const settings = await settingsForAlice();
    // Rest day (derived): the training target is excluded.
    const before = await getDayScore(alice.id, DAY, settings);
    expect(before.exclusions.some((entry) => entry.label === "Protein (training)")).toBe(true);

    // Overriding to training makes it applicable — with NO workout logged.
    await setDayTypeOverride({ date: DAY, dayType: "training" });
    const after = await getDayScore(alice.id, DAY, settings);
    const opportunity = after.categories
      .find((category) => category.category === "goals")
      ?.opportunities.find((entry) => entry.label === "Protein (training)");
    expect(opportunity).toBeDefined();
  });

  it("the comparison respects overrides and skips unlogged days", async () => {
    // A logged rest day, manually declared a training day.
    await logMeal(1500);
    await setDayTypeOverride({ date: DAY, dayType: "training" });
    const view = await getNutritionTargets(DAY);
    expect(view.comparison.training.days).toBe(1);
    expect(view.comparison.rest.days).toBe(0);
  });

  it("overrides never cross users and ride the backup", async () => {
    await setDayTypeOverride({ date: DAY, dayType: "training" });

    actAs(bob);
    expect((await getNutritionTargets(DAY)).overridden).toBe(false);

    actAs(alice);
    const exported = await exportBackup();
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const file = exported.data as { data: Record<string, Array<{ dayType?: string; date?: string }>> };
    expect(file.data.dayTypeOverrides).toHaveLength(1);
    expect(file.data.dayTypeOverrides[0]).toMatchObject({ date: DAY, dayType: "training" });

    actAs(bob);
    const restored = await importBackup(exported.data, "merge");
    expect(restored.ok).toBe(true);
    const bobOverride = await prisma.dayTypeOverride.findFirst({ where: { userId: bob.id } });
    expect(bobOverride).toMatchObject({ date: DAY, dayType: "training" });
  });
});
