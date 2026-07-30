import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FOOD_STALE_AFTER_DAYS, isStaleCachedFood, selectStaleFoods } from "@/lib/logic/food";

/**
 * Background refresh of stale cached provider foods.
 *
 * Two contracts pinned here: the staleness decision itself (pure), and the
 * refresh path — which must never block or fail a search, must skip a provider
 * that is not configured, and must only ever rewrite the `FoodItem` row. The
 * prisma mock deliberately has no `mealEntry` model: a refresh that reached
 * for one would throw, which is the structural proof snapshots stay untouched.
 */

const foodItem = {
  findMany: vi.fn(),
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  upsert: vi.fn(),
  create: vi.fn(),
};
const favoriteItem = { findMany: vi.fn(), findUnique: vi.fn() };

vi.mock("@/lib/db", () => ({
  prisma: { foodItem, favoriteItem },
  getCurrentUser: vi.fn(),
}));

const {
  searchAllFoods,
  refreshStaleCachedFoods,
  pendingFoodRefresh,
  clearFoodRefreshState,
  clearFoodSearchMemo,
  rowToNormalizedFood,
} = await import("@/server/food");

import { offProductResponse } from "./fixtures/openfoodfacts";

const USER = "user-1";
const NOW = new Date("2026-07-30T12:00:00Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

interface RowOverrides {
  id?: string;
  name?: string;
  provider?: string;
  externalId?: string | null;
  cached?: boolean;
  retrievedAt?: Date | null;
  refreshedAt?: Date | null;
}

function row(overrides: RowOverrides = {}) {
  return {
    id: overrides.id ?? "food-1",
    userId: null,
    name: overrides.name ?? "Nutella",
    brand: null,
    description: null,
    provider: overrides.provider ?? "off",
    externalId: overrides.externalId === undefined ? "3017620422003" : overrides.externalId,
    barcode: null,
    kind: "branded",
    source: null,
    retrievedAt: overrides.retrievedAt ?? null,
    refreshedAt: overrides.refreshedAt ?? null,
    extraNutrients: null,
    servingOptions: null,
    completeness: 1,
    cached: overrides.cached ?? true,
    basis: "per_100g",
    servingSize: 100,
    servingUnit: "g",
    servingLabel: null,
    calories: 539,
    protein: 6.3,
    carbs: 57.5,
    fat: 30.9,
    fiber: 0,
    sugar: 56.3,
    sodium: 43,
    category: "other",
    isCustom: false,
    verified: false,
    searchKey: (overrides.name ?? "Nutella").toLowerCase(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function staleFood(overrides: RowOverrides = {}) {
  return rowToNormalizedFood(
    row({ retrievedAt: daysAgo(FOOD_STALE_AFTER_DAYS + 10), ...overrides }),
  );
}

let fetchCalls: string[] = [];

function stubFetch(handler: (url: string) => { status?: number; json?: unknown }) {
  fetchCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      fetchCalls.push(url);
      const response = handler(url);
      const status = response.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => null },
        json: async () => response.json ?? {},
      } as unknown as Response;
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  clearFoodSearchMemo();
  clearFoodRefreshState();
  process.env.USDA_FDC_API_KEY = "test-key";
  favoriteItem.findMany.mockResolvedValue([]);
  foodItem.findMany.mockResolvedValue([]);
  foodItem.upsert.mockResolvedValue(row());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// The staleness decision, pure
// ---------------------------------------------------------------------------

describe("isStaleCachedFood", () => {
  it("marks a cached provider row past the threshold stale", () => {
    const food = staleFood({ retrievedAt: daysAgo(FOOD_STALE_AFTER_DAYS + 1) });
    expect(isStaleCachedFood(food, NOW)).toBe(true);
  });

  it("leaves a recently fetched row alone", () => {
    const food = staleFood({ retrievedAt: daysAgo(FOOD_STALE_AFTER_DAYS - 1) });
    expect(isStaleCachedFood(food, NOW)).toBe(false);
  });

  it("counts age from the last refresh, not the first retrieval", () => {
    const food = staleFood({ retrievedAt: daysAgo(200), refreshedAt: daysAgo(2) });
    expect(isStaleCachedFood(food, NOW)).toBe(false);
  });

  it("treats a cached row with no readable timestamp as stale", () => {
    expect(isStaleCachedFood(staleFood({ retrievedAt: null, refreshedAt: null }), NOW)).toBe(true);
  });

  it("never marks a row that is not a cached provider food", () => {
    expect(isStaleCachedFood(staleFood({ cached: false }), NOW)).toBe(false);
    expect(isStaleCachedFood(staleFood({ externalId: null }), NOW)).toBe(false);
    expect(isStaleCachedFood(staleFood({ provider: "local" }), NOW)).toBe(false);
    expect(isStaleCachedFood(staleFood({ provider: "custom" }), NOW)).toBe(false);
  });
});

describe("selectStaleFoods", () => {
  it("keeps only stale foods, oldest first, up to the cap", () => {
    const foods = [
      staleFood({ id: "fresh", externalId: "10000001", retrievedAt: daysAgo(1) }),
      staleFood({ id: "older", externalId: "10000002", retrievedAt: daysAgo(90) }),
      staleFood({ id: "oldest", externalId: "10000003", retrievedAt: daysAgo(120) }),
      staleFood({ id: "old", externalId: "10000004", retrievedAt: daysAgo(60) }),
    ];

    const picked = selectStaleFoods(foods, NOW, 2);
    expect(picked.map((food) => food.id)).toEqual(["oldest", "older"]);
  });

  it("dedupes the same provider record surfacing twice", () => {
    const foods = [staleFood({ id: "a" }), staleFood({ id: "b" })];
    expect(selectStaleFoods(foods, NOW, 10)).toHaveLength(1);
  });

  it("returns nothing for a non-positive cap", () => {
    expect(selectStaleFoods([staleFood()], NOW, 0)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The refresh path
// ---------------------------------------------------------------------------

describe("refreshStaleCachedFoods", () => {
  it("re-fetches a stale row and rewrites only the food row", async () => {
    stubFetch(() => ({ json: offProductResponse }));

    const refreshed = await refreshStaleCachedFoods([staleFood()], NOW);

    expect(refreshed).toBe(1);
    expect(fetchCalls.some((url) => url.includes("/api/v2/product/3017620422003"))).toBe(true);

    const call = foodItem.upsert.mock.calls[0][0];
    expect(call.where).toEqual({
      provider_externalId: { provider: "off", externalId: "3017620422003" },
    });
    // Only the refresh timestamp moves; the original retrieval time stays.
    expect(call.update.retrievedAt).toBeUndefined();
    expect(call.update.refreshedAt).toBeInstanceOf(Date);
  });

  it("does nothing when the provider is not configured", async () => {
    delete process.env.USDA_FDC_API_KEY;
    stubFetch(() => ({ json: {} }));

    const refreshed = await refreshStaleCachedFoods(
      [staleFood({ provider: "usda", externalId: "171077" })],
      NOW,
    );

    expect(refreshed).toBe(0);
    expect(fetchCalls).toHaveLength(0);
  });

  it("swallows a provider failure instead of throwing", async () => {
    stubFetch(() => ({ status: 503 }));

    const refreshed = await refreshStaleCachedFoods([staleFood()], NOW);

    expect(refreshed).toBe(0);
    expect(foodItem.upsert).not.toHaveBeenCalled();
  });

  it("does not retry the same food within the retry window", async () => {
    stubFetch(() => ({ status: 503 }));

    await refreshStaleCachedFoods([staleFood()], NOW);
    const attemptsAfterFirst = fetchCalls.length;
    await refreshStaleCachedFoods([staleFood()], NOW);

    expect(attemptsAfterFirst).toBe(1);
    expect(fetchCalls).toHaveLength(1);
  });

  it("caps how many rows one sweep refreshes", async () => {
    stubFetch(() => ({ json: offProductResponse }));

    const foods = Array.from({ length: 8 }, (_, index) =>
      staleFood({ id: `f${index}`, externalId: String(40000000000 + index) }),
    );
    await refreshStaleCachedFoods(foods, NOW);

    expect(fetchCalls.length).toBeLessThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// The search never waits for it
// ---------------------------------------------------------------------------

describe("search-triggered refresh", () => {
  it("answers the search before the refresh completes", async () => {
    // Enough stale local rows that no provider is consulted for the search
    // itself — every fetch below belongs to the background refresh.
    foodItem.findMany.mockResolvedValue(
      Array.from({ length: 8 }, (_, index) =>
        row({
          id: `f${index}`,
          name: `Nutella ${index}`,
          externalId: String(40000000000 + index),
          retrievedAt: daysAgo(90),
        }),
      ),
    );

    let releaseFetch = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    fetchCalls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo) => {
        fetchCalls.push(String(input));
        await gate;
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => offProductResponse,
        } as unknown as Response;
      }),
    );

    const outcome = await searchAllFoods(USER, "nutella");

    // The search resolved while every refresh fetch was still hanging.
    expect(outcome.results).toHaveLength(8);
    expect(outcome.searchedRemotely).toBe(false);
    expect(foodItem.upsert).not.toHaveBeenCalled();

    releaseFetch();
    await pendingFoodRefresh();
    expect(foodItem.upsert).toHaveBeenCalled();
  });

  it("does not refresh when the search is local-only", async () => {
    foodItem.findMany.mockResolvedValue([row({ retrievedAt: daysAgo(90) })]);
    stubFetch(() => ({ json: offProductResponse }));

    await searchAllFoods(USER, "nutella", { localOnly: true });
    await pendingFoodRefresh();

    expect(fetchCalls).toHaveLength(0);
    expect(foodItem.upsert).not.toHaveBeenCalled();
  });
});
