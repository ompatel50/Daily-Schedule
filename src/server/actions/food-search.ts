"use server";

import { getCurrentUser } from "@/lib/db";
import { PROVIDER_SHORT_LABELS, type FoodProviderId } from "@/lib/logic/food";
import { searchAllFoods, toResultView, type FoodResultView } from "@/server/food";
import type { ProviderFailureReason } from "@/server/providers/types";

/**
 * The one search entry point the client calls.
 *
 * Only the search term crosses this boundary outward. The user's meals, goals,
 * weight, schedule and notes are never part of a provider request — see
 * `server/food.ts`, which is the only module that talks to one.
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
