import "server-only";

import {
  normalizeOffProduct,
  sanitizeNormalizedFood,
  type NormalizedFood,
  type OffProductRaw,
} from "@/lib/logic/food";
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
 * Open Food Facts — the supplemental source for branded, packaged products.
 *
 * Read-only by construction: only GET endpoints are used and nothing here
 * writes, uploads or contributes. Open Food Facts asks callers to identify
 * themselves with a descriptive User-Agent, which is the one identifying
 * header sent; it names the app and its repository, not the user.
 *
 * No key is needed, so this provider is always "configured" — which makes it
 * the fallback that keeps branded search working before USDA is set up.
 */

const BASE_URL = "https://world.openfoodfacts.org";
const TIMEOUT_MS = 8000;

/**
 * OFF's documented format is `AppName/Version (contact)`. It identifies the
 * software, deliberately not the person running it.
 */
const USER_AGENT = "PersonalOS/1.0 (local-first personal planner; https://github.com/ompatel50/Daily-Schedule)";

/** Products under this completeness are usually a name and nothing else. */
const MIN_USABLE_COMPLETENESS = 0.3;

async function request<T>(path: string, signal?: AbortSignal): Promise<ProviderOutcome<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);

  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": USER_AGENT,
      },
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

    return ok((await response.json()) as T);
  } catch (error) {
    return { ok: false, failure: classifyThrown(error) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Only the fields we normalise — asking for less is faster and politer. */
const FIELDS = [
  "code",
  "product_name",
  "product_name_en",
  "generic_name",
  "brands",
  "quantity",
  "product_quantity",
  "serving_size",
  "serving_quantity",
  "categories",
  "completeness",
  "nutriments",
].join(",");

interface OffSearchResponse {
  products?: OffProductRaw[];
}

interface OffProductResponse {
  status?: number;
  product?: OffProductRaw;
}

export function looksLikeBarcode(query: string): boolean {
  const trimmed = query.trim();
  return /^\d{8,14}$/.test(trimmed);
}

export const offProvider: FoodProvider = {
  id: "off",
  label: "Open Food Facts",
  covers: "branded",

  status(): ProviderStatus {
    // No credential to configure — the trade-off is that data quality varies,
    // which is why every result carries its completeness.
    return { id: "off", label: "Open Food Facts", configured: true };
  },

  async search(query, options: ProviderSearchOptions = {}) {
    const term = query.trim();
    if (term.length < 2) return ok([]);

    // A bare barcode is a lookup, not a search.
    if (looksLikeBarcode(term)) {
      const single = await this.details(term, options);
      if (!single.ok) return single;
      return ok(single.data ? [single.data] : []);
    }

    const params = new URLSearchParams({
      search_terms: term,
      fields: FIELDS,
      page_size: String(Math.min(Math.max(options.limit ?? 15, 1), 50)),
      json: "1",
    });

    const result = await request<OffSearchResponse>(`/api/v2/search?${params.toString()}`, options.signal);
    if (!result.ok) return result;

    const products = Array.isArray(result.data?.products) ? result.data.products : [];
    return ok(normalizeMany(products));
  },

  async details(externalId, options: ProviderSearchOptions = {}) {
    const code = externalId.trim();
    if (!/^\d{4,14}$/.test(code)) {
      return failure("bad_response", "That is not an Open Food Facts barcode.");
    }

    const result = await request<OffProductResponse>(
      `/api/v2/product/${code}?fields=${FIELDS}`,
      options.signal,
    );
    if (!result.ok) return result;

    // OFF answers 200 with status 0 for "no such product".
    if (result.data?.status === 0 || !result.data?.product) return ok(null);

    const normalized = normalizeOffProduct(result.data.product);
    return ok(normalized ? sanitizeNormalizedFood(normalized) : null);
  },
};

/**
 * Community records are frequently partial. A product with a usable name and
 * calories is kept and labelled; one that is essentially an empty stub is
 * dropped, because an entry claiming 0 g of everything is worse than absent.
 */
function normalizeMany(raw: OffProductRaw[]): NormalizedFood[] {
  const out: NormalizedFood[] = [];
  for (const product of raw) {
    const normalized = normalizeOffProduct(product);
    if (!normalized) continue;
    if (normalized.completeness < MIN_USABLE_COMPLETENESS) continue;
    out.push(sanitizeNormalizedFood(normalized));
  }
  return out;
}
