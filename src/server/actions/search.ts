"use server";

import { searchEverything } from "@/server/queries";
import { relativeDayLabel } from "@/lib/date";

export interface SearchHit {
  id: string;
  group: "Planner" | "Workouts" | "Foods" | "Habits" | "Journal";
  title: string;
  subtitle: string;
  href: string;
}

/**
 * Cross-domain search for the command palette. Returns a flat, render-ready
 * list so the client component stays dumb.
 */
export async function globalSearch(query: string): Promise<SearchHit[]> {
  const results = await searchEverything(query);
  const hits: SearchHit[] = [];

  for (const item of results.items) {
    hits.push({
      id: `item-${item.id}`,
      group: "Planner",
      title: item.title,
      subtitle: `${relativeDayLabel(item.date)} · ${item.category}`,
      href: `/planner?date=${item.date}`,
    });
  }

  for (const workout of results.workouts) {
    hits.push({
      id: `workout-${workout.id}`,
      group: "Workouts",
      title: workout.name,
      subtitle: `${relativeDayLabel(workout.date)} · ${workout.durationMin} min`,
      href: `/workouts?date=${workout.date}`,
    });
  }

  for (const habit of results.habits) {
    hits.push({
      id: `habit-${habit.id}`,
      group: "Habits",
      title: habit.name,
      subtitle: habit.category,
      href: "/habits",
    });
  }

  for (const food of results.foods) {
    hits.push({
      id: `food-${food.id}`,
      group: "Foods",
      title: food.name,
      subtitle: `${Math.round(food.calories)} kcal · ${food.brand ?? food.category}`,
      href: "/nutrition",
    });
  }

  for (const entry of results.journal) {
    hits.push({
      id: `journal-${entry.id}`,
      group: "Journal",
      title: entry.title || entry.content.slice(0, 60),
      subtitle: relativeDayLabel(entry.date),
      href: `/today?date=${entry.date}`,
    });
  }

  return hits;
}
