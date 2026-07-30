/**
 * The contract every food source implements.
 *
 * The UI never sees a provider. It asks the registry for foods and gets
 * `NormalizedFood` back, so a third source later is a new file here rather than
 * a change to the search box, the log dialog or the meal totals.
 *
 * Providers are also the app's only outbound network calls, which is why the
 * privacy rule is stated in the type itself: a provider receives a query, a
 * barcode or a public identifier, and nothing else. There is no field on
 * `ProviderSearchOptions` through which a meal, a goal, a weight or a user id
 * could travel.
 */

import type { FoodProviderId, NormalizedFood } from "@/lib/logic/food";

export interface ProviderSearchOptions {
  /** Hard cap on results the provider should return. */
  limit?: number;
  /** Abort signal so a slow provider cannot hold up the whole search. */
  signal?: AbortSignal;
  /** Prefer branded products (a barcode-ish query) over generic ingredients. */
  preferBranded?: boolean;
}

/**
 * Runtime mirror of the interface above, asserted at the type level so it
 * cannot drift. Tests read this to prove the privacy boundary structurally:
 * adding any field through which personal data could travel fails the suite.
 */
export const SEARCH_OPTION_KEYS = ["limit", "signal", "preferBranded"] as const satisfies
  readonly (keyof ProviderSearchOptions)[];
type AssertsAllKeysListed = Exclude<keyof ProviderSearchOptions, (typeof SEARCH_OPTION_KEYS)[number]> extends never
  ? true
  : never;
const _searchOptionKeysComplete: AssertsAllKeysListed = true;
void _searchOptionKeysComplete;

/**
 * Why a provider produced nothing. Distinguishing these is the difference
 * between "no such food" and "we could not ask", which the UI must not blur.
 */
export type ProviderFailureReason =
  | "not_configured"
  | "unauthorized"
  | "rate_limited"
  | "unavailable"
  | "timeout"
  | "bad_response";

export interface ProviderFailure {
  reason: ProviderFailureReason;
  /** Safe to show a user. Never contains a key, a URL with a key, or a body. */
  message: string;
  /** Seconds to wait, when the provider said. */
  retryAfter?: number;
}

export type ProviderOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; failure: ProviderFailure };

export interface ProviderStatus {
  id: FoodProviderId;
  label: string;
  /** False when the provider cannot run at all — e.g. no API key configured. */
  configured: boolean;
  /** Operator-facing hint shown in the setup state. Never a secret. */
  setupHint?: string;
}

export interface FoodProvider {
  readonly id: FoodProviderId;
  readonly label: string;
  /** Generic ingredients, branded products, or both. */
  readonly covers: "generic" | "branded" | "both";

  status(): ProviderStatus;
  search(query: string, options?: ProviderSearchOptions): Promise<ProviderOutcome<NormalizedFood[]>>;
  /** A single record by the provider's own id. */
  details(externalId: string, options?: ProviderSearchOptions): Promise<ProviderOutcome<NormalizedFood | null>>;
}

export function failure(
  reason: ProviderFailureReason,
  message: string,
  retryAfter?: number,
): { ok: false; failure: ProviderFailure } {
  return { ok: false, failure: { reason, message, retryAfter } };
}

export function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

/**
 * Turn a thrown error or a non-OK response into a typed failure.
 *
 * Nothing from the provider's body reaches the message: an upstream error page
 * can contain the request URL, and the request URL for USDA contains the API
 * key. The reason code carries the meaning; the text is ours.
 */
export function classifyHttpStatus(status: number, retryAfter?: number): ProviderFailure {
  if (status === 401 || status === 403) {
    return {
      reason: "unauthorized",
      message: "The provider rejected the API key.",
    };
  }
  if (status === 429) {
    return {
      reason: "rate_limited",
      message: "The provider is rate-limiting requests. Try again shortly.",
      retryAfter,
    };
  }
  return {
    reason: "unavailable",
    message: `The provider returned an error (HTTP ${status}).`,
  };
}

export function classifyThrown(error: unknown): ProviderFailure {
  if (error instanceof Error && error.name === "AbortError") {
    return { reason: "timeout", message: "The provider did not respond in time." };
  }
  return { reason: "unavailable", message: "Could not reach the provider." };
}
