import "server-only";

import type { Prisma, FoodItem } from "@prisma/client";

import { prisma } from "@/lib/db";
import {
  blendProviderResults,
  dedupeByIdentity,
  foodIdentity,
  parseExtraNutrients,
  rankFoodResults,
  sanitizeNormalizedFood,
  selectStaleFoods,
  PROVIDER_SHORT_LABELS,
  type FoodProviderId,
  type FoodSearchResult,
  type NormalizedFood,
} from "@/lib/logic/food";
import {
  BASIS_LABELS,
  parseServingSpec,
  servingOptionsFor,
  type ServingOption,
} from "@/lib/logic/servings";
import { EXTERNAL_PROVIDERS, providerById, providerStatuses } from "@/server/providers";
import type { ProviderFailure, ProviderStatus } from "@/server/providers/types";

/**
 * Food lookup, in one place, in one order:
 *
 *   1. local foods (bundled + the user's own)   ─┐
 *   2. favourites                                │ all rows already in the
 *   3. recent foods                              │ database — one query, then
 *   4. cached external foods                    ─┘ flagged from usage records
 *   5. USDA FoodData Central  (generic)
 *   6. Open Food Facts        (branded)
 *   7. "add it as a custom food" — the UI's last resort, always available
 *
 * The first four never touch the network, which is what makes the app work
 * offline: everything you have used before is local by the time you use it
 * again. Steps 5 and 6 run only when the local answer looks thin, and a failure
 * there degrades the result set rather than the page.
 *
 * Nothing about the user is sent outward. The providers receive a search term
 * or a public identifier; meals, goals, weights and notes never leave here.
 */

/** What the picker renders: a normalised food plus its presentation bits. */
export interface FoodResultView {
  /** Internal id; null for a provider result not yet cached locally. */
  id: string | null;
  provider: FoodProviderId;
  externalId: string | null;

  name: string;
  brand: string | null;
  description: string | null;
  barcode: string | null;
  kind: "generic" | "branded";
  /** "USDA", "Open Food Facts", "Custom" — shown on every row. */
  sourceLabel: string;
  sourceDetail: string | null;

  basis: string;
  basisLabel: string;
  servingSize: number;
  servingUnit: string;
  servingLabel: string | null;
  servingOptions: ServingOption[];
  gramsPerMl: number | null;

  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  sugar: number;
  sodium: number;
  extraNutrients: Record<string, number>;

  isCustom: boolean;
  isFavorite: boolean;
  isRecent: boolean;
  cached: boolean;
  /** 0–1. Below 1 the row says "partial data" rather than implying zeroes. */
  completeness: number;
}

/**
 * Lives here rather than in the server action because a `"use server"` module
 * may only export async functions — and because the mapping is shared by the
 * search action and the page that renders favourites without one.
 */
export function toResultView(food: FoodSearchResult): FoodResultView {
  return {
    id: food.id ?? null,
    provider: food.provider,
    externalId: food.externalId,
    name: food.name,
    brand: food.brand,
    description: food.description,
    barcode: food.barcode,
    kind: food.kind,
    sourceLabel: PROVIDER_SHORT_LABELS[food.provider] ?? food.provider,
    sourceDetail: food.source,
    basis: food.basis,
    basisLabel: BASIS_LABELS[food.basis as keyof typeof BASIS_LABELS] ?? food.basis,
    servingSize: food.servingSize,
    servingUnit: food.servingUnit,
    servingLabel: food.servingLabel,
    servingOptions: servingOptionsFor(food),
    gramsPerMl: food.gramsPerMl,
    calories: food.nutrients.calories,
    protein: food.nutrients.protein,
    carbs: food.nutrients.carbs,
    fat: food.nutrients.fat,
    fiber: food.nutrients.fiber,
    sugar: food.nutrients.sugar,
    sodium: food.nutrients.sodium,
    extraNutrients: food.extraNutrients as Record<string, number>,
    isCustom: food.isCustom,
    isFavorite: food.isFavorite,
    isRecent: food.isRecent,
    cached: food.cached,
    completeness: food.completeness,
  };
}

/** Local hits below this and it is worth asking a provider as well. */
const LOCAL_SUFFICIENCY_THRESHOLD = 6;
const SEARCH_CACHE_TTL_MS = 60_000;
const SEARCH_CACHE_MAX = 100;

export interface FoodSearchOptions {
  limit?: number;
  /** Skip the network entirely — used by tests and the offline path. */
  localOnly?: boolean;
  /** Ask providers even when local results look sufficient. */
  forceRemote?: boolean;
  signal?: AbortSignal;
}

export interface FoodSearchOutcome {
  results: FoodSearchResult[];
  /** Per-provider status, so the UI can explain a missing key rather than 0 hits. */
  providers: ProviderStatus[];
  /** Providers that were asked and could not answer. */
  failures: Array<{ provider: FoodProviderId; failure: ProviderFailure }>;
  /** True when at least one provider was actually queried. */
  searchedRemotely: boolean;
}

// ---------------------------------------------------------------------------
// Row ⇄ normalised record
// ---------------------------------------------------------------------------

export function rowToNormalizedFood(row: FoodItem): NormalizedFood {
  const spec = parseServingSpec(row.servingOptions);
  const provider = (row.provider ?? "local") as FoodProviderId;

  return {
    id: row.id,
    provider,
    externalId: row.externalId,
    name: row.name,
    description: row.description,
    brand: row.brand,
    barcode: row.barcode,
    kind: row.kind === "branded" ? "branded" : "generic",
    source: row.source,
    basis: (row.basis ?? "per_100g") as NormalizedFood["basis"],
    servingSize: row.servingSize,
    servingUnit: row.servingUnit,
    servingLabel: row.servingLabel,
    servingOptions: spec.options,
    gramsPerMl: spec.gramsPerMl,
    nutrients: {
      calories: row.calories,
      protein: row.protein,
      carbs: row.carbs,
      fat: row.fat,
      fiber: row.fiber,
      sugar: row.sugar,
      sodium: row.sodium,
    },
    extraNutrients: parseExtraNutrients(row.extraNutrients),
    category: row.category,
    isCustom: row.isCustom,
    cached: row.cached,
    isFavorite: false,
    completeness: row.completeness ?? 1,
    retrievedAt: row.retrievedAt?.toISOString() ?? null,
    refreshedAt: row.refreshedAt?.toISOString() ?? null,
  };
}

function normalizedToRowData(food: NormalizedFood, userId: string | null) {
  const clean = sanitizeNormalizedFood(food);
  return {
    userId,
    name: clean.name,
    brand: clean.brand,
    description: clean.description,
    provider: clean.provider,
    externalId: clean.externalId,
    barcode: clean.barcode,
    kind: clean.kind,
    source: clean.source,
    basis: clean.basis,
    servingSize: clean.servingSize,
    servingUnit: clean.servingUnit,
    servingLabel: clean.servingLabel,
    servingOptions: JSON.stringify({
      options: clean.servingOptions,
      gramsPerMl: clean.gramsPerMl,
    }),
    extraNutrients: JSON.stringify(clean.extraNutrients),
    completeness: clean.completeness,
    calories: clean.nutrients.calories,
    protein: clean.nutrients.protein,
    carbs: clean.nutrients.carbs,
    fat: clean.nutrients.fat,
    fiber: clean.nutrients.fiber,
    sugar: clean.nutrients.sugar,
    sodium: clean.nutrients.sodium,
    category: clean.category,
    searchKey: `${clean.name} ${clean.brand ?? ""}`.toLowerCase().trim(),
  };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export async function getCachedFood(
  provider: FoodProviderId,
  externalId: string,
): Promise<NormalizedFood | null> {
  if (!externalId) return null;
  const row = await prisma.foodItem.findUnique({
    where: { provider_externalId: { provider, externalId } },
  });
  return row ? rowToNormalizedFood(row) : null;
}

/**
 * Persist a provider result so it is available offline and cheap forever after.
 *
 * Keyed on (provider, externalId), so re-selecting the same food updates the
 * cached copy instead of creating a second row — and two foods that merely have
 * similar names stay separate records, because the identity is the provider's,
 * not the name.
 *
 * A refresh deliberately does **not** touch any `MealEntry`: those carry their
 * own snapshot, so corrected upstream data never rewrites a logged day.
 */
export async function cacheFood(food: NormalizedFood): Promise<FoodItem> {
  const data = normalizedToRowData(food, null);
  const now = new Date();

  if (!food.externalId) {
    // Nothing to key on: a food with no provider id is not cacheable.
    return prisma.foodItem.create({
      data: { ...data, cached: false, retrievedAt: now, refreshedAt: now },
    });
  }

  return prisma.foodItem.upsert({
    where: { provider_externalId: { provider: food.provider, externalId: food.externalId } },
    create: { ...data, cached: true, retrievedAt: now, refreshedAt: now },
    // Keep the original retrievedAt; only the refresh timestamp moves.
    update: { ...data, cached: true, refreshedAt: now },
  });
}

/**
 * The internal row for a food the user picked, creating it on first use.
 * External results have no internal id until this runs.
 */
export async function materializeFood(
  provider: FoodProviderId,
  externalId: string | null,
  internalId: string | null,
  userId: string,
): Promise<FoodItem | null> {
  if (internalId) {
    const row = await prisma.foodItem.findFirst({
      where: { id: internalId, OR: [{ userId: null }, { userId }] },
    });
    if (row) return row;
  }

  if (!externalId) return null;

  const cached = await prisma.foodItem.findUnique({
    where: { provider_externalId: { provider, externalId } },
  });
  if (cached) return cached;

  const source = providerById(provider);
  if (!source) return null;

  const outcome = await source.details(externalId);
  if (!outcome.ok || !outcome.data) return null;

  return cacheFood(outcome.data);
}

// ---------------------------------------------------------------------------
// Background refresh
// ---------------------------------------------------------------------------

/** How many stale cached rows one search will refresh in the background. */
const REFRESH_BATCH_MAX = 4;
/** A refresh attempt — success or not — is not repeated within this window. */
const REFRESH_RETRY_MS = 60 * 60 * 1000;

const refreshAttempts = new Map<string, number>();

let pendingRefresh: Promise<number> = Promise.resolve(0);

/**
 * Cached provider rows go stale — upstream records get corrected, servings get
 * filled in. A search that surfaces a row older than ~30 days queues a
 * re-fetch that runs after the search has answered: it never blocks the
 * search, never fails it, and never runs for a provider that is not
 * configured.
 *
 * Only the `FoodItem` row is updated. Meal entries carry their own snapshot,
 * so a refresh can never rewrite a logged day.
 */
export async function refreshStaleCachedFoods(
  foods: NormalizedFood[],
  now: Date = new Date(),
): Promise<number> {
  const due = selectStaleFoods(foods, now, REFRESH_BATCH_MAX * 2)
    .filter((food) => {
      const attempted = refreshAttempts.get(foodIdentity(food));
      return attempted === undefined || now.getTime() - attempted > REFRESH_RETRY_MS;
    })
    .slice(0, REFRESH_BATCH_MAX);

  let refreshed = 0;
  for (const food of due) {
    // Recorded before the attempt: a provider that is down is not re-asked on
    // every keystroke for the same stale row.
    refreshAttempts.set(foodIdentity(food), now.getTime());

    const source = food.externalId ? providerById(food.provider) : null;
    if (!source || !source.status().configured) continue;

    try {
      const outcome = await source.details(food.externalId as string);
      if (outcome.ok && outcome.data) {
        await cacheFood(outcome.data);
        refreshed += 1;
      }
    } catch {
      // Opportunistic by design; a failed refresh changes nothing.
    }
  }
  return refreshed;
}

function scheduleStaleRefresh(foods: FoodSearchResult[]): void {
  pendingRefresh = refreshStaleCachedFoods(foods).catch(() => 0);
}

/** Exposed for tests — lets them await work the search deliberately does not. */
export function pendingFoodRefresh(): Promise<number> {
  return pendingRefresh;
}

/** Exposed for tests — the attempt log is process-global and would leak between them. */
export function clearFoodRefreshState(): void {
  refreshAttempts.clear();
  pendingRefresh = Promise.resolve(0);
}

// ---------------------------------------------------------------------------
// Short-lived search memo
// ---------------------------------------------------------------------------

/**
 * A debounced search box still fires on every pause, and a user comparing two
 * foods will retype the same term within a minute. This keeps that from
 * becoming two identical provider round-trips; it is not a substitute for the
 * durable cache above, which is what survives a restart and works offline.
 */
const searchMemo = new Map<string, { at: number; results: NormalizedFood[] }>();

function memoGet(key: string): NormalizedFood[] | null {
  const hit = searchMemo.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > SEARCH_CACHE_TTL_MS) {
    searchMemo.delete(key);
    return null;
  }
  return hit.results;
}

function memoSet(key: string, results: NormalizedFood[]): void {
  if (searchMemo.size >= SEARCH_CACHE_MAX) {
    const oldest = searchMemo.keys().next().value;
    if (oldest) searchMemo.delete(oldest);
  }
  searchMemo.set(key, { at: Date.now(), results });
}

/** Exposed for tests — the memo is process-global and would leak between them. */
export function clearFoodSearchMemo(): void {
  searchMemo.clear();
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

async function localMatches(
  userId: string,
  term: string,
  limit: number,
): Promise<{ foods: FoodSearchResult[]; identities: Set<string> }> {
  const where: Prisma.FoodItemWhereInput = {
    OR: [{ userId: null }, { userId }],
    ...(term ? { searchKey: { contains: term } } : {}),
  };

  const [rows, usage] = await Promise.all([
    prisma.foodItem.findMany({
      where,
      take: limit,
      orderBy: [{ verified: "desc" }, { name: "asc" }],
    }),
    prisma.favoriteItem.findMany({ where: { userId, kind: "food" } }),
  ]);

  const favorites = new Set(
    usage.filter((item) => item.sortOrder >= 0).map((item) => item.refId),
  );
  const recents = new Set(usage.map((item) => item.refId));

  const foods = rows.map((row): FoodSearchResult => {
    const normalized = rowToNormalizedFood(row);
    const isFavorite = favorites.has(row.id);
    const isRecent = recents.has(row.id);
    return {
      ...normalized,
      isFavorite,
      isRecent,
      origin: isFavorite ? "favorite" : isRecent ? "recent" : row.cached ? "cache" : "local",
    };
  });

  return { foods, identities: new Set(foods.map(foodIdentity)) };
}

/**
 * Search every source, in order, and report honestly about what answered.
 *
 * Providers run concurrently and are individually allowed to fail: one being
 * rate-limited or unreachable removes its results, never the local ones. That
 * is the whole offline story — the local half of the answer is the half that
 * matters day to day.
 */
export async function searchAllFoods(
  userId: string,
  query: string,
  options: FoodSearchOptions = {},
): Promise<FoodSearchOutcome> {
  const term = query.trim().toLowerCase();
  const limit = options.limit ?? 25;
  const providers = providerStatuses();

  if (term.length < 2) {
    return { results: [], providers, failures: [], searchedRemotely: false };
  }

  const { foods: local, identities } = await localMatches(userId, term, limit);

  const enoughLocally = local.length >= LOCAL_SUFFICIENCY_THRESHOLD;
  const askRemote = !options.localOnly && (options.forceRemote || !enoughLocally);

  if (!askRemote) {
    // Any stale cached rows the search surfaced get refreshed after the
    // answer — but not offline, where localOnly says the network is out.
    if (!options.localOnly) scheduleStaleRefresh(local);
    return {
      results: rankFoodResults(term, local).slice(0, limit),
      providers,
      failures: [],
      searchedRemotely: false,
    };
  }

  const failures: FoodSearchOutcome["failures"] = [];
  const remote: FoodSearchResult[] = [];

  const memoKey = `${term}::${limit}`;
  const memoed = memoGet(memoKey);

  if (memoed) {
    for (const food of memoed) {
      remote.push({ ...food, isFavorite: false, isRecent: false, origin: food.provider === "usda" ? "usda" : "off" });
    }
  } else {
    const settled = await Promise.allSettled(
      EXTERNAL_PROVIDERS.map(async (provider) => ({
        id: provider.id,
        outcome: await provider.search(term, { limit: Math.min(limit, 15), signal: options.signal }),
      })),
    );

    const fresh: NormalizedFood[] = [];
    for (const entry of settled) {
      if (entry.status === "rejected") {
        failures.push({
          provider: "usda",
          failure: { reason: "unavailable", message: "Could not reach the provider." },
        });
        continue;
      }

      const { id, outcome } = entry.value;
      if (!outcome.ok) {
        failures.push({ provider: id, failure: outcome.failure });
        continue;
      }

      for (const food of outcome.data) {
        fresh.push(food);
        remote.push({
          ...food,
          isFavorite: false,
          isRecent: false,
          origin: id === "usda" ? "usda" : "off",
        });
      }
    }

    if (fresh.length > 0) memoSet(memoKey, fresh);
  }

  // A provider result already sitting in the local set is the same food; the
  // local row wins because it carries the internal id, the favourite flag and
  // any correction the user made.
  const localRanked = rankFoodResults(term, local).slice(0, limit);
  const freshRemote = dedupeByIdentity(remote.filter((food) => !identities.has(foodIdentity(food))));

  // Each provider gets a fair share of the slots local results left over,
  // ranked within itself first so its quota keeps its best matches.
  const byProvider = new Map<FoodProviderId, FoodSearchResult[]>();
  for (const food of freshRemote) {
    const bucket = byProvider.get(food.provider);
    if (bucket) bucket.push(food);
    else byProvider.set(food.provider, [food]);
  }
  const blended = blendProviderResults(
    Array.from(byProvider, ([provider, foods]) => ({ provider, foods: rankFoodResults(term, foods) })),
    limit - localRanked.length,
  );

  scheduleStaleRefresh(local);

  return {
    results: [...localRanked, ...rankFoodResults(term, blended)],
    providers,
    failures,
    searchedRemotely: !memoed,
  };
}

/** One food by provider + external id, from cache when possible. */
export async function getFoodDetails(
  provider: FoodProviderId,
  externalId: string,
): Promise<NormalizedFood | null> {
  const cached = await getCachedFood(provider, externalId);
  if (cached) return cached;

  const source = providerById(provider);
  if (!source) return null;

  const outcome = await source.details(externalId);
  if (!outcome.ok) return null;
  return outcome.data;
}

// ---------------------------------------------------------------------------
// Barcode lookup
// ---------------------------------------------------------------------------

export interface BarcodeLookupOutcome {
  food: FoodSearchResult | null;
  /** Set when the provider could not answer — distinct from "no such product". */
  failure: ProviderFailure | null;
}

/**
 * One food by its retail barcode: local rows first (a product scanned before
 * is already cached and works offline), then Open Food Facts, the provider
 * that indexes by barcode. Only the digits leave the machine.
 */
export async function lookupFoodByBarcode(
  userId: string,
  barcode: string,
): Promise<BarcodeLookupOutcome> {
  const code = barcode.trim();

  const row = await prisma.foodItem.findFirst({
    where: { barcode: code, OR: [{ userId: null }, { userId }] },
  });
  if (row) {
    const usage = await prisma.favoriteItem.findUnique({
      where: { userId_kind_refId: { userId, kind: "food", refId: row.id } },
    });
    const isFavorite = usage !== null && usage.sortOrder >= 0;
    const isRecent = usage !== null;
    return {
      food: {
        ...rowToNormalizedFood(row),
        isFavorite,
        isRecent,
        origin: isFavorite ? "favorite" : isRecent ? "recent" : row.cached ? "cache" : "local",
      },
      failure: null,
    };
  }

  const source = providerById("off");
  if (!source || !source.status().configured) {
    return {
      food: null,
      failure: { reason: "not_configured", message: "Barcode lookup is not available right now." },
    };
  }

  const outcome = await source.details(code);
  if (!outcome.ok) return { food: null, failure: outcome.failure };
  if (!outcome.data) return { food: null, failure: null };

  return { food: { ...outcome.data, isRecent: false, origin: "off" }, failure: null };
}
