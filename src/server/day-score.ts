/**
 * NOTE ON `server-only`: this module is part of the shared computation layer
 * (facts → schedule → goals → score → summaries) rather than the app-facing
 * server surface. The guard lives on `src/server/queries.ts` and the modules in
 * `src/server/actions/`, which are what pages and components import directly.
 * Keeping it off the computation modules is deliberate: it lets the seed script
 * and future CLI tooling call the *real* aggregation instead of maintaining a
 * hand-copied duplicate of the formula, which is precisely the drift this
 * upgrade set out to remove.
 */
import { cache } from "react";

import { prisma } from "@/lib/db";
import { type DayKey, daysBetween } from "@/lib/date";
import {
  computeDayScore,
  parseScoreWeights,
  type DayScore,
  type ScoreExclusion,
  type ScoreOpportunity,
} from "@/lib/logic/day-score";
import { getStatusForDate, type ScheduleSettings } from "@/lib/logic/schedule";
import { evaluateGoalsForDate } from "@/server/goals";
import { loadSchedules, toSchedulable } from "@/server/schedule";

/**
 * Assembles the day score's inputs from the three scoring categories and hands
 * them to the pure calculator.
 *
 * Every page that shows a score calls this. That is the whole point: before it
 * existed, `recomputeDay` and `getDayOverview` counted the same day two
 * different ways and could disagree.
 */

export interface DayScoreOptions {
  /** Count low-priority planner items as required. */
  scoreOptionalTasks?: boolean;
  weightsJson?: string | null;
}

export async function getDayScore(
  userId: string,
  date: DayKey,
  settings: ScheduleSettings,
  options: DayScoreOptions = {},
): Promise<DayScore> {
  return getDayScoreMemo(
    userId,
    date,
    settings,
    options.scoreOptionalTasks ?? false,
    options.weightsJson ?? null,
  );
}

const getDayScoreMemo = cache(getDayScoreImpl);

async function getDayScoreImpl(
  userId: string,
  date: DayKey,
  settings: ScheduleSettings,
  scoreOptionalTasks: boolean,
  weightsJson: string | null,
): Promise<DayScore> {
  const options: DayScoreOptions = { scoreOptionalTasks, weightsJson };
  const opportunities: ScoreOpportunity[] = [];
  const exclusions: ScoreExclusion[] = [];

  const isFuture = daysBetween(settings.today, date) > 0;
  const isToday = date === settings.today;

  // --- planner --------------------------------------------------------------
  const items = await prisma.scheduleItem.findMany({
    where: { userId, date },
    select: { id: true, title: true, status: true, priority: true },
  });

  for (const item of items) {
    const optional = item.priority === "low" && !options.scoreOptionalTasks;
    if (optional) {
      exclusions.push({
        id: item.id,
        label: item.title,
        category: "planner",
        reason: "optional",
        detail: "Low priority — optional items are not scored",
      });
      continue;
    }
    if (item.status === "skipped") {
      exclusions.push({
        id: item.id,
        label: item.title,
        category: "planner",
        reason: "cancelled",
        detail: "Skipped for this day",
      });
      continue;
    }
    if (isFuture) {
      exclusions.push({
        id: item.id,
        label: item.title,
        category: "planner",
        reason: "future",
        detail: "Still upcoming",
      });
      continue;
    }

    const done = item.status === "done";
    opportunities.push({
      id: item.id,
      label: item.title,
      category: "planner",
      kind: "binary",
      credit: done ? 1 : 0,
      met: done,
      pending: !done && isToday,
      status: done ? "completed" : isToday ? "pending" : "missed",
      detail: done ? "Completed" : isToday ? "Still open today" : "Not completed",
    });
  }

  // --- habits ---------------------------------------------------------------
  const habits = await prisma.habit.findMany({
    where: { userId, archived: false },
    select: { id: true, name: true, startDate: true, endDate: true, archived: true },
  });

  if (habits.length > 0) {
    const [schedules, logs] = await Promise.all([
      loadSchedules(
        userId,
        "habit",
        habits.map((habit) => habit.id),
      ),
      prisma.habitLog.findMany({
        where: { userId, date },
        select: { habitId: true, status: true, date: true, value: true },
      }),
    ]);
    const logByHabit = new Map(logs.map((log) => [log.habitId, log]));

    for (const habit of habits) {
      const item = toSchedulable(
        {
          id: habit.id,
          startDate: habit.startDate,
          endDate: habit.endDate,
          enabled: !habit.archived,
        },
        schedules.get(habit.id),
      );
      const resolved = getStatusForDate(item, date, logByHabit.get(habit.id) ?? null, settings);

      switch (resolved.status) {
        case "completed":
          opportunities.push(habitOpportunity(habit, 1, true, false, "completed", "Completed"));
          break;
        case "pending":
          opportunities.push(
            habitOpportunity(habit, 0, false, true, "pending", "Still open today"),
          );
          break;
        case "missed":
          opportunities.push(habitOpportunity(habit, 0, false, false, "missed", "Not completed"));
          break;
        case "skipped":
          opportunities.push(habitOpportunity(habit, 0, false, false, "skipped", "Skipped"));
          break;
        default:
          exclusions.push({
            id: habit.id,
            label: habit.name,
            category: "habits",
            reason: exclusionReasonFor(resolved.status),
            detail: resolved.label,
          });
          break;
      }
    }
  }

  // --- goals ----------------------------------------------------------------
  const goals = await evaluateGoalsForDate(userId, date, settings, {
    scoreOptionalTasks: options.scoreOptionalTasks,
  });

  for (const evaluation of goals) {
    if (!evaluation.applicable) {
      exclusions.push({
        id: evaluation.goal.id,
        label: evaluation.goal.label,
        category: "goals",
        reason: exclusionReasonFor(evaluation.status),
        detail: evaluation.summary,
      });
      continue;
    }
    if (isFuture) {
      exclusions.push({
        id: evaluation.goal.id,
        label: evaluation.goal.label,
        category: "goals",
        reason: "future",
        detail: "Still upcoming",
      });
      continue;
    }
    // Missing data is not a failure. A protein goal on a day with no food
    // logged is "not logged", and scoring it 0 would claim something the app
    // does not actually know.
    if (!evaluation.outcome.hasData) {
      exclusions.push({
        id: evaluation.goal.id,
        label: evaluation.goal.label,
        category: "goals",
        reason: "no_data",
        detail: "Nothing logged for this goal yet",
      });
      continue;
    }

    const met = evaluation.outcome.met;
    // Partial credit only where a partial amount is genuinely partial progress.
    const partialAllowed = evaluation.goal.direction !== "boolean";
    const credit = met ? 1 : partialAllowed ? (evaluation.outcome.progress ?? 0) : 0;

    opportunities.push({
      id: evaluation.goal.id,
      label: evaluation.goal.label,
      category: "goals",
      kind: partialAllowed ? "partial" : "binary",
      credit,
      met,
      pending: !met && isToday,
      status: met ? "completed" : isToday ? "pending" : "missed",
      detail: evaluation.summary,
    });
  }

  return computeDayScore({
    date,
    opportunities,
    exclusions,
    weights: parseScoreWeights(options.weightsJson),
  });
}

function habitOpportunity(
  habit: { id: string; name: string },
  credit: number,
  met: boolean,
  pending: boolean,
  status: ScoreOpportunity["status"],
  detail: string,
): ScoreOpportunity {
  return {
    id: habit.id,
    label: habit.name,
    category: "habits",
    kind: "binary",
    credit,
    met,
    pending,
    status,
    detail,
  };
}

function exclusionReasonFor(status: string): ScoreExclusion["reason"] {
  switch (status) {
    case "rest":
      return "rest_day";
    case "excused":
      return "excused";
    case "canceled":
      return "cancelled";
    case "future":
      return "future";
    case "inactive":
      return "disabled";
    default:
      return "not_scheduled";
  }
}

// NOTE: a range variant (`getDayScores`) used to live here, looping
// `getDayScore` per day — several queries × days. Nothing ever called it (the
// calendar and insights read the `CalendarDaySummary` cache, which
// `rebuildSummaries` maintains), so it was removed rather than optimised.

/** The options a user's settings imply. Keeps callers from re-deriving them. */
export function scoreOptionsFor(user: {
  scoreWeights: string | null;
  scoreOptionalTasks: boolean;
}): DayScoreOptions {
  return {
    scoreOptionalTasks: user.scoreOptionalTasks,
    weightsJson: user.scoreWeights,
  };
}
