import "server-only";

import { getCurrentUser, prisma } from "@/lib/db";
import {
  type DayKey,
  dayRange,
  monthGridDays,
  shiftDay,
  today,
  weekRange,
} from "@/lib/date";
import { MEAL_TYPE_META, type MealType } from "@/lib/enums";
import { isHabitDue } from "@/lib/logic/recurrence";
import { computeStreaks, weeklyProgress } from "@/lib/logic/streaks";
import { totalMacros } from "@/lib/logic/nutrition";
import { parseJson, sum } from "@/lib/utils";
import { getSummaries } from "@/server/summaries";

/**
 * Read model for the app. Pages are Server Components and call these directly;
 * nothing here mutates, so it is all cache-friendly and easy to reason about.
 */

export type CurrentUser = Awaited<ReturnType<typeof getCurrentUser>>;

export async function getUser() {
  return getCurrentUser();
}

export async function getWeekStart(): Promise<0 | 1> {
  const user = await getCurrentUser();
  return user.weekStartsOn === 0 ? 0 : 1;
}

// --- planner ----------------------------------------------------------------

export async function getScheduleItems(from: DayKey, to: DayKey) {
  const user = await getCurrentUser();
  return prisma.scheduleItem.findMany({
    where: { userId: user.id, date: { gte: from, lte: to } },
    include: {
      tags: { include: { tag: true } },
      workout: { select: { id: true, type: true, durationMin: true } },
      habit: { select: { id: true, name: true, color: true } },
    },
    orderBy: [{ date: "asc" }, { allDay: "desc" }, { startMinute: "asc" }, { sortOrder: "asc" }],
  });
}

export type ScheduleItemWithRelations = Awaited<ReturnType<typeof getScheduleItems>>[number];

export async function getDaySchedule(date: DayKey) {
  return getScheduleItems(date, date);
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
  frequency: string;
  weekdays: number[];
  targetPerWeek: number;
  targetValue: number | null;
  unit: string | null;
  color: string;
  icon: string;
  startDate: string;
  archived: boolean;
  sortOrder: number;
  dueToday: boolean;
  todayStatus: string | null;
  streak: number;
  longestStreak: number;
  completionRate: number;
  weekDone: number;
  weekTarget: number;
  recentLogs: Array<{ date: string; status: string }>;
}

/** Habits with their stats for `date`, ready to render. */
export async function getHabitsWithStats(
  date: DayKey = today(),
  options: { includeArchived?: boolean; historyDays?: number } = {},
): Promise<HabitWithStats[]> {
  const user = await getCurrentUser();
  const historyDays = options.historyDays ?? 90;
  const from = shiftDay(date, -historyDays);

  const habits = await prisma.habit.findMany({
    where: { userId: user.id, ...(options.includeArchived ? {} : { archived: false }) },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: {
      logs: { where: { date: { gte: from, lte: date } }, orderBy: { date: "asc" } },
    },
  });

  const weekStartsOn = user.weekStartsOn === 0 ? 0 : 1;

  return habits.map((habit) => {
    const weekdays = parseJson<number[]>(habit.weekdays, [0, 1, 2, 3, 4, 5, 6]);
    const shape = {
      id: habit.id,
      frequency: habit.frequency,
      weekdays,
      targetPerWeek: habit.targetPerWeek,
      startDate: habit.startDate,
      endDate: habit.endDate,
    };
    const logs = habit.logs.map((log) => ({ date: log.date, status: log.status }));
    const stats = computeStreaks(shape, logs, { from, to: date });
    const week = weeklyProgress(shape, logs, date, weekStartsOn);

    return {
      id: habit.id,
      name: habit.name,
      description: habit.description,
      category: habit.category,
      timeOfDay: habit.timeOfDay,
      frequency: habit.frequency,
      weekdays,
      targetPerWeek: habit.targetPerWeek,
      targetValue: habit.targetValue,
      unit: habit.unit,
      color: habit.color,
      icon: habit.icon,
      startDate: habit.startDate,
      archived: habit.archived,
      sortOrder: habit.sortOrder,
      dueToday: isHabitDue(shape, date),
      todayStatus: habit.logs.find((log) => log.date === date)?.status ?? null,
      streak: stats.current,
      longestStreak: stats.longest,
      completionRate: stats.completionRate,
      weekDone: week.done,
      weekTarget: week.target,
      recentLogs: logs,
    };
  });
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
    orderBy: [{ lastUsedAt: "desc" }],
    take: 60,
  });

  const ids = favorites.map((favorite) => favorite.refId);
  const foods = ids.length
    ? await prisma.foodItem.findMany({ where: { id: { in: ids } } })
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
    orderBy: [{ date: "desc" }, { time: "desc" }],
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

export async function getLatestMetrics() {
  const user = await getCurrentUser();
  const rows = await prisma.healthMetric.findMany({
    where: { userId: user.id },
    orderBy: { date: "desc" },
    take: 400,
  });

  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!latest.has(row.type)) latest.set(row.type, row);
  return latest;
}

export async function getGoals() {
  const user = await getCurrentUser();
  return prisma.goal.findMany({
    where: { userId: user.id },
    orderBy: [{ domain: "asc" }, { sortOrder: "asc" }],
  });
}

export async function getGoalMap() {
  const goals = await getGoals();
  return new Map(goals.filter((goal) => goal.active).map((goal) => [goal.metric, goal]));
}

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

export async function getReminders() {
  const user = await getCurrentUser();
  return prisma.reminder.findMany({
    where: { userId: user.id },
    orderBy: { remindAt: "asc" },
  });
}

// --- aggregate views --------------------------------------------------------

/** Everything the Today page and dashboard need, in one round of queries. */
export async function getDayOverview(date: DayKey = today()) {
  const user = await getCurrentUser();
  const weekStartsOn = user.weekStartsOn === 0 ? 0 : 1;
  const { start: weekStart, end: weekEnd } = weekRange(date, weekStartsOn);

  const [schedule, habits, nutrition, workouts, metrics, goals, journal, weekSummaries] =
    await Promise.all([
      getDaySchedule(date),
      getHabitsWithStats(date),
      getDayNutrition(date),
      prisma.workout.findMany({
        where: { userId: user.id, date },
        include: { sets: { orderBy: { sortOrder: "asc" } } },
      }),
      prisma.healthMetric.findMany({ where: { userId: user.id, date } }),
      getGoalMap(),
      getJournalEntry(date),
      getSummaries(user.id, weekStart, weekEnd),
    ]);

  const dueHabits = habits.filter((habit) => habit.dueToday);
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
    habitsDone: dueHabits.filter((habit) => habit.todayStatus === "done").length,
    nutrition,
    workouts,
    metrics,
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
export async function searchEverything(query: string, limit = 8) {
  const term = query.trim();
  if (term.length < 2) {
    return { items: [], workouts: [], foods: [], habits: [], journal: [] };
  }

  const user = await getCurrentUser();
  const [items, workouts, foods, habits, journal] = await Promise.all([
    prisma.scheduleItem.findMany({
      where: { userId: user.id, title: { contains: term } },
      orderBy: { date: "desc" },
      take: limit,
    }),
    prisma.workout.findMany({
      where: { userId: user.id, name: { contains: term } },
      orderBy: { date: "desc" },
      take: limit,
    }),
    prisma.foodItem.findMany({
      where: { OR: [{ userId: null }, { userId: user.id }], searchKey: { contains: term.toLowerCase() } },
      take: limit,
    }),
    prisma.habit.findMany({
      where: { userId: user.id, name: { contains: term } },
      take: limit,
    }),
    prisma.journalEntry.findMany({
      where: {
        userId: user.id,
        OR: [{ content: { contains: term } }, { title: { contains: term } }],
      },
      orderBy: { date: "desc" },
      take: limit,
    }),
  ]);

  return { items, workouts, foods, habits, journal };
}

/** Totals over a window, used by Insights and the weekly review. */
export async function getWindowStats(from: DayKey, to: DayKey) {
  const user = await getCurrentUser();
  const summaries = await getSummaries(user.id, from, to);
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
    averageScore:
      active.length === 0 ? 0 : Math.round(sum(active, (s) => s.score) / active.length),
  };
}

export type WindowStats = Awaited<ReturnType<typeof getWindowStats>>;
