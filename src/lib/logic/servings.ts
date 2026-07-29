/**
 * Units, serving options and the conversions between them.
 *
 * The rule this module exists to enforce: **a conversion happens only when it
 * is mathematically valid.** Grams to ounces is arithmetic. Millilitres to
 * grams is not — it needs a density, and "a cup of flour" and "a cup of honey"
 * differ by more than a factor of two. Where the density is unknown this
 * returns `null` rather than quietly assuming water, and the caller is expected
 * to stop offering that unit rather than log a number nobody can defend.
 *
 * Grams are always available as a fallback, because a scale is the one input
 * that never needs a food-specific constant.
 */

export const MASS_UNITS = ["g", "kg", "oz", "lb"] as const;
export const VOLUME_UNITS = ["ml", "l", "cup", "tbsp", "tsp"] as const;
export const COUNT_UNITS = ["piece", "slice"] as const;
export const PORTION_UNITS = ["serving", "package"] as const;

export const ALL_SERVING_UNITS = [
  ...MASS_UNITS,
  ...VOLUME_UNITS,
  ...COUNT_UNITS,
  ...PORTION_UNITS,
] as const;

export type AnyServingUnit = (typeof ALL_SERVING_UNITS)[number];
export type UnitDimension = "mass" | "volume" | "count" | "portion";

export interface UnitMeta {
  label: string;
  plural: string;
  dimension: UnitDimension;
  /** Grams per unit — mass units only, and exact. */
  grams?: number;
  /** Millilitres per unit — volume units only. US customary for the spoons. */
  millilitres?: number;
}

export const UNIT_META: Record<AnyServingUnit, UnitMeta> = {
  g: { label: "g", plural: "g", dimension: "mass", grams: 1 },
  kg: { label: "kg", plural: "kg", dimension: "mass", grams: 1000 },
  oz: { label: "oz", plural: "oz", dimension: "mass", grams: 28.349523125 },
  lb: { label: "lb", plural: "lb", dimension: "mass", grams: 453.59237 },

  ml: { label: "ml", plural: "ml", dimension: "volume", millilitres: 1 },
  l: { label: "l", plural: "l", dimension: "volume", millilitres: 1000 },
  cup: { label: "cup", plural: "cups", dimension: "volume", millilitres: 240 },
  tbsp: { label: "tbsp", plural: "tbsp", dimension: "volume", millilitres: 14.7867648 },
  tsp: { label: "tsp", plural: "tsp", dimension: "volume", millilitres: 4.9289216 },

  piece: { label: "piece", plural: "pieces", dimension: "count" },
  slice: { label: "slice", plural: "slices", dimension: "count" },

  serving: { label: "serving", plural: "servings", dimension: "portion" },
  package: { label: "package", plural: "packages", dimension: "portion" },
};

export function isServingUnit(value: string): value is AnyServingUnit {
  return (ALL_SERVING_UNITS as readonly string[]).includes(value);
}

export function dimensionOf(unit: string): UnitDimension | null {
  return isServingUnit(unit) ? UNIT_META[unit].dimension : null;
}

// ---------------------------------------------------------------------------
// The nutrient basis
// ---------------------------------------------------------------------------

export const NUTRIENT_BASES = ["per_100g", "per_serving", "per_package", "per_item"] as const;
export type NutrientBasis = (typeof NUTRIENT_BASES)[number];

export const BASIS_LABELS: Record<NutrientBasis, string> = {
  per_100g: "per 100 g",
  per_serving: "per serving",
  per_package: "per package",
  per_item: "per item",
};

export function isNutrientBasis(value: string): value is NutrientBasis {
  return (NUTRIENT_BASES as readonly string[]).includes(value);
}

/** The unit that *is* one base amount, for a basis that counts portions. */
const BASIS_NATIVE_UNIT: Partial<Record<NutrientBasis, AnyServingUnit>> = {
  per_serving: "serving",
  per_package: "package",
  per_item: "piece",
};

// ---------------------------------------------------------------------------
// Serving options
// ---------------------------------------------------------------------------

export interface ServingOption {
  /** Stable id used as the select value. */
  id: string;
  label: string;
  unit: AnyServingUnit;
  /** How many `unit` this option represents (1 cup, 30 g, …). */
  quantity: number;
  /** Resolved grams, when they are actually known. Null is not "zero". */
  grams: number | null;
}

/**
 * Everything about a food that affects a conversion. Deliberately structural,
 * so both a Prisma row and a freshly normalised provider result satisfy it.
 */
export interface ServingCapableFood {
  basis: string;
  /** Magnitude of one serving, expressed in `servingUnit`. */
  servingSize: number;
  servingUnit: string;
  servingLabel?: string | null;
  /**
   * Food-specific density. Only ever set when a provider supplied enough to
   * derive it; never guessed, and never defaulted to 1.
   */
  gramsPerMl?: number | null;
  /** Extra options a provider declared (household measures, package size). */
  servingOptions?: ServingOption[] | null;
}

/** Parsed shape of the `FoodItem.servingOptions` JSON column. */
export interface ServingSpec {
  options: ServingOption[];
  gramsPerMl: number | null;
}

export function parseServingSpec(json: string | null | undefined): ServingSpec {
  if (!json) return { options: [], gramsPerMl: null };
  try {
    const parsed = JSON.parse(json) as Partial<ServingSpec>;
    const options = Array.isArray(parsed.options) ? parsed.options : [];
    return {
      options: options.filter(
        (option): option is ServingOption =>
          Boolean(option) &&
          typeof option.id === "string" &&
          typeof option.quantity === "number" &&
          isServingUnit(String(option.unit)),
      ),
      gramsPerMl:
        typeof parsed.gramsPerMl === "number" && parsed.gramsPerMl > 0 ? parsed.gramsPerMl : null,
    };
  } catch {
    return { options: [], gramsPerMl: null };
  }
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/**
 * How many grams is one serving / package / item of this food?
 * `null` when the food's serving cannot honestly be weighed.
 *
 * Note the project's existing convention, which this preserves: for a
 * `per_100g` food `servingSize` is already stored **in grams** and
 * `servingUnit` is only a display label ("240", "ml"). For a portion-based
 * food the pair genuinely describes the portion, so a volume there needs a
 * density like anything else.
 */
export function servingGrams(food: ServingCapableFood): number | null {
  const size = Number(food.servingSize);
  if (!Number.isFinite(size) || size <= 0) return null;

  const basis = isNutrientBasis(food.basis) ? food.basis : "per_100g";
  if (basis === "per_100g") return size;

  const unit = food.servingUnit;
  if (!isServingUnit(unit)) return null;

  const meta = UNIT_META[unit];
  if (meta.dimension === "mass" && meta.grams) return size * meta.grams;

  if (meta.dimension === "volume" && meta.millilitres) {
    const density = food.gramsPerMl;
    // No density means no honest answer. A serving declared in ml stays in ml.
    if (!density || density <= 0) return null;
    return size * meta.millilitres * density;
  }

  // A serving declared in "pieces" tells us how many pieces, not their weight.
  return null;
}

/**
 * Convert `quantity` of `unit` into grams for this food, or `null` when the
 * conversion would require a constant we do not have.
 *
 * Mass to mass is arithmetic. Volume to mass is not: it needs a food-specific
 * density, and without one this returns `null` rather than assuming water.
 * Portion and count units resolve through the food's own serving weight.
 */
export function toGrams(quantity: number, unit: string, food: ServingCapableFood): number | null {
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;
  if (!isServingUnit(unit)) return null;

  const meta = UNIT_META[unit];

  if (meta.dimension === "mass" && meta.grams) return quantity * meta.grams;

  if (meta.dimension === "volume" && meta.millilitres) {
    const density = food.gramsPerMl;
    if (!density || density <= 0) return null;
    return quantity * meta.millilitres * density;
  }

  // A piece or a slice is one portion of the food — the same amount a
  // "serving" means. It is an assumption, but a bounded one: it never crosses
  // a dimension, and it degrades to null when the portion has no weight.
  const perServing = servingGrams(food);
  if (perServing === null) return null;
  return quantity * perServing;
}

/** Can this food be logged in this unit at all? */
export function canConvert(unit: string, food: ServingCapableFood): boolean {
  if (!isServingUnit(unit)) return false;
  return baseAmountsFor(food, 1, unit) !== null;
}

/** Units that are safe to offer for this food, grams always among them. */
export function availableUnits(food: ServingCapableFood): AnyServingUnit[] {
  return ALL_SERVING_UNITS.filter((unit) => canConvert(unit, food));
}

/**
 * How many "base amounts" does `quantity` of `unit` represent?
 *
 * A base amount is whatever the nutrients are stated per: 100 g, one serving,
 * one package, one item. `null` means the conversion is not defensible, and the
 * caller must not invent a number — the UI stops offering the unit and the
 * server action refuses it.
 */
export function baseAmountsFor(
  food: ServingCapableFood,
  quantity: number,
  unit: string,
): number | null {
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;
  if (!isServingUnit(unit)) return null;

  const basis = isNutrientBasis(food.basis) ? food.basis : "per_100g";
  const native = BASIS_NATIVE_UNIT[basis];
  const meta = UNIT_META[unit];

  // Asking in the basis's own unit is a pass-through — no constant required,
  // which is why a "1 bowl" prepared meal stays loggable with no known weight.
  if (native && unit === native) return quantity;
  if (basis !== "per_100g" && meta.dimension === "portion" && unit === "serving") {
    return quantity;
  }

  // Counting is not converting: when the food's own portion is itself counted
  // in pieces or slices, asking for pieces stays within the same dimension and
  // needs no weight. "2 slices of a 1-slice portion" is simply two portions.
  if (basis !== "per_100g" && meta.dimension === "count") {
    const portionUnit = isServingUnit(food.servingUnit) ? UNIT_META[food.servingUnit] : null;
    if (portionUnit?.dimension === "count" && food.servingSize > 0) {
      return quantity / food.servingSize;
    }
  }

  const grams = toGrams(quantity, unit, food);
  if (grams === null) return null;

  if (basis === "per_100g") return grams / 100;

  const perBase = servingGrams(food);
  if (perBase === null || perBase <= 0) return null;
  return grams / perBase;
}

/** A readable description of what was logged: "1.5 servings (45 g)". */
export function describeAmount(
  food: ServingCapableFood,
  quantity: number,
  unit: string,
): string {
  const qty = Math.round(quantity * 100) / 100;
  const meta = isServingUnit(unit) ? UNIT_META[unit] : null;
  const name = meta ? (qty === 1 ? meta.label : meta.plural) : unit;
  const spaced = meta && (meta.dimension === "portion" || meta.dimension === "count");
  const head = spaced ? `${qty} ${name}` : `${qty} ${name}`;

  const grams = toGrams(quantity, unit, food);
  if (grams === null || unit === "g") return head;
  const rounded = Math.round(grams);
  if (rounded <= 0) return head;
  return `${head} (${rounded} g)`;
}

/**
 * The serving options to offer in the log dialog, most useful first.
 * Always ends with grams, which never needs a food-specific constant.
 */
export function servingOptionsFor(food: ServingCapableFood): ServingOption[] {
  const options: ServingOption[] = [];
  const seen = new Set<string>();
  const push = (option: ServingOption) => {
    if (seen.has(option.id)) return;
    seen.add(option.id);
    options.push(option);
  };

  const basis = isNutrientBasis(food.basis) ? food.basis : "per_100g";
  const perServing = servingGrams(food);

  // 1. The food's own serving, when it has a meaningful one.
  if (basis !== "per_100g" || (food.servingSize > 0 && food.servingUnit !== "g")) {
    const native = BASIS_NATIVE_UNIT[basis] ?? "serving";
    push({
      id: native,
      label: food.servingLabel?.trim() || defaultServingLabel(food, native, perServing),
      unit: native,
      quantity: 1,
      grams: perServing,
    });
  }

  // 2. Whatever the provider declared, but only where it is usable.
  for (const option of food.servingOptions ?? []) {
    if (!isServingUnit(option.unit)) continue;
    if (option.grams === null && !canConvert(option.unit, food)) continue;
    push(option);
  }

  // 2b. Weight — available for anything whose base amount can be weighed, which
  // is every food except a portion with no declared size ("1 bowl" of soup).
  // Offering grams there would hand the user a unit that silently cannot be
  // converted, and a Log button that refuses to work.
  if (canConvert("g", food)) {
    push({ id: "g", label: "grams", unit: "g", quantity: 1, grams: 1 });
    push({ id: "oz", label: "ounces", unit: "oz", quantity: 1, grams: UNIT_META.oz.grams ?? null });
  }

  // 4. Volume, only when a density makes it real.
  if (food.gramsPerMl && food.gramsPerMl > 0) {
    for (const unit of ["ml", "cup", "tbsp", "tsp"] as const) {
      push({
        id: unit,
        label: UNIT_META[unit].plural,
        unit,
        quantity: 1,
        grams: toGrams(1, unit, food),
      });
    }
  }

  return options;
}

function defaultServingLabel(
  food: ServingCapableFood,
  unit: AnyServingUnit,
  grams: number | null,
): string {
  const noun = UNIT_META[unit].label;
  if (grams !== null) return `1 ${noun} (${Math.round(grams)} g)`;
  if (food.servingSize > 0 && food.servingUnit) {
    return `1 ${noun} (${food.servingSize} ${food.servingUnit})`;
  }
  return `1 ${noun}`;
}
