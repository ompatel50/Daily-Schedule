import { round } from "@/lib/utils";
import type { ServingUnit } from "@/lib/enums";

/**
 * All nutrition math lives here so the UI, the server actions and the importer
 * agree on one definition of "how many calories is 1.5 servings".
 */

export interface FoodLike {
  basis: string; // per_100g | per_serving
  servingSize: number;
  servingUnit: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  sugar: number;
  sodium: number;
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

const GRAMS_PER_OZ = 28.3495;

/**
 * How many "base units" of the food does `quantity` in `unit` represent?
 * A base unit is 100 g for `per_100g` foods, and one serving for `per_serving`.
 */
export function baseUnitsFor(food: FoodLike, quantity: number, unit: ServingUnit | string): number {
  const qty = Number.isFinite(quantity) ? quantity : 0;
  if (qty <= 0) return 0;

  if (food.basis === "per_serving") {
    switch (unit) {
      case "serving":
      case "piece":
        return qty;
      case "g":
      case "ml":
        // Interpret a raw weight against the serving's declared size.
        return food.servingSize > 0 ? qty / food.servingSize : 0;
      case "oz":
        return food.servingSize > 0 ? (qty * GRAMS_PER_OZ) / food.servingSize : 0;
      default:
        return qty;
    }
  }

  // per_100g
  switch (unit) {
    case "serving":
    case "piece":
      return (qty * food.servingSize) / 100;
    case "g":
    case "ml":
      return qty / 100;
    case "oz":
      return (qty * GRAMS_PER_OZ) / 100;
    default:
      return (qty * food.servingSize) / 100;
  }
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
  const qty = round(quantity, 2);
  if (unit === "serving") {
    const grams = food.basis === "per_100g" ? round(quantity * food.servingSize, 0) : null;
    const suffix = grams ? ` (${grams} ${food.servingUnit})` : "";
    return `${qty} ${qty === 1 ? "serving" : "servings"}${suffix}`;
  }
  return `${qty} ${unit}`;
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
