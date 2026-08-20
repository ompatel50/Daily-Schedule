"use server";

import { buildSearchHits, type SearchHit } from "@/lib/logic/search";
import { getToday, searchEverything } from "@/server/queries";

/**
 * Cross-domain search for the command palette, spanning every user-facing
 * module (the SEARCH_GROUPS list in src/lib/logic/search.ts is the roster).
 * Returns a flat, render-ready list so the client component stays dumb;
 * relative-day labels are resolved against the *user's* today, and the typed
 * term rides along so exact title matches rank first.
 */
export async function globalSearch(query: string): Promise<SearchHit[]> {
  const [rows, referenceDay] = await Promise.all([searchEverything(query), getToday()]);
  return buildSearchHits(rows, referenceDay, query);
}
