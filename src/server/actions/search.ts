"use server";

import { buildSearchHits, type SearchHit } from "@/lib/logic/search";
import { getToday, searchEverything } from "@/server/queries";

/**
 * Cross-domain search for the command palette: planner items, routines,
 * habits, goals, workouts, workout templates, foods, meal templates and
 * journal entries. Returns a flat, render-ready list so the client component
 * stays dumb; relative-day labels are resolved against the *user's* today.
 */
export async function globalSearch(query: string): Promise<SearchHit[]> {
  const [rows, referenceDay] = await Promise.all([searchEverything(query), getToday()]);
  return buildSearchHits(rows, referenceDay);
}
