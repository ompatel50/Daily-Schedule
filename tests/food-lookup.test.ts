import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The lookup order, end to end, with the database mocked and every provider
 * request intercepted.
 *
 * This is the layer where "works offline" is actually decided: local rows,
 * favourites, recents and cached foods must answer without the network, and a
 * provider that is down must remove only its own results.
 */

const foodItem = {
  findMany: vi.fn(),
  findUnique: vi.fn(),
  upsert: vi.fn(),
  create: vi.fn(),
};
const favoriteItem = { findMany: vi.fn() };

vi.mock("@/lib/db", () => ({
  prisma: { foodItem, favoriteItem },
  getCurrentUser: vi.fn(),
}));

const { searchAllFoods, getCachedFood, cacheFood, rowToNormalizedFood, clearFoodSearchMemo } =
  await import("@/server/food");

import { usdaSearchResponse } from "./fixtures/usda";
import { offSearchResponse } from "./fixtures/openfoodfacts";

const USER = "user-1";

interface RowOverrides {
  id?: string;
  name?: string;
  provider?: string;
  externalId?: string | null;
  cached?: boolean;
  isCustom?: boolean;
  calories?: number;
}

function row(overrides: RowOverrides = {}) {
  return {
    id: overrides.id ?? "food-1",
    userId: null,
    name: overrides.name ?? "Rolled oats",
    brand: null,
    description: null,
    provider: overrides.provider ?? "local",
    externalId: overrides.externalId ?? null,
    barcode: null,
    kind: "generic",
    source: null,
    retrievedAt: null,
    refreshedAt: null,
    extraNutrients: null,
    servingOptions: null,
    completeness: 1,
    cached: overrides.cached ?? false,
    basis: "per_100g",
    servingSize: 40,
    servingUnit: "g",
    servingLabel: null,
    calories: overrides.calories ?? 380,
    protein: 13,
    carbs: 67,
    fat: 7,
    fiber: 10,
    sugar: 1,
    sodium: 5,
    category: "grain",
    isCustom: overrides.isCustom ?? false,
    verified: true,
    searchKey: (overrides.name ?? "Rolled oats").toLowerCase(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function favorite(refId: string, pinned: boolean) {
  return { id: `fav-${refId}`, userId: USER, kind: "food", refId, sortOrder: pinned ? 0 : -1 };
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
  process.env.USDA_FDC_API_KEY = "test-key";
  favoriteItem.findMany.mockResolvedValue([]);
  foodItem.findMany.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe("lookup order", () => {
  it("answers from local rows alone when they are sufficient", async () => {
    foodItem.findMany.mockResolvedValue(
      Array.from({ length: 8 }, (_, index) => row({ id: `f${index}`, name: `Oats ${index}` })),
    );
    stubFetch(() => ({ json: usdaSearchResponse }));

    const outcome = await searchAllFoods(USER, "oats");

    expect(outcome.results.length).toBeGreaterThan(0);
    expect(outcome.searchedRemotely).toBe(false);
    // The whole point: a well-stocked local database never calls out.
    expect(fetchCalls).toHaveLength(0);
  });

  it("consults providers when the local answer is thin", async () => {
    foodItem.findMany.mockResolvedValue([row({ name: "Oats" })]);
    stubFetch((url) => (url.includes("openfoodfacts") ? { json: offSearchResponse } : { json: usdaSearchResponse }));

    const outcome = await searchAllFoods(USER, "oats");

    expect(outcome.searchedRemotely).toBe(true);
    expect(fetchCalls.some((url) => url.includes("nal.usda.gov"))).toBe(true);
    expect(fetchCalls.some((url) => url.includes("openfoodfacts"))).toBe(true);
    expect(outcome.results.length).toBeGreaterThan(1);
  });

  it("marks favourites and recents, and ranks them first", async () => {
    foodItem.findMany.mockResolvedValue([
      row({ id: "plain", name: "Oats" }),
      row({ id: "fav", name: "Oats" }),
    ]);
    favoriteItem.findMany.mockResolvedValue([favorite("fav", true)]);
    stubFetch(() => ({ json: { foods: [] } }));

    const outcome = await searchAllFoods(USER, "oats");

    const first = outcome.results[0];
    expect(first.id).toBe("fav");
    expect(first.isFavorite).toBe(true);
    expect(first.origin).toBe("favorite");
  });

  it("treats an unpinned usage record as recent, not favourite", async () => {
    foodItem.findMany.mockResolvedValue([row({ id: "seen", name: "Oats" })]);
    favoriteItem.findMany.mockResolvedValue([favorite("seen", false)]);
    stubFetch(() => ({ json: { foods: [] } }));

    const outcome = await searchAllFoods(USER, "oats");
    expect(outcome.results[0]).toMatchObject({ isFavorite: false, isRecent: true, origin: "recent" });
  });

  it("labels a previously cached provider food as cached", async () => {
    foodItem.findMany.mockResolvedValue([
      row({ id: "c1", name: "Nutella", provider: "off", externalId: "3017620422003", cached: true }),
    ]);
    stubFetch(() => ({ json: { products: [] } }));

    const outcome = await searchAllFoods(USER, "nutella");
    expect(outcome.results[0]).toMatchObject({ cached: true, origin: "cache", provider: "off" });
  });

  it("does not return a provider result that is already a local row", async () => {
    // The USDA fixture's first food is fdcId 171077.
    foodItem.findMany.mockResolvedValue([
      row({ id: "local-copy", name: "Chicken breast", provider: "usda", externalId: "171077", cached: true }),
    ]);
    stubFetch((url) => (url.includes("openfoodfacts") ? { json: { products: [] } } : { json: usdaSearchResponse }));

    const outcome = await searchAllFoods(USER, "chicken");

    const matches = outcome.results.filter((food) => food.externalId === "171077");
    expect(matches).toHaveLength(1);
    // The local row wins, because it carries the internal id and the flags.
    expect(matches[0].id).toBe("local-copy");
  });

  it("returns nothing for a query below the useful length, without querying anything", async () => {
    stubFetch(() => ({ json: usdaSearchResponse }));
    const outcome = await searchAllFoods(USER, "a");

    expect(outcome.results).toEqual([]);
    expect(foodItem.findMany).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("degrading when a provider cannot answer", () => {
  it("keeps local results and reports the failure", async () => {
    foodItem.findMany.mockResolvedValue([row({ name: "Oats" })]);
    stubFetch(() => ({ status: 503 }));

    const outcome = await searchAllFoods(USER, "oats");

    // Local half of the answer survives — this is the offline story.
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0].id).toBe("food-1");
    expect(outcome.failures.length).toBeGreaterThan(0);
    expect(outcome.failures.every((entry) => entry.failure.reason === "unavailable")).toBe(true);
  });

  it("keeps the other provider's results when one is rate-limited", async () => {
    foodItem.findMany.mockResolvedValue([]);
    stubFetch((url) =>
      url.includes("nal.usda.gov") ? { status: 429 } : { json: offSearchResponse },
    );

    const outcome = await searchAllFoods(USER, "nutella");

    expect(outcome.failures.map((entry) => entry.provider)).toEqual(["usda"]);
    expect(outcome.failures[0].failure.reason).toBe("rate_limited");
    expect(outcome.results.some((food) => food.provider === "off")).toBe(true);
  });

  it("reports the missing key as provider status, not as an error", async () => {
    delete process.env.USDA_FDC_API_KEY;
    foodItem.findMany.mockResolvedValue([]);
    stubFetch(() => ({ json: offSearchResponse }));

    const outcome = await searchAllFoods(USER, "nutella");

    const usda = outcome.providers.find((provider) => provider.id === "usda");
    expect(usda?.configured).toBe(false);
    expect(usda?.setupHint).toContain("USDA_FDC_API_KEY");
    // Open Food Facts still answered.
    expect(outcome.results.length).toBeGreaterThan(0);
  });

  it("never throws when everything external is down", async () => {
    foodItem.findMany.mockResolvedValue([row()]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const outcome = await searchAllFoods(USER, "oats");
    expect(outcome.results).toHaveLength(1);
    expect(outcome.failures.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------

describe("offline", () => {
  it("skips every provider when asked for local only", async () => {
    foodItem.findMany.mockResolvedValue([row({ name: "Oats" })]);
    stubFetch(() => ({ json: usdaSearchResponse }));

    const outcome = await searchAllFoods(USER, "oats", { localOnly: true });

    expect(fetchCalls).toHaveLength(0);
    expect(outcome.searchedRemotely).toBe(false);
    expect(outcome.failures).toEqual([]);
    // Local food still works, which is what the offline notice promises.
    expect(outcome.results).toHaveLength(1);
  });

  it("still returns favourites and cached foods offline", async () => {
    foodItem.findMany.mockResolvedValue([
      row({ id: "fav", name: "Oats" }),
      row({ id: "cached", name: "Oats bar", provider: "off", externalId: "999", cached: true }),
    ]);
    favoriteItem.findMany.mockResolvedValue([favorite("fav", true)]);

    const outcome = await searchAllFoods(USER, "oats", { localOnly: true });

    expect(outcome.results.map((food) => food.id)).toEqual(["fav", "cached"]);
  });
});

// ---------------------------------------------------------------------------

describe("avoiding repeat provider calls", () => {
  it("reuses a recent identical search instead of asking again", async () => {
    foodItem.findMany.mockResolvedValue([]);
    stubFetch((url) => (url.includes("openfoodfacts") ? { json: { products: [] } } : { json: usdaSearchResponse }));

    const first = await searchAllFoods(USER, "chicken");
    const callsAfterFirst = fetchCalls.length;
    const second = await searchAllFoods(USER, "chicken");

    expect(callsAfterFirst).toBeGreaterThan(0);
    expect(fetchCalls).toHaveLength(callsAfterFirst);
    expect(second.searchedRemotely).toBe(false);
    expect(second.results.map((food) => food.externalId)).toEqual(
      first.results.map((food) => food.externalId),
    );
  });

  it("asks again for a different term", async () => {
    foodItem.findMany.mockResolvedValue([]);
    stubFetch(() => ({ json: usdaSearchResponse }));

    await searchAllFoods(USER, "chicken");
    const after = fetchCalls.length;
    await searchAllFoods(USER, "oats");

    expect(fetchCalls.length).toBeGreaterThan(after);
  });
});

// ---------------------------------------------------------------------------

describe("the cache", () => {
  it("finds a cached food by provider and external id", async () => {
    foodItem.findUnique.mockResolvedValue(row({ provider: "usda", externalId: "171077", cached: true }));

    const food = await getCachedFood("usda", "171077");
    expect(food?.externalId).toBe("171077");
    expect(foodItem.findUnique).toHaveBeenCalledWith({
      where: { provider_externalId: { provider: "usda", externalId: "171077" } },
    });
  });

  it("upserts on that same pair, so re-selecting refreshes rather than duplicates", async () => {
    foodItem.upsert.mockResolvedValue(row());
    const normalized = rowToNormalizedFood(row({ provider: "usda", externalId: "171077" }));

    await cacheFood(normalized);

    const call = foodItem.upsert.mock.calls[0][0];
    expect(call.where).toEqual({
      provider_externalId: { provider: "usda", externalId: "171077" },
    });
    expect(call.create.cached).toBe(true);
    expect(call.update.cached).toBe(true);
    // The original retrieval time is not overwritten by a refresh.
    expect(call.update.retrievedAt).toBeUndefined();
    expect(call.update.refreshedAt).toBeInstanceOf(Date);
  });

  it("creates rather than upserts a food with no external id", async () => {
    foodItem.create.mockResolvedValue(row());
    await cacheFood(rowToNormalizedFood(row({ provider: "custom", externalId: null })));

    expect(foodItem.upsert).not.toHaveBeenCalled();
    expect(foodItem.create).toHaveBeenCalled();
    expect(foodItem.create.mock.calls[0][0].data.cached).toBe(false);
  });

  it("stores the serving spec and micronutrients as JSON the reader can parse", async () => {
    foodItem.upsert.mockResolvedValue(row());
    const normalized = rowToNormalizedFood(row({ provider: "usda", externalId: "1" }));
    normalized.gramsPerMl = 1.03;
    normalized.extraNutrients = { potassium: 300 };

    await cacheFood(normalized);

    const data = foodItem.upsert.mock.calls[0][0].create;
    expect(JSON.parse(data.servingOptions)).toMatchObject({ gramsPerMl: 1.03 });
    expect(JSON.parse(data.extraNutrients)).toEqual({ potassium: 300 });
  });
});

// ---------------------------------------------------------------------------

describe("privacy", () => {
  it("sends only the search term outward, never anything about the user", async () => {
    foodItem.findMany.mockResolvedValue([]);
    stubFetch(() => ({ json: { foods: [], products: [] } }));

    await searchAllFoods(USER, "greek yogurt");

    expect(fetchCalls.length).toBeGreaterThan(0);
    for (const url of fetchCalls) {
      expect(url).not.toContain(USER);
      // No identifier, meal, goal, weight or date rides along.
      for (const leak of ["user", "meal", "goal", "weight", "journal", "habit", "date="]) {
        expect(url.toLowerCase()).not.toContain(leak);
      }
    }
  });

  it("passes the query through verbatim and adds nothing of its own", async () => {
    foodItem.findMany.mockResolvedValue([]);
    stubFetch(() => ({ json: { foods: [], products: [] } }));

    await searchAllFoods(USER, "chicken breast");

    const usdaCall = fetchCalls.find((url) => url.includes("nal.usda.gov"));
    expect(new URL(usdaCall as string).searchParams.get("query")).toBe("chicken breast");
  });
});
