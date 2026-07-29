import "server-only";

import type { FoodProviderId } from "@/lib/logic/food";
import { offProvider } from "@/server/providers/openfoodfacts";
import { usdaProvider } from "@/server/providers/usda";
import type { FoodProvider, ProviderStatus } from "@/server/providers/types";

/**
 * The registry of external food sources, in the order they are consulted.
 *
 * USDA first because generic ingredients — "chicken breast", "rolled oats" —
 * are what most searches are, and its data is curated. Open Food Facts second
 * because it covers the packaged products USDA's branded set misses, at the
 * cost of community-variable quality.
 */
export const EXTERNAL_PROVIDERS: readonly FoodProvider[] = [usdaProvider, offProvider];

export function providerById(id: FoodProviderId): FoodProvider | null {
  return EXTERNAL_PROVIDERS.find((provider) => provider.id === id) ?? null;
}

export function providerStatuses(): ProviderStatus[] {
  return EXTERNAL_PROVIDERS.map((provider) => provider.status());
}

/** True when at least one external source can actually be queried. */
export function anyProviderConfigured(): boolean {
  return EXTERNAL_PROVIDERS.some((provider) => provider.status().configured);
}

export { usdaProvider, offProvider };
export type { FoodProvider, ProviderStatus };
