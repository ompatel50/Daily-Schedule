/**
 * PostgreSQL NULLS DISTINCT behaviour the app's unique constraints rely on:
 * rows whose nullable key columns are null never collide with each other,
 * while equal non-null keys always do. If a Postgres upgrade or a migration
 * ever switched a constraint to NULLS NOT DISTINCT, ordinary hand-made rows
 * (no routine, no idempotency key, no import id) would start rejecting each
 * other — this file is the tripwire.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { expectUniqueViolation, resetDatabase, twoUsers } from "./helpers";

import type { User } from "@prisma/client";

let alice: User;

const DAY = "2026-07-30";

beforeEach(async () => {
  await resetDatabase();
  ({ alice } = await twoUsers());
});

describe("ScheduleItem (userId, date, templateId, sourceKey)", () => {
  it("two hand-made items on one day (both keys null) insert; equal non-null keys collide", async () => {
    await prisma.scheduleItem.create({ data: { userId: alice.id, title: "One", date: DAY } });
    await prisma.scheduleItem.create({ data: { userId: alice.id, title: "Two", date: DAY } });
    expect(await prisma.scheduleItem.count({ where: { userId: alice.id, date: DAY } })).toBe(2);

    const template = await prisma.scheduleTemplate.create({
      data: { userId: alice.id, name: "Routine", items: "[]" },
    });
    await prisma.scheduleItem.create({
      data: { userId: alice.id, title: "Keyed", date: DAY, templateId: template.id, sourceKey: "1:0" },
    });
    await expectUniqueViolation(
      prisma.scheduleItem.create({
        data: { userId: alice.id, title: "Keyed again", date: DAY, templateId: template.id, sourceKey: "1:0" },
      }),
    );
  });
});

describe("MealEntry (mealId, idempotencyKey)", () => {
  it("two entries with null keys insert; equal non-null keys collide", async () => {
    const food = await prisma.foodItem.create({
      data: { userId: alice.id, name: "Rice", provider: "custom", isCustom: true, calories: 130 },
    });
    const meal = await prisma.meal.create({ data: { userId: alice.id, date: DAY, type: "lunch" } });
    const entry = {
      mealId: meal.id,
      foodItemId: food.id,
      quantity: 100,
      unit: "g",
      calories: 130,
      protein: 2.7,
      carbs: 28,
      fat: 0.3,
    };

    // Null on BOTH nullable-unique tuples of this table — (mealId,
    // idempotencyKey) and (mealId, templateId, sourceKey) — and still no clash.
    await prisma.mealEntry.create({ data: entry });
    await prisma.mealEntry.create({ data: entry });
    expect(await prisma.mealEntry.count({ where: { mealId: meal.id } })).toBe(2);

    await prisma.mealEntry.create({ data: { ...entry, idempotencyKey: "abc-12345678" } });
    await expectUniqueViolation(
      prisma.mealEntry.create({ data: { ...entry, idempotencyKey: "abc-12345678" } }),
    );
  });
});

describe("Workout (userId, source, externalId)", () => {
  it("two manual workouts (externalId null) insert; equal non-null ids collide", async () => {
    await prisma.workout.create({ data: { userId: alice.id, date: DAY, name: "Run", source: "manual" } });
    await prisma.workout.create({ data: { userId: alice.id, date: DAY, name: "Lift", source: "manual" } });
    expect(await prisma.workout.count({ where: { userId: alice.id, source: "manual" } })).toBe(2);

    await prisma.workout.create({
      data: { userId: alice.id, date: DAY, name: "Watch run", source: "apple_health", externalId: "ext-1" },
    });
    await expectUniqueViolation(
      prisma.workout.create({
        data: { userId: alice.id, date: DAY, name: "Watch run again", source: "apple_health", externalId: "ext-1" },
      }),
    );
  });
});
