/**
 * NOTE ON `server-only`: part of the shared computation layer, not the
 * app-facing server surface. See src/server/facts.ts for the reasoning.
 */
import { prisma } from "@/lib/db";
import { type DayKey, dayRange, daysBetween, formatDay } from "@/lib/date";
import { type ScheduleSettings, getStatusForDate } from "@/lib/logic/schedule";
import { getHabitViews } from "@/server/habits";
import { loadSchedules, toSchedulable } from "@/server/schedule";
import { getSummaries } from "@/server/summaries";

/**
 * The weekly review.
 *
 * Every number here is expressed in **scheduled opportunities**, which is the
 * whole point: four scheduled workouts with three done is "3 of 4, 75%", never
 * "3 of 7, 43%". Days and occurrences that were never scheduled are reported
 * separately as rest, not folded into the denominator.
 *
 * The wording is deliberately factual. It reports what happened; it does not
 * praise, scold, diagnose, or advise.
 */

export interface AreaSummary {
  key: string;
  label: string;
  scheduled: number;
  completed: number;
  missed: number;
  excused: number;
  /** Null when nothing was scheduled — distinct from 0%. */
  rate: number | null;
}

export interface WeeklyReview {
  start: DayKey;
  end: DayKey;
  label: string;
  /** Days in the window that had at least one applicable opportunity. */
  scoredDays: number;
  /** Days with nothing scheduled at all. */
  restDays: number;
  totalDays: number;
  averageScore: number | null;

  scheduledOpportunities: number;
  completedOpportunities: number;
  missedOpportunities: number;
  excusedOpportunities: number;

  areas: AreaSummary[];
  strongest: AreaSummary | null;
  mostMissed: AreaSummary | null;

  workouts: { completed: number; minutes: number };
  nutrition: { loggedDays: number; averageCalories: number | null };
  planner: { scheduled: number; completed: number; rate: number | null };
  habits: { scheduled: number; completed: number; rate: number | null };

  notes: Array<{ date: DayKey; content: string }>;
  /** One factual sentence naming the area with the most missed opportunities. */
  focus: string;
}

export async function getWeeklyReview(
  userId: string,
  start: DayKey,
  end: DayKey,
  settings: ScheduleSettings,
): Promise<WeeklyReview> {
  const days = daysBetween(start, end) < 0 ? [] : dayRange(start, end);

  const [summaries, habitViews, workouts, journals] = await Promise.all([
    getSummaries(userId, start, end),
    getHabitViews(userId, end, settings, { historyDays: Math.max(7, days.length), stripDays: 0 }),
    prisma.workout.findMany({
      where: { userId, date: { gte: start, lte: end }, status: "completed" },
      select: { durationMin: true },
    }),
    prisma.journalEntry.findMany({
      where: { userId, date: { gte: start, lte: end }, NOT: { content: "" } },
      orderBy: { date: "asc" },
      select: { date: true, content: true },
    }),
  ]);

  const scored = summaries.filter((summary) => summary.scoreApplicable > 0);
  const restDays = days.length - scored.length;

  // --- planner --------------------------------------------------------------
  const plannerScheduled = summaries.reduce((total, summary) => total + summary.plannedCount, 0);
  const plannerCompleted = summaries.reduce((total, summary) => total + summary.completedCount, 0);

  // --- habits ---------------------------------------------------------------
  let habitScheduled = 0;
  let habitCompleted = 0;
  let habitExcused = 0;

  for (const view of habitViews) {
    const windowStates = view.recentLogs;
    void windowStates;
    for (const date of days) {
      const log = view.recentLogs.find((entry) => entry.date === date) ?? null;
      const resolved = resolveHabitDay(view, date, log, settings);
      if (resolved === "completed") {
        habitScheduled += 1;
        habitCompleted += 1;
      } else if (resolved === "missed" || resolved === "skipped") {
        habitScheduled += 1;
      } else if (resolved === "pending") {
        habitScheduled += 1;
      } else if (resolved === "excused") {
        habitExcused += 1;
      }
    }
  }

  // --- goals ----------------------------------------------------------------
  // Goal opportunities come from the cached day scores rather than a second
  // evaluation pass, so the review agrees with the calendar by construction.
  const goalScheduled = Math.max(
    0,
    summaries.reduce((total, summary) => total + summary.scoreApplicable, 0) -
      plannerScheduled -
      habitScheduled,
  );
  const goalCompleted = Math.max(
    0,
    summaries.reduce((total, summary) => total + summary.scoreCompleted, 0) -
      plannerCompleted -
      habitCompleted,
  );

  const areas: AreaSummary[] = [
    area("planner", "Planner", plannerScheduled, plannerCompleted, 0),
    area("habits", "Habits", habitScheduled, habitCompleted, habitExcused),
    area("goals", "Goals", goalScheduled, goalCompleted, 0),
  ];

  const ranked = areas.filter((entry) => entry.scheduled > 0);
  const strongest =
    ranked.length === 0
      ? null
      : ranked.reduce((best, entry) => ((entry.rate ?? 0) > (best.rate ?? 0) ? entry : best));
  const mostMissed =
    ranked.length === 0
      ? null
      : ranked.reduce((worst, entry) => (entry.missed > worst.missed ? entry : worst));

  const scheduledOpportunities = areas.reduce((total, entry) => total + entry.scheduled, 0);
  const completedOpportunities = areas.reduce((total, entry) => total + entry.completed, 0);
  const missedOpportunities = areas.reduce((total, entry) => total + entry.missed, 0);
  const excusedOpportunities = areas.reduce((total, entry) => total + entry.excused, 0);

  const loggedDays = summaries.filter((summary) => summary.calories > 0).length;
  const totalCalories = summaries.reduce((total, summary) => total + summary.calories, 0);

  return {
    start,
    end,
    label: `${formatDay(start, "MMM d")} – ${formatDay(end, "MMM d")}`,
    scoredDays: scored.length,
    restDays,
    totalDays: days.length,
    averageScore:
      scored.length === 0
        ? null
        : Math.round(scored.reduce((total, summary) => total + summary.score, 0) / scored.length),

    scheduledOpportunities,
    completedOpportunities,
    missedOpportunities,
    excusedOpportunities,

    areas,
    strongest,
    mostMissed,

    workouts: {
      completed: workouts.length,
      minutes: workouts.reduce((total, workout) => total + workout.durationMin, 0),
    },
    nutrition: {
      loggedDays,
      averageCalories: loggedDays === 0 ? null : Math.round(totalCalories / loggedDays),
    },
    planner: {
      scheduled: plannerScheduled,
      completed: plannerCompleted,
      rate: rateOf(plannerScheduled, plannerCompleted),
    },
    habits: {
      scheduled: habitScheduled,
      completed: habitCompleted,
      rate: rateOf(habitScheduled, habitCompleted),
    },

    notes: journals.map((entry) => ({ date: entry.date, content: entry.content })),
    focus: describeFocus(mostMissed, scheduledOpportunities),
  };
}

function area(
  key: string,
  label: string,
  scheduled: number,
  completed: number,
  excused: number,
): AreaSummary {
  return {
    key,
    label,
    scheduled,
    completed,
    missed: Math.max(0, scheduled - completed),
    excused,
    rate: rateOf(scheduled, completed),
  };
}

function rateOf(scheduled: number, completed: number): number | null {
  return scheduled === 0 ? null : Math.round((completed / scheduled) * 100);
}

type HabitDayOutcome = "completed" | "missed" | "skipped" | "pending" | "excused" | "neutral";

function resolveHabitDay(
  view: Awaited<ReturnType<typeof getHabitViews>>[number],
  date: DayKey,
  log: { date: string; status: string } | null,
  settings: ScheduleSettings,
): HabitDayOutcome {
  // The habit view already carries its resolved schedule; re-resolving one date
  // through the engine keeps this consistent with everything else.
  const item = toSchedulable(
    { id: view.id, startDate: view.startDate, endDate: view.endDate, enabled: !view.archived },
    { rules: view.rule ? [view.rule] : [], overrides: view.occurrence.override ? [view.occurrence.override] : [] },
  );
  const resolved = getStatusForDate(item, date, log, settings);
  switch (resolved.status) {
    case "completed":
    case "missed":
    case "skipped":
    case "pending":
    case "excused":
      return resolved.status;
    default:
      return "neutral";
  }
}

/** Factual, non-judgemental. Names the area, never the person. */
function describeFocus(mostMissed: AreaSummary | null, scheduled: number): string {
  if (scheduled === 0) return "Nothing was scheduled this week, so there is nothing to review.";
  if (!mostMissed || mostMissed.missed === 0) {
    return "Every scheduled opportunity this week was met.";
  }
  return `${mostMissed.label} had the most missed opportunities: ${mostMissed.missed} of ${mostMissed.scheduled}.`;
}

/** Re-export so pages can load schedules for a review without a second import. */
export { loadSchedules };
