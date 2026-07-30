import { relativeDayLabel, type DayKey } from "@/lib/date";

/**
 * Global-search hit building — pure. The server fetches matching rows; this
 * module turns them into render-ready hits with the destination each entity
 * actually lives at, labelled relative to the *user's* today (passed in — the
 * host clock is never consulted).
 */

export const SEARCH_GROUPS = [
  "Planner",
  "Routines",
  "Habits",
  "Goals",
  "Workouts",
  "Templates",
  "Foods",
  "Meal templates",
  "Journal",
] as const;
export type SearchGroup = (typeof SEARCH_GROUPS)[number];

export interface SearchHit {
  id: string;
  group: SearchGroup;
  title: string;
  subtitle: string;
  href: string;
}

export interface SearchRows {
  items: Array<{ id: string; title: string; date: DayKey; category: string }>;
  workouts: Array<{ id: string; name: string; date: DayKey; durationMin: number }>;
  foods: Array<{ id: string; name: string; brand: string | null; category: string; calories: number }>;
  habits: Array<{ id: string; name: string; category: string; archived: boolean }>;
  goals: Array<{ id: string; label: string; domain: string; unit: string; target: number }>;
  journal: Array<{ id: string; title: string | null; content: string; date: DayKey }>;
  routines: Array<{ id: string; name: string; category: string }>;
  workoutTemplates: Array<{ id: string; name: string; type: string }>;
  mealTemplates: Array<{ id: string; name: string; mealType: string }>;
}

export function emptySearchRows(): SearchRows {
  return {
    items: [],
    workouts: [],
    foods: [],
    habits: [],
    goals: [],
    journal: [],
    routines: [],
    workoutTemplates: [],
    mealTemplates: [],
  };
}

/**
 * Flatten matching rows into grouped, render-ready hits. Group order is the
 * declaration order of SEARCH_GROUPS: the things you act on daily first.
 */
export function buildSearchHits(rows: SearchRows, referenceDay: DayKey): SearchHit[] {
  const hits: SearchHit[] = [];

  for (const item of rows.items) {
    hits.push({
      id: `item-${item.id}`,
      group: "Planner",
      title: item.title,
      subtitle: `${relativeDayLabel(item.date, referenceDay)} · ${item.category}`,
      href: `/planner?date=${item.date}`,
    });
  }

  for (const routine of rows.routines) {
    hits.push({
      id: `routine-${routine.id}`,
      group: "Routines",
      title: routine.name,
      subtitle: `Routine · apply it from the planner`,
      href: "/planner",
    });
  }

  for (const habit of rows.habits) {
    hits.push({
      id: `habit-${habit.id}`,
      group: "Habits",
      title: habit.name,
      subtitle: habit.archived ? `${habit.category} · archived` : habit.category,
      href: "/habits",
    });
  }

  for (const goal of rows.goals) {
    hits.push({
      id: `goal-${goal.id}`,
      group: "Goals",
      title: goal.label,
      subtitle: `${goal.domain} · target ${formatTarget(goal.target)}${goal.unit ? ` ${goal.unit}` : ""}`,
      href: "/settings",
    });
  }

  for (const workout of rows.workouts) {
    hits.push({
      id: `workout-${workout.id}`,
      group: "Workouts",
      title: workout.name,
      subtitle: `${relativeDayLabel(workout.date, referenceDay)} · ${workout.durationMin} min`,
      href: `/workouts?date=${workout.date}`,
    });
  }

  for (const template of rows.workoutTemplates) {
    hits.push({
      id: `wt-${template.id}`,
      group: "Templates",
      title: template.name,
      subtitle: `Workout template · ${template.type}`,
      href: "/workouts",
    });
  }

  for (const food of rows.foods) {
    hits.push({
      id: `food-${food.id}`,
      group: "Foods",
      title: food.name,
      subtitle: `${Math.round(food.calories)} kcal · ${food.brand ?? food.category}`,
      href: "/nutrition",
    });
  }

  for (const template of rows.mealTemplates) {
    hits.push({
      id: `mt-${template.id}`,
      group: "Meal templates",
      title: template.name,
      subtitle: `Meal template · ${template.mealType}`,
      href: "/nutrition",
    });
  }

  for (const entry of rows.journal) {
    hits.push({
      id: `journal-${entry.id}`,
      group: "Journal",
      title: entry.title || entry.content.slice(0, 60),
      subtitle: relativeDayLabel(entry.date, referenceDay),
      href: `/today?date=${entry.date}`,
    });
  }

  const order = new Map(SEARCH_GROUPS.map((group, index) => [group, index]));
  return hits.sort((a, b) => (order.get(a.group) ?? 99) - (order.get(b.group) ?? 99));
}

function formatTarget(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
}
