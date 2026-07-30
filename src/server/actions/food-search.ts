"use server";

import { getCurrentUser, prisma } from "@/lib/db";
import { PROVIDER_SHORT_LABELS, type FoodProviderId } from "@/lib/logic/food";
import {
  lookupFoodByBarcode,
  rowToNormalizedFood,
  searchAllFoods,
  toResultView,
  type FoodResultView,
} from "@/server/food";
import type { ProviderFailureReason } from "@/server/providers/types";

/**
 * The search entry points the client calls: text search, barcode lookup, and
 * the recent-foods pager.
 *
 * Only the search term or the barcode digits cross this boundary outward. The
 * user's meals, goals, weight, schedule and notes are never part of a provider
 * request — see `server/food.ts`, which is the only module that talks to one.
 */

export interface ProviderNotice {
  provider: FoodProviderId;
  label: string;
  reason: ProviderFailureReason;
  message: string;
}

export type { FoodResultView };

export interface FoodSearchResponse {
  results: FoodResultView[];
  /** Providers that were asked and could not answer, phrased for a person. */
  notices: ProviderNotice[];
  /** Providers that are not set up, with the hint for setting them up. */
  setup: Array<{ provider: FoodProviderId; label: string; hint: string }>;
  /** True when the local database answered and no provider was asked. */
  localOnly: boolean;
}

export async function searchFoodsAction(
  query: string,
  options: { localOnly?: boolean } = {},
): Promise<FoodSearchResponse> {
  const user = await getCurrentUser();

  const outcome = await searchAllFoods(user.id, query, {
    limit: 25,
    localOnly: options.localOnly,
  });

  return {
    results: outcome.results.map(toResultView),
    notices: outcome.failures.map((entry) => ({
      provider: entry.provider,
      label: PROVIDER_SHORT_LABELS[entry.provider] ?? entry.provider,
      reason: entry.failure.reason,
      message: entry.failure.message,
    })),
    setup: outcome.providers
      .filter((provider) => !provider.configured && provider.setupHint)
      .map((provider) => ({
        provider: provider.id,
        label: PROVIDER_SHORT_LABELS[provider.id] ?? provider.label,
        hint: provider.setupHint as string,
      })),
    localOnly: !outcome.searchedRemotely,
  };
}

/** EAN-8 through EAN-13/GTIN-14 — the codes food packaging actually carries. */
const BARCODE_PATTERN = /^\d{8,14}$/;

export interface BarcodeLookupResponse {
  food: FoodResultView | null;
  /** Set when the lookup could not run — distinct from "no such product". */
  notice: ProviderNotice | null;
}

export async function lookupBarcodeAction(code: string): Promise<BarcodeLookupResponse> {
  const user = await getCurrentUser();

  const trimmed = code.trim();
  if (!BARCODE_PATTERN.test(trimmed)) {
    return {
      food: null,
      notice: {
        provider: "off",
        label: PROVIDER_SHORT_LABELS.off,
        reason: "bad_response",
        message: "A product barcode is 8 to 14 digits.",
      },
    };
  }

  const outcome = await lookupFoodByBarcode(user.id, trimmed);
  return {
    food: outcome.food ? toResultView(outcome.food) : null,
    notice: outcome.failure
      ? {
          provider: "off",
          label: PROVIDER_SHORT_LABELS.off,
          reason: outcome.failure.reason,
          message: outcome.failure.message,
        }
      : null,
  };
}

/** Server-side bounds for the recent-foods pager: fixed page, hard ceiling. */
const RECENT_PAGE_SIZE = 12;
const RECENT_OFFSET_MAX = 240;

export interface RecentFoodsPage {
  foods: FoodResultView[];
  /** Offset of the next page, or null when this was the last one. */
  nextOffset: number | null;
}

/**
 * The pages behind the first dozen recents the page renders. Offset-based on
 * the usage records' own ordering; the page size and ceiling live here so the
 * client can only ever ask for the next bounded slice, never an arbitrary one.
 */
export async function loadRecentFoodsAction(offset: number): Promise<RecentFoodsPage> {
  const user = await getCurrentUser();

  const start = Math.min(
    Math.max(Number.isFinite(offset) ? Math.floor(offset) : 0, 0),
    RECENT_OFFSET_MAX,
  );

  const usage = await prisma.favoriteItem.findMany({
    where: { userId: user.id, kind: "food" },
    // Same order the shortcuts list uses, with the id as a tiebreak so pages
    // cannot overlap when two rows share a lastUsedAt.
    orderBy: [{ lastUsedAt: { sort: "desc", nulls: "last" } }, { id: "asc" }],
    skip: start,
    take: RECENT_PAGE_SIZE + 1, // one extra row = "there is another page"
  });

  const page = usage.slice(0, RECENT_PAGE_SIZE);
  const ids = page.map((item) => item.refId);
  const rows = ids.length
    ? await prisma.foodItem.findMany({
        where: { id: { in: ids }, OR: [{ userId: null }, { userId: user.id }] },
      })
    : [];
  const byId = new Map(rows.map((row) => [row.id, row]));

  const foods = page.flatMap((item) => {
    const row = byId.get(item.refId);
    if (!row) return [];
    const isFavorite = item.sortOrder >= 0;
    return [
      toResultView({
        ...rowToNormalizedFood(row),
        isFavorite,
        isRecent: true,
        origin: isFavorite ? ("favorite" as const) : ("recent" as const),
      }),
    ];
  });

  const nextOffset = usage.length > RECENT_PAGE_SIZE ? start + RECENT_PAGE_SIZE : null;
  return { foods, nextOffset: nextOffset !== null && nextOffset <= RECENT_OFFSET_MAX ? nextOffset : null };
}
