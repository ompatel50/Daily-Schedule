import "server-only";

import { normalizeUsdaFood, sanitizeNormalizedFood, type NormalizedFood, type UsdaFoodRaw } from "@/lib/logic/food";
import {
  classifyHttpStatus,
  classifyThrown,
  failure,
  ok,
  type FoodProvider,
  type ProviderOutcome,
  type ProviderSearchOptions,
  type ProviderStatus,
} from "@/server/providers/types";

/**
 * USDA FoodData Central — the primary source for generic, unbranded foods.
 *
 * The API key is read from `process.env.USDA_FDC_API_KEY` inside this module,
 * which is `server-only`. It is passed as a query parameter because that is the
 * only authentication FDC accepts, which is exactly why no error path here ever
 * echoes a URL: the key would travel with it into a log or a toast.
 */

const BASE_URL = "https://api.nal.usda.gov/fdc/v1";
const TIMEOUT_MS = 8000;

/** Read at call time, not module load, so tests and setup flows see changes. */
function apiKey(): string | null {
  const key = process.env.USDA_FDC_API_KEY?.trim();
  return key ? key : null;
}

export function usdaConfigured(): boolean {
  return apiKey() !== null;
}

async function request<T>(
  path: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<ProviderOutcome<T>> {
  const key = apiKey();
  if (!key) {
    return failure(
      "not_configured",
      "USDA FoodData Central is not set up. Add USDA_FDC_API_KEY to .env to search it.",
    );
  }

  const url = new URL(`${BASE_URL}${path}`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  url.searchParams.set("api_key", key);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
      // Nothing about the user travels with this request — no cookies, no
      // referrer, no body. Only the search term and the key.
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });

    if (!response.ok) {
      const retryAfter = Number(response.headers.get("retry-after"));
      return {
        ok: false,
        failure: classifyHttpStatus(
          response.status,
          Number.isFinite(retryAfter) ? retryAfter : undefined,
        ),
      };
    }

    const json = (await response.json()) as T;
    return ok(json);
  } catch (error) {
    return { ok: false, failure: classifyThrown(error) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

interface UsdaSearchResponse {
  foods?: UsdaFoodRaw[];
}

export const usdaProvider: FoodProvider = {
  id: "usda",
  label: "USDA FoodData Central",
  covers: "generic",

  status(): ProviderStatus {
    const configured = usdaConfigured();
    return {
      id: "usda",
      label: "USDA FoodData Central",
      configured,
      setupHint: configured
        ? undefined
        : "Get a free key at fdc.nal.usda.gov/api-key-signup.html and set USDA_FDC_API_KEY in .env",
    };
  },

  async search(query, options: ProviderSearchOptions = {}) {
    const term = query.trim();
    if (term.length < 2) return ok([]);

    const result = await request<UsdaSearchResponse>(
      "/foods/search",
      {
        query: term,
        pageSize: String(Math.min(Math.max(options.limit ?? 15, 1), 50)),
        // Foundation and SR Legacy are the curated generic entries; Branded is
        // included because a query can legitimately be a product name, and
        // Open Food Facts does not cover every US label.
        dataType: options.preferBranded
          ? "Branded,Foundation,SR Legacy"
          : "Foundation,SR Legacy,Survey (FNDDS),Branded",
        requireAllWords: "true",
      },
      options.signal,
    );

    if (!result.ok) return result;

    const foods = Array.isArray(result.data?.foods) ? result.data.foods : [];
    return ok(normalizeMany(foods));
  },

  async details(externalId, options: ProviderSearchOptions = {}) {
    const id = externalId.trim();
    if (!/^\d+$/.test(id)) {
      return failure("bad_response", "That is not a FoodData Central id.");
    }

    const result = await request<UsdaFoodRaw>(`/food/${id}`, { format: "abridged" }, options.signal);
    if (!result.ok) return result;

    const normalized = normalizeUsdaFood(result.data);
    return ok(normalized ? sanitizeNormalizedFood(normalized) : null);
  },
};

function normalizeMany(raw: UsdaFoodRaw[]): NormalizedFood[] {
  const out: NormalizedFood[] = [];
  for (const item of raw) {
    const normalized = normalizeUsdaFood(item);
    // A record we cannot name or count is noise, not a result.
    if (normalized) out.push(sanitizeNormalizedFood(normalized));
  }
  return out;
}
