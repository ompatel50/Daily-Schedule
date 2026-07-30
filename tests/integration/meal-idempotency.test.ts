/**
 * Meal-entry idempotency against real PostgreSQL: the client-generated
 * idempotencyKey turns a replayed logFood into a reported no-op, fresh keys
 * still log normally, and the (mealId, idempotencyKey) unique index holds at
 * the database level regardless of what the action layer does.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { logFood } from "@/server/actions/nutrition";
import { actAs, expectUniqueViolation, resetDatabase, twoUsers } from "./helpers";

import type { FoodItem } from "@prisma/client";
import type { User } from "./helpers";

let alice: User;
let food: FoodItem;

const DAY = "2026-07-30";

function logOats(idempotencyKey: string, mealType: "breakfast" | "lunch" = "breakfast") {
  return logFood({
    date: DAY,
    mealType,
    foodItemId: food.id,
    quantity: 100,
    unit: "g",
    idempotencyKey,
  });
}

beforeEach(async () => {
  await resetDatabase();
  ({ alice } = await twoUsers());
  actAs(alice);
  food = await prisma.foodItem.create({
    data: {
      userId: alice.id,
      name: "Test oats",
      provider: "custom",
      isCustom: true,
      basis: "per_100g",
      calories: 380,
      protein: 13,
      carbs: 68,
      fat: 7,
    },
  });
});

describe("logFood idempotency", () => {
  it("the same key twice results in one row, with the replay reported as duplicate", async () => {
    const first = await logOats("replayed-key-0001");
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.data.duplicate).toBe(false);

    const second = await logOats("replayed-key-0001");
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.data.duplicate).toBe(true);
      if (first.ok) expect(second.data.mealId).toBe(first.data.mealId);
    }

    expect(await prisma.mealEntry.count()).toBe(1);
  });

  it("different keys log two separate entries", async () => {
    expect((await logOats("fresh-key-000001")).ok).toBe(true);
    expect((await logOats("fresh-key-000002")).ok).toBe(true);

    const entries = await prisma.mealEntry.findMany();
    expect(entries).toHaveLength(2);
    expect(entries[0].mealId).toBe(entries[1].mealId);
  });

  it("the key is scoped per meal — the same key on another meal still logs", async () => {
    expect((await logOats("shared-key-00001", "breakfast")).ok).toBe(true);

    const lunch = await logOats("shared-key-00001", "lunch");
    expect(lunch.ok).toBe(true);
    if (lunch.ok) expect(lunch.data.duplicate).toBe(false);

    expect(await prisma.mealEntry.count()).toBe(2);
  });

  it("the (mealId, idempotencyKey) unique holds against a raw insert", async () => {
    const logged = await logOats("guarded-key-0001");
    expect(logged.ok).toBe(true);
    if (!logged.ok) return;

    await expectUniqueViolation(
      prisma.mealEntry.create({
        data: {
          mealId: logged.data.mealId,
          foodItemId: food.id,
          idempotencyKey: "guarded-key-0001",
          quantity: 100,
          unit: "g",
          calories: 380,
          protein: 13,
          carbs: 68,
          fat: 7,
        },
      }),
    );

    expect(await prisma.mealEntry.count()).toBe(1);
  });
});
