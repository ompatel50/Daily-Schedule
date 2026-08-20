import type { DayKey } from "@/lib/date";
import { spanDurationMinutes } from "@/lib/logic/schedule-span";
import { round, sum } from "@/lib/utils";

/**
 * The unified daily fact layer — Phase 2's shared foundation.
 *
 * One record per user per OPERATIONAL day with every module's summary
 * attached. Storage is the existing `CalendarDaySummary` cache (extended, not
 * paralleled — see the decision note below); this module is the single place
 * that (a) folds raw rows into the summary's new columns and (b) turns a
 * stored row into the typed `DailyFact` the correlation, spending-trigger and
 * anomaly analyses consume, with the null semantics resolved.
 *
 * WHY EXTEND CalendarDaySummary RATHER THAN ADD A PARALLEL TABLE (the task
 * asked for this decision to be deliberate and documented): the summary is
 * already one row per (userId, operational day), already recomputed
 * incrementally by every write path in the app (`recomputeDay`), already
 * idempotent (upsert), already rebuildable in O(days) with bounded
 * concurrency, and already read by the calendar/insights surfaces. A parallel
 * DailyFact table would need the identical trigger network, the identical
 * rebuild machinery and the identical day-key semantics — a hand-maintained
 * twin of exactly the kind this codebase's standing rules forbid. The cost is
 * a wider row; the analyses read a bounded window of them.
 *
 * NULL SEMANTICS — the load-bearing rule: **missing data is explicitly null,
 * never zero.** The storage keeps legacy non-null columns (calories …) for
 * compatibility, so this module carries the discriminators:
 *  * macros are null unless `mealCount > 0` (a day with no meals logged is
 *    unknown, not "ate 0 kcal");
 *  * the score is null unless `scoreApplicable > 0` (an open day, not 0);
 *  * target adherence is null unless `nutritionTargetsTotal > 0`;
 *  * health metrics are nullable end to end;
 *  * counts (tasks, transactions, habits, planner blocks) are true zeros —
 *    "nothing happened" is a fact for them, not an unknown. The one caveat
 *    is finance: an account that never tracks money reads all-zero, and the
 *    analyses must treat an all-zero finance HISTORY as untracked (the
 *    spending-trigger layer checks history-wide activity, not per-day).
 */

// --- the typed record ---------------------------------------------------------

export interface DailyFact {
  date: DayKey;

  // Planner
  plannedCount: number;
  completedCount: number;
  skippedCount: number;
  plannedMinutes: number;
  completedMinutes: number;
  /** Schedule category → planned minutes (timed blocks only). */
  categoryMinutes: Record<string, number>;

  // Habits (pause-aware: paused is its own bucket and never leaks into missed)
  habitsDue: number;
  habitsDone: number;
  habitsSkipped: number;
  habitsMissed: number;
  habitsPaused: number;

  // Nutrition — null when nothing was logged
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  fiber: number | null;
  mealCount: number;
  /** Fraction of applicable, measured targets met; null when none applied. */
  targetAdherence: number | null;

  // Workouts
  workoutCount: number;
  workoutMinutes: number;
  workoutVolumeKg: number;
  caloriesBurned: number;
  workoutTypes: string[];
  /** training | rest, override-aware; null on pre-upgrade rows. */
  dayType: "training" | "rest" | null;

  // Tasks
  tasksCreated: number;
  tasksCompleted: number;
  tasksDueOpen: number;

  // Finance (integer cents; bookkeeping categories excluded)
  spendCents: number;
  incomeCents: number;
  transactionCount: number;
  spendByCategory: Record<string, number>;

  // Health — null means no reading
  steps: number | null;
  sleepHours: number | null;
  bodyWeight: number | null;
  restingHr: number | null;
  hrv: number | null;
  activeCalories: number | null;
  hydrationMl: number | null;

  // Day score
  score: number | null;
  scoreApplicable: number;
  scoreCompleted: number;
  scoreMissed: number;
  scorePending: number;
  scoreExcluded: number;

  // Journal
  hasJournal: boolean;
}

/** The stored row's shape, structurally (works for any Prisma client type). */
export interface DailyFactRowLike {
  date: string;
  plannedCount: number;
  completedCount: number;
  skippedCount: number;
  plannedMinutes: number;
  completedMinutes: number;
  categoryMinutes: string;
  habitsDue: number;
  habitsDone: number;
  habitsSkipped: number;
  habitsMissed: number;
  habitsPaused: number;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  mealCount: number;
  nutritionTargetsMet: number;
  nutritionTargetsTotal: number;
  workoutCount: number;
  workoutMinutes: number;
  workoutVolumeKg: number;
  caloriesBurned: number;
  workoutTypes: string;
  dayType: string | null;
  tasksCreated: number;
  tasksCompleted: number;
  tasksDueOpen: number;
  spendCents: number;
  incomeCents: number;
  transactionCount: number;
  spendByCategory: string;
  steps: number | null;
  sleepHours: number | null;
  bodyWeight: number | null;
  restingHr: number | null;
  hrv: number | null;
  activeCalories: number | null;
  hydrationMl: number | null;
  score: number;
  scoreApplicable: number;
  scoreCompleted: number;
  scoreMissed: number;
  scorePending: number;
  scoreExcluded: number;
  hasJournal: boolean;
}

/**
 * A stored summary row → the typed fact, null semantics resolved. O(1);
 * JSON columns are parsed defensively (a corrupt cell degrades to empty,
 * never throws a page down).
 */
export function dailyFactFromSummary(row: DailyFactRowLike): DailyFact {
  const logged = row.mealCount > 0;
  return {
    date: row.date,

    plannedCount: row.plannedCount,
    completedCount: row.completedCount,
    skippedCount: row.skippedCount,
    plannedMinutes: row.plannedMinutes,
    completedMinutes: row.completedMinutes,
    categoryMinutes: parseNumberMap(row.categoryMinutes),

    habitsDue: row.habitsDue,
    habitsDone: row.habitsDone,
    habitsSkipped: row.habitsSkipped,
    habitsMissed: row.habitsMissed,
    habitsPaused: row.habitsPaused,

    calories: logged ? row.calories : null,
    protein: logged ? row.protein : null,
    carbs: logged ? row.carbs : null,
    fat: logged ? row.fat : null,
    fiber: logged ? row.fiber : null,
    mealCount: row.mealCount,
    targetAdherence:
      row.nutritionTargetsTotal > 0 ? row.nutritionTargetsMet / row.nutritionTargetsTotal : null,

    workoutCount: row.workoutCount,
    workoutMinutes: row.workoutMinutes,
    workoutVolumeKg: row.workoutVolumeKg,
    caloriesBurned: row.caloriesBurned,
    workoutTypes: parseStringArray(row.workoutTypes),
    dayType: row.dayType === "training" || row.dayType === "rest" ? row.dayType : null,

    tasksCreated: row.tasksCreated,
    tasksCompleted: row.tasksCompleted,
    tasksDueOpen: row.tasksDueOpen,

    spendCents: row.spendCents,
    incomeCents: row.incomeCents,
    transactionCount: row.transactionCount,
    spendByCategory: parseNumberMap(row.spendByCategory),

    steps: row.steps,
    sleepHours: row.sleepHours,
    bodyWeight: row.bodyWeight,
    restingHr: row.restingHr,
    hrv: row.hrv,
    activeCalories: row.activeCalories,
    hydrationMl: row.hydrationMl,

    score: row.scoreApplicable > 0 ? row.score : null,
    scoreApplicable: row.scoreApplicable,
    scoreCompleted: row.scoreCompleted,
    scoreMissed: row.scoreMissed,
    scorePending: row.scorePending,
    scoreExcluded: row.scoreExcluded,

    hasJournal: row.hasJournal,
  };
}

// --- fold helpers used by recomputeDay ---------------------------------------

export interface PlannerMinuteFacts {
  plannedMinutes: number;
  completedMinutes: number;
  /** category → planned minutes. */
  categoryMinutes: Record<string, number>;
}

/**
 * Minutes over one day's planner rows — timed blocks only (the utilisation
 * view's rule: an all-day block is counted, never summed), cross-midnight
 * spans measured by the shared span math. Skipped blocks carry no minutes in
 * either bucket. O(rows).
 */
export function plannerMinuteFacts(
  items: Array<{
    status: string;
    allDay: boolean;
    startMinute: number | null;
    endMinute: number | null;
    category: string;
  }>,
): PlannerMinuteFacts {
  const facts: PlannerMinuteFacts = {
    plannedMinutes: 0,
    completedMinutes: 0,
    categoryMinutes: {},
  };
  for (const item of items) {
    if (item.status === "skipped") continue;
    if (item.allDay || item.startMinute === null || item.endMinute === null) continue;
    const duration = spanDurationMinutes(item.startMinute, item.endMinute);
    if (duration === null || duration <= 0) continue;
    facts.plannedMinutes += duration;
    facts.categoryMinutes[item.category] =
      (facts.categoryMinutes[item.category] ?? 0) + duration;
    if (item.status === "done") facts.completedMinutes += duration;
  }
  return facts;
}

/** The bookkeeping categories that never count as spending or income. */
export const BOOKKEEPING_CATEGORIES: ReadonlySet<string> = new Set(["transfer", "adjustment"]);

export interface FinanceDayFacts {
  spendCents: number;
  incomeCents: number;
  transactionCount: number;
  /** category → spend cents (magnitudes; spending categories only). */
  spendByCategory: Record<string, number>;
}

/**
 * One day's ledger folded into spend/income totals. Bookkeeping rows
 * (transfers, adjustments) count toward `transactionCount` but never toward
 * spend or income — the same rule budgets and the finance insights apply.
 * O(rows).
 */
export function financeDayFacts(
  transactions: Array<{ category: string; amountCents: number }>,
): FinanceDayFacts {
  const facts: FinanceDayFacts = {
    spendCents: 0,
    incomeCents: 0,
    transactionCount: transactions.length,
    spendByCategory: {},
  };
  for (const transaction of transactions) {
    if (BOOKKEEPING_CATEGORIES.has(transaction.category)) continue;
    if (transaction.amountCents < 0) {
      const magnitude = -transaction.amountCents;
      facts.spendCents += magnitude;
      facts.spendByCategory[transaction.category] =
        (facts.spendByCategory[transaction.category] ?? 0) + magnitude;
    } else {
      facts.incomeCents += transaction.amountCents;
    }
  }
  return facts;
}

export interface WorkoutDayFacts {
  workoutVolumeKg: number;
  /** Distinct completed types, in first-seen order. */
  workoutTypes: string[];
}

/** Volume and the type mix over one day's completed workouts. O(sets). */
export function workoutDayFacts(
  workouts: Array<{
    type: string;
    sets: Array<{ reps: number | null; weightKg: number | null; completed: boolean }>;
  }>,
): WorkoutDayFacts {
  const types: string[] = [];
  let volume = 0;
  for (const workout of workouts) {
    if (!types.includes(workout.type)) types.push(workout.type);
    volume += sum(
      workout.sets.filter((set) => set.completed),
      (set) => (set.reps ?? 0) * (set.weightKg ?? 0),
    );
  }
  return { workoutVolumeKg: round(volume, 1), workoutTypes: types };
}

// --- internals ----------------------------------------------------------------

function parseNumberMap(raw: string): Record<string, number> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const map: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value)) map[key] = value;
    }
    return map;
  } catch {
    return {};
  }
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}
