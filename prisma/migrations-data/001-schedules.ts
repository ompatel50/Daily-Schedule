import type { DbClient } from "../db-client";

/**
 * Backfill: give every existing goal and habit a `ScheduleRule`.
 *
 * Idempotent by construction — it only ever creates a rule for an owner that
 * has none, so re-running it is a no-op. Nothing is deleted or rewritten, and
 * no habit log or goal history is touched.
 *
 * Migration rules (from the upgrade spec):
 *  * Existing goals become **every-day, enabled**, effective from the day the
 *    goal was created — that is what they behaved as before, so no historical
 *    score changes.
 *  * Existing habits **preserve their current recurrence** where it is
 *    recoverable from the legacy `frequency`/`weekdays`/`targetPerWeek`
 *    columns. If a habit's weekday list is corrupt or empty we fall back to
 *    every-day rather than deleting anything.
 */

const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

/** Map a legacy goal `metric` onto the completion source that can prove it. */
function inferGoalSource(domain: string, metric: string): string {
  switch (metric) {
    case "calories":
      return "calories";
    case "protein":
      return "protein";
    case "carbs":
      return "carbs";
    case "fat":
      return "fat";
    case "fiber":
      return "fiber";
    case "steps":
      return "steps";
    case "sleep_hours":
      return "sleep_hours";
    case "hydration_ml":
      return "hydration";
    case "active_calories":
      return "active_calories";
    case "workouts_per_week":
    case "workouts":
      return "workout_count";
    case "workout_minutes":
      return "workout_minutes";
    default:
      return domain === "planner" ? "planner_required" : "manual";
  }
}

function parseWeekdays(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const days = parsed.filter(
      (value): value is number => Number.isInteger(value) && value >= 0 && value <= 6,
    );
    return Array.from(new Set(days)).sort((a, b) => a - b);
  } catch {
    return [];
  }
}

function toDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export async function run(prisma: DbClient): Promise<string[]> {
  const notes: string[] = [];

  // --- goals ----------------------------------------------------------------
  const goals = await prisma.goal.findMany();
  let goalRules = 0;
  let goalFields = 0;

  for (const goal of goals) {
    const existing = await prisma.scheduleRule.count({
      where: { ownerType: "goal", ownerId: goal.id },
    });

    const startDate = goal.startDate ?? toDayKey(goal.createdAt);

    if (existing === 0) {
      await prisma.scheduleRule.create({
        data: {
          userId: goal.userId,
          ownerType: "goal",
          ownerId: goal.id,
          effectiveFrom: startDate,
          effectiveTo: goal.endDate,
          // Weekly/monthly goals keep applying every day — the *period* is what
          // makes them weekly, not the schedule. Changing that here would
          // silently rewrite history.
          mode: "every_day",
          enabled: goal.active,
        },
      });
      goalRules += 1;
    }

    // Fill in the new descriptive columns without overwriting anything the
    // user may already have set.
    const patch: Record<string, unknown> = {};
    if (goal.startDate === null) patch.startDate = startDate;
    if (goal.source === "manual") {
      const inferred = inferGoalSource(goal.domain, goal.metric);
      if (inferred !== "manual") patch.source = inferred;
    }
    if (Object.keys(patch).length > 0) {
      await prisma.goal.update({ where: { id: goal.id }, data: patch });
      goalFields += 1;
    }
  }

  notes.push(`goals: ${goalRules} schedule rules created, ${goalFields} rows enriched`);

  // --- habits ---------------------------------------------------------------
  const habits = await prisma.habit.findMany();
  let habitRules = 0;
  let recovered = 0;
  let fellBack = 0;

  for (const habit of habits) {
    const existing = await prisma.scheduleRule.count({
      where: { ownerType: "habit", ownerId: habit.id },
    });
    if (existing > 0) continue;

    const weekdays = parseWeekdays(habit.weekdays);

    let mode = "every_day";
    let days: number[] = [];
    let timesPerWeek: number | null = null;

    if (habit.frequency === "custom") {
      if (weekdays.length > 0 && weekdays.length < 7) {
        mode = "weekdays";
        days = weekdays;
        recovered += 1;
      } else if (weekdays.length === 7) {
        mode = "every_day";
        recovered += 1;
      } else {
        // Unrecoverable weekday list — fall back to every day rather than
        // guessing. The habit's logs are untouched either way.
        fellBack += 1;
      }
    } else if (habit.frequency === "weekly") {
      mode = "times_per_week";
      timesPerWeek = Math.min(7, Math.max(1, habit.targetPerWeek || 1));
      recovered += 1;
    } else {
      recovered += 1;
    }

    await prisma.scheduleRule.create({
      data: {
        userId: habit.userId,
        ownerType: "habit",
        ownerId: habit.id,
        effectiveFrom: habit.startDate,
        effectiveTo: habit.endDate,
        mode,
        timesPerWeek,
        enabled: !habit.archived,
        daypart: habit.timeOfDay,
        days: days.length > 0 ? { create: days.map((weekday) => ({ weekday })) } : undefined,
      },
    });
    habitRules += 1;
  }

  notes.push(
    `habits: ${habitRules} schedule rules created (${recovered} recurrence recovered, ${fellBack} defaulted to every day)`,
  );

  if (goalRules === 0 && habitRules === 0) {
    notes.push("nothing to do — every goal and habit already has a schedule");
  }

  void ALL_WEEKDAYS;
  return notes;
}

export const id = "001-schedules";
export const description = "Backfill ScheduleRule for existing goals and habits";
