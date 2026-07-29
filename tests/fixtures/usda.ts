import type { UsdaFoodRaw } from "@/lib/logic/food";

/**
 * Trimmed captures of real USDA FoodData Central shapes.
 *
 * Nutrient ids and the two different row shapes (`nutrientId` on search hits,
 * a nested `nutrient` object on detail records) are reproduced exactly, because
 * those are the details a normaliser gets wrong. Values are per 100 g, which is
 * what FDC publishes for every data type.
 */

/** A Foundation/SR Legacy record — a generic ingredient. */
export const usdaChickenBreast: UsdaFoodRaw = {
  fdcId: 171077,
  description: "Chicken, broilers or fryers, breast, meat only, raw",
  dataType: "SR Legacy",
  foodCategory: "Poultry Products",
  foodNutrients: [
    { nutrientId: 1008, nutrientName: "Energy", unitName: "KCAL", value: 120 },
    { nutrientId: 1003, nutrientName: "Protein", unitName: "G", value: 22.5 },
    { nutrientId: 1005, nutrientName: "Carbohydrate, by difference", unitName: "G", value: 0 },
    { nutrientId: 1004, nutrientName: "Total lipid (fat)", unitName: "G", value: 2.62 },
    { nutrientId: 1079, nutrientName: "Fiber, total dietary", unitName: "G", value: 0 },
    { nutrientId: 2000, nutrientName: "Sugars, total", unitName: "G", value: 0 },
    { nutrientId: 1093, nutrientName: "Sodium, Na", unitName: "MG", value: 45 },
    { nutrientId: 1258, nutrientName: "Fatty acids, total saturated", unitName: "G", value: 0.56 },
    { nutrientId: 1253, nutrientName: "Cholesterol", unitName: "MG", value: 73 },
    { nutrientId: 1092, nutrientName: "Potassium, K", unitName: "MG", value: 334 },
    { nutrientId: 1087, nutrientName: "Calcium, Ca", unitName: "MG", value: 5 },
    { nutrientId: 1089, nutrientName: "Iron, Fe", unitName: "MG", value: 0.37 },
  ],
};

/** A Branded record — has a label serving and a GTIN. */
export const usdaBrandedGranola: UsdaFoodRaw = {
  fdcId: 2094832,
  description: "OATS & HONEY GRANOLA",
  dataType: "Branded",
  brandOwner: "Nature Valley",
  brandName: "Nature Valley",
  gtinUpc: "0016000275287",
  servingSize: 49,
  servingSizeUnit: "g",
  householdServingFullText: "2 bars",
  foodNutrients: [
    { nutrientId: 1008, value: 449 },
    { nutrientId: 1003, value: 8.16 },
    { nutrientId: 1005, value: 69.4 },
    { nutrientId: 1004, value: 14.3 },
    { nutrientId: 1079, value: 6.12 },
    { nutrientId: 2000, value: 24.5 },
    { nutrientId: 1093, value: 388 },
  ],
};

/** A detail-endpoint record: the nutrient id is nested and the value is `amount`. */
export const usdaDetailShape: UsdaFoodRaw = {
  fdcId: 169097,
  description: "Egg, whole, raw, fresh",
  dataType: "Foundation",
  foodNutrients: [
    { nutrient: { id: 1008, name: "Energy", unitName: "kcal" }, amount: 143 },
    { nutrient: { id: 1003, name: "Protein", unitName: "g" }, amount: 12.6 },
    { nutrient: { id: 1005, name: "Carbohydrate", unitName: "g" }, amount: 0.72 },
    { nutrient: { id: 1004, name: "Total lipid (fat)", unitName: "g" }, amount: 9.51 },
  ],
};

/** A household serving with no gram weight — a label, never a conversion. */
export const usdaHouseholdOnly: UsdaFoodRaw = {
  fdcId: 999001,
  description: "Soup, homestyle",
  dataType: "Survey (FNDDS)",
  householdServingFullText: "1 bowl",
  foodNutrients: [
    { nutrientId: 1008, value: 60 },
    { nutrientId: 1003, value: 2 },
  ],
};

/** Missing energy — not a usable search result. */
export const usdaNoCalories: UsdaFoodRaw = {
  fdcId: 999002,
  description: "Water, tap",
  dataType: "SR Legacy",
  foodNutrients: [{ nutrientId: 1093, value: 4 }],
};

/** Missing a description — cannot be named, so not a result either. */
export const usdaNameless: UsdaFoodRaw = {
  fdcId: 999003,
  dataType: "SR Legacy",
  foodNutrients: [{ nutrientId: 1008, value: 100 }],
};

export const usdaSearchResponse = {
  totalHits: 2,
  foods: [usdaChickenBreast, usdaBrandedGranola],
};
