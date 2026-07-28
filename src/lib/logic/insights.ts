import { average, pct } from "@/lib/utils";
import { linearTrend, trendDelta } from "./scoring";

/**
 * Turns raw summaries into the short, plain-language observations shown on the
 * Insights page. Kept pure so the wording is easy to test and tune.
 */
export interface WindowTotals {
  planned: number;
  completed: number;
  habitsDue: number;
  habitsDone: number;
  workouts: number;
  workoutMinutes: number;
  caloriesEaten: number;
  loggedDays: number;
  activeDays: number;
  averageScore: number;
}

export interface Insight {
  id: string;
  tone: "positive" | "neutral" | "attention";
  title: string;
  detail: string;
}

export function buildInsights(
  current: WindowTotals,
  previous: WindowTotals,
  extras: {
    /** Per-day scores in the current window, oldest first. */
    scores: number[];
    bestHabit?: { name: string; streak: number };
    weakestHabit?: { name: string; completionRate: number };
    calorieGoal?: number;
    workoutGoal?: number;
  },
): Insight[] {
  const insights: Insight[] = [];

  // --- planner --------------------------------------------------------------
  const rate = current.planned > 0 ? pct(current.completed, current.planned) : 0;
  const previousRate = previous.planned > 0 ? pct(previous.completed, previous.planned) : 0;
  if (current.planned > 0) {
    const delta = trendDelta(rate, previousRate);
    insights.push({
      id: "planner",
      tone: rate >= 75 ? "positive" : rate >= 50 ? "neutral" : "attention",
      title: `${rate}% of planned items completed`,
      detail:
        previous.planned === 0
          ? `${current.completed} of ${current.planned} items done this week.`
          : delta === 0
            ? "Same as last week."
            : `${delta > 0 ? "Up" : "Down"} ${Math.abs(delta)}% versus last week (${previousRate}%).`,
    });
  }

  // --- habits ---------------------------------------------------------------
  if (current.habitsDue > 0) {
    const habitRate = pct(current.habitsDone, current.habitsDue);
    const previousHabitRate = previous.habitsDue > 0 ? pct(previous.habitsDone, previous.habitsDue) : 0;
    insights.push({
      id: "habits",
      tone: habitRate >= 80 ? "positive" : habitRate >= 55 ? "neutral" : "attention",
      title: `Habits at ${habitRate}%`,
      detail:
        previous.habitsDue === 0
          ? `${current.habitsDone} of ${current.habitsDue} due habits completed.`
          : `Last week was ${previousHabitRate}%.`,
    });
  }

  if (extras.bestHabit && extras.bestHabit.streak >= 3) {
    insights.push({
      id: "best-habit",
      tone: "positive",
      title: `${extras.bestHabit.name} is on a ${extras.bestHabit.streak}-day streak`,
      detail: "Your most reliable habit right now — protect it.",
    });
  }

  if (extras.weakestHabit && extras.weakestHabit.completionRate < 50) {
    insights.push({
      id: "weak-habit",
      tone: "attention",
      title: `${extras.weakestHabit.name} is slipping`,
      detail: `Only ${extras.weakestHabit.completionRate}% completion. Consider making it smaller, or moving it earlier in the day.`,
    });
  }

  // --- training -------------------------------------------------------------
  if (extras.workoutGoal && extras.workoutGoal > 0) {
    const hit = current.workouts >= extras.workoutGoal;
    insights.push({
      id: "training",
      tone: hit ? "positive" : current.workouts >= extras.workoutGoal - 1 ? "neutral" : "attention",
      title: hit
        ? `Training goal hit — ${current.workouts} sessions`
        : `${current.workouts} of ${extras.workoutGoal} sessions`,
      detail: `${Math.round(current.workoutMinutes)} minutes trained${
        previous.workouts > 0 ? `, versus ${previous.workouts} sessions last week` : ""
      }.`,
    });
  } else if (current.workouts > 0) {
    insights.push({
      id: "training",
      tone: "neutral",
      title: `${current.workouts} workouts logged`,
      detail: `${Math.round(current.workoutMinutes)} minutes of training this week.`,
    });
  }

  // --- nutrition ------------------------------------------------------------
  if (current.loggedDays > 0) {
    const avgCalories = Math.round(current.caloriesEaten / current.loggedDays);
    const goal = extras.calorieGoal ?? 0;
    const withinRange = goal > 0 && Math.abs(avgCalories - goal) / goal <= 0.1;
    insights.push({
      id: "nutrition",
      tone: current.loggedDays >= 5 ? (withinRange ? "positive" : "neutral") : "attention",
      title:
        current.loggedDays >= 5
          ? `Logged food on ${current.loggedDays} of 7 days`
          : `Only ${current.loggedDays} days of food logged`,
      detail:
        goal > 0
          ? `Averaging ${avgCalories} kcal against a ${goal} kcal goal.`
          : `Averaging ${avgCalories} kcal on the days you logged.`,
    });
  }

  // --- momentum -------------------------------------------------------------
  if (extras.scores.length >= 5) {
    const slope = linearTrend(extras.scores.map((score, index) => ({ x: index, y: score })));
    if (Math.abs(slope) >= 0.8) {
      insights.push({
        id: "momentum",
        tone: slope > 0 ? "positive" : "attention",
        title: slope > 0 ? "Momentum is building" : "Momentum is slipping",
        detail: `Your day score is trending ${slope > 0 ? "up" : "down"} by about ${Math.abs(
          Math.round(slope),
        )} points per day across this window.`,
      });
    }
  }

  return insights;
}

/** One-line "focus on this next" recommendation. */
export function suggestFocus(insights: Insight[]): string {
  const attention = insights.find((insight) => insight.tone === "attention");
  if (attention) return attention.title;

  const neutral = insights.find((insight) => insight.tone === "neutral");
  if (neutral) return `Keep pushing: ${neutral.title.toLowerCase()}`;

  return insights.length > 0
    ? "Everything is trending well — hold the line."
    : "Log a few days to unlock insights.";
}

/**
 * "You usually do X around this time" suggestions, derived from what the user
 * has actually scheduled on this weekday before.
 */
export function suggestRoutineItems(
  history: Array<{ title: string; weekday: number; startMinute: number | null; category: string }>,
  weekday: number,
  limit = 5,
): Array<{ title: string; startMinute: number | null; category: string; count: number }> {
  const counts = new Map<
    string,
    { title: string; startMinute: number | null; category: string; count: number }
  >();

  for (const row of history) {
    if (row.weekday !== weekday) continue;
    const key = row.title.trim().toLowerCase();
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else
      counts.set(key, {
        title: row.title,
        startMinute: row.startMinute,
        category: row.category,
        count: 1,
      });
  }

  return Array.from(counts.values())
    .filter((row) => row.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export function averageOrNull(values: number[]): number | null {
  return values.length === 0 ? null : average(values);
}
