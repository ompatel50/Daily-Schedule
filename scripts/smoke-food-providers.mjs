#!/usr/bin/env node
/**
 * Live smoke test for the two food providers, run by hand from a machine with
 * real network access:
 *
 *   node scripts/smoke-food-providers.mjs                       # Open Food Facts only
 *   USDA_FDC_API_KEY=... node scripts/smoke-food-providers.mjs  # both providers
 *
 * It hits the same endpoints the app's providers use — a USDA text search, an
 * Open Food Facts text search, and an Open Food Facts barcode lookup — and
 * prints exactly what happened: PASS with a sample result, FAIL with the HTTP
 * status or error, or SKIP when the USDA key is absent. Exit code 1 when any
 * attempted check failed, so it can gate a deploy.
 *
 * It is standalone on purpose: the automated test suites never touch the live
 * APIs (they run on captured fixtures), and the development sandbox blocks
 * both provider hosts outright — running it there reports both as unreachable,
 * which is the honest answer, not a pass.
 */

const TIMEOUT_MS = 10_000;

async function get(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json", ...headers },
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    return { ok: true, json: await response.json() };
  } catch (error) {
    const reason = error?.name === "AbortError" ? `no response within ${TIMEOUT_MS / 1000}s` : (error?.cause?.message ?? error?.message ?? String(error));
    return { ok: false, error: `unreachable (${reason})` };
  } finally {
    clearTimeout(timer);
  }
}

/** Same identification the app sends: the software, never the person. */
const OFF_USER_AGENT =
  "PersonalOS/1.0 (local-first personal planner; https://github.com/ompatel50/Daily-Schedule)";

let failed = false;

function report(name, outcome, describe) {
  if (outcome.ok) {
    console.log(`PASS  ${name} — ${describe(outcome.json)}`);
  } else {
    failed = true;
    console.log(`FAIL  ${name} — ${outcome.error}`);
  }
}

// --- USDA FoodData Central ---------------------------------------------------

const usdaKey = process.env.USDA_FDC_API_KEY?.trim();
if (!usdaKey) {
  console.log("SKIP  USDA search — USDA_FDC_API_KEY is not set");
} else {
  const params = new URLSearchParams({
    query: "chicken breast",
    pageSize: "3",
    dataType: "Foundation,SR Legacy",
    api_key: usdaKey,
  });
  const outcome = await get(`https://api.nal.usda.gov/fdc/v1/foods/search?${params}`);
  report("USDA search", outcome, (json) => {
    const first = json?.foods?.[0];
    return `${json?.foods?.length ?? 0} foods, first: ${first?.description ?? "(none)"}`;
  });
}

// --- Open Food Facts ---------------------------------------------------------

{
  const params = new URLSearchParams({
    search_terms: "nutella",
    fields: "code,product_name,brands",
    page_size: "3",
    json: "1",
  });
  const outcome = await get(`https://world.openfoodfacts.org/api/v2/search?${params}`, {
    "user-agent": OFF_USER_AGENT,
  });
  report("OFF search", outcome, (json) => {
    const first = json?.products?.[0];
    return `${json?.products?.length ?? 0} products, first: ${first?.product_name ?? "(none)"}`;
  });
}

{
  const outcome = await get(
    "https://world.openfoodfacts.org/api/v2/product/3017620422003?fields=code,product_name,brands",
    { "user-agent": OFF_USER_AGENT },
  );
  report("OFF barcode lookup", outcome, (json) =>
    json?.status === 0 ? "product not found (unexpected for Nutella)" : `found: ${json?.product?.product_name ?? "(unnamed)"}`,
  );
}

process.exit(failed ? 1 : 0);
