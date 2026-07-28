"use server";

import type { FoodOption } from "@/components/nutrition/food-search";
import { searchFoods } from "@/server/queries";

/** Search action used by the client-side food picker. */
export async function searchFoodsAction(query: string): Promise<FoodOption[]> {
  const foods = await searchFoods(query, 25);
  return foods.map((food) => ({
    id: food.id,
    name: food.name,
    brand: food.brand,
    basis: food.basis,
    servingSize: food.servingSize,
    servingUnit: food.servingUnit,
    servingLabel: food.servingLabel,
    calories: food.calories,
    protein: food.protein,
    carbs: food.carbs,
    fat: food.fat,
    fiber: food.fiber,
    sugar: food.sugar,
    sodium: food.sodium,
    category: food.category,
    isCustom: food.isCustom,
  }));
}
