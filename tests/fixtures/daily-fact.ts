import { shiftDay } from "@/lib/date";
import type { DailyFact } from "@/lib/logic/daily-facts";

/** A fact with nothing measured: counts zero, measurements null. */
export function emptyFact(date: string): DailyFact {
  return {
    date,
    plannedCount: 0,
    completedCount: 0,
    skippedCount: 0,
    plannedMinutes: 0,
    completedMinutes: 0,
    categoryMinutes: {},
    habitsDue: 0,
    habitsDone: 0,
    habitsSkipped: 0,
    habitsMissed: 0,
    habitsPaused: 0,
    calories: null,
    protein: null,
    carbs: null,
    fat: null,
    fiber: null,
    mealCount: 0,
    targetAdherence: null,
    workoutCount: 0,
    workoutMinutes: 0,
    workoutVolumeKg: 0,
    caloriesBurned: 0,
    workoutTypes: [],
    dayType: null,
    tasksCreated: 0,
    tasksCompleted: 0,
    tasksDueOpen: 0,
    spendCents: 0,
    incomeCents: 0,
    transactionCount: 0,
    spendByCategory: {},
    steps: null,
    sleepHours: null,
    bodyWeight: null,
    restingHr: null,
    hrv: null,
    activeCalories: null,
    hydrationMl: null,
    score: null,
    scoreApplicable: 0,
    scoreCompleted: 0,
    scoreMissed: 0,
    scorePending: 0,
    scoreExcluded: 0,
    hasJournal: false,
  };
}

/** `days` consecutive facts from `start`, shaped by the builder. */
export function factsFrom(
  start: string,
  days: number,
  build: (index: number, date: string) => Partial<DailyFact>,
): DailyFact[] {
  return Array.from({ length: days }, (_, index) => {
    const date = shiftDay(start, index);
    return { ...emptyFact(date), ...build(index, date) };
  });
}
