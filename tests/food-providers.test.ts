import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { offProvider, looksLikeBarcode } from "@/server/providers/openfoodfacts";
import { usdaProvider, usdaConfigured } from "@/server/providers/usda";
import { EXTERNAL_PROVIDERS, anyProviderConfigured, providerById, providerStatuses } from "@/server/providers";
import { classifyHttpStatus, classifyThrown } from "@/server/providers/types";
import { usdaSearchResponse, usdaChickenBreast } from "./fixtures/usda";
import {
  offMissingProductResponse,
  offProductResponse,
  offSearchResponse,
} from "./fixtures/openfoodfacts";

/**
 * Provider behaviour against mocked responses.
 *
 * Nothing here touches a live API — the fixtures are captured shapes, and every
 * request is intercepted. That is deliberate: a test suite that depends on
 * fdc.nal.usda.gov being up is a test suite that fails for reasons unrelated to
 * the code.
 */

const ORIGINAL_KEY = process.env.USDA_FDC_API_KEY;

interface Captured {
  url: string;
  headers: Record<string, string>;
  method: string;
  body: unknown;
}

let captured: Captured[] = [];

function mockFetch(handler: (url: string) => { status?: number; json?: unknown; headers?: Record<string, string> }) {
  return vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    captured.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      method: init?.method ?? "GET",
      body: init?.body ?? null,
    });

    const response = handler(url);
    const status = response.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => response.headers?.[name.toLowerCase()] ?? null },
      json: async () => response.json ?? {},
    } as unknown as Response;
  });
}

beforeEach(() => {
  captured = [];
  process.env.USDA_FDC_API_KEY = "test-key-1234";
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL_KEY === undefined) delete process.env.USDA_FDC_API_KEY;
  else process.env.USDA_FDC_API_KEY = ORIGINAL_KEY;
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("provider registry", () => {
  it("consults USDA before Open Food Facts", () => {
    expect(EXTERNAL_PROVIDERS.map((provider) => provider.id)).toEqual(["usda", "off"]);
  });

  it("resolves a provider by id", () => {
    expect(providerById("usda")?.label).toBe("USDA FoodData Central");
    expect(providerById("off")?.label).toBe("Open Food Facts");
    expect(providerById("local")).toBeNull();
  });

  it("declares which providers cover generic versus branded foods", () => {
    expect(providerById("usda")?.covers).toBe("generic");
    expect(providerById("off")?.covers).toBe("branded");
  });

  it("reports Open Food Facts as usable with no key at all", () => {
    delete process.env.USDA_FDC_API_KEY;
    const statuses = providerStatuses();
    expect(statuses.find((status) => status.id === "off")?.configured).toBe(true);
    expect(statuses.find((status) => status.id === "usda")?.configured).toBe(false);
    // Branded search still works, so the app is never fully without a provider.
    expect(anyProviderConfigured()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The missing-key path
// ---------------------------------------------------------------------------

describe("USDA without an API key", () => {
  beforeEach(() => {
    delete process.env.USDA_FDC_API_KEY;
  });

  it("knows it is not configured", () => {
    expect(usdaConfigured()).toBe(false);
    expect(usdaProvider.status().configured).toBe(false);
  });

  it("offers a setup hint that names the variable but never a key", () => {
    const hint = usdaProvider.status().setupHint ?? "";
    expect(hint).toContain("USDA_FDC_API_KEY");
    expect(hint).toContain("fdc.nal.usda.gov");
  });

  it("fails with not_configured instead of calling out", async () => {
    const fetchMock = mockFetch(() => ({ json: usdaSearchResponse }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await usdaProvider.search("chicken");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe("not_configured");
    // The important part: no request was attempted.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats an empty or whitespace key as absent", async () => {
    process.env.USDA_FDC_API_KEY = "   ";
    expect(usdaConfigured()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// USDA success and failure
// ---------------------------------------------------------------------------

describe("USDA search", () => {
  it("normalises a search response into internal records", async () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ json: usdaSearchResponse })));

    const result = await usdaProvider.search("chicken breast");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toMatchObject({
      provider: "usda",
      externalId: "171077",
      kind: "generic",
      basis: "per_100g",
    });
  });

  it("sends the API key and the query, and nothing else", async () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ json: usdaSearchResponse })));
    await usdaProvider.search("chicken breast");

    const url = new URL(captured[0].url);
    expect(url.searchParams.get("query")).toBe("chicken breast");
    expect(url.searchParams.get("api_key")).toBe("test-key-1234");

    // Every parameter is either the search itself or a result-shaping option.
    const allowed = new Set(["query", "api_key", "pageSize", "dataType", "requireAllWords", "format"]);
    for (const name of url.searchParams.keys()) expect(allowed).toContain(name);

    // A search is a GET with no body — there is no channel for personal data.
    expect(captured[0].method).toBe("GET");
    expect(captured[0].body).toBeNull();
  });

  it("does not send cookies or a referrer", async () => {
    const fetchMock = mockFetch(() => ({ json: usdaSearchResponse }));
    vi.stubGlobal("fetch", fetchMock);
    await usdaProvider.search("oats");

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.referrerPolicy).toBe("no-referrer");
    expect(init.cache).toBe("no-store");
    expect("credentials" in init).toBe(false);
  });

  it("returns unauthorized when the key is rejected", async () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ status: 403 })));

    const result = await usdaProvider.search("oats");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.reason).toBe("unauthorized");
      // The message must never echo the URL, which carries the key.
      expect(result.failure.message).not.toContain("test-key-1234");
      expect(result.failure.message).not.toContain("api_key");
    }
  });

  it("returns rate_limited and the retry hint on a 429", async () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ status: 429, headers: { "retry-after": "30" } })));

    const result = await usdaProvider.search("oats");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.reason).toBe("rate_limited");
      expect(result.failure.retryAfter).toBe(30);
    }
  });

  it("returns unavailable on a server error", async () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ status: 503 })));
    const result = await usdaProvider.search("oats");
    if (!result.ok) expect(result.failure.reason).toBe("unavailable");
  });

  it("survives a thrown network error rather than propagating it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    const result = await usdaProvider.search("oats");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe("unavailable");
  });

  it("reports a timeout distinctly from an outage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }),
    );

    const result = await usdaProvider.search("oats");
    if (!result.ok) expect(result.failure.reason).toBe("timeout");
  });

  it("survives a response that is not the shape it expects", async () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ json: { unexpected: true } })));
    const result = await usdaProvider.search("oats");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual([]);
  });

  it("drops unusable records instead of failing the whole search", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({ json: { foods: [usdaChickenBreast, { fdcId: 1 }, null] } })),
    );
    const result = await usdaProvider.search("chicken");
    if (result.ok) expect(result.data).toHaveLength(1);
  });

  it("does not call out for a query below the useful length", async () => {
    const fetchMock = mockFetch(() => ({ json: usdaSearchResponse }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await usdaProvider.search("a");
    expect(result.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric id before making a request", async () => {
    const fetchMock = mockFetch(() => ({ json: {} }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await usdaProvider.details("../../etc/passwd");
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches one record by id", async () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ json: usdaChickenBreast })));
    const result = await usdaProvider.details("171077");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data?.externalId).toBe("171077");
    expect(captured[0].url).toContain("/food/171077");
  });
});

// ---------------------------------------------------------------------------
// Open Food Facts
// ---------------------------------------------------------------------------

describe("Open Food Facts", () => {
  it("needs no configuration", () => {
    delete process.env.USDA_FDC_API_KEY;
    expect(offProvider.status().configured).toBe(true);
  });

  it("normalises a search response", async () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ json: offSearchResponse })));

    const result = await offProvider.search("nutella");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data[0]).toMatchObject({ provider: "off", externalId: "3017620422003", kind: "branded" });
    }
  });

  it("identifies itself with a descriptive User-Agent naming the app, not the user", async () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ json: offSearchResponse })));
    await offProvider.search("nutella");

    const agent = captured[0].headers["user-agent"];
    expect(agent).toBeTruthy();
    expect(agent).toContain("PersonalOS");
  });

  it("only ever reads", async () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ json: offSearchResponse })));
    await offProvider.search("nutella");
    await offProvider.details("3017620422003");

    for (const call of captured) {
      expect(call.method).toBe("GET");
      expect(call.body).toBeNull();
      // Nothing points at the write endpoints.
      expect(call.url).not.toContain("/cgi/product_jqm");
      expect(call.url).not.toContain("product_jqm2.pl");
    }
  });

  it("sends only the search term and field selection", async () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ json: offSearchResponse })));
    await offProvider.search("greek yogurt");

    const url = new URL(captured[0].url);
    expect(url.searchParams.get("search_terms")).toBe("greek yogurt");
    const allowed = new Set(["search_terms", "fields", "page_size", "json"]);
    for (const name of url.searchParams.keys()) expect(allowed).toContain(name);
  });

  it("treats a bare barcode as a product lookup, not a text search", async () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ json: offProductResponse })));

    const result = await offProvider.search("3017620422003");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toHaveLength(1);
    expect(captured[0].url).toContain("/api/v2/product/3017620422003");
  });

  it("recognises what looks like a barcode", () => {
    expect(looksLikeBarcode("3017620422003")).toBe(true);
    expect(looksLikeBarcode("12345678")).toBe(true);
    expect(looksLikeBarcode("1234")).toBe(false);
    expect(looksLikeBarcode("nutella")).toBe(false);
  });

  it("returns nothing, not an error, for a product that does not exist", async () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ json: offMissingProductResponse })));

    const result = await offProvider.details("0000000000000");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBeNull();
  });

  it("filters out essentially empty community stubs", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({
        json: {
          products: [
            { code: "1", product_name: "Stub", nutriments: { "energy-kcal_100g": 100 }, completeness: 0.05 },
          ],
        },
      })),
    );

    const result = await offProvider.search("stub");
    if (result.ok) expect(result.data).toHaveLength(0);
  });

  it("keeps a partial record and reports how partial it is", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({
        json: {
          products: [
            {
              code: "2",
              product_name: "Half-filled snack",
              nutriments: { "energy-kcal_100g": 200, proteins_100g: 5, fat_100g: 3 },
              completeness: 0.5,
            },
          ],
        },
      })),
    );

    const result = await offProvider.search("snack");
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0].completeness).toBeLessThan(1);
      expect(result.data[0].completeness).toBeGreaterThan(0);
    }
  });

  it("handles a rate limit the same way USDA does", async () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ status: 429, headers: { "retry-after": "60" } })));
    const result = await offProvider.search("nutella");
    if (!result.ok) {
      expect(result.failure.reason).toBe("rate_limited");
      expect(result.failure.retryAfter).toBe(60);
    }
  });

  it("survives an outage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ENOTFOUND");
      }),
    );
    const result = await offProvider.search("nutella");
    expect(result.ok).toBe(false);
  });

  it("rejects a malformed barcode before making a request", async () => {
    const fetchMock = mockFetch(() => ({ json: {} }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await offProvider.details("abc");
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Fallback between providers
// ---------------------------------------------------------------------------

describe("provider fallback", () => {
  it("keeps branded results when USDA has no key configured", async () => {
    delete process.env.USDA_FDC_API_KEY;
    vi.stubGlobal("fetch", mockFetch(() => ({ json: offSearchResponse })));

    const [usda, off] = await Promise.all([
      usdaProvider.search("nutella"),
      offProvider.search("nutella"),
    ]);

    expect(usda.ok).toBe(false);
    expect(off.ok).toBe(true);
    if (off.ok) expect(off.data.length).toBeGreaterThan(0);
  });

  it("keeps generic results when Open Food Facts is down", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => (url.includes("openfoodfacts") ? { status: 500 } : { json: usdaSearchResponse })),
    );

    const [usda, off] = await Promise.all([
      usdaProvider.search("chicken"),
      offProvider.search("chicken"),
    ]);

    expect(off.ok).toBe(false);
    expect(usda.ok).toBe(true);
    if (usda.ok) expect(usda.data.length).toBeGreaterThan(0);
  });

  it("degrades to nothing rather than throwing when both are unavailable", async () => {
    vi.stubGlobal("fetch", mockFetch(() => ({ status: 500 })));

    const results = await Promise.all(
      EXTERNAL_PROVIDERS.map((provider) => provider.search("anything")),
    );
    expect(results.every((result) => !result.ok)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

describe("failure classification", () => {
  it("maps HTTP statuses to reasons a person can act on", () => {
    expect(classifyHttpStatus(401).reason).toBe("unauthorized");
    expect(classifyHttpStatus(403).reason).toBe("unauthorized");
    expect(classifyHttpStatus(429).reason).toBe("rate_limited");
    expect(classifyHttpStatus(500).reason).toBe("unavailable");
    expect(classifyHttpStatus(404).reason).toBe("unavailable");
  });

  it("never puts a response body or URL into a user-facing message", () => {
    const message = classifyHttpStatus(500).message;
    expect(message).not.toContain("http://");
    expect(message).not.toContain("https://");
  });

  it("tells a timeout apart from an outage", () => {
    const aborted = new Error("aborted");
    aborted.name = "AbortError";
    expect(classifyThrown(aborted).reason).toBe("timeout");
    expect(classifyThrown(new Error("boom")).reason).toBe("unavailable");
    expect(classifyThrown("a string").reason).toBe("unavailable");
  });
});
