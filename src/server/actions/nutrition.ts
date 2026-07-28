"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser, prisma } from "@/lib/db";
import { MEAL_TYPE_META, type MealType } from "@/lib/enums";
import { macrosFor } from "@/lib/logic/nutrition";
import {
  fail,
  foodItemSchema,
  fromZod,
  mealEntrySchema,
  succeed,
  updateMealEntrySchema,
  type ActionResult,
} from "@/lib/validation";
import { recomputeDay } from "@/server/summaries";

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

export async function logFood(input: unknown): Promise<ActionResult<{ mealId: string }>> {
  const parsed = mealEntrySchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const user = await getCurrentUser();
  const { date, mealType, mealLabel, foodItemId, quantity, unit } = parsed.data;

  const food = await prisma.foodItem.findFirst({
    where: { id: foodItemId, OR: [{ userId: null }, { userId: user.id }] },
  });
  if (!food) return fail("Food not found");

  const mealId = await ensureMeal(user.id, date, mealType, mealLabel);
  const macros = macrosFor(food, quantity, unit);

  const maxOrder = await prisma.mealEntry.aggregate({
    where: { mealId },
    _max: { sortOrder: true },
  });

  await prisma.mealEntry.create({
    data: {
      mealId,
      foodItemId,
      quantity,
      unit,
      sortOrder: (maxOrder._max.sortOrder ?? 0) + 1,
      ...macros,
    },
  });

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
  return succeed({ mealId });
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

  const macros = macrosFor(entry.foodItem, parsed.data.quantity, parsed.data.unit);
  await prisma.mealEntry.update({
    where: { id: entry.id },
    data: { quantity: parsed.data.quantity, unit: parsed.data.unit, ...macros },
  });

  await recomputeDay(user.id, entry.meal.date);
  revalidateAll();
  return succeed(null);
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
  const { id, ...rest } = parsed.data;
  const data = {
    ...rest,
    brand: rest.brand ?? null,
    servingLabel: rest.servingLabel ?? null,
    userId: user.id,
    isCustom: true,
    searchKey: `${rest.name} ${rest.brand ?? ""}`.toLowerCase().trim(),
  };

  const food = id
    ? await prisma.foodItem.update({ where: { id }, data })
    : await prisma.foodItem.create({ data });

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

export async function applyMealTemplate(
  templateId: string,
  date: string,
  mealType?: MealType,
): Promise<ActionResult<{ added: number }>> {
  const user = await getCurrentUser();
  const template = await prisma.mealTemplate.findFirst({
    where: { id: templateId, userId: user.id },
    include: { items: { include: { foodItem: true } } },
  });
  if (!template) return fail("Template not found");
  if (template.items.length === 0) return fail("Template is empty");

  const type = (mealType ?? template.mealType) as MealType;
  const mealId = await ensureMeal(user.id, date, type, null);

  await prisma.mealEntry.createMany({
    data: template.items.map((item, index) => ({
      mealId,
      foodItemId: item.foodItemId,
      quantity: item.quantity,
      unit: item.unit,
      sortOrder: index,
      ...macrosFor(item.foodItem, item.quantity, item.unit),
    })),
  });

  await prisma.mealTemplate.update({
    where: { id: template.id },
    data: { useCount: { increment: 1 }, lastUsed: new Date() },
  });

  await recomputeDay(user.id, date);
  revalidateAll();
  return succeed({ added: template.items.length });
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
      })),
    });
    added += meal.entries.length;
  }

  await recomputeDay(user.id, to);
  revalidateAll();
  return succeed({ added });
}
