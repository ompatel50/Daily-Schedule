import { describe, expect, it } from "vitest";

import {
  baseUnitsFor,
  compareDayTypes,
  describeServing,
  macroSplit,
  macrosFor,
  totalMacros,
  type FoodLike,
} from "@/lib/logic/nutrition";

/** Chicken breast: per-100g basis, 140 g default serving. */
const chicken: FoodLike = {
  basis: "per_100g",
  servingSize: 140,
  servingUnit: "g",
  calories: 165,
  protein: 31,
  carbs: 0,
  fat: 3.6,
  fiber: 0,
  sugar: 0,
  sodium: 74,
};

/** Protein bar: per-serving basis. */
const bar: FoodLike = {
  basis: "per_serving",
  servingSize: 60,
  servingUnit: "g",
  calories: 210,
  protein: 20,
  carbs: 22,
  fat: 7,
  fiber: 8,
  sugar: 3,
  sodium: 200,
};

describe("baseUnitsFor", () => {
  it("converts a serving of a per-100g food to base units", () => {
    // 1 serving = 140 g = 1.4 × 100 g
    expect(baseUnitsFor(chicken, 1, "serving")).toBeCloseTo(1.4);
  });

  it("converts grams directly", () => {
    expect(baseUnitsFor(chicken, 250, "g")).toBeCloseTo(2.5);
  });

  it("converts ounces to grams first", () => {
    expect(baseUnitsFor(chicken, 4, "oz")).toBeCloseTo(1.134, 2);
  });

  it("treats a serving of a per-serving food as exactly one unit", () => {
    expect(baseUnitsFor(bar, 2, "serving")).toBe(2);
  });

  it("interprets grams against the declared serving size for per-serving foods", () => {
    expect(baseUnitsFor(bar, 30, "g")).toBeCloseTo(0.5);
  });

  it("returns zero for non-positive quantities", () => {
    expect(baseUnitsFor(chicken, 0, "serving")).toBe(0);
    expect(baseUnitsFor(chicken, -3, "g")).toBe(0);
  });
});

describe("macrosFor", () => {
  it("scales a per-100g food by serving", () => {
    const macros = macrosFor(chicken, 1, "serving");
    expect(macros.calories).toBe(231); // 165 × 1.4
    expect(macros.protein).toBeCloseTo(43.4, 1);
  });

  it("scales a per-serving food by count", () => {
    expect(macrosFor(bar, 2, "serving")).toMatchObject({ calories: 420, protein: 40, carbs: 44 });
  });

  it("handles fractional quantities", () => {
    expect(macrosFor(bar, 0.5, "serving").calories).toBe(105);
  });

  it("yields zeros for a zero quantity", () => {
    expect(macrosFor(chicken, 0, "serving").calories).toBe(0);
  });
});

describe("totalMacros", () => {
  it("sums entries and rounds consistently", () => {
    const total = totalMacros([
      { calories: 231, protein: 43.4, carbs: 0, fat: 5 },
      { calories: 210, protein: 20, carbs: 22, fat: 7 },
    ]);
    expect(total.calories).toBe(441);
    expect(total.protein).toBeCloseTo(63.4, 1);
    expect(total.carbs).toBe(22);
  });

  it("returns zeros for an empty day", () => {
    expect(totalMacros([]).calories).toBe(0);
  });
});

describe("macroSplit", () => {
  it("splits calories across macros", () => {
    // 100g protein (400) + 100g carbs (400) + 0 fat → 50/50/0
    expect(macroSplit({ ...chicken, protein: 100, carbs: 100, fat: 0 })).toEqual({
      protein: 50,
      carbs: 50,
      fat: 0,
    });
  });

  it("returns zeros when nothing is logged", () => {
    expect(macroSplit({ calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0 })).toEqual(
      { protein: 0, carbs: 0, fat: 0 },
    );
  });
});

describe("describeServing", () => {
  it("shows the gram weight for per-100g foods", () => {
    expect(describeServing(chicken, 1, "serving")).toBe("1 serving (140 g)");
    expect(describeServing(chicken, 2, "serving")).toBe("2 servings (280 g)");
  });

  it("passes raw units through", () => {
    expect(describeServing(chicken, 150, "g")).toBe("150 g");
  });
});

describe("training vs rest comparison", () => {
  const day = (
    calories: number,
    workoutCount: number,
    override: "training" | "rest" | null = null,
  ) => ({ calories, protein: calories / 10, workoutCount, override });

  it("averages logged days per side; unlogged days join neither", () => {
    const result = compareDayTypes([
      day(2000, 1),
      day(2200, 2),
      day(1600, 0),
      day(0, 1), // trained but logged nothing — unknown, excluded
      day(0, 0),
    ]);
    expect(result.training).toEqual({ days: 2, avgCalories: 2100, avgProtein: 210 });
    expect(result.rest).toEqual({ days: 1, avgCalories: 1600, avgProtein: 160 });
  });

  it("an override moves a day to the other side", () => {
    const result = compareDayTypes([day(2000, 1, "rest"), day(1500, 0, "training")]);
    expect(result.rest.days).toBe(1);
    expect(result.rest.avgCalories).toBe(2000);
    expect(result.training.avgCalories).toBe(1500);
  });

  it("no logged days at all reports empty sides, not zeros", () => {
    const result = compareDayTypes([day(0, 1)]);
    expect(result.training).toEqual({ days: 0, avgCalories: null, avgProtein: null });
  });
});
