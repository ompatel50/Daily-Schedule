import "server-only";

import { prisma } from "@/lib/db";
import { type DayKey } from "@/lib/date";
import {
  buildGoalEvaluation,
  describeGoalTarget,
  emptyFacts,
  evaluateGoal,
  isWeeklyGoal,
  measureGoal,
  type GoalEvaluation,
  type GoalFacts,
  type GoalLike,
} from "@/lib/logic/goals";
import {
  calculateCompletionRate,
  calculateScheduledStreak,
  calculateWeeklyProgress,
  describeSchedule,
  getOccurrenceForDate,
  getStatusForDate,
  getWeekBounds,
  resolveEffectiveSchedule,
  type CompletionLike,
  type ScheduleSettings,
} from "@/lib/logic/schedule";
import { measureFactsByDay, sumFacts } from "@/server/facts";
import { loadSchedules, toSchedulable } from "@/server/schedule";

/**
 * Goal orchestration: load goals with their schedules, measure the facts once,
 * and hand both to the pure evaluator. Every surface that shows a goal —
 * Dashboard, Today, the calendar detail, insights, the day score — calls in
 * here, which is what makes them agree.
 */

type GoalRow = Awaited<ReturnType<typeof prisma.goal.findMany>>[number];

function toGoalLike(goal: GoalRow): GoalLike {
  return {
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
  };
}

export interface GoalWithSchedule {
  goal: GoalLike;
  raw: GoalRow;
  scheduleSummary: string;
  targetSummary: string;
  enabled: boolean;
  archived: boolean;
  rule: ReturnType<typeof resolveEffectiveSchedule>;
}

/** Goals plus their current schedule — what the Goals editor renders. */
export async function getGoalsWithSchedule(
  userId: string,
  settings: ScheduleSettings,
  options: { includeArchived?: boolean } = {},
): Promise<GoalWithSchedule[]> {
  const goals = await prisma.goal.findMany({
    where: { userId, ...(options.includeArchived ? {} : { archivedAt: null }) },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });

  const schedules = await loadSchedules(
    userId,
    "goal",
    goals.map((goal) => goal.id),
  );

  return goals.map((goal) => {
    const item = toSchedulable(
      { id: goal.id, startDate: goal.startDate, endDate: goal.endDate, enabled: goal.active },
      schedules.get(goal.id),
    );
    const rule = resolveEffectiveSchedule(item, settings.today);
    const like = toGoalLike(goal);

    return {
      goal: like,
      raw: goal,
      scheduleSummary: goal.active ? describeSchedule(rule) : "Disabled",
      targetSummary: describeGoalTarget(like),
      enabled: goal.active,
      archived: goal.archivedAt !== null,
      rule,
    };
  });
}

export interface GoalDayResult extends GoalEvaluation {
  scheduleSummary: string;
  streak: number;
  streakUnit: "occurrences" | "weeks";
}

/**
 * Evaluate every active goal for one date.
 *
 * `historyDays` controls how far back streaks and rates look — bounded rather
 * than "since the beginning of time" so the query stays cheap on the pages
 * that call this on every render.
 */
export async function evaluateGoalsForDate(
  userId: string,
  date: DayKey,
  settings: ScheduleSettings,
  options: { historyDays?: number; scoreOptionalTasks?: boolean } = {},
): Promise<GoalDayResult[]> {
  const goals = await prisma.goal.findMany({
    where: { userId, active: true, archivedAt: null },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  if (goals.length === 0) return [];

  const week = getWeekBounds(date, settings);
  const schedules = await loadSchedules(
    userId,
    "goal",
    goals.map((goal) => goal.id),
  );

  // The facts window has to cover the whole week so a weekly goal can be
  // measured, even when only one date was asked for.
  const from = week.start < date ? week.start : date;
  const to = week.end > date ? week.end : date;
  const [factsByDay, entries] = await Promise.all([
    measureFactsByDay(userId, from, to, { scoreOptionalTasks: options.scoreOptionalTasks }),
    prisma.goalEntry.findMany({
      where: { userId, goalId: { in: goals.map((goal) => goal.id) } },
      orderBy: { date: "asc" },
    }),
  ]);

  const entriesByGoal = new Map<string, CompletionLike[]>();
  for (const entry of entries) {
    const list = entriesByGoal.get(entry.goalId) ?? [];
    list.push({ date: entry.date, status: entry.status, value: entry.value });
    entriesByGoal.set(entry.goalId, list);
  }

  const dayFacts = factsByDay.get(date) ?? emptyFacts();
  const weekFacts = sumFacts(week.days.map((day) => factsByDay.get(day) ?? emptyFacts()));

  return goals.map((goal) => {
    const item = toSchedulable(
      { id: goal.id, startDate: goal.startDate, endDate: goal.endDate, enabled: goal.active },
      schedules.get(goal.id),
    );
    const like = toGoalLike(goal);
    const occurrence = getOccurrenceForDate(item, date, settings);

    // Completions for a goal come either from its manual entries or from the
    // measured facts. For streak purposes we synthesise a completion record on
    // every date where the goal was met, so the streak rules stay identical to
    // habits'.
    const manualCompletions = entriesByGoal.get(goal.id) ?? [];
    const completions = buildGoalCompletions(like, factsByDay, manualCompletions);

    const weekly = isWeeklyGoal(like, occurrence)
      ? calculateWeeklyProgress(item, date, completions, settings)
      : null;

    const resolved = getStatusForDate(
      item,
      date,
      manualCompletions.find((completion) => completion.date === date) ?? null,
      settings,
    );

    const evaluation = buildGoalEvaluation({
      goal: like,
      date,
      occurrence,
      status: resolved.status,
      facts: dayFacts,
      weekFacts,
      weekly,
      settings,
    });

    // A goal whose data proves it is complete should read as completed, without
    // asking the user to also tick a box.
    const status =
      evaluation.outcome.met && (occurrence.active || occurrence.flexible || weekly !== null)
        ? "completed"
        : resolved.status;

    const streak = calculateScheduledStreak(item, date, completions, settings);

    return {
      ...evaluation,
      status,
      summary: evaluation.summary,
      scheduleSummary: describeSchedule(resolveEffectiveSchedule(item, date)),
      streak: streak.current,
      streakUnit: streak.unit,
    };
  });
}

/**
 * Turn measured facts into completion records so goals and habits share one
 * streak implementation. A date counts as "done" when the goal was met there,
 * or when the user explicitly recorded an outcome.
 */
function buildGoalCompletions(
  goal: GoalLike,
  factsByDay: Map<DayKey, GoalFacts>,
  manual: CompletionLike[],
): CompletionLike[] {
  const byDate = new Map<DayKey, CompletionLike>();

  if (goal.source !== "manual") {
    for (const [date, facts] of factsByDay) {
      const measurement = measureGoalSafe(goal, facts);
      if (measurement) byDate.set(date, { date, status: "done" });
    }
  }

  // An explicit entry always wins over an inferred one.
  for (const entry of manual) byDate.set(entry.date, entry);

  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function measureGoalSafe(goal: GoalLike, facts: GoalFacts): boolean {
  const measurement = measureGoal(goal, facts);
  if (!measurement.hasData) return false;
  return evaluateGoal(goal, measurement).met;
}

/** Completion history for one goal, used by insights and the goal detail. */
export async function getGoalHistory(
  userId: string,
  goalId: string,
  from: DayKey,
  to: DayKey,
  settings: ScheduleSettings,
) {
  const goal = await prisma.goal.findFirst({ where: { id: goalId, userId } });
  if (!goal) return null;

  const [schedules, factsByDay, entries] = await Promise.all([
    loadSchedules(userId, "goal", [goalId]),
    measureFactsByDay(userId, from, to),
    prisma.goalEntry.findMany({ where: { userId, goalId }, orderBy: { date: "asc" } }),
  ]);

  const item = toSchedulable(
    { id: goal.id, startDate: goal.startDate, endDate: goal.endDate, enabled: goal.active },
    schedules.get(goal.id),
  );
  const like = toGoalLike(goal);
  const completions = buildGoalCompletions(
    like,
    factsByDay,
    entries.map((entry) => ({ date: entry.date, status: entry.status, value: entry.value })),
  );

  return {
    goal: like,
    stats: calculateCompletionRate(item, from, to, completions, settings),
    streak: calculateScheduledStreak(item, to, completions, settings),
  };
}
