"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser, prisma } from "@/lib/db";
import { MEAL_TYPE_META, type MealType } from "@/lib/enums";
import { parseExtraNutrients, type FoodProviderId } from "@/lib/logic/food";
import { nutrientSnapshotFor } from "@/lib/logic/nutrition";
import { planTemplateApplication, templateSourceKey, type TemplateApplyMode } from "@/lib/logic/planner";
import { parseServingSpec } from "@/lib/logic/servings";
import {
  fail,
  foodItemSchema,
  fromZod,
  mealEntrySchema,
  moveMealEntrySchema,
  succeed,
  updateMealEntrySchema,
  type ActionResult,
} from "@/lib/validation";
import { materializeFood } from "@/server/food";
import { recomputeDay } from "@/server/summaries";

/** A Prisma food row in the shape the nutrition maths expects. */
function toFoodLike(food: {
  name: string;
  basis: string;
  servingSize: number;
  servingUnit: string;
  servingLabel: string | null;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  sugar: number;
  sodium: number;
  extraNutrients: string | null;
  servingOptions: string | null;
}) {
  const spec = parseServingSpec(food.servingOptions);
  return {
    ...food,
    gramsPerMl: spec.gramsPerMl,
    servingOptions: spec.options,
    extraNutrients: parseExtraNutrients(food.extraNutrients),
  };
}

/**
 * The columns a `MealEntry` freezes. Written on every path that creates or
 * changes an entry, so a provider refresh or a renamed food can never move a
 * total that has already been recorded.
 */
function snapshotColumns(snapshot: ReturnType<typeof nutrientSnapshotFor>) {
  return {
    calories: snapshot.macros.calories,
    protein: snapshot.macros.protein,
    carbs: snapshot.macros.carbs,
    fat: snapshot.macros.fat,
    fiber: snapshot.macros.fiber,
    sugar: snapshot.macros.sugar,
    sodium: snapshot.macros.sodium,
    foodNameAtLog: snapshot.foodName,
    basisAtLog: snapshot.basis,
    servingSizeAtLog: snapshot.servingSize,
    servingUnitAtLog: snapshot.servingUnit,
    gramsAtLog: snapshot.grams,
    extraNutrientsAtLog: JSON.stringify(snapshot.extraNutrients),
  };
}

/** Prisma's unique-constraint violation. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

function revalidateAll() {
  revalidatePath("/", "layout");
}

/** Find or create the meal container for (date, type, label). */
async function ensureMeal(
  userId: string,
  date: string,
  type: MealType,
  label?: string | null,
): Promise<string> {
  const existing = await prisma.meal.findFirst({
    where: { userId, date, type, label: label ?? null },
  });
  if (existing) return existing.id;

  const meal = await prisma.meal.create({
    data: {
      userId,
      date,
      type,
      label: label ?? null,
      time: MEAL_TYPE_META[type]?.defaultTime ?? null,
    },
  });
  return meal.id;
}

export async function logFood(
  input: unknown,
): Promise<ActionResult<{ mealId: string; duplicate: boolean }>> {
  const parsed = mealEntrySchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const user = await getCurrentUser();
  const { date, mealType, mealLabel, foodItemId, provider, externalId, quantity, unit, idempotencyKey } =
    parsed.data;

  if (!foodItemId && !externalId) return fail("Pick a food first");

  // An external result has no internal row until now; this caches it, so the
  // same food is local (and offline-capable) from here on.
  const food = await materializeFood(
    (provider ?? "local") as FoodProviderId,
    externalId ?? null,
    foodItemId ?? null,
    user.id,
  );
  if (!food) return fail("Food not found");

  const snapshot = nutrientSnapshotFor(toFoodLike(food), quantity, unit);
  if (!snapshot.convertible) {
    return fail(`${food.name} cannot be measured in ${unit}. Try grams.`);
  }

  const mealId = await ensureMeal(user.id, date, mealType, mealLabel);

  const maxOrder = await prisma.mealEntry.aggregate({
    where: { mealId },
    _max: { sortOrder: true },
  });

  try {
    await prisma.mealEntry.create({
      data: {
        mealId,
        foodItemId: food.id,
        quantity,
        unit,
        idempotencyKey: idempotencyKey ?? null,
        sortOrder: (maxOrder._max.sortOrder ?? 0) + 1,
        ...snapshotColumns(snapshot),
      },
    });
  } catch (error) {
    // The unique index on (mealId, idempotencyKey) is the real defence against
    // a double-click or a retried request — a disabled button is a hint, not a
    // guarantee, and an optimistic client can replay a save after a timeout.
    if (isUniqueViolation(error)) {
      return succeed({ mealId, duplicate: true });
    }
    throw error;
  }

  // Keep the "recent foods" list useful without a separate history table.
  await prisma.favoriteItem.upsert({
    where: { userId_kind_refId: { userId: user.id, kind: "food", refId: food.id } },
    create: {
      userId: user.id,
      kind: "food",
      refId: food.id,
      label: food.name,
      useCount: 1,
      lastUsedAt: new Date(),
    },
    update: { useCount: { increment: 1 }, lastUsedAt: new Date() },
  });

  await recomputeDay(user.id, date);
  revalidateAll();
  return succeed({ mealId, duplicate: false });
}

export async function updateMealEntry(input: unknown): Promise<ActionResult<null>> {
  const parsed = updateMealEntrySchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const user = await getCurrentUser();
  const entry = await prisma.mealEntry.findFirst({
    where: { id: parsed.data.id, meal: { userId: user.id } },
    include: { foodItem: true, meal: true },
  });
  if (!entry) return fail("Entry not found");

  const snapshot = nutrientSnapshotFor(
    toFoodLike(entry.foodItem),
    parsed.data.quantity,
    parsed.data.unit,
  );
  if (!snapshot.convertible) {
    return fail(`${entry.foodItem.name} cannot be measured in ${parsed.data.unit}. Try grams.`);
  }

  await prisma.mealEntry.update({
    where: { id: entry.id },
    data: {
      quantity: parsed.data.quantity,
      unit: parsed.data.unit,
      ...snapshotColumns(snapshot),
    },
  });

  await recomputeDay(user.id, entry.meal.date);
  revalidateAll();
  return succeed(null);
}

/**
 * Move an entry to another meal, another date, or both.
 *
 * The snapshot travels untouched — moving *when* something was eaten does not
 * change *what* it was, so the numbers must not be recomputed against a food
 * that may have been edited since. Both days are recomputed, because the source
 * day loses the calories the destination gains.
 */
export async function moveMealEntry(input: unknown): Promise<ActionResult<null>> {
  const parsed = moveMealEntrySchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const user = await getCurrentUser();
  const entry = await prisma.mealEntry.findFirst({
    where: { id: parsed.data.id, meal: { userId: user.id } },
    include: { meal: true },
  });
  if (!entry) return fail("Entry not found");

  const fromDate = entry.meal.date;
  const toDate = parsed.data.date ?? fromDate;
  const toType = (parsed.data.mealType ?? entry.meal.type) as MealType;
  const toLabel = parsed.data.mealLabel ?? (toType === "custom" ? entry.meal.label : null);

  const targetMealId = await ensureMeal(user.id, toDate, toType, toLabel);
  if (targetMealId === entry.mealId) return succeed(null);

  const maxOrder = await prisma.mealEntry.aggregate({
    where: { mealId: targetMealId },
    _max: { sortOrder: true },
  });

  await prisma.mealEntry.update({
    where: { id: entry.id },
    data: {
      mealId: targetMealId,
      sortOrder: (maxOrder._max.sortOrder ?? 0) + 1,
      // The move is a new row in its destination as far as idempotency goes;
      // keeping the old key could collide with an unrelated entry there.
      idempotencyKey: null,
      templateId: null,
      sourceKey: null,
    },
  });

  const remaining = await prisma.mealEntry.count({ where: { mealId: entry.mealId } });
  if (remaining === 0) await prisma.meal.delete({ where: { id: entry.mealId } });

  await recomputeDay(user.id, fromDate);
  if (toDate !== fromDate) await recomputeDay(user.id, toDate);
  revalidateAll();
  return succeed(null);
}

/**
 * Deliberately log the same thing again. Explicit, and it takes a fresh
 * idempotency key, so it is never confused with the accidental double-save the
 * unique index exists to reject.
 */
export async function duplicateMealEntry(id: string): Promise<ActionResult<{ id: string }>> {
  const user = await getCurrentUser();
  const entry = await prisma.mealEntry.findFirst({
    where: { id, meal: { userId: user.id } },
    include: { meal: true },
  });
  if (!entry) return fail("Entry not found");

  const maxOrder = await prisma.mealEntry.aggregate({
    where: { mealId: entry.mealId },
    _max: { sortOrder: true },
  });

  const copy = await prisma.mealEntry.create({
    data: {
      mealId: entry.mealId,
      foodItemId: entry.foodItemId,
      quantity: entry.quantity,
      unit: entry.unit,
      sortOrder: (maxOrder._max.sortOrder ?? 0) + 1,
      // The snapshot is copied verbatim: a duplicate of what was eaten is the
      // same food with the same numbers, not a fresh lookup.
      calories: entry.calories,
      protein: entry.protein,
      carbs: entry.carbs,
      fat: entry.fat,
      fiber: entry.fiber,
      sugar: entry.sugar,
      sodium: entry.sodium,
      foodNameAtLog: entry.foodNameAtLog,
      basisAtLog: entry.basisAtLog,
      servingSizeAtLog: entry.servingSizeAtLog,
      servingUnitAtLog: entry.servingUnitAtLog,
      gramsAtLog: entry.gramsAtLog,
      extraNutrientsAtLog: entry.extraNutrientsAtLog,
      idempotencyKey: null,
      templateId: null,
      sourceKey: null,
    },
  });

  await recomputeDay(user.id, entry.meal.date);
  revalidateAll();
  return succeed({ id: copy.id });
}

export async function deleteMealEntry(id: string): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  const entry = await prisma.mealEntry.findFirst({
    where: { id, meal: { userId: user.id } },
    include: { meal: true },
  });
  if (!entry) return fail("Entry not found");

  await prisma.mealEntry.delete({ where: { id } });

  // Drop the meal container once it's empty so the day view stays clean.
  const remaining = await prisma.mealEntry.count({ where: { mealId: entry.mealId } });
  if (remaining === 0) await prisma.meal.delete({ where: { id: entry.mealId } });

  await recomputeDay(user.id, entry.meal.date);
  revalidateAll();
  return succeed(null);
}

export async function saveFoodItem(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = foodItemSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const user = await getCurrentUser();
  const { id, extraNutrients, favorite, notes, ...rest } = parsed.data;

  const data = {
    ...rest,
    brand: rest.brand ?? null,
    description: rest.description ?? notes ?? null,
    servingLabel: rest.servingLabel ?? null,
    userId: user.id,
    isCustom: true,
    // A hand-entered food is its own provider: it has no external id, so the
    // (provider, externalId) unique index never applies to it.
    provider: "custom",
    externalId: null,
    kind: rest.brand ? "branded" : "generic",
    source: "Entered by you",
    cached: false,
    completeness: 1,
    extraNutrients: extraNutrients ? JSON.stringify(extraNutrients) : null,
    searchKey: `${rest.name} ${rest.brand ?? ""}`.toLowerCase().trim(),
  };

  const food = id
    ? await prisma.foodItem.update({ where: { id }, data })
    : await prisma.foodItem.create({ data });

  if (favorite !== undefined) {
    await prisma.favoriteItem.upsert({
      where: { userId_kind_refId: { userId: user.id, kind: "food", refId: food.id } },
      create: {
        userId: user.id,
        kind: "food",
        refId: food.id,
        label: food.name,
        sortOrder: favorite ? 0 : -1,
      },
      update: { sortOrder: favorite ? 0 : -1 },
    });
  }

  revalidateAll();
  return succeed({ id: food.id });
}

export async function deleteFoodItem(id: string): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  const inUse = await prisma.mealEntry.count({ where: { foodItemId: id } });
  if (inUse > 0) {
    return fail(`This food is used in ${inUse} logged ${inUse === 1 ? "entry" : "entries"}`);
  }
  await prisma.foodItem.deleteMany({ where: { id, userId: user.id } });
  revalidateAll();
  return succeed(null);
}

export async function toggleFavoriteFood(foodItemId: string): Promise<ActionResult<{ favorite: boolean }>> {
  const user = await getCurrentUser();
  const food = await prisma.foodItem.findFirst({
    where: { id: foodItemId, OR: [{ userId: null }, { userId: user.id }] },
  });
  if (!food) return fail("Food not found");

  const existing = await prisma.favoriteItem.findUnique({
    where: { userId_kind_refId: { userId: user.id, kind: "food", refId: foodItemId } },
  });

  // A "favourite" is a pin on top of the usage record, so unpinning must not
  // erase the recent-foods history — sortOrder < 0 means "not pinned".
  if (existing && existing.sortOrder >= 0) {
    await prisma.favoriteItem.update({ where: { id: existing.id }, data: { sortOrder: -1 } });
    revalidateAll();
    return succeed({ favorite: false });
  }

  await prisma.favoriteItem.upsert({
    where: { userId_kind_refId: { userId: user.id, kind: "food", refId: foodItemId } },
    create: { userId: user.id, kind: "food", refId: foodItemId, label: food.name, sortOrder: 0 },
    update: { sortOrder: 0 },
  });

  revalidateAll();
  return succeed({ favorite: true });
}

export async function saveMealAsTemplate(
  mealId: string,
  name: string,
): Promise<ActionResult<{ id: string }>> {
  const trimmed = name.trim();
  if (!trimmed) return fail("Template name is required");

  const user = await getCurrentUser();
  const meal = await prisma.meal.findFirst({
    where: { id: mealId, userId: user.id },
    include: { entries: true },
  });
  if (!meal || meal.entries.length === 0) return fail("Nothing to save");

  const template = await prisma.mealTemplate.create({
    data: {
      userId: user.id,
      name: trimmed,
      mealType: meal.type,
      items: {
        create: meal.entries.map((entry) => ({
          foodItemId: entry.foodItemId,
          quantity: entry.quantity,
          unit: entry.unit,
        })),
      },
    },
  });

  revalidateAll();
  return succeed({ id: template.id });
}

/**
 * Stamp a saved meal onto a day.
 *
 * Uses the same `planTemplateApplication` the planner's routines use — "apply a
 * saved set of rows without doubling it by accident" is one problem, so it has
 * one implementation and one set of tests. `auto` writes cleanly onto an empty
 * meal and otherwise reports `duplicate` so the UI can offer the choice;
 * `keep` / `replace` / `duplicate` each do exactly one thing.
 */
export async function applyMealTemplate(
  templateId: string,
  date: string,
  mealType?: MealType,
  mode: TemplateApplyMode = "auto",
): Promise<
  ActionResult<{ status: "applied" | "duplicate" | "kept"; added: number; removed: number; existing: number }>
> {
  const user = await getCurrentUser();
  const template = await prisma.mealTemplate.findFirst({
    where: { id: templateId, userId: user.id },
    include: { items: { include: { foodItem: true } } },
  });
  if (!template) return fail("Template not found");
  if (template.items.length === 0) return fail("Template is empty");

  const type = (mealType ?? template.mealType) as MealType;
  const mealId = await ensureMeal(user.id, date, type, null);

  const existing = await prisma.mealEntry.findMany({
    where: { mealId, templateId: template.id },
    select: { id: true, sourceKey: true },
  });

  const plan = planTemplateApplication({ rows: template.items, existing, mode });

  if (plan.action === "ask") {
    return succeed({ status: "duplicate", added: 0, removed: 0, existing: plan.existing });
  }
  if (plan.action === "keep") {
    return succeed({ status: "kept", added: 0, removed: 0, existing: plan.existing });
  }

  let removed = 0;
  if (plan.action === "replace" && plan.remove.length > 0) {
    const result = await prisma.mealEntry.deleteMany({ where: { id: { in: plan.remove } } });
    removed = result.count;
  }

  const maxOrder = await prisma.mealEntry.aggregate({
    where: { mealId },
    _max: { sortOrder: true },
  });
  const base = plan.action === "replace" ? 0 : (maxOrder._max.sortOrder ?? 0) + 1;

  let added = 0;
  for (const planned of plan.create) {
    const item = planned.row;
    const snapshot = nutrientSnapshotFor(toFoodLike(item.foodItem), item.quantity, item.unit);
    // A template row whose unit stopped being valid (the food was edited) is
    // skipped rather than silently logged as zero.
    if (!snapshot.convertible) continue;

    try {
      await prisma.mealEntry.create({
        data: {
          mealId,
          foodItemId: item.foodItemId,
          quantity: item.quantity,
          unit: item.unit,
          sortOrder: base + planned.index,
          templateId: template.id,
          sourceKey: templateSourceKey(plan.ordinal, planned.index),
          ...snapshotColumns(snapshot),
        },
      });
      added += 1;
    } catch (error) {
      // Last line of defence for a double-submit that raced the read above.
      if (!isUniqueViolation(error)) throw error;
    }
  }

  await prisma.mealTemplate.update({
    where: { id: template.id },
    data: { useCount: { increment: 1 }, lastUsed: new Date() },
  });

  await recomputeDay(user.id, date);
  revalidateAll();
  return succeed({ status: "applied", added, removed, existing: plan.existing });
}

export async function renameMealTemplate(id: string, name: string): Promise<ActionResult<null>> {
  const trimmed = name.trim();
  if (!trimmed) return fail("Template name is required");

  const user = await getCurrentUser();
  const result = await prisma.mealTemplate.updateMany({
    where: { id, userId: user.id },
    data: { name: trimmed.slice(0, 80) },
  });
  if (result.count === 0) return fail("Template not found");

  revalidateAll();
  return succeed(null);
}

export async function deleteMealTemplate(id: string): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  await prisma.mealTemplate.deleteMany({ where: { id, userId: user.id } });
  revalidateAll();
  return succeed(null);
}

/** Copy a whole day of meals onto another day — the fastest way to repeat. */
export async function copyDayMeals(from: string, to: string): Promise<ActionResult<{ added: number }>> {
  const user = await getCurrentUser();
  const meals = await prisma.meal.findMany({
    where: { userId: user.id, date: from },
    include: { entries: true },
  });
  if (meals.length === 0) return fail("That day has no meals to copy");

  let added = 0;
  for (const meal of meals) {
    const mealId = await ensureMeal(user.id, to, meal.type as MealType, meal.label);
    await prisma.mealEntry.createMany({
      // Copies carry the original snapshot forward. Recomputing here would let
      // an edited food rewrite what a past day recorded, which is the one thing
      // the snapshot exists to prevent.
      data: meal.entries.map((entry) => ({
        mealId,
        foodItemId: entry.foodItemId,
        quantity: entry.quantity,
        unit: entry.unit,
        calories: entry.calories,
        protein: entry.protein,
        carbs: entry.carbs,
        fat: entry.fat,
        fiber: entry.fiber,
        sugar: entry.sugar,
        sodium: entry.sodium,
        foodNameAtLog: entry.foodNameAtLog,
        basisAtLog: entry.basisAtLog,
        servingSizeAtLog: entry.servingSizeAtLog,
        servingUnitAtLog: entry.servingUnitAtLog,
        gramsAtLog: entry.gramsAtLog,
        extraNutrientsAtLog: entry.extraNutrientsAtLog,
      })),
    });
    added += meal.entries.length;
  }

  await recomputeDay(user.id, to);
  revalidateAll();
  return succeed({ added });
}
