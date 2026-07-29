/**
 * The internal food record, and the translation into it from each provider.
 *
 * Everything above this layer — the search UI, the log dialog, the meal
 * aggregation — speaks `NormalizedFood` only. Provider response shapes stop
 * here, so adding a third source later is a new normaliser rather than a change
 * to every component that renders a calorie.
 *
 * Pure and dependency-free on purpose: these are the functions most worth
 * testing, and they must be testable without a network or a database.
 */

import type { NutrientBasis, ServingOption } from "@/lib/logic/servings";
import { isNutrientBasis, isServingUnit } from "@/lib/logic/servings";

// ---------------------------------------------------------------------------
// Nutrients
// ---------------------------------------------------------------------------

/** The seven the app has always stored as columns and always displays. */
export const CORE_NUTRIENTS = [
  "calories",
  "protein",
  "carbs",
  "fat",
  "fiber",
  "sugar",
  "sodium",
] as const;
export type CoreNutrient = (typeof CORE_NUTRIENTS)[number];

export type CoreNutrients = Record<CoreNutrient, number>;

/**
 * Everything else a provider happened to supply. Kept rather than discarded:
 * the provider will not always be reachable later, and a micronutrient that was
 * free to store is expensive to re-fetch.
 */
export const EXTRA_NUTRIENTS = [
  "saturatedFat",
  "transFat",
  "monounsaturatedFat",
  "polyunsaturatedFat",
  "cholesterol",
  "potassium",
  "calcium",
  "iron",
  "magnesium",
  "zinc",
  "vitaminA",
  "vitaminC",
  "vitaminD",
  "vitaminE",
  "vitaminK",
  "vitaminB6",
  "vitaminB12",
  "folate",
  "caffeine",
  "alcohol",
] as const;
export type ExtraNutrient = (typeof EXTRA_NUTRIENTS)[number];

export type ExtraNutrients = Partial<Record<ExtraNutrient, number>>;

export const NUTRIENT_UNITS: Record<CoreNutrient | ExtraNutrient, string> = {
  calories: "kcal",
  protein: "g",
  carbs: "g",
  fat: "g",
  fiber: "g",
  sugar: "g",
  sodium: "mg",
  saturatedFat: "g",
  transFat: "g",
  monounsaturatedFat: "g",
  polyunsaturatedFat: "g",
  cholesterol: "mg",
  potassium: "mg",
  calcium: "mg",
  iron: "mg",
  magnesium: "mg",
  zinc: "mg",
  vitaminA: "µg",
  vitaminC: "mg",
  vitaminD: "µg",
  vitaminE: "mg",
  vitaminK: "µg",
  vitaminB6: "mg",
  vitaminB12: "µg",
  folate: "µg",
  caffeine: "mg",
  alcohol: "g",
};

export const NUTRIENT_LABELS: Partial<Record<CoreNutrient | ExtraNutrient, string>> = {
  saturatedFat: "Saturated fat",
  transFat: "Trans fat",
  monounsaturatedFat: "Monounsaturated fat",
  polyunsaturatedFat: "Polyunsaturated fat",
  cholesterol: "Cholesterol",
  potassium: "Potassium",
  calcium: "Calcium",
  iron: "Iron",
  magnesium: "Magnesium",
  zinc: "Zinc",
  vitaminA: "Vitamin A",
  vitaminC: "Vitamin C",
  vitaminD: "Vitamin D",
  vitaminE: "Vitamin E",
  vitaminK: "Vitamin K",
  vitaminB6: "Vitamin B6",
  vitaminB12: "Vitamin B12",
  folate: "Folate",
  caffeine: "Caffeine",
  alcohol: "Alcohol",
};

export const EMPTY_CORE_NUTRIENTS: CoreNutrients = {
  calories: 0,
  protein: 0,
  carbs: 0,
  fat: 0,
  fiber: 0,
  sugar: 0,
  sodium: 0,
};

// ---------------------------------------------------------------------------
// The normalised record
// ---------------------------------------------------------------------------

export const FOOD_PROVIDERS = ["local", "custom", "usda", "off"] as const;
export type FoodProviderId = (typeof FOOD_PROVIDERS)[number];

export const PROVIDER_LABELS: Record<FoodProviderId, string> = {
  local: "Bundled",
  custom: "Your food",
  usda: "USDA FoodData Central",
  off: "Open Food Facts",
};

/** Short label for a result row, where space is tight. */
export const PROVIDER_SHORT_LABELS: Record<FoodProviderId, string> = {
  local: "Bundled",
  custom: "Custom",
  usda: "USDA",
  off: "Open Food Facts",
};

export type FoodKind = "generic" | "branded";

export interface NormalizedFood {
  /** Internal id. Absent until the food has been persisted. */
  id?: string;
  provider: FoodProviderId;
  /** The provider's own id. Null for bundled and user-created foods. */
  externalId: string | null;

  name: string;
  description: string | null;
  brand: string | null;
  barcode: string | null;
  kind: FoodKind;
  /** Human-readable attribution, e.g. "USDA FoodData Central · SR Legacy". */
  source: string | null;

  basis: NutrientBasis;
  servingSize: number;
  servingUnit: string;
  servingLabel: string | null;
  servingOptions: ServingOption[];
  gramsPerMl: number | null;

  nutrients: CoreNutrients;
  extraNutrients: ExtraNutrients;

  category: string;
  isCustom: boolean;
  cached: boolean;
  isFavorite: boolean;
  /** 0–1. How much of the core nutrient set the provider actually supplied. */
  completeness: number;

  retrievedAt: string | null;
  refreshedAt: string | null;
}

/**
 * A result row as the search UI consumes it — a normalised food plus why it is
 * in the list. No provider-specific shape ever reaches a component.
 */
export interface FoodSearchResult extends NormalizedFood {
  /** Which bucket surfaced it: local, favourite, recent, cache or a provider. */
  origin: "local" | "favorite" | "recent" | "cache" | "usda" | "off";
  isRecent: boolean;
}

// ---------------------------------------------------------------------------
// Completeness
// ---------------------------------------------------------------------------

/**
 * How much of the core nutrient set is actually present.
 *
 * Community data is frequently partial, and a missing value is not a zero. This
 * drives a "partial data" badge rather than silently presenting 0 g of protein
 * as a fact.
 */
export function foodCompleteness(
  nutrients: Partial<CoreNutrients>,
  supplied?: ReadonlySet<string>,
): number {
  const known = CORE_NUTRIENTS.filter((key) => {
    if (supplied) return supplied.has(key);
    const value = nutrients[key];
    return typeof value === "number" && Number.isFinite(value);
  });
  return Math.round((known.length / CORE_NUTRIENTS.length) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Small parsing helpers
// ---------------------------------------------------------------------------

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function nonNegative(value: unknown): number | null {
  const parsed = num(value);
  if (parsed === null) return null;
  // A negative nutrient is bad data, not a small number.
  return parsed < 0 ? null : parsed;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** "15 g", "1 cup (240 ml)", "30g" → { quantity, unit }. */
export function parseQuantityWithUnit(
  value: string | null | undefined,
): { quantity: number; unit: string } | null {
  if (!value) return null;
  const match = /(-?\d+(?:[.,]\d+)?)\s*([a-zA-Zµ]+)/.exec(value);
  if (!match) return null;
  const quantity = Number(match[1].replace(",", "."));
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  const unit = match[2].toLowerCase();
  const normalised = unit === "gr" || unit === "grams" || unit === "gram" ? "g" : unit;
  return isServingUnit(normalised) ? { quantity, unit: normalised } : null;
}

// ---------------------------------------------------------------------------
// USDA FoodData Central
// ---------------------------------------------------------------------------

/**
 * FDC nutrient ids for everything we keep. Search results and the detail
 * endpoint disagree about where the id lives, so `usdaNutrientValue` looks in
 * both places rather than the caller caring which endpoint produced the row.
 */
const USDA_NUTRIENT_IDS: Record<CoreNutrient | ExtraNutrient, number[]> = {
  calories: [1008, 2047, 2048],
  protein: [1003],
  carbs: [1005],
  fat: [1004],
  fiber: [1079],
  sugar: [2000, 1063],
  sodium: [1093],
  saturatedFat: [1258],
  transFat: [1257],
  monounsaturatedFat: [1292],
  polyunsaturatedFat: [1293],
  cholesterol: [1253],
  potassium: [1092],
  calcium: [1087],
  iron: [1089],
  magnesium: [1090],
  zinc: [1095],
  vitaminA: [1106],
  vitaminC: [1162],
  vitaminD: [1114],
  vitaminE: [1109],
  vitaminK: [1185],
  vitaminB6: [1175],
  vitaminB12: [1178],
  folate: [1177],
  caffeine: [1057],
  alcohol: [1018],
};

interface UsdaNutrientRow {
  nutrientId?: number;
  nutrientName?: string;
  unitName?: string;
  value?: number;
  amount?: number;
  nutrient?: { id?: number; name?: string; unitName?: string };
}

export interface UsdaFoodRaw {
  fdcId?: number | string;
  description?: string;
  dataType?: string;
  brandOwner?: string;
  brandName?: string;
  gtinUpc?: string;
  ingredients?: string;
  servingSize?: number;
  servingSizeUnit?: string;
  householdServingFullText?: string;
  foodCategory?: string | { description?: string };
  foodNutrients?: UsdaNutrientRow[];
}

function usdaNutrientValue(rows: UsdaNutrientRow[], ids: number[]): number | null {
  for (const id of ids) {
    const row = rows.find((candidate) => (candidate.nutrientId ?? candidate.nutrient?.id) === id);
    if (!row) continue;
    const value = nonNegative(row.value ?? row.amount);
    if (value !== null) return value;
  }
  return null;
}

/** USDA data types that describe an ingredient rather than a retail product. */
const USDA_GENERIC_TYPES = new Set(["Foundation", "SR Legacy", "Survey (FNDDS)", "Experimental"]);

/**
 * A USDA search hit or detail record → the internal shape.
 *
 * FDC states `foodNutrients` per 100 g for every data type, so the basis is
 * always `per_100g`; the label serving, when present, becomes a serving option
 * rather than changing what the numbers mean.
 *
 * Returns `null` for a record with no name or no calories — a food we cannot
 * name or count is not a search result, it is noise.
 */
export function normalizeUsdaFood(raw: UsdaFoodRaw | null | undefined): NormalizedFood | null {
  if (!raw) return null;

  const name = text(raw.description);
  const externalId = raw.fdcId === undefined || raw.fdcId === null ? null : String(raw.fdcId);
  if (!name || !externalId) return null;

  const rows = Array.isArray(raw.foodNutrients) ? raw.foodNutrients : [];
  const supplied = new Set<string>();
  const nutrients: CoreNutrients = { ...EMPTY_CORE_NUTRIENTS };

  for (const key of CORE_NUTRIENTS) {
    const value = usdaNutrientValue(rows, USDA_NUTRIENT_IDS[key]);
    if (value !== null) {
      nutrients[key] = value;
      supplied.add(key);
    }
  }
  if (!supplied.has("calories")) return null;

  const extraNutrients: ExtraNutrients = {};
  for (const key of EXTRA_NUTRIENTS) {
    const value = usdaNutrientValue(rows, USDA_NUTRIENT_IDS[key]);
    if (value !== null) extraNutrients[key] = value;
  }

  const dataType = text(raw.dataType);
  const kind: FoodKind = dataType && !USDA_GENERIC_TYPES.has(dataType) ? "branded" : "generic";
  const brand = text(raw.brandName) ?? text(raw.brandOwner);

  // The label serving becomes an option; it never redefines the basis.
  const servingOptions: ServingOption[] = [];
  const servingSize = nonNegative(raw.servingSize);
  const servingUnitRaw = text(raw.servingSizeUnit)?.toLowerCase() ?? null;
  const servingUnit =
    servingUnitRaw === "gram" || servingUnitRaw === "grm" || servingUnitRaw === "g" ? "g" : servingUnitRaw;
  const household = text(raw.householdServingFullText);

  let defaultServingSize = 100;
  let defaultServingUnit = "g";
  let servingLabel: string | null = null;

  if (servingSize && servingSize > 0 && servingUnit === "g") {
    defaultServingSize = servingSize;
    defaultServingUnit = "g";
    servingLabel = household ? `${household} (${Math.round(servingSize)} g)` : `${Math.round(servingSize)} g`;
    servingOptions.push({
      id: "serving",
      label: servingLabel,
      unit: "serving",
      quantity: 1,
      grams: servingSize,
    });
  } else if (household) {
    // A household measure with no gram weight is a label, not a conversion.
    servingLabel = household;
  }

  const category =
    typeof raw.foodCategory === "string"
      ? text(raw.foodCategory)
      : text(raw.foodCategory?.description);

  return {
    provider: "usda",
    externalId,
    name,
    description: category,
    brand,
    barcode: text(raw.gtinUpc),
    kind,
    source: dataType ? `USDA FoodData Central · ${dataType}` : "USDA FoodData Central",
    basis: "per_100g",
    servingSize: defaultServingSize,
    servingUnit: defaultServingUnit,
    servingLabel,
    servingOptions,
    // FDC does not publish densities. Volume stays unconvertible.
    gramsPerMl: null,
    nutrients,
    extraNutrients,
    category: "other",
    isCustom: false,
    cached: false,
    isFavorite: false,
    completeness: foodCompleteness(nutrients, supplied),
    retrievedAt: null,
    refreshedAt: null,
  };
}

// ---------------------------------------------------------------------------
// Open Food Facts
// ---------------------------------------------------------------------------

export interface OffProductRaw {
  code?: string | number;
  product_name?: string;
  product_name_en?: string;
  generic_name?: string;
  brands?: string;
  quantity?: string;
  product_quantity?: number | string;
  serving_size?: string;
  serving_quantity?: number | string;
  categories?: string;
  completeness?: number;
  nutriments?: Record<string, unknown>;
}

/** OFF keys are per 100 g and suffixed `_100g`. Sodium and salt are in grams. */
const OFF_CORE_KEYS: Record<CoreNutrient, string[]> = {
  calories: ["energy-kcal_100g"],
  protein: ["proteins_100g"],
  carbs: ["carbohydrates_100g"],
  fat: ["fat_100g"],
  fiber: ["fiber_100g"],
  sugar: ["sugars_100g"],
  sodium: ["sodium_100g"],
};

const OFF_EXTRA_KEYS: Partial<Record<ExtraNutrient, { keys: string[]; scale?: number }>> = {
  saturatedFat: { keys: ["saturated-fat_100g"] },
  transFat: { keys: ["trans-fat_100g"] },
  monounsaturatedFat: { keys: ["monounsaturated-fat_100g"] },
  polyunsaturatedFat: { keys: ["polyunsaturated-fat_100g"] },
  // OFF reports these in grams; the app stores milligrams.
  cholesterol: { keys: ["cholesterol_100g"], scale: 1000 },
  potassium: { keys: ["potassium_100g"], scale: 1000 },
  calcium: { keys: ["calcium_100g"], scale: 1000 },
  iron: { keys: ["iron_100g"], scale: 1000 },
  magnesium: { keys: ["magnesium_100g"], scale: 1000 },
  zinc: { keys: ["zinc_100g"], scale: 1000 },
  vitaminA: { keys: ["vitamin-a_100g"], scale: 1_000_000 },
  vitaminC: { keys: ["vitamin-c_100g"], scale: 1000 },
  vitaminD: { keys: ["vitamin-d_100g"], scale: 1_000_000 },
  vitaminE: { keys: ["vitamin-e_100g"], scale: 1000 },
  vitaminK: { keys: ["vitamin-k_100g"], scale: 1_000_000 },
  vitaminB6: { keys: ["vitamin-b6_100g"], scale: 1000 },
  vitaminB12: { keys: ["vitamin-b12_100g"], scale: 1_000_000 },
  folate: { keys: ["folates_100g", "vitamin-b9_100g"], scale: 1_000_000 },
  caffeine: { keys: ["caffeine_100g"], scale: 1000 },
  alcohol: { keys: ["alcohol_100g"] },
};

const KJ_PER_KCAL = 4.184;

function offValue(nutriments: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = nonNegative(nutriments[key]);
    if (value !== null) return value;
  }
  return null;
}

/**
 * An Open Food Facts product → the internal shape.
 *
 * Community data, so incompleteness is the norm rather than the exception: a
 * product with a name and calories is usable and the rest is recorded as
 * missing. `completeness` carries that forward to a badge.
 *
 * Two unit traps handled here: OFF states sodium in **grams** where the app
 * stores milligrams, and a product may carry only kilojoules.
 */
export function normalizeOffProduct(raw: OffProductRaw | null | undefined): NormalizedFood | null {
  if (!raw) return null;

  const name = text(raw.product_name) ?? text(raw.product_name_en) ?? text(raw.generic_name);
  const code = raw.code === undefined || raw.code === null ? null : String(raw.code).trim();
  if (!name || !code) return null;

  const nutriments = (raw.nutriments ?? {}) as Record<string, unknown>;
  const supplied = new Set<string>();
  const nutrients: CoreNutrients = { ...EMPTY_CORE_NUTRIENTS };

  for (const key of CORE_NUTRIENTS) {
    let value = offValue(nutriments, OFF_CORE_KEYS[key]);

    if (key === "calories" && value === null) {
      // Fall back to kilojoules rather than dropping an otherwise usable product.
      const kj = offValue(nutriments, ["energy-kj_100g", "energy_100g"]);
      if (kj !== null) value = Math.round((kj / KJ_PER_KCAL) * 10) / 10;
    }
    if (key === "sodium" && value !== null) {
      value = value * 1000; // g → mg
    }
    if (key === "sodium" && value === null) {
      // OFF often carries salt but not sodium. Salt ÷ 2.5 is the standard
      // conversion the project's own label maths already assumes.
      const salt = offValue(nutriments, ["salt_100g"]);
      if (salt !== null) value = (salt / 2.5) * 1000;
    }

    if (value !== null) {
      nutrients[key] = Math.round(value * 1000) / 1000;
      supplied.add(key);
    }
  }
  if (!supplied.has("calories")) return null;

  const extraNutrients: ExtraNutrients = {};
  for (const key of EXTRA_NUTRIENTS) {
    const spec = OFF_EXTRA_KEYS[key];
    if (!spec) continue;
    const value = offValue(nutriments, spec.keys);
    if (value !== null) extraNutrients[key] = Math.round(value * (spec.scale ?? 1) * 1000) / 1000;
  }

  // Serving and package sizes, but only where they are weights we can trust.
  const servingOptions: ServingOption[] = [];
  let servingSize = 100;
  let servingUnit = "g";
  let servingLabel: string | null = null;
  let gramsPerMl: number | null = null;

  const servingQuantity = nonNegative(raw.serving_quantity);
  const parsedServing = parseQuantityWithUnit(text(raw.serving_size));

  if (servingQuantity && servingQuantity > 0) {
    // `serving_quantity` is documented as grams.
    servingSize = servingQuantity;
    servingUnit = "g";
    servingLabel = text(raw.serving_size) ?? `${Math.round(servingQuantity)} g`;
    servingOptions.push({
      id: "serving",
      label: servingLabel,
      unit: "serving",
      quantity: 1,
      grams: servingQuantity,
    });

    // A serving stated in both ml and grams is the one place OFF hands us a
    // real, food-specific density. Anything less and volume stays unconvertible.
    if (parsedServing && parsedServing.unit === "ml" && parsedServing.quantity > 0) {
      gramsPerMl = Math.round((servingQuantity / parsedServing.quantity) * 1000) / 1000;
    }
  } else if (parsedServing && parsedServing.unit === "g") {
    servingSize = parsedServing.quantity;
    servingUnit = "g";
    servingLabel = text(raw.serving_size);
    servingOptions.push({
      id: "serving",
      label: servingLabel ?? `${parsedServing.quantity} g`,
      unit: "serving",
      quantity: 1,
      grams: parsedServing.quantity,
    });
  } else if (text(raw.serving_size)) {
    servingLabel = text(raw.serving_size);
  }

  const packageGrams = nonNegative(raw.product_quantity);
  if (packageGrams && packageGrams > 0) {
    servingOptions.push({
      id: "package",
      label: text(raw.quantity) ?? `1 package (${Math.round(packageGrams)} g)`,
      unit: "package",
      quantity: 1,
      grams: packageGrams,
    });
  }

  const declaredCompleteness = num(raw.completeness);

  return {
    provider: "off",
    externalId: code,
    name,
    description: text(raw.generic_name) === name ? null : text(raw.generic_name),
    brand: text(raw.brands),
    barcode: code,
    // Open Food Facts is a database of retail products by definition.
    kind: "branded",
    source: "Open Food Facts",
    basis: "per_100g",
    servingSize,
    servingUnit,
    servingLabel,
    servingOptions,
    gramsPerMl,
    nutrients,
    extraNutrients,
    category: "other",
    isCustom: false,
    cached: false,
    isFavorite: false,
    // Our own measure of the fields we need beats OFF's editorial score, but
    // when OFF says a record is thin we take the lower of the two.
    completeness:
      declaredCompleteness !== null
        ? Math.min(foodCompleteness(nutrients, supplied), Math.max(0, Math.min(1, declaredCompleteness)))
        : foodCompleteness(nutrients, supplied),
    retrievedAt: null,
    refreshedAt: null,
  };
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

function normalizeForMatch(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Rank search results the way someone typing "chicken breast" expects:
 * things they already use, then exact generic ingredients, then related
 * generics, then brands, then anything that merely contains the words.
 */
export function rankFoodResults<T extends FoodSearchResult>(query: string, results: T[]): T[] {
  const term = normalizeForMatch(query);

  const tierOf = (food: T): number => {
    const name = normalizeForMatch(food.name);
    const exact = name === term;
    const starts = name.startsWith(term);
    const known = food.isFavorite || food.isRecent;
    const localish = food.provider === "local" || food.provider === "custom" || food.cached;

    if (exact && known) return 0;
    if (exact && localish) return 1;
    if (exact && food.kind === "generic") return 2;
    if (known) return 3;
    if (starts && food.kind === "generic") return 4;
    if (food.kind === "generic") return 5;
    if (exact || starts) return 6;
    return 7;
  };

  return results
    .map((food, index) => ({ food, index, tier: tierOf(food) }))
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      // A shorter name is usually the more basic food: "Egg" over "Egg salad".
      const lengthDelta = a.food.name.length - b.food.name.length;
      if (lengthDelta !== 0) return lengthDelta;
      // Stable for everything else, so provider order is preserved.
      return a.index - b.index;
    })
    .map((entry) => entry.food);
}

/**
 * Two results are the same food only when the provider *and* the provider's id
 * agree. Similar names are not evidence: "Chicken breast, raw" from USDA and a
 * supermarket's "Chicken Breast" are different records with different numbers.
 */
export function foodIdentity(food: Pick<NormalizedFood, "provider" | "externalId" | "id">): string {
  if (food.externalId) return `${food.provider}:${food.externalId}`;
  return `${food.provider}:internal:${food.id ?? ""}`;
}

export function dedupeByIdentity<T extends NormalizedFood>(foods: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const food of foods) {
    const key = foodIdentity(food);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(food);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

export function parseExtraNutrients(json: string | null | undefined): ExtraNutrients {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const out: ExtraNutrients = {};
    for (const key of EXTRA_NUTRIENTS) {
      const value = parsed[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function scaleExtraNutrients(extras: ExtraNutrients, factor: number): ExtraNutrients {
  const out: ExtraNutrients = {};
  for (const [key, value] of Object.entries(extras)) {
    if (typeof value !== "number") continue;
    out[key as ExtraNutrient] = Math.round(value * factor * 1000) / 1000;
  }
  return out;
}

/** Provider payloads are untrusted input; clamp before anything is persisted. */
export function sanitizeNormalizedFood(food: NormalizedFood): NormalizedFood {
  const clampNutrient = (value: number, max: number): number => {
    if (!Number.isFinite(value) || value < 0) return 0;
    return Math.min(value, max);
  };

  const nutrients: CoreNutrients = {
    calories: clampNutrient(food.nutrients.calories, 10000),
    protein: clampNutrient(food.nutrients.protein, 1000),
    carbs: clampNutrient(food.nutrients.carbs, 1000),
    fat: clampNutrient(food.nutrients.fat, 1000),
    fiber: clampNutrient(food.nutrients.fiber, 1000),
    sugar: clampNutrient(food.nutrients.sugar, 1000),
    sodium: clampNutrient(food.nutrients.sodium, 500000),
  };

  const extraNutrients: ExtraNutrients = {};
  for (const key of EXTRA_NUTRIENTS) {
    const value = food.extraNutrients[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      extraNutrients[key] = Math.min(value, 1_000_000);
    }
  }

  const servingSize =
    Number.isFinite(food.servingSize) && food.servingSize > 0 ? Math.min(food.servingSize, 100000) : 100;

  return {
    ...food,
    name: food.name.slice(0, 200),
    description: food.description?.slice(0, 400) ?? null,
    brand: food.brand?.slice(0, 160) ?? null,
    barcode: food.barcode?.replace(/[^\dA-Za-z-]/g, "").slice(0, 40) || null,
    source: food.source?.slice(0, 160) ?? null,
    basis: isNutrientBasis(food.basis) ? food.basis : "per_100g",
    servingSize,
    servingUnit: isServingUnit(food.servingUnit) ? food.servingUnit : "g",
    servingLabel: food.servingLabel?.slice(0, 120) ?? null,
    servingOptions: food.servingOptions
      .filter((option) => isServingUnit(option.unit) && option.quantity > 0)
      .slice(0, 12),
    gramsPerMl:
      food.gramsPerMl && Number.isFinite(food.gramsPerMl) && food.gramsPerMl > 0
        ? Math.min(food.gramsPerMl, 10)
        : null,
    nutrients,
    extraNutrients,
    completeness: Math.max(0, Math.min(1, food.completeness)),
  };
}
