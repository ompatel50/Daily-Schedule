import { describe, expect, it } from "vitest";

import {
  CORE_NUTRIENTS,
  dedupeByIdentity,
  foodCompleteness,
  foodIdentity,
  normalizeOffProduct,
  normalizeUsdaFood,
  parseExtraNutrients,
  parseQuantityWithUnit,
  rankFoodResults,
  sanitizeNormalizedFood,
  scaleExtraNutrients,
  type FoodSearchResult,
  type NormalizedFood,
} from "@/lib/logic/food";
import {
  availableUnits,
  baseAmountsFor,
  canConvert,
  describeAmount,
  parseServingSpec,
  servingGrams,
  servingOptionsFor,
  toGrams,
} from "@/lib/logic/servings";
import { nutrientSnapshotFor, macrosFor, totalMacros } from "@/lib/logic/nutrition";
import { planTemplateApplication, templateSourceKey } from "@/lib/logic/planner";
import { foodItemSchema, mealEntrySchema } from "@/lib/validation";
import {
  usdaBrandedGranola,
  usdaChickenBreast,
  usdaDetailShape,
  usdaHouseholdOnly,
  usdaNameless,
  usdaNoCalories,
} from "./fixtures/usda";
import {
  offDrinkWithDensity,
  offEmptyStub,
  offKilojoulesOnly,
  offNameless,
  offNutella,
  offSparse,
} from "./fixtures/openfoodfacts";

// ---------------------------------------------------------------------------
// USDA normalisation
// ---------------------------------------------------------------------------

describe("USDA normalisation", () => {
  it("reads a generic SR Legacy ingredient per 100 g", () => {
    const food = normalizeUsdaFood(usdaChickenBreast);
    expect(food).not.toBeNull();
    expect(food).toMatchObject({
      provider: "usda",
      externalId: "171077",
      name: "Chicken, broilers or fryers, breast, meat only, raw",
      kind: "generic",
      basis: "per_100g",
      servingSize: 100,
      servingUnit: "g",
    });
    expect(food?.nutrients).toEqual({
      calories: 120,
      protein: 22.5,
      carbs: 0,
      fat: 2.62,
      fiber: 0,
      sugar: 0,
      sodium: 45,
    });
  });

  it("keeps micronutrients rather than discarding them", () => {
    const food = normalizeUsdaFood(usdaChickenBreast);
    expect(food?.extraNutrients).toMatchObject({
      saturatedFat: 0.56,
      cholesterol: 73,
      potassium: 334,
      calcium: 5,
      iron: 0.37,
    });
  });

  it("classifies a Branded record as branded and keeps its barcode", () => {
    const food = normalizeUsdaFood(usdaBrandedGranola);
    expect(food?.kind).toBe("branded");
    expect(food?.brand).toBe("Nature Valley");
    expect(food?.barcode).toBe("0016000275287");
  });

  it("turns a gram label serving into a serving option without changing the basis", () => {
    const food = normalizeUsdaFood(usdaBrandedGranola);
    // The nutrients are still per 100 g; the 49 g serving is an option.
    expect(food?.basis).toBe("per_100g");
    expect(food?.servingSize).toBe(49);
    expect(food?.servingLabel).toBe("2 bars (49 g)");
    expect(food?.servingOptions).toContainEqual(
      expect.objectContaining({ id: "serving", unit: "serving", grams: 49 }),
    );
  });

  it("treats a household measure with no weight as a label, not a conversion", () => {
    const food = normalizeUsdaFood(usdaHouseholdOnly);
    expect(food?.servingLabel).toBe("1 bowl");
    // Nothing claims to know what a bowl weighs.
    expect(food?.servingOptions).toEqual([]);
  });

  it("reads the detail endpoint's nested nutrient shape", () => {
    const food = normalizeUsdaFood(usdaDetailShape);
    expect(food?.nutrients.calories).toBe(143);
    expect(food?.nutrients.protein).toBe(12.6);
  });

  it("never invents a density", () => {
    expect(normalizeUsdaFood(usdaChickenBreast)?.gramsPerMl).toBeNull();
  });

  it("drops records with no calories or no name", () => {
    expect(normalizeUsdaFood(usdaNoCalories)).toBeNull();
    expect(normalizeUsdaFood(usdaNameless)).toBeNull();
    expect(normalizeUsdaFood(null)).toBeNull();
    expect(normalizeUsdaFood(undefined)).toBeNull();
  });

  it("reports completeness from what was actually supplied", () => {
    expect(normalizeUsdaFood(usdaChickenBreast)?.completeness).toBe(1);
    // Energy + protein of seven.
    expect(normalizeUsdaFood(usdaHouseholdOnly)?.completeness).toBeCloseTo(2 / 7, 2);
  });
});

// ---------------------------------------------------------------------------
// Open Food Facts normalisation
// ---------------------------------------------------------------------------

describe("Open Food Facts normalisation", () => {
  it("reads a well-filled branded product", () => {
    const food = normalizeOffProduct(offNutella);
    expect(food).toMatchObject({
      provider: "off",
      externalId: "3017620422003",
      barcode: "3017620422003",
      name: "Nutella",
      brand: "Ferrero",
      kind: "branded",
      basis: "per_100g",
      source: "Open Food Facts",
    });
    expect(food?.nutrients.calories).toBe(539);
    expect(food?.nutrients.protein).toBe(6.3);
  });

  it("converts sodium from grams to milligrams", () => {
    // 0.0428 g per 100 g is 42.8 mg — storing 0.0428 would be off by 1000×.
    expect(normalizeOffProduct(offNutella)?.nutrients.sodium).toBeCloseTo(42.8, 1);
  });

  it("converts micronutrients from grams to milligrams", () => {
    const food = normalizeOffProduct(offNutella);
    expect(food?.extraNutrients.potassium).toBeCloseTo(407, 0);
    expect(food?.extraNutrients.calcium).toBeCloseTo(108, 0);
    expect(food?.extraNutrients.iron).toBeCloseTo(3.5, 1);
  });

  it("falls back to kilojoules when kcal is absent", () => {
    const food = normalizeOffProduct(offKilojoulesOnly);
    expect(food?.nutrients.calories).toBeCloseTo(478, 0);
  });

  it("derives sodium from salt when sodium is missing", () => {
    // 1.25 g salt ÷ 2.5 = 0.5 g sodium = 500 mg.
    expect(normalizeOffProduct(offKilojoulesOnly)?.nutrients.sodium).toBeCloseTo(500, 0);
  });

  it("derives a density only when the serving is given in both ml and grams", () => {
    const drink = normalizeOffProduct(offDrinkWithDensity);
    expect(drink?.gramsPerMl).toBeCloseTo(1.04, 2);
    // Nutella's serving is grams only — no volume information at all.
    expect(normalizeOffProduct(offNutella)?.gramsPerMl).toBeNull();
  });

  it("offers the package as an option when the pack weight is known", () => {
    const food = normalizeOffProduct(offNutella);
    expect(food?.servingOptions).toContainEqual(
      expect.objectContaining({ id: "package", unit: "package", grams: 400 }),
    );
  });

  it("keeps a sparse record but marks it incomplete", () => {
    const food = normalizeOffProduct(offSparse);
    expect(food).not.toBeNull();
    expect(food?.completeness).toBeLessThan(0.3);
  });

  it("drops a record with no calories or no name", () => {
    expect(normalizeOffProduct(offEmptyStub)).toBeNull();
    expect(normalizeOffProduct(offNameless)).toBeNull();
  });

  it("never reports a missing nutrient as a zero it measured", () => {
    const food = normalizeOffProduct(offSparse);
    // The column defaults to 0 because the schema needs a number, but
    // completeness is what tells the UI it was never published.
    expect(food?.completeness).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// Servings and conversion
// ---------------------------------------------------------------------------

const per100g: NormalizedFood = sanitizeNormalizedFood({
  provider: "local",
  externalId: null,
  name: "Rolled oats",
  description: null,
  brand: null,
  barcode: null,
  kind: "generic",
  source: null,
  basis: "per_100g",
  servingSize: 40,
  servingUnit: "g",
  servingLabel: "1 serving (40 g)",
  servingOptions: [],
  gramsPerMl: null,
  nutrients: { calories: 380, protein: 13, carbs: 67, fat: 7, fiber: 10, sugar: 1, sodium: 5 },
  extraNutrients: { saturatedFat: 1.2 },
  category: "grain",
  isCustom: false,
  cached: false,
  isFavorite: false,
  completeness: 1,
  retrievedAt: null,
  refreshedAt: null,
});

const perServing: NormalizedFood = sanitizeNormalizedFood({
  ...per100g,
  name: "Protein bar",
  basis: "per_serving",
  servingSize: 60,
  servingUnit: "g",
  servingLabel: "1 bar (60 g)",
  nutrients: { calories: 220, protein: 20, carbs: 22, fat: 7, fiber: 5, sugar: 2, sodium: 150 },
});

const opaquePortion: NormalizedFood = sanitizeNormalizedFood({
  ...per100g,
  name: "Chef's salad",
  basis: "per_serving",
  servingSize: 1,
  servingUnit: "piece",
  servingLabel: "1 salad",
  nutrients: { calories: 450, protein: 25, carbs: 20, fat: 30, fiber: 6, sugar: 5, sodium: 700 },
});

const liquidWithDensity: NormalizedFood = sanitizeNormalizedFood({
  ...per100g,
  name: "Whole milk",
  basis: "per_100g",
  servingSize: 244,
  servingUnit: "g",
  gramsPerMl: 1.03,
  nutrients: { calories: 61, protein: 3.2, carbs: 4.8, fat: 3.3, fiber: 0, sugar: 5, sodium: 43 },
});

describe("serving conversion", () => {
  it("computes per-100-gram amounts from grams", () => {
    expect(baseAmountsFor(per100g, 250, "g")).toBeCloseTo(2.5, 5);
    expect(baseAmountsFor(per100g, 100, "g")).toBeCloseTo(1, 5);
  });

  it("resolves a serving through the food's own serving weight", () => {
    // 2 servings of 40 g = 80 g = 0.8 × 100 g.
    expect(baseAmountsFor(per100g, 2, "serving")).toBeCloseTo(0.8, 5);
  });

  it("converts between mass units exactly", () => {
    expect(toGrams(1, "kg", per100g)).toBeCloseTo(1000, 5);
    expect(toGrams(1, "oz", per100g)).toBeCloseTo(28.349523125, 6);
    expect(toGrams(1, "lb", per100g)).toBeCloseTo(453.59237, 5);
    expect(baseAmountsFor(per100g, 1, "oz")).toBeCloseTo(0.28349523125, 6);
  });

  it("treats the basis's own unit as a pass-through for a per-serving food", () => {
    expect(baseAmountsFor(perServing, 3, "serving")).toBe(3);
    expect(baseAmountsFor(perServing, 1.5, "serving")).toBe(1.5);
  });

  it("resolves grams against a per-serving food's serving weight", () => {
    // 120 g of a 60 g bar is two bars.
    expect(baseAmountsFor(perServing, 120, "g")).toBeCloseTo(2, 5);
  });

  it("keeps a portion with no known weight loggable in its own unit", () => {
    expect(servingGrams(opaquePortion)).toBeNull();
    expect(baseAmountsFor(opaquePortion, 2, "serving")).toBe(2);
    expect(baseAmountsFor(opaquePortion, 1, "piece")).toBe(1);
    // …but not in grams, because nobody knows what it weighs.
    expect(baseAmountsFor(opaquePortion, 200, "g")).toBeNull();
    expect(canConvert("g", opaquePortion)).toBe(false);
  });

  it("refuses volume-to-weight without a food-specific density", () => {
    expect(toGrams(250, "ml", per100g)).toBeNull();
    expect(toGrams(1, "cup", per100g)).toBeNull();
    expect(toGrams(1, "tbsp", per100g)).toBeNull();
    expect(baseAmountsFor(per100g, 250, "ml")).toBeNull();
    expect(canConvert("ml", per100g)).toBe(false);
    expect(canConvert("cup", per100g)).toBe(false);
  });

  it("allows volume once a density is actually known", () => {
    expect(toGrams(100, "ml", liquidWithDensity)).toBeCloseTo(103, 5);
    // 1 US cup = 240 ml × 1.03 = 247.2 g
    expect(toGrams(1, "cup", liquidWithDensity)).toBeCloseTo(247.2, 3);
    expect(baseAmountsFor(liquidWithDensity, 1, "cup")).toBeCloseTo(2.472, 3);
    expect(canConvert("ml", liquidWithDensity)).toBe(true);
  });

  it("does not assume water — a density of 1 is never the fallback", () => {
    // If it silently assumed 1 g/ml, 250 ml would be 2.5 base units.
    expect(baseAmountsFor(per100g, 250, "ml")).not.toBe(2.5);
    expect(baseAmountsFor(per100g, 250, "ml")).toBeNull();
  });

  it("always offers grams for a food that can be weighed", () => {
    expect(availableUnits(per100g)).toContain("g");
    expect(availableUnits(perServing)).toContain("g");
    expect(servingOptionsFor(per100g).map((option) => option.unit)).toContain("g");
  });

  it("does not offer grams for a portion with no declared weight", () => {
    // "1 bowl" of soup: loggable as a portion, but nobody knows what it weighs,
    // so offering grams would be a unit the Log button then refuses.
    expect(canConvert("g", opaquePortion)).toBe(false);
    const units = servingOptionsFor(opaquePortion).map((option) => option.unit);
    expect(units).not.toContain("g");
    expect(units).not.toContain("oz");
    // It is still loggable in its own unit.
    expect(units).toContain("serving");
  });

  it("only ever offers units it can actually convert", () => {
    for (const food of [per100g, perServing, opaquePortion, liquidWithDensity]) {
      for (const option of servingOptionsFor(food)) {
        expect(canConvert(option.unit, food), `${food.name} / ${option.unit}`).toBe(true);
      }
    }
  });

  it("offers volume options only for a food with a density", () => {
    expect(servingOptionsFor(per100g).map((option) => option.unit)).not.toContain("cup");
    expect(servingOptionsFor(liquidWithDensity).map((option) => option.unit)).toContain("cup");
  });

  it("returns zero, not null, for a non-positive quantity", () => {
    expect(baseAmountsFor(per100g, 0, "g")).toBe(0);
    expect(baseAmountsFor(per100g, -5, "g")).toBe(0);
  });

  it("rejects a unit it does not know", () => {
    expect(baseAmountsFor(per100g, 1, "handful")).toBeNull();
    expect(canConvert("handful", per100g)).toBe(false);
  });

  it("describes an amount with its gram weight when that is known", () => {
    expect(describeAmount(per100g, 2, "serving")).toBe("2 servings (80 g)");
    expect(describeAmount(per100g, 150, "g")).toBe("150 g");
    // No weight to add for an opaque portion.
    expect(describeAmount(opaquePortion, 1, "serving")).toBe("1 serving");
  });

  it("parses a stored serving spec defensively", () => {
    expect(parseServingSpec(null)).toEqual({ options: [], gramsPerMl: null });
    expect(parseServingSpec("not json")).toEqual({ options: [], gramsPerMl: null });
    expect(parseServingSpec('{"options":[{"id":"x","unit":"nope","quantity":1}]}').options).toEqual([]);
    expect(parseServingSpec('{"gramsPerMl":-3}').gramsPerMl).toBeNull();
  });

  it("parses quantities with units out of free text", () => {
    expect(parseQuantityWithUnit("15 g")).toEqual({ quantity: 15, unit: "g" });
    expect(parseQuantityWithUnit("250ml")).toEqual({ quantity: 250, unit: "ml" });
    expect(parseQuantityWithUnit("1,5 g")).toEqual({ quantity: 1.5, unit: "g" });
    expect(parseQuantityWithUnit("about a handful")).toBeNull();
    expect(parseQuantityWithUnit(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Nutrient maths and snapshots
// ---------------------------------------------------------------------------

describe("nutrient calculation", () => {
  it("scales per-100-gram nutrients by weight", () => {
    const snapshot = nutrientSnapshotFor({ ...per100g, ...per100g.nutrients }, 250, "g");
    expect(snapshot.convertible).toBe(true);
    expect(snapshot.macros.calories).toBe(950); // 380 × 2.5
    expect(snapshot.macros.protein).toBeCloseTo(32.5, 1);
    expect(snapshot.grams).toBe(250);
  });

  it("scales per-serving nutrients by servings", () => {
    const snapshot = nutrientSnapshotFor({ ...perServing, ...perServing.nutrients }, 2, "serving");
    expect(snapshot.macros.calories).toBe(440);
    expect(snapshot.macros.protein).toBeCloseTo(40, 1);
  });

  it("scales the micronutrients alongside the macros", () => {
    const snapshot = nutrientSnapshotFor({ ...per100g, ...per100g.nutrients }, 200, "g");
    expect(snapshot.extraNutrients.saturatedFat).toBeCloseTo(2.4, 3);
  });

  it("reports a unit it cannot convert instead of returning zeroes", () => {
    const snapshot = nutrientSnapshotFor({ ...per100g, ...per100g.nutrients }, 250, "ml");
    expect(snapshot.convertible).toBe(false);
    expect(snapshot.grams).toBeNull();
  });

  it("recomputes cleanly when the quantity is edited", () => {
    const food = { ...per100g, ...per100g.nutrients };
    const before = nutrientSnapshotFor(food, 100, "g");
    const after = nutrientSnapshotFor(food, 150, "g");
    expect(before.macros.calories).toBe(380);
    expect(after.macros.calories).toBe(570);
    expect(after.macros.calories / before.macros.calories).toBeCloseTo(1.5, 2);
  });

  it("recomputes cleanly when the serving unit is changed", () => {
    const food = { ...per100g, ...per100g.nutrients };
    // 1 serving is 40 g, so switching 1 serving → 40 g must not move the number.
    expect(nutrientSnapshotFor(food, 1, "serving").macros.calories).toBe(
      nutrientSnapshotFor(food, 40, "g").macros.calories,
    );
  });

  it("freezes the food's name, basis and serving in the snapshot", () => {
    const snapshot = nutrientSnapshotFor({ ...per100g, ...per100g.nutrients }, 40, "g");
    expect(snapshot.foodName).toBe("Rolled oats");
    expect(snapshot.basis).toBe("per_100g");
    expect(snapshot.servingSize).toBe(40);
    expect(snapshot.servingUnit).toBe("g");
  });

  it("keeps a historical snapshot stable when the food is later corrected", () => {
    const food = { ...per100g, ...per100g.nutrients };
    const logged = nutrientSnapshotFor(food, 100, "g");

    // The provider refreshes and the calories change.
    const corrected = { ...food, calories: 500, name: "Rolled oats (organic)" };
    const recomputed = nutrientSnapshotFor(corrected, 100, "g");

    // The already-taken snapshot is a value, not a view: it does not move.
    expect(logged.macros.calories).toBe(380);
    expect(recomputed.macros.calories).toBe(500);
    expect(logged.foodName).toBe("Rolled oats");
  });

  it("keeps macrosFor backwards compatible with the pre-Phase-9 behaviour", () => {
    expect(macrosFor({ ...per100g, ...per100g.nutrients }, 1, "serving").calories).toBe(152);
    expect(totalMacros([{ calories: 100, protein: 5 }, { calories: 50, protein: 2.5 }])).toMatchObject({
      calories: 150,
      protein: 7.5,
    });
  });
});

// ---------------------------------------------------------------------------
// Completeness, identity, ranking
// ---------------------------------------------------------------------------

describe("completeness and identity", () => {
  it("scores completeness over the core nutrient set", () => {
    expect(foodCompleteness({}, new Set(CORE_NUTRIENTS))).toBe(1);
    expect(foodCompleteness({}, new Set(["calories"]))).toBeCloseTo(1 / 7, 2);
    expect(foodCompleteness({}, new Set())).toBe(0);
  });

  it("identifies a food by provider and external id, never by name", () => {
    const usda = { provider: "usda" as const, externalId: "1", id: "a" };
    const off = { provider: "off" as const, externalId: "1", id: "b" };
    expect(foodIdentity(usda)).toBe("usda:1");
    expect(foodIdentity(off)).toBe("off:1");
    // Same external id, different provider — different foods.
    expect(foodIdentity(usda)).not.toBe(foodIdentity(off));
  });

  it("does not merge two foods that merely share a name", () => {
    const a = { ...per100g, name: "Chicken breast", provider: "usda" as const, externalId: "111" };
    const b = { ...per100g, name: "Chicken breast", provider: "off" as const, externalId: "222" };
    expect(dedupeByIdentity([a, b])).toHaveLength(2);
  });

  it("collapses genuine repeats of the same provider record", () => {
    const a = { ...per100g, provider: "usda" as const, externalId: "111" };
    expect(dedupeByIdentity([a, { ...a }])).toHaveLength(1);
  });

  it("keeps local foods distinct even with no external id", () => {
    const a = { ...per100g, id: "a", provider: "local" as const, externalId: null };
    const b = { ...per100g, id: "b", provider: "local" as const, externalId: null };
    expect(dedupeByIdentity([a, b])).toHaveLength(2);
  });
});

function result(overrides: Partial<FoodSearchResult> & { name: string }): FoodSearchResult {
  return {
    ...per100g,
    origin: "local",
    isRecent: false,
    isFavorite: false,
    ...overrides,
  } as FoodSearchResult;
}

describe("result ranking", () => {
  it("puts an exact favourite or recent match first", () => {
    const ranked = rankFoodResults("oats", [
      result({ name: "Oats and honey granola", kind: "branded", provider: "off" }),
      result({ name: "Oats", kind: "generic", provider: "usda" }),
      result({ name: "Oats", isFavorite: true, provider: "local" }),
    ]);
    expect(ranked[0].isFavorite).toBe(true);
  });

  it("prefers an exact local or cached match over a fresh provider hit", () => {
    const ranked = rankFoodResults("oats", [
      result({ name: "Oats", provider: "usda", kind: "generic" }),
      result({ name: "Oats", provider: "off", cached: true }),
    ]);
    expect(ranked[0].cached).toBe(true);
  });

  it("prefers generic ingredients over branded products", () => {
    const ranked = rankFoodResults("chicken breast", [
      result({ name: "Chicken Breast Fillets", kind: "branded", provider: "off" }),
      result({ name: "Chicken breast", kind: "generic", provider: "usda" }),
    ]);
    expect(ranked[0].kind).toBe("generic");
  });

  it("ranks a related generic above a partial branded match", () => {
    const ranked = rankFoodResults("rice", [
      result({ name: "Uncle's Rice Pudding Cups", kind: "branded", provider: "off" }),
      result({ name: "Rice, white, long-grain", kind: "generic", provider: "usda" }),
    ]);
    expect(ranked[0].name).toContain("Rice, white");
  });

  it("breaks ties towards the shorter, more basic name", () => {
    const ranked = rankFoodResults("egg", [
      result({ name: "Egg salad sandwich", kind: "generic" }),
      result({ name: "Egg", kind: "generic" }),
    ]);
    expect(ranked[0].name).toBe("Egg");
  });

  it("is stable for results it cannot otherwise separate", () => {
    const input = [result({ name: "Aaa food" }), result({ name: "Bbb food" })];
    expect(rankFoodResults("zzz", input).map((food) => food.name)).toEqual(["Aaa food", "Bbb food"]);
  });
});

// ---------------------------------------------------------------------------
// Sanitising untrusted provider payloads
// ---------------------------------------------------------------------------

describe("sanitising provider payloads", () => {
  it("clamps absurd and negative nutrients before anything is persisted", () => {
    const clean = sanitizeNormalizedFood({
      ...per100g,
      nutrients: {
        calories: 9_999_999,
        protein: -12,
        carbs: Number.NaN,
        fat: 5,
        fiber: 0,
        sugar: 0,
        sodium: 0,
      },
    });
    expect(clean.nutrients.calories).toBe(10000);
    expect(clean.nutrients.protein).toBe(0);
    expect(clean.nutrients.carbs).toBe(0);
    expect(clean.nutrients.fat).toBe(5);
  });

  it("strips a hostile barcode down to safe characters", () => {
    // Angle brackets and slashes go; the digits and letters that survive are
    // inert, and the value is only ever rendered as text.
    const clean = sanitizeNormalizedFood({ ...per100g, barcode: "12<script>34" });
    expect(clean.barcode).toBe("12script34");
    expect(clean.barcode).not.toContain("<");
    expect(clean.barcode).not.toContain(">");
  });

  it("treats an unusable barcode as absent rather than empty", () => {
    expect(sanitizeNormalizedFood({ ...per100g, barcode: "<<>>" }).barcode).toBeNull();
  });

  it("rejects a nonsensical density", () => {
    expect(sanitizeNormalizedFood({ ...per100g, gramsPerMl: -1 }).gramsPerMl).toBeNull();
    expect(sanitizeNormalizedFood({ ...per100g, gramsPerMl: 0 }).gramsPerMl).toBeNull();
    expect(sanitizeNormalizedFood({ ...per100g, gramsPerMl: 500 }).gramsPerMl).toBe(10);
  });

  it("falls back to a sane serving when the provider gives a broken one", () => {
    expect(sanitizeNormalizedFood({ ...per100g, servingSize: 0 }).servingSize).toBe(100);
    expect(sanitizeNormalizedFood({ ...per100g, servingSize: Number.NaN }).servingSize).toBe(100);
  });

  it("round-trips extra nutrients through storage, dropping bad values", () => {
    expect(parseExtraNutrients(JSON.stringify({ potassium: 300, bogus: 5, iron: -2 }))).toEqual({
      potassium: 300,
    });
    expect(parseExtraNutrients("nonsense")).toEqual({});
    expect(parseExtraNutrients(null)).toEqual({});
  });

  it("scales extra nutrients without introducing floating-point noise", () => {
    expect(scaleExtraNutrients({ potassium: 300 }, 0.5)).toEqual({ potassium: 150 });
  });
});

// ---------------------------------------------------------------------------
// Custom foods
// ---------------------------------------------------------------------------

describe("custom food validation", () => {
  const valid = {
    name: "Mum's granola",
    brand: null,
    basis: "per_100g" as const,
    servingSize: 45,
    servingUnit: "g",
    calories: 450,
    protein: 10,
    carbs: 60,
    fat: 18,
    fiber: 6,
    sugar: 12,
    sodium: 80,
    category: "grain" as const,
  };

  it("accepts a complete custom food", () => {
    expect(foodItemSchema.safeParse(valid).success).toBe(true);
  });

  it("requires a name", () => {
    expect(foodItemSchema.safeParse({ ...valid, name: "   " }).success).toBe(false);
  });

  it("requires a positive serving size", () => {
    expect(foodItemSchema.safeParse({ ...valid, servingSize: 0 }).success).toBe(false);
    expect(foodItemSchema.safeParse({ ...valid, servingSize: -10 }).success).toBe(false);
  });

  it("rejects negative nutrients", () => {
    expect(foodItemSchema.safeParse({ ...valid, protein: -1 }).success).toBe(false);
    expect(foodItemSchema.safeParse({ ...valid, calories: -1 }).success).toBe(false);
  });

  it("rejects values that are not real numbers", () => {
    expect(foodItemSchema.safeParse({ ...valid, calories: Number.NaN }).success).toBe(false);
    expect(foodItemSchema.safeParse({ ...valid, calories: Infinity }).success).toBe(false);
  });

  it("accepts optional micronutrients and a favourite flag", () => {
    const parsed = foodItemSchema.safeParse({
      ...valid,
      extraNutrients: { potassium: 300, calcium: 90 },
      favorite: true,
    });
    expect(parsed.success).toBe(true);
  });

  it("supports every nutrient basis", () => {
    for (const basis of ["per_100g", "per_serving", "per_package", "per_item"] as const) {
      expect(foodItemSchema.safeParse({ ...valid, basis }).success).toBe(true);
    }
  });
});

describe("logging validation", () => {
  const base = {
    date: "2026-07-28",
    mealType: "breakfast" as const,
    quantity: 1,
    unit: "serving" as const,
  };

  it("accepts an internal food id", () => {
    expect(mealEntrySchema.safeParse({ ...base, foodItemId: "abc" }).success).toBe(true);
  });

  it("accepts a provider result that has no internal id yet", () => {
    expect(
      mealEntrySchema.safeParse({ ...base, provider: "usda", externalId: "171077" }).success,
    ).toBe(true);
  });

  it("rejects a non-positive quantity", () => {
    expect(mealEntrySchema.safeParse({ ...base, foodItemId: "a", quantity: 0 }).success).toBe(false);
    expect(mealEntrySchema.safeParse({ ...base, foodItemId: "a", quantity: -2 }).success).toBe(false);
  });

  it("accepts an idempotency key and rejects a stub one", () => {
    expect(
      mealEntrySchema.safeParse({ ...base, foodItemId: "a", idempotencyKey: "a".repeat(16) }).success,
    ).toBe(true);
    expect(mealEntrySchema.safeParse({ ...base, foodItemId: "a", idempotencyKey: "x" }).success).toBe(
      false,
    );
  });

  it("accepts every unit the serving engine knows", () => {
    for (const unit of ["g", "kg", "oz", "lb", "ml", "cup", "piece", "slice", "package"] as const) {
      expect(mealEntrySchema.safeParse({ ...base, foodItemId: "a", unit }).success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Meal templates — the same identity logic the planner's routines use
// ---------------------------------------------------------------------------

interface MealRow {
  foodItemId: string;
  quantity: number;
  unit: string;
}

const mealRows: MealRow[] = [
  { foodItemId: "oats", quantity: 60, unit: "g" },
  { foodItemId: "milk", quantity: 200, unit: "g" },
  { foodItemId: "banana", quantity: 1, unit: "serving" },
];

describe("meal template application", () => {
  it("writes every row onto an empty meal", () => {
    const plan = planTemplateApplication<MealRow>({ rows: mealRows, existing: [] });
    expect(plan.action).toBe("create");
    expect(plan.ordinal).toBe(1);
    expect(plan.create).toHaveLength(3);
    expect(plan.create.map((row) => row.sourceKey)).toEqual(["1:0", "1:1", "1:2"]);
  });

  it("writes nothing and asks when the template is already on the meal", () => {
    const existing = [
      { id: "a", sourceKey: "1:0" },
      { id: "b", sourceKey: "1:1" },
      { id: "c", sourceKey: "1:2" },
    ];
    const plan = planTemplateApplication<MealRow>({ rows: mealRows, existing });
    expect(plan.action).toBe("ask");
    expect(plan.create).toHaveLength(0);
    expect(plan.existing).toBe(3);
  });

  it("keeps what is there when the user says keep", () => {
    const plan = planTemplateApplication<MealRow>({
      rows: mealRows,
      existing: [{ id: "a", sourceKey: "1:0" }],
      mode: "keep",
    });
    expect(plan.action).toBe("keep");
    expect(plan.create).toHaveLength(0);
    expect(plan.remove).toHaveLength(0);
  });

  it("replaces by removing the old rows and re-keying from one", () => {
    const plan = planTemplateApplication<MealRow>({
      rows: mealRows,
      existing: [
        { id: "a", sourceKey: "1:0" },
        { id: "b", sourceKey: "1:1" },
      ],
      mode: "replace",
    });
    expect(plan.action).toBe("replace");
    expect(plan.remove).toEqual(["a", "b"]);
    expect(plan.create.map((row) => row.sourceKey)).toEqual(["1:0", "1:1", "1:2"]);
  });

  it("lets a deliberate second copy through on the next ordinal", () => {
    const plan = planTemplateApplication<MealRow>({
      rows: mealRows,
      existing: [
        { id: "a", sourceKey: "1:0" },
        { id: "b", sourceKey: "1:1" },
        { id: "c", sourceKey: "1:2" },
      ],
      mode: "duplicate",
    });
    expect(plan.action).toBe("create");
    expect(plan.ordinal).toBe(2);
    expect(plan.create.map((row) => row.sourceKey)).toEqual(["2:0", "2:1", "2:2"]);
  });

  it("never re-uses a key a deliberate copy already took", () => {
    const first = planTemplateApplication<MealRow>({ rows: mealRows, existing: [] });
    const existing = first.create.map((row, index) => ({ id: `x${index}`, sourceKey: row.sourceKey }));
    const second = planTemplateApplication<MealRow>({ rows: mealRows, existing, mode: "duplicate" });
    const keys = new Set([...existing.map((row) => row.sourceKey), ...second.create.map((row) => row.sourceKey)]);
    expect(keys.size).toBe(6);
  });

  it("keys rows the same way the planner does", () => {
    expect(templateSourceKey(1, 0)).toBe("1:0");
    expect(templateSourceKey(3, 12)).toBe("3:12");
  });

  it("carries the row payload through untouched, whatever its shape", () => {
    const plan = planTemplateApplication<MealRow>({ rows: mealRows, existing: [] });
    expect(plan.create[0].row).toEqual({ foodItemId: "oats", quantity: 60, unit: "g" });
  });
});
