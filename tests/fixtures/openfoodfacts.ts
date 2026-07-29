import type { OffProductRaw } from "@/lib/logic/food";

/**
 * Trimmed captures of real Open Food Facts product shapes.
 *
 * The traps these exist to pin down: OFF states sodium in **grams** where the
 * app stores milligrams, energy may arrive only as kilojoules, salt is often
 * present where sodium is not, and community records are routinely partial.
 */

/** A well-filled product with a gram serving. */
export const offNutella: OffProductRaw = {
  code: "3017620422003",
  product_name: "Nutella",
  brands: "Ferrero",
  quantity: "400 g",
  product_quantity: 400,
  serving_size: "15 g",
  serving_quantity: 15,
  categories: "Spreads,Sweet spreads",
  completeness: 0.9,
  nutriments: {
    "energy-kcal_100g": 539,
    proteins_100g: 6.3,
    carbohydrates_100g: 57.5,
    fat_100g: 30.9,
    fiber_100g: 0,
    sugars_100g: 56.3,
    // 0.0428 g per 100 g → 42.8 mg
    sodium_100g: 0.0428,
    salt_100g: 0.107,
    "saturated-fat_100g": 10.6,
    // grams → milligrams
    potassium_100g: 0.407,
    calcium_100g: 0.108,
    iron_100g: 0.0035,
  },
};

/** Kilojoules only, and salt instead of sodium. */
export const offKilojoulesOnly: OffProductRaw = {
  code: "5000159407236",
  product_name: "Oat Biscuits",
  brands: "Test Bakery",
  serving_size: "25 g",
  serving_quantity: 25,
  completeness: 0.6,
  nutriments: {
    // 2000 kJ ÷ 4.184 ≈ 478 kcal
    "energy-kj_100g": 2000,
    proteins_100g: 7,
    carbohydrates_100g: 60,
    fat_100g: 20,
    salt_100g: 1.25, // ÷ 2.5 → 0.5 g sodium → 500 mg
  },
};

/** A drink whose serving is stated in ml *and* grams — the one honest density. */
export const offDrinkWithDensity: OffProductRaw = {
  code: "5449000000996",
  product_name: "Cola",
  brands: "Test Drinks",
  serving_size: "250 ml",
  serving_quantity: 260, // 260 g per 250 ml → 1.04 g/ml
  completeness: 0.7,
  nutriments: {
    "energy-kcal_100g": 42,
    proteins_100g: 0,
    carbohydrates_100g: 10.6,
    fat_100g: 0,
    sugars_100g: 10.6,
    sodium_100g: 0.004,
  },
};

/** Name and calories only — usable, but plainly incomplete. */
export const offSparse: OffProductRaw = {
  code: "1234567890123",
  product_name: "Mystery Snack",
  completeness: 0.25,
  nutriments: { "energy-kcal_100g": 250 },
};

/** An empty stub: no nutriments at all. */
export const offEmptyStub: OffProductRaw = {
  code: "9999999999999",
  product_name: "Unknown Product",
  nutriments: {},
};

/** No name — not a result. */
export const offNameless: OffProductRaw = {
  code: "8888888888888",
  nutriments: { "energy-kcal_100g": 100 },
};

export const offSearchResponse = {
  count: 2,
  page: 1,
  products: [offNutella, offKilojoulesOnly],
};

export const offProductResponse = {
  code: "3017620422003",
  status: 1,
  product: offNutella,
};

export const offMissingProductResponse = {
  code: "0000000000000",
  status: 0,
  status_verbose: "product not found",
};
