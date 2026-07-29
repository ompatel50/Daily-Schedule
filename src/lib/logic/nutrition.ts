import { round } from "@/lib/utils";
import type { ServingUnit } from "@/lib/enums";
import type { ExtraNutrients } from "@/lib/logic/food";
import { scaleExtraNutrients } from "@/lib/logic/food";
import {
  baseAmountsFor,
  describeAmount,
  toGrams,
  type ServingCapableFood,
} from "@/lib/logic/servings";

/**
 * All nutrition math lives here so the UI, the server actions, the day score
 * and the importer agree on one definition of "how many calories is 1.5
 * servings". The unit arithmetic itself lives one level down in
 * `lib/logic/servings`; this module is what turns an amount into nutrients.
 */

export interface FoodLike extends ServingCapableFood {
  basis: string; // per_100g | per_serving | per_package | per_item
  servingSize: number;
  servingUnit: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  sugar: number;
  sodium: number;
  extraNutrients?: ExtraNutrients;
}

export interface Macros {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  sugar: number;
  sodium: number;
}

export const EMPTY_MACROS: Macros = {
  calories: 0,
  protein: 0,
  carbs: 0,
  fat: 0,
  fiber: 0,
  sugar: 0,
  sodium: 0,
};

/**
 * How many "base units" of the food does `quantity` in `unit` represent?
 *
 * A base unit is 100 g for `per_100g` foods and one portion for the others.
 * Returns 0 where the conversion is not defensible — callers that need to tell
 * "zero" apart from "cannot be converted" should use `nutrientSnapshotFor`,
 * which reports it explicitly.
 */
export function baseUnitsFor(food: FoodLike, quantity: number, unit: ServingUnit | string): number {
  return baseAmountsFor(food, quantity, unit) ?? 0;
}

/** Macros for a given quantity of a food, rounded for storage/display. */
export function macrosFor(food: FoodLike, quantity: number, unit: ServingUnit | string): Macros {
  const units = baseUnitsFor(food, quantity, unit);
  return {
    calories: round(food.calories * units, 0),
    protein: round(food.protein * units, 1),
    carbs: round(food.carbs * units, 1),
    fat: round(food.fat * units, 1),
    fiber: round(food.fiber * units, 1),
    sugar: round(food.sugar * units, 1),
    sodium: round(food.sodium * units, 0),
  };
}

/**
 * Everything a `MealEntry` freezes at log time.
 *
 * The macros alone were never quite enough: a food renamed, a serving size
 * corrected, or a provider record refreshed would leave a historical entry
 * whose numbers no longer matched anything you could reconstruct. Storing the
 * amount, the basis and the serving it was computed against means a logged day
 * stays explainable regardless of what happens to the food afterwards.
 */
export interface NutrientSnapshot {
  macros: Macros;
  extraNutrients: ExtraNutrients;
  /** Resolved grams, when the unit could be converted at all. */
  grams: number | null;
  /** False when the unit is not valid for this food; nothing should be saved. */
  convertible: boolean;
  foodName: string;
  basis: string;
  servingSize: number;
  servingUnit: string;
  description: string;
}

export function nutrientSnapshotFor(
  food: FoodLike & { name?: string },
  quantity: number,
  unit: ServingUnit | string,
): NutrientSnapshot {
  const amounts = baseAmountsFor(food, quantity, unit);
  const convertible = amounts !== null;
  const units = amounts ?? 0;

  return {
    macros: {
      calories: round(food.calories * units, 0),
      protein: round(food.protein * units, 1),
      carbs: round(food.carbs * units, 1),
      fat: round(food.fat * units, 1),
      fiber: round(food.fiber * units, 1),
      sugar: round(food.sugar * units, 1),
      sodium: round(food.sodium * units, 0),
    },
    extraNutrients: scaleExtraNutrients(food.extraNutrients ?? {}, units),
    grams: convertible ? toGrams(quantity, unit, food) : null,
    convertible,
    foodName: food.name ?? "",
    basis: food.basis,
    servingSize: food.servingSize,
    servingUnit: food.servingUnit,
    description: describeAmount(food, quantity, unit),
  };
}

export function addMacros(a: Macros, b: Partial<Macros>): Macros {
  return {
    calories: a.calories + (b.calories ?? 0),
    protein: a.protein + (b.protein ?? 0),
    carbs: a.carbs + (b.carbs ?? 0),
    fat: a.fat + (b.fat ?? 0),
    fiber: a.fiber + (b.fiber ?? 0),
    sugar: a.sugar + (b.sugar ?? 0),
    sodium: a.sodium + (b.sodium ?? 0),
  };
}

export function totalMacros(entries: Partial<Macros>[]): Macros {
  const total = entries.reduce<Macros>((acc, entry) => addMacros(acc, entry), { ...EMPTY_MACROS });
  return {
    calories: round(total.calories, 0),
    protein: round(total.protein, 1),
    carbs: round(total.carbs, 1),
    fat: round(total.fat, 1),
    fiber: round(total.fiber, 1),
    sugar: round(total.sugar, 1),
    sodium: round(total.sodium, 0),
  };
}

/** Share of calories coming from each macro (sums to ~100). */
export function macroSplit(macros: Macros): { protein: number; carbs: number; fat: number } {
  const proteinKcal = macros.protein * 4;
  const carbKcal = macros.carbs * 4;
  const fatKcal = macros.fat * 9;
  const total = proteinKcal + carbKcal + fatKcal;
  if (total <= 0) return { protein: 0, carbs: 0, fat: 0 };
  return {
    protein: Math.round((proteinKcal / total) * 100),
    carbs: Math.round((carbKcal / total) * 100),
    fat: Math.round((fatKcal / total) * 100),
  };
}

/** Label like "1 serving (150 g)" for a logged entry. */
export function describeServing(food: FoodLike, quantity: number, unit: string): string {
  return describeAmount(food, quantity, unit);
}

// --- goal estimation --------------------------------------------------------

const ACTIVITY_FACTORS: Record<string, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  athlete: 1.9,
};

/**
 * Mifflin–St Jeor BMR + activity factor. Used only to *suggest* starting goals
 * in Settings; the user's explicit goals always win.
 */
export function estimateDailyCalories(input: {
  weightKg: number;
  heightCm: number;
  age: number;
  sex?: string | null;
  activityLevel?: string | null;
}): number {
  const { weightKg, heightCm, age } = input;
  if (!weightKg || !heightCm || !age) return 2000;
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  const bmr = input.sex === "female" ? base - 161 : base + 5;
  const factor = ACTIVITY_FACTORS[input.activityLevel ?? "moderate"] ?? 1.55;
  return Math.round((bmr * factor) / 10) * 10;
}

/** Suggested macro targets from a calorie goal (30/40/30 split by default). */
export function suggestMacroGoals(calories: number): {
  protein: number;
  carbs: number;
  fat: number;
} {
  return {
    protein: Math.round((calories * 0.3) / 4),
    carbs: Math.round((calories * 0.4) / 4),
    fat: Math.round((calories * 0.3) / 9),
  };
}

export const LB_PER_KG = 2.20462;

export function kgToLb(kg: number): number {
  return kg * LB_PER_KG;
}

export function lbToKg(lb: number): number {
  return lb / LB_PER_KG;
}
