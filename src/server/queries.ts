import "server-only";

import { centsOrLegacy } from "@/lib/logic/money";

import { getCurrentUser, prisma } from "@/lib/db";
import {
  type DayKey,
  dayRange,
  monthGridDays,
  shiftDay,
  today,
  weekRange,
} from "@/lib/date";
import {
  HEALTH_GROUP_META,
  HEALTH_METRIC_META,
  HEALTH_METRIC_TYPES,
  MEAL_TYPE_META,
  type MealType,
} from "@/lib/enums";
import { describeGoalTarget, orderMilestones } from "@/lib/logic/goals";
import { aggregateDay, aggregateDayAll, toDisplay, type HealthRowLike } from "@/lib/logic/health";
import { emptySearchRows, type SearchRows } from "@/lib/logic/search";
import { operationalDayWhere } from "@/lib/logic/operational-day";
import { comparePlannerSpans } from "@/lib/logic/schedule-span";
import {
  createStableDateKey,
  describeSchedule,
  resetMinuteOf,
  resolveEffectiveSchedule,
  type DayStatus,
  type ScheduleMode,
} from "@/lib/logic/schedule";
import { compareDayTypes, totalMacros } from "@/lib/logic/nutrition";
import { parseJson, sum } from "@/lib/utils";
import { getDayScore, scoreOptionsFor } from "@/server/day-score";
import { evaluateGoalsForDate } from "@/server/goals";
import { getHabitViews } from "@/server/habits";
import { loadSchedules, scheduleSettingsFor, toSchedulable } from "@/server/schedule";
import { getSummaries } from "@/server/summaries";

/**
 * Read model for the app. Pages are Server Components and call these directly;
 * nothing here mutates, so it is all cache-friendly and easy to reason about.
 */

export type CurrentUser = Awaited<ReturnType<typeof getCurrentUser>>;

export async function getUser() {
  return getCurrentUser();
}

/**
 * "Today" in the user's configured timezone.
 *
 * Pages must use this rather than the host clock: a user whose Settings
 * timezone differs from the machine's would otherwise be shown the wrong day
 * around midnight, which silently shifts every score and streak by one date.
 */
export async function getToday(): Promise<DayKey> {
  const user = await getCurrentUser();
  return scheduleSettingsFor(user).today;
}

export async function getWeekStart(): Promise<0 | 1> {
  const user = await getCurrentUser();
  return user.weekStartsOn === 0 ? 0 : 1;
}

// --- planner ----------------------------------------------------------------

const SCHEDULE_ITEM_INCLUDE = {
  tags: { include: { tag: true } },
  workout: { select: { id: true, type: true, durationMin: true } },
  habit: { select: { id: true, name: true, color: true } },
  // The linked task ("add to planner"): the block shows what it schedules,
  // and the done-checkbox offer needs to know the task is still open.
  // `deletedAt` rides along because Prisma cannot filter a to-one include —
  // consumers null the link when the task sits in the Trash
  // (src/lib/soft-delete.ts documents this boundary).
  task: { select: { id: true, title: true, status: true, deletedAt: true } },
  // An occurrence's own recurrenceRule is null; the SERIES' rule lives on the
  // parent. The edit dialog pre-fills its recurrence controls from it, which
  // is what makes a "this and future" edit inherit the pattern and end date
  // instead of silently un-repeating the series.
  series: { select: { recurrenceRule: true } },
} as const;

// A coarse database-side pre-sort only — the authoritative chronological
// order is `comparePlannerSpans` (src/lib/logic/schedule-span.ts), applied
// in-memory below, because SQL cannot rank a wrapped cross-midnight end
// (endMinute < startMinute means "ends next day", which must sort AFTER a
// same-start same-day end). `nulls: "first"` pins the SQLite ordering the UI
// was built on: untimed items sort ahead of timed ones. Date-ascending gives
// operational order for free: an operational day's after-midnight tail lives
// on the next calendar date, so it sorts last.
const SCHEDULE_ITEM_ORDER = [
  { date: "asc" },
  { allDay: "desc" },
  { startMinute: { sort: "asc", nulls: "first" } },
  { sortOrder: "asc" },
  { id: "asc" },
] as const;

export async function getScheduleItems(from: DayKey, to: DayKey) {
  const user = await getCurrentUser();
  const items = await prisma.scheduleItem.findMany({
    where: { userId: user.id, date: { gte: from, lte: to } },
    include: SCHEDULE_ITEM_INCLUDE,
    orderBy: [...SCHEDULE_ITEM_ORDER],
  });
  return items.sort((a, b) => comparePlannerSpans(a, b));
}

export type ScheduleItemWithRelations = Awaited<ReturnType<typeof getScheduleItems>>[number];

/**
 * One OPERATIONAL day's schedule: the date's own records plus the
 * after-midnight tail on the next calendar date (before the user's daily
 * reset). Timestamps are reported untouched — grouping only.
 */
export async function getDaySchedule(date: DayKey) {
  const user = await getCurrentUser();
  const reset = resetMinuteOf(scheduleSettingsFor(user));
  const items = await prisma.scheduleItem.findMany({
    where: { userId: user.id, ...operationalDayWhere(date, reset) },
    include: SCHEDULE_ITEM_INCLUDE,
    orderBy: [...SCHEDULE_ITEM_ORDER],
  });
  return items.sort((a, b) => comparePlannerSpans(a, b));
}

export async function getScheduleTemplates() {
  const user = await getCurrentUser();
  const templates = await prisma.scheduleTemplate.findMany({
    where: { userId: user.id },
    orderBy: [{ useCount: "desc" }, { name: "asc" }],
  });
  return templates.map((template) => ({
    ...template,
    parsedItems: parseJson<Array<Record<string, unknown>>>(template.items, []),
  }));
}

export async function getTags() {
  const user = await getCurrentUser();
  return prisma.tag.findMany({ where: { userId: user.id }, orderBy: { name: "asc" } });
}

// --- habits -----------------------------------------------------------------

export interface HabitWithStats {
  id: string;
  name: string;
  description: string | null;
  category: string;
  timeOfDay: string;
  targetValue: number | null;
  unit: string | null;
  color: string;
  icon: string;
  startDate: string;
  endDate: string | null;
  /** Pause window — days inside are neither due nor missed. */
  pausedFrom: string | null;
  pausedUntil: string | null;
  archived: boolean;
  sortOrder: number;

  /** True only when the habit places a real requirement on this date. */
  dueToday: boolean;
  /** True for a times-per-week habit — available today, judged weekly. */
  flexibleToday: boolean;
  todayStatus: string | null;
  /** Resolved status: completed / missed / pending / rest / not_scheduled … */
  status: DayStatus;
  statusLabel: string;

  streak: number;
  longestStreak: number;
  streakUnit: "occurrences" | "weeks";
  /** Null when the window contained no scheduled opportunity at all. */
  completionRate: number | null;
  opportunities: number;

  weekDone: number;
  weekTarget: number;
  scheduleSummary: string;
  schedule: ScheduleDraftShape;

  recentLogs: Array<{ date: string; status: string }>;
  dayStates: Array<{ date: string; status: DayStatus; label: string }>;
}

/** The schedule fields the habit editor round-trips. */
export interface ScheduleDraftShape {
  mode: ScheduleMode;
  weekdays: number[];
  interval: number;
  timesPerWeek: number | null;
  monthDay: number | null;
  enabled: boolean;
  daypart: string;
  timeMinute: number | null;
  reminderEnabled: boolean;
  reminderMinute: number | null;
}

/**
 * Habits with their stats for `date`, ready to render.
 *
 * A thin adapter over `getHabitViews` so every caller shares the one schedule
 * engine. It used to compute due-ness and streaks here directly, which is how
 * a "3 times per week" habit ended up marked missed four days a week.
 */
export async function getHabitsWithStats(
  date: DayKey = today(),
  options: { includeArchived?: boolean; historyDays?: number; stripDays?: number } = {},
): Promise<HabitWithStats[]> {
  const user = await getCurrentUser();
  const settings = scheduleSettingsFor(user);
  const views = await getHabitViews(user.id, date, settings, options);

  return views.map((view) => ({
    id: view.id,
    name: view.name,
    description: view.description,
    category: view.category,
    timeOfDay: view.daypart,
    targetValue: view.targetValue,
    unit: view.unit,
    color: view.color,
    icon: view.icon,
    startDate: view.startDate,
    endDate: view.endDate,
    pausedFrom: view.pausedFrom,
    pausedUntil: view.pausedUntil,
    archived: view.archived,
    sortOrder: view.sortOrder,

    dueToday: view.dueToday,
    flexibleToday: view.flexibleToday,
    todayStatus: view.loggedStatus,
    status: view.status,
    statusLabel: view.statusLabel,

    streak: view.streak,
    longestStreak: view.longestStreak,
    streakUnit: view.streakUnit,
    completionRate: view.completionRate,
    opportunities: view.opportunities,

    weekDone: view.weekly.done,
    weekTarget: view.weekly.target,
    scheduleSummary: view.scheduleSummary,
    schedule: {
      mode: (view.rule?.mode ?? "every_day") as ScheduleMode,
      weekdays: view.rule?.weekdays ?? [],
      interval: view.rule?.interval ?? 1,
      timesPerWeek: view.rule?.timesPerWeek ?? null,
      monthDay: view.rule?.monthDay ?? null,
      enabled: view.rule?.enabled ?? true,
      daypart: view.rule?.daypart ?? view.daypart,
      timeMinute: view.rule?.timeMinute ?? null,
      reminderEnabled: view.rule?.reminderEnabled ?? false,
      reminderMinute: view.rule?.reminderMinute ?? null,
    },

    recentLogs: view.recentLogs,
    dayStates: view.dayStates,
  }));
}

export async function getHabitLogs(from: DayKey, to: DayKey) {
  const user = await getCurrentUser();
  return prisma.habitLog.findMany({
    where: { userId: user.id, date: { gte: from, lte: to } },
    orderBy: { date: "asc" },
  });
}

// --- nutrition --------------------------------------------------------------

export async function getMealsForDay(date: DayKey) {
  const user = await getCurrentUser();
  const meals = await prisma.meal.findMany({
    where: { userId: user.id, date },
    include: {
      entries: { include: { foodItem: true }, orderBy: { sortOrder: "asc" } },
    },
  });

  return meals
    .map((meal) => ({
      ...meal,
      totals: totalMacros(meal.entries),
    }))
    .sort(
      (a, b) =>
        (MEAL_TYPE_META[a.type as MealType]?.order ?? 9) -
        (MEAL_TYPE_META[b.type as MealType]?.order ?? 9),
    );
}

export type MealWithEntries = Awaited<ReturnType<typeof getMealsForDay>>[number];

export async function getDayNutrition(date: DayKey) {
  const meals = await getMealsForDay(date);
  return { meals, totals: totalMacros(meals.flatMap((meal) => meal.entries)) };
}

/**
 * Local food search. There is no third-party nutrition API by design — the app
 * is private and offline-capable — so this searches the bundled database plus
 * the user's own custom foods.
 */
export async function searchFoods(query: string, limit = 30) {
  const user = await getCurrentUser();
  const term = query.trim().toLowerCase();

  const where = {
    OR: [{ userId: null }, { userId: user.id }],
    // searchKey is written lowercase and the term is lowercased above, so a
    // plain (index-friendlier) contains is already case-insensitive here.
    ...(term ? { searchKey: { contains: term } } : {}),
  };

  const foods = await prisma.foodItem.findMany({
    where,
    take: limit,
    orderBy: [{ verified: "desc" }, { name: "asc" }],
  });

  if (!term) return foods;

  // Prefix matches first — "chic" should surface "Chicken breast" above
  // "Grilled chicken salad".
  return foods.sort((a, b) => {
    const aStarts = a.name.toLowerCase().startsWith(term) ? 0 : 1;
    const bStarts = b.name.toLowerCase().startsWith(term) ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;
    return a.name.length - b.name.length;
  });
}

export async function getFoodShortcuts() {
  const user = await getCurrentUser();
  const favorites = await prisma.favoriteItem.findMany({
    where: { userId: user.id, kind: "food" },
    // Never-used favourites (null lastUsedAt) stay at the end, as on SQLite.
    orderBy: [{ lastUsedAt: { sort: "desc", nulls: "last" } }],
    take: 60,
  });

  const ids = favorites.map((favorite) => favorite.refId);
  // Same ownership scope as loadRecentFoodsAction: the user's foods and
  // global rows only, so a stray refId can never render another account's
  // custom food here.
  const foods = ids.length
    ? await prisma.foodItem.findMany({
        where: { id: { in: ids }, OR: [{ userId: null }, { userId: user.id }] },
      })
    : [];
  const byId = new Map(foods.map((food) => [food.id, food]));

  const pinned = favorites
    .filter((favorite) => favorite.sortOrder >= 0)
    .map((favorite) => byId.get(favorite.refId))
    .filter((food): food is NonNullable<typeof food> => Boolean(food));

  const recent = favorites
    .slice()
    .sort((a, b) => (b.lastUsedAt?.getTime() ?? 0) - (a.lastUsedAt?.getTime() ?? 0))
    .map((favorite) => byId.get(favorite.refId))
    .filter((food): food is NonNullable<typeof food> => Boolean(food))
    .slice(0, 12);

  return { favorites: pinned, recent, favoriteIds: new Set(pinned.map((food) => food.id)) };
}

export async function getMealTemplates() {
  const user = await getCurrentUser();
  return prisma.mealTemplate.findMany({
    where: { userId: user.id },
    include: { items: { include: { foodItem: true } } },
    orderBy: [{ useCount: "desc" }, { name: "asc" }],
  });
}

export async function getCustomFoods() {
  const user = await getCurrentUser();
  return prisma.foodItem.findMany({
    where: { userId: user.id, isCustom: true },
    orderBy: { name: "asc" },
  });
}

// --- workouts ---------------------------------------------------------------

export async function getWorkouts(from: DayKey, to: DayKey) {
  const user = await getCurrentUser();
  return prisma.workout.findMany({
    where: { userId: user.id, date: { gte: from, lte: to } },
    include: { sets: { orderBy: { sortOrder: "asc" } } },
    // Untimed workouts (null time) stay below timed ones within a day, as on
    // SQLite — Postgres would otherwise float them to the top.
    orderBy: [{ date: "desc" }, { time: { sort: "desc", nulls: "last" } }],
  });
}

export type WorkoutWithSets = Awaited<ReturnType<typeof getWorkouts>>[number];

export async function getRecentWorkouts(limit = 20) {
  const user = await getCurrentUser();
  return prisma.workout.findMany({
    where: { userId: user.id },
    include: { sets: { orderBy: { sortOrder: "asc" } } },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    take: limit,
  });
}

export async function getWorkoutTemplates() {
  const user = await getCurrentUser();
  const templates = await prisma.workoutTemplate.findMany({
    where: { userId: user.id },
    orderBy: [{ useCount: "desc" }, { name: "asc" }],
  });
  return templates.map((template) => ({
    ...template,
    parsedExercises: parseJson<
      Array<{ exercise: string; sets: number; reps?: number; weightKg?: number }>
    >(template.exercises, []),
  }));
}

/** Distinct exercise names, for autocomplete in the workout editor. */
export async function getExerciseNames(): Promise<string[]> {
  const user = await getCurrentUser();
  const rows = await prisma.workoutSet.findMany({
    where: { workout: { userId: user.id } },
    select: { exercise: true },
    distinct: ["exercise"],
    orderBy: { exercise: "asc" },
    take: 200,
  });
  return rows.map((row) => row.exercise);
}

// --- health -----------------------------------------------------------------

export async function getHealthMetrics(from: DayKey, to: DayKey, types?: string[]) {
  const user = await getCurrentUser();
  return prisma.healthMetric.findMany({
    where: {
      userId: user.id,
      date: { gte: from, lte: to },
      ...(types && types.length ? { type: { in: types } } : {}),
    },
    orderBy: { date: "asc" },
  });
}

// Latest-per-metric moved to `getLatestMetricValues` in src/server/health.ts,
// which aggregates a day's rows through the central module and converts to the
// user's display units instead of returning whichever raw row sorted first.

export async function getGoals() {
  const user = await getCurrentUser();
  return prisma.goal.findMany({
    where: { userId: user.id, archivedAt: null },
    orderBy: [{ domain: "asc" }, { sortOrder: "asc" }],
  });
}

/** Habit names for the "which habit completes this goal?" picker. */
export async function getHabitOptions() {
  const user = await getCurrentUser();
  return prisma.habit.findMany({
    where: { userId: user.id, archived: false },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
}

/** Goals plus their resolved schedule — the shape the Goals editor renders. */
export async function getGoalRows() {
  const user = await getCurrentUser();
  const settings = scheduleSettingsFor(user);

  const goals = await prisma.goal.findMany({
    where: { userId: user.id },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: { milestones: { orderBy: [{ ordinal: "asc" }, { targetValue: "asc" }] } },
  });

  const schedules = await loadSchedules(
    user.id,
    "goal",
    goals.map((goal) => goal.id),
  );

  return goals.map((goal) => {
    const item = toSchedulable(
      { id: goal.id, startDate: goal.startDate, endDate: goal.endDate, enabled: goal.active },
      schedules.get(goal.id),
    );
    const rule = resolveEffectiveSchedule(item, settings.today);
    const like = {
      id: goal.id,
      label: goal.label,
      description: goal.description,
      domain: goal.domain,
      metric: goal.metric,
      target: goal.target,
      targetMax: goal.targetMax,
      unit: goal.unit,
      direction: goal.direction,
      period: goal.period,
      source: goal.source,
      sourceRef: goal.sourceRef,
      dayType: goal.dayType,
    };

    return {
      ...like,
      startDate: goal.startDate,
      endDate: goal.endDate,
      active: goal.active,
      archived: goal.archivedAt !== null,
      scheduleSummary: describeSchedule(rule),
      targetSummary: describeGoalTarget(like),
      // In progress order — the panel shows the next unreached one first.
      milestones: orderMilestones(goal.milestones, goal.direction).map((milestone) => ({
        id: milestone.id,
        label: milestone.label,
        targetValue: milestone.targetValue,
        targetDate: milestone.targetDate,
        ordinal: milestone.ordinal,
        reminderEnabled: milestone.reminderEnabled,
        reachedAt: milestone.reachedAt ? milestone.reachedAt.toISOString() : null,
      })),
      schedule: {
        mode: (rule?.mode ?? "every_day") as ScheduleMode,
        weekdays: rule?.weekdays ?? [],
        interval: rule?.interval ?? 1,
        timesPerWeek: rule?.timesPerWeek ?? null,
        monthDay: rule?.monthDay ?? null,
        enabled: rule?.enabled ?? true,
        daypart: rule?.daypart ?? "anytime",
        timeMinute: rule?.timeMinute ?? null,
        reminderEnabled: rule?.reminderEnabled ?? false,
        reminderMinute: rule?.reminderMinute ?? null,
      },
    };
  });
}

/**
 * Active goals keyed by metric, for target displays. With day-type variants
 * (a training-day and a rest-day calorie target), the DATE's variant wins and
 * the "all" goal is the fallback — so the nutrition page and dashboard show
 * the target that actually applies today. One extra count query, and only
 * when a variant exists at all.
 */
export async function getGoalMap(date?: DayKey) {
  const user = await getCurrentUser();
  const goals = (await getGoals()).filter((goal) => goal.active);

  const hasVariants = goals.some((goal) => goal.dayType !== "all");
  let dayType: "training" | "rest" | null = null;
  if (hasVariants) {
    const day = date ?? scheduleSettingsFor(user).today;
    dayType = (await getDayType(user.id, day)).dayType;
  }

  const map = new Map<string, (typeof goals)[number]>();
  for (const goal of goals) {
    if (goal.dayType !== "all" && goal.dayType !== dayType) continue;
    const current = map.get(goal.metric);
    // A day-type-specific goal outranks the "all" fallback for its metric.
    if (!current || (current.dayType === "all" && goal.dayType !== "all")) {
      map.set(goal.metric, goal);
    }
  }
  return map;
}

/**
 * One day's type — the manual override when one exists, else derived from
 * completed workouts. THE resolver: everything that answers "is this a
 * training day?" (goal gating reads it via facts, the goal map and the
 * targets view-model read it here) agrees by construction.
 */
export async function getDayType(
  userId: string,
  date: DayKey,
): Promise<{ dayType: "training" | "rest"; overridden: boolean; trainedCount: number }> {
  const [override, trained] = await Promise.all([
    prisma.dayTypeOverride.findUnique({ where: { userId_date: { userId, date } } }),
    prisma.workout.count({ where: { userId, date, status: "completed" } }),
  ]);
  if (override?.dayType === "training" || override?.dayType === "rest") {
    return { dayType: override.dayType, overridden: true, trainedCount: trained };
  }
  return { dayType: trained > 0 ? "training" : "rest", overridden: false, trainedCount: trained };
}

/**
 * The nutrition page's Targets view-model: every active nutrition target
 * (macro goals + the hydration goal), the date's day type, and what was
 * consumed against each. `consumed: null` when nothing was logged — unknown,
 * never zero.
 */
export async function getNutritionTargets(date: DayKey) {
  const user = await getCurrentUser();
  const comparisonFrom = shiftDay(date, -27);
  const [goals, dayTypeInfo, meals, hydrationRows, windowSummaries, windowOverrides] =
    await Promise.all([
      prisma.goal.findMany({
        where: {
          userId: user.id,
          active: true,
          archivedAt: null,
          OR: [{ domain: "nutrition" }, { source: "hydration" }],
        },
        orderBy: [{ metric: "asc" }, { dayType: "asc" }],
      }),
      getDayType(user.id, date),
      getMealsForDay(date),
      prisma.healthMetric.findMany({ where: { userId: user.id, date, type: "hydration_ml" } }),
      // For the descriptive training-vs-rest comparison: the summary cache
      // already holds per-day calories/protein/workoutCount — O(28) rows.
      getSummaries(user.id, comparisonFrom, date),
      prisma.dayTypeOverride.findMany({
        where: { userId: user.id, date: { gte: comparisonFrom, lte: date } },
        select: { date: true, dayType: true },
      }),
    ]);

  const { dayType, overridden, trainedCount } = dayTypeInfo;
  const overrideByDate = new Map(windowOverrides.map((row) => [row.date, row.dayType]));
  const comparison = compareDayTypes(
    windowSummaries.map((summary) => ({
      calories: summary.calories,
      protein: summary.protein,
      workoutCount: summary.workoutCount,
      override:
        overrideByDate.get(summary.date) === "training"
          ? ("training" as const)
          : overrideByDate.get(summary.date) === "rest"
            ? ("rest" as const)
            : null,
    })),
  );
  const totals = totalMacros(meals.flatMap((meal) => meal.entries));
  const anyFood = meals.some((meal) => meal.entries.length > 0);
  const hydration = aggregateDay("hydration_ml", hydrationRows as HealthRowLike[])?.value ?? null;

  const consumedFor = (source: string): number | null => {
    switch (source) {
      case "calories":
        return anyFood ? totals.calories : null;
      case "protein":
        return anyFood ? totals.protein : null;
      case "carbs":
        return anyFood ? totals.carbs : null;
      case "fat":
        return anyFood ? totals.fat : null;
      case "fiber":
        return anyFood ? totals.fiber : null;
      case "hydration":
        return hydration;
      default:
        return null;
    }
  };

  return {
    date,
    dayType,
    overridden,
    trainedCount,
    comparison,
    hasVariants: goals.some((goal) => goal.dayType !== "all"),
    rows: goals.map((goal) => ({
      id: goal.id,
      metric: goal.metric,
      label: goal.label,
      target: goal.target,
      targetMax: goal.targetMax,
      direction: goal.direction,
      unit: goal.unit,
      dayType: goal.dayType,
      period: goal.period,
      source: goal.source,
      consumed: consumedFor(goal.source),
      applies: goal.dayType === "all" || goal.dayType === dayType,
    })),
  };
}

export type NutritionTargetsView = Awaited<ReturnType<typeof getNutritionTargets>>;

export async function getJournalEntry(date: DayKey) {
  const user = await getCurrentUser();
  return prisma.journalEntry.findUnique({ where: { userId_date: { userId: user.id, date } } });
}

export async function getJournalEntries(from: DayKey, to: DayKey) {
  const user = await getCurrentUser();
  return prisma.journalEntry.findMany({
    where: { userId: user.id, date: { gte: from, lte: to } },
    orderBy: { date: "desc" },
  });
}

// Raw reminder rows are no longer handed to the client: the watcher consumes
// the schedule-aware feed from src/server/reminders.ts instead.

// --- aggregate views --------------------------------------------------------

/** Everything the Today page and dashboard need, in one round of queries. */
export async function getDayOverview(date: DayKey = today()) {
  const user = await getCurrentUser();
  const settings = scheduleSettingsFor(user);
  const weekStartsOn = settings.weekStartsOn;
  const { start: weekStart, end: weekEnd } = weekRange(date, weekStartsOn);

  const [
    schedule,
    habits,
    nutrition,
    workouts,
    metrics,
    goals,
    goalEvaluations,
    journal,
    weekSummaries,
    // One score, from the one service. The Dashboard and Today used to each
    // call scoreDay() with their own inputs and could show different numbers
    // for the same date.
    score,
  ] = await Promise.all([
    getDaySchedule(date),
    getHabitsWithStats(date),
    getDayNutrition(date),
    prisma.workout.findMany({
      where: { userId: user.id, date },
      include: { sets: { orderBy: { sortOrder: "asc" } } },
    }),
    prisma.healthMetric.findMany({ where: { userId: user.id, date } }),
    getGoalMap(date),
    evaluateGoalsForDate(user.id, date, settings),
    getJournalEntry(date),
    getSummaries(user.id, weekStart, weekEnd),
    getDayScore(user.id, date, settings, scoreOptionsFor(user)),
  ]);

  // "Due" is a schedule question, answered by the engine. A times-per-week
  // habit is available today rather than required, and habits that are not
  // scheduled are separated out so a rest day never renders as pending work.
  const dueHabits = habits.filter((habit) => habit.dueToday || habit.flexibleToday);
  const restingHabits = habits.filter((habit) => !habit.dueToday && !habit.flexibleToday);
  const planned = schedule.length;
  const completed = schedule.filter((item) => item.status === "done").length;

  return {
    user,
    date,
    weekStart,
    weekEnd,
    schedule,
    planned,
    completed,
    skipped: schedule.filter((item) => item.status === "skipped").length,
    habits,
    dueHabits,
    restingHabits,
    habitsDone: dueHabits.filter((habit) => habit.todayStatus === "done").length,
    score,
    goalEvaluations,
    settings,
    nutrition,
    workouts,
    metrics,
    // A day can carry several rows per metric (manual + import, or per-device);
    // the one aggregation module decides the day's number.
    metricSummary: aggregateDayAll(metrics),
    goals,
    journal,
    weekSummaries,
  };
}

export type DayOverview = Awaited<ReturnType<typeof getDayOverview>>;

/** Month grid data for the calendar page. */
export async function getMonthCalendar(anchor: DayKey) {
  const user = await getCurrentUser();
  const weekStartsOn = user.weekStartsOn === 0 ? 0 : 1;
  const days = monthGridDays(anchor, weekStartsOn);
  const from = days[0];
  const to = days[days.length - 1];

  const [summaries, journals] = await Promise.all([
    getSummaries(user.id, from, to),
    getJournalEntries(from, to),
  ]);

  const byDate = new Map(summaries.map((summary) => [summary.date, summary]));
  const journalDates = new Set(journals.map((entry) => entry.date));

  return { days, from, to, byDate, journalDates, weekStartsOn: weekStartsOn as 0 | 1 };
}

/** Rolling window used by the heatmap and insights. */
export async function getConsistencyWindow(days = 182, end: DayKey = today()) {
  const user = await getCurrentUser();
  const from = shiftDay(end, -(days - 1));
  const summaries = await getSummaries(user.id, from, end);
  const byDate = new Map(summaries.map((summary) => [summary.date, summary]));
  return { from, to: end, days: dayRange(from, end), byDate, summaries };
}

/** Cross-domain search backing the command palette's "find anything". */
export async function searchEverything(query: string, limit = 8): Promise<SearchRows> {
  const term = query.trim();
  if (term.length < 2) return emptySearchRows();

  const user = await getCurrentUser();
  const [
    items,
    workouts,
    foods,
    habits,
    goals,
    journal,
    routines,
    workoutTemplates,
    mealTemplates,
    tasks,
    projects,
    inboxItems,
    accounts,
    transactionRows,
    bills,
    budgets,
    savingsGoals,
    documents,
    tags,
    healthMetrics,
    healthRecords,
    meals,
    reminders,
  ] = await Promise.all([
      prisma.scheduleItem.findMany({
        where: { userId: user.id, title: { contains: term, mode: "insensitive" } },
        orderBy: { date: "desc" },
        take: limit,
      }),
      prisma.workout.findMany({
        where: { userId: user.id, name: { contains: term, mode: "insensitive" } },
        orderBy: { date: "desc" },
        take: limit,
      }),
      prisma.foodItem.findMany({
        where: { OR: [{ userId: null }, { userId: user.id }], searchKey: { contains: term.toLowerCase() } },
        take: limit,
      }),
      prisma.habit.findMany({
        where: { userId: user.id, name: { contains: term, mode: "insensitive" } },
        take: limit,
      }),
      prisma.goal.findMany({
        where: { userId: user.id, archivedAt: null, label: { contains: term, mode: "insensitive" } },
        take: limit,
      }),
      prisma.journalEntry.findMany({
        where: {
          userId: user.id,
          OR: [{ content: { contains: term, mode: "insensitive" } }, { title: { contains: term, mode: "insensitive" } }],
        },
        orderBy: { date: "desc" },
        take: limit,
      }),
      prisma.scheduleTemplate.findMany({
        where: { userId: user.id, name: { contains: term, mode: "insensitive" } },
        take: limit,
      }),
      prisma.workoutTemplate.findMany({
        where: { userId: user.id, name: { contains: term, mode: "insensitive" } },
        take: limit,
      }),
      prisma.mealTemplate.findMany({
        where: { userId: user.id, name: { contains: term, mode: "insensitive" } },
        take: limit,
      }),
      prisma.task.findMany({
        where: { userId: user.id, title: { contains: term, mode: "insensitive" } },
        orderBy: { updatedAt: "desc" },
        take: limit,
      }),
      prisma.project.findMany({
        where: { userId: user.id, name: { contains: term, mode: "insensitive" } },
        take: limit,
      }),
      prisma.inboxItem.findMany({
        where: {
          userId: user.id,
          OR: [
            { title: { contains: term, mode: "insensitive" } },
            { notes: { contains: term, mode: "insensitive" } },
          ],
        },
        orderBy: { createdAt: "desc" },
        take: limit,
      }),
      prisma.financeAccount.findMany({
        where: { userId: user.id, name: { contains: term, mode: "insensitive" } },
        take: limit,
      }),
      prisma.financeTransaction.findMany({
        where: {
          userId: user.id,
          OR: [
            { payee: { contains: term, mode: "insensitive" } },
            { notes: { contains: term, mode: "insensitive" } },
          ],
        },
        include: { account: { select: { currency: true } } },
        orderBy: { date: "desc" },
        take: limit,
      }),
      prisma.bill.findMany({
        where: {
          userId: user.id,
          archivedAt: null,
          settledAt: null,
          name: { contains: term, mode: "insensitive" },
        },
        orderBy: { nextDueDate: "asc" },
        take: limit,
      }),
      // Budgets are named by their category key ("dining", "groceries"), which
      // is also what the labels derive from — key matching covers both.
      prisma.budget.findMany({
        where: { userId: user.id, category: { contains: term, mode: "insensitive" } },
        take: limit,
      }),
      prisma.savingsGoal.findMany({
        where: { userId: user.id, archivedAt: null, name: { contains: term, mode: "insensitive" } },
        take: limit,
      }),
      prisma.lifeDocument.findMany({
        where: {
          userId: user.id,
          archivedAt: null,
          OR: [
            { name: { contains: term, mode: "insensitive" } },
            { issuer: { contains: term, mode: "insensitive" } },
          ],
        },
        orderBy: { expiryDate: "asc" },
        take: limit,
      }),
      // Tags carry a count so a hit reads "3 tasks" rather than just a word;
      // the count is grouped, never a task scan.
      prisma.tag.findMany({
        where: { userId: user.id, name: { contains: term, mode: "insensitive" } },
        include: { _count: { select: { tasks: true, scheduleItems: true } } },
        orderBy: { name: "asc" },
        take: limit,
      }),
      // Health metrics match on their *name*, which is a fixed vocabulary — so
      // the candidate types are found in memory and the database is asked one
      // grouped question about them, rather than scanning a decade of rows.
      matchingHealthMetrics(user.id, user.unitSystem, term, limit),
      prisma.healthRecord.findMany({
        where: {
          userId: user.id,
          OR: [
            { title: { contains: term, mode: "insensitive" } },
            { subtitle: { contains: term, mode: "insensitive" } },
            { kind: { contains: term, mode: "insensitive" } },
          ],
        },
        orderBy: { date: "desc" },
        take: limit,
        select: { id: true, kind: true, title: true, subtitle: true, date: true },
      }),
      // Logged meals match on their free text only. `type` is a fixed
      // vocabulary ("lunch") that would return every lunch ever logged —
      // discovery of meal *kinds* belongs to Foods and Meal templates.
      prisma.meal.findMany({
        where: {
          userId: user.id,
          OR: [
            { label: { contains: term, mode: "insensitive" } },
            { notes: { contains: term, mode: "insensitive" } },
          ],
        },
        orderBy: { date: "desc" },
        take: limit,
        select: { id: true, date: true, type: true, label: true },
      }),
      prisma.reminder.findMany({
        where: {
          userId: user.id,
          OR: [
            { title: { contains: term, mode: "insensitive" } },
            { message: { contains: term, mode: "insensitive" } },
          ],
        },
        orderBy: { remindAt: "desc" },
        take: limit,
        select: {
          id: true,
          title: true,
          repeat: true,
          enabled: true,
          remindAt: true,
          // A block-born reminder deep-links its planner day. `deletedAt`
          // rides along because Prisma cannot filter a to-one include —
          // the mapping below nulls the link when the block sits in the
          // Trash (src/lib/soft-delete.ts documents this boundary).
          scheduleItem: { select: { date: true, deletedAt: true } },
        },
      }),
    ]);

  return {
    items,
    workouts,
    foods,
    habits,
    goals,
    journal,
    routines,
    workoutTemplates,
    mealTemplates,
    tasks,
    projects,
    inboxItems,
    accounts: accounts.map((account) => ({
      ...account,
      archived: account.archivedAt !== null,
    })),
    // Money leaves the server as integer cents, search hits included.
    transactions: transactionRows.map((transaction) => ({
      ...transaction,
      amount: centsOrLegacy(transaction.amountCents, transaction.amount),
      currency: transaction.account.currency,
    })),
    bills: bills.map((bill) => ({
      ...bill,
      amount: centsOrLegacy(bill.amountCents, bill.amount),
    })),
    budgets: budgets.map((budget) => ({
      ...budget,
      amount: centsOrLegacy(budget.amountCents, budget.amount),
    })),
    savingsGoals: savingsGoals.map((goal) => ({
      ...goal,
      targetAmount: centsOrLegacy(goal.targetAmountCents, goal.targetAmount),
      currentAmount: centsOrLegacy(goal.currentAmountCents, goal.currentAmount),
    })),
    documents,
    healthMetrics,
    healthRecords: healthRecords.map((record) => ({ ...record, date: record.date as DayKey })),
    meals: meals.map((meal) => ({ ...meal, date: meal.date as DayKey })),
    // The fire day resolves in the USER's timezone here — the pure hit
    // builder never does timezone math on an instant.
    reminders: reminders.map((reminder) => ({
      id: reminder.id,
      title: reminder.title,
      repeat: reminder.repeat,
      enabled: reminder.enabled,
      day: createStableDateKey(reminder.remindAt, user.timezone),
      blockDate:
        reminder.scheduleItem && reminder.scheduleItem.deletedAt === null
          ? (reminder.scheduleItem.date as DayKey)
          : null,
    })),
    tags: tags.map((tag) => ({
      id: tag.id,
      name: tag.name,
      taskCount: tag._count.tasks,
      plannerCount: tag._count.scheduleItems,
    })),
  };
}

/**
 * Health metrics that match a search term.
 *
 * The set of metric names is a fixed vocabulary, so the matching happens in
 * memory and the database is only asked "which of these does this account have
 * readings for, how many, and when was the last one" — one grouped query,
 * bounded by the number of matched types, whatever the size of the table.
 */
async function matchingHealthMetrics(
  userId: string,
  unitSystem: string,
  term: string,
  limit: number,
): Promise<SearchRows["healthMetrics"]> {
  const needle = term.toLowerCase();
  const matched = HEALTH_METRIC_TYPES.filter((type) => {
    const meta = HEALTH_METRIC_META[type];
    return (
      meta.label.toLowerCase().includes(needle) ||
      type.includes(needle) ||
      HEALTH_GROUP_META[meta.group].label.toLowerCase().includes(needle)
    );
  });
  if (matched.length === 0) return [];

  const groups = await prisma.healthMetric.groupBy({
    by: ["type"],
    where: { userId, type: { in: matched } },
    _count: { _all: true },
    _max: { date: true },
  });
  if (groups.length === 0) return [];

  // The latest reading's value, aggregated through the one health module so a
  // multi-device day reports the same number the charts do.
  const byType = new Map(groups.map((group) => [group.type, group]));
  const latestRows = await prisma.healthMetric.findMany({
    where: {
      userId,
      OR: groups
        .filter((group) => group._max.date !== null)
        .map((group) => ({ type: group.type, date: group._max.date as string })),
    },
    select: {
      date: true,
      type: true,
      subtype: true,
      value: true,
      unit: true,
      secondaryValue: true,
      minValue: true,
      maxValue: true,
      source: true,
      sourceApp: true,
      recordedAt: true,
      startAt: true,
      endAt: true,
      createdAt: true,
    },
  });
  const rowsByType = new Map<string, HealthRowLike[]>();
  for (const row of latestRows as HealthRowLike[]) {
    const bucket = rowsByType.get(row.type);
    if (bucket) bucket.push(row);
    else rowsByType.set(row.type, [row]);
  }

  return matched
    .filter((type) => byType.has(type))
    .slice(0, limit)
    .map((type) => {
      const meta = HEALTH_METRIC_META[type];
      const group = byType.get(type);
      const aggregated = aggregateDay(type, rowsByType.get(type) ?? []);
      const display = aggregated ? toDisplay(type, aggregated.value, unitSystem) : null;
      return {
        type,
        label: meta.label,
        unit: display?.unit ?? meta.unit,
        group: HEALTH_GROUP_META[meta.group].slug,
        count: group?._count._all ?? 0,
        latestDate: (group?._max.date as DayKey | null) ?? null,
        latestValue:
          display === null ? null : Math.round(display.value * 10 ** meta.decimals) / 10 ** meta.decimals,
      };
    });
}

/** Totals over a window, used by Insights and the weekly review. */
export async function getWindowStats(from: DayKey, to: DayKey) {
  const user = await getCurrentUser();
  const summaries = await getSummaries(user.id, from, to);
  // Only days that had an applicable opportunity carry a score. Days with
  // nothing scheduled are not failures and must not be averaged in as zero.
  const scored = summaries.filter((summary) => summary.scoreApplicable > 0);
  const active = summaries.filter(
    (summary) => summary.plannedCount > 0 || summary.habitsDue > 0 || summary.calories > 0,
  );

  return {
    from,
    to,
    summaries,
    planned: sum(summaries, (s) => s.plannedCount),
    completed: sum(summaries, (s) => s.completedCount),
    habitsDue: sum(summaries, (s) => s.habitsDue),
    habitsDone: sum(summaries, (s) => s.habitsDone),
    workouts: sum(summaries, (s) => s.workoutCount),
    workoutMinutes: sum(summaries, (s) => s.workoutMinutes),
    caloriesBurned: sum(summaries, (s) => s.caloriesBurned),
    caloriesEaten: sum(summaries, (s) => s.calories),
    protein: sum(summaries, (s) => s.protein),
    loggedDays: summaries.filter((s) => s.calories > 0).length,
    activeDays: active.length,
    scoredDays: scored.length,
    scheduledOpportunities: sum(summaries, (s) => s.scoreApplicable),
    metOpportunities: sum(summaries, (s) => s.scoreCompleted),
    missedOpportunities: sum(summaries, (s) => s.scoreMissed),
    averageScore:
      scored.length === 0 ? 0 : Math.round(sum(scored, (s) => s.score) / scored.length),
  };
}

export type WindowStats = Awaited<ReturnType<typeof getWindowStats>>;
