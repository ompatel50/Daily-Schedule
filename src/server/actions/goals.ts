"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser, prisma } from "@/lib/db";
import { type DayKey } from "@/lib/date";
import { todayIn } from "@/lib/logic/schedule";
import {
  dateOverrideSchema,
  fail,
  fromZod,
  goalEntrySchema,
  goalWithScheduleSchema,
  succeed,
  type ActionResult,
} from "@/lib/validation";
import {
  clearDateOverride,
  deleteSchedule,
  setDateOverride,
  setScheduleEnabled,
  writeSchedule,
} from "@/server/schedule";
import { recomputeDay } from "@/server/summaries";

function revalidateAll() {
  revalidatePath("/", "layout");
}

/**
 * Create or update a goal and its schedule in one submission.
 *
 * Schedule edits default to `forward`: the change applies from today onward and
 * the previous version is closed off rather than overwritten, so yesterday's
 * score cannot silently change because you edited a schedule this morning.
 * "Recalculate all history" is available but must be asked for explicitly.
 */
export async function saveGoalWithSchedule(
  input: unknown,
): Promise<ActionResult<{ id: string; scheduleId: string }>> {
  const parsed = goalWithScheduleSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const user = await getCurrentUser();
  const today = todayIn(user.timezone);
  const { goal: goalInput, schedule, apply } = parsed.data;
  const { id, ...fields } = goalInput;

  if (fields.direction === "range" && (fields.targetMax ?? 0) <= fields.target) {
    return fail("The range maximum must be greater than the minimum", {
      targetMax: ["Must be greater than the minimum"],
    });
  }
  if (fields.source === "habit" && !fields.sourceRef) {
    return fail("Choose which habit completes this goal", { sourceRef: ["Pick a habit"] });
  }

  const data = {
    ...fields,
    description: fields.description ?? null,
    targetMax: fields.direction === "range" ? (fields.targetMax ?? null) : null,
    sourceRef: fields.source === "habit" ? (fields.sourceRef ?? null) : null,
    startDate: fields.startDate ?? today,
    endDate: fields.endDate ?? null,
  };

  if (data.sourceRef) {
    // A habit-sourced goal must point at the user's own habit — a foreign id
    // would leak another account's completions into this user's score.
    const habit = await prisma.habit.findFirst({
      where: { id: data.sourceRef, userId: user.id },
      select: { id: true },
    });
    if (!habit) return fail("Choose which habit completes this goal", { sourceRef: ["Pick a habit"] });
  }

  const goal = id
    ? await prisma.goal.update({ where: { id, userId: user.id }, data })
    : await prisma.goal.create({
        data: {
          ...data,
          userId: user.id,
          sortOrder: await prisma.goal.count({ where: { userId: user.id } }),
        },
      });

  const scheduleId = await writeSchedule({
    userId: user.id,
    ownerType: "goal",
    ownerId: goal.id,
    input: schedule,
    apply: apply?.mode ?? "forward",
    applyFrom: apply?.from,
    ownerStartDate: data.startDate,
    today,
  });

  await recomputeDay(user.id, today);
  revalidateAll();
  return succeed({ id: goal.id, scheduleId });
}

export async function setGoalEnabled(
  id: string,
  enabled: boolean,
): Promise<ActionResult<{ enabled: boolean }>> {
  const user = await getCurrentUser();
  const goal = await prisma.goal.findFirst({ where: { id, userId: user.id } });
  if (!goal) return fail("Goal not found");

  await prisma.goal.update({ where: { id }, data: { active: enabled } });
  await setScheduleEnabled(user.id, "goal", id, enabled);

  await recomputeDay(user.id, todayIn(user.timezone));
  revalidateAll();
  return succeed({ enabled });
}

/**
 * Archiving keeps every record — the goal stops applying from today, and its
 * history stays queryable. Deletion is a separate, confirmed action.
 */
export async function archiveGoal(id: string, archived = true): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  const goal = await prisma.goal.findFirst({ where: { id, userId: user.id } });
  if (!goal) return fail("Goal not found");

  await prisma.goal.update({
    where: { id },
    data: { archivedAt: archived ? new Date() : null, active: archived ? false : goal.active },
  });
  await setScheduleEnabled(user.id, "goal", id, !archived && goal.active);

  await recomputeDay(user.id, todayIn(user.timezone));
  revalidateAll();
  return succeed(null);
}

export async function deleteGoalPermanently(id: string): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  const goal = await prisma.goal.findFirst({ where: { id, userId: user.id } });
  if (!goal) return fail("Goal not found");

  await prisma.$transaction([
    prisma.goalEntry.deleteMany({ where: { goalId: id } }),
    prisma.goal.delete({ where: { id } }),
  ]);
  await deleteSchedule(user.id, "goal", id);

  await recomputeDay(user.id, todayIn(user.timezone));
  revalidateAll();
  return succeed(null);
}

/** Record a manual outcome — for goals the app cannot prove on its own. */
export async function logGoalEntry(input: unknown): Promise<ActionResult<{ status: string }>> {
  const parsed = goalEntrySchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const user = await getCurrentUser();
  const { goalId, date, status, value, notes } = parsed.data;

  const goal = await prisma.goal.findFirst({ where: { id: goalId, userId: user.id } });
  if (!goal) return fail("Goal not found");

  await prisma.goalEntry.upsert({
    where: { goalId_date: { goalId, date } },
    create: { goalId, userId: user.id, date, status, value: value ?? null, notes: notes ?? null },
    update: { status, value: value ?? null, notes: notes ?? null },
  });

  await recomputeDay(user.id, date);
  revalidateAll();
  return succeed({ status });
}

export async function clearGoalEntry(goalId: string, date: DayKey): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  await prisma.goalEntry.deleteMany({ where: { goalId, userId: user.id, date } });
  await recomputeDay(user.id, date);
  revalidateAll();
  return succeed(null);
}

// ---------------------------------------------------------------------------
// Date-specific overrides (shared by goals and habits)
// ---------------------------------------------------------------------------

/**
 * Make one date an exception without touching the repeating schedule — "rest
 * today", "excused", "train today anyway", "move this one".
 */
export async function applyDateOverride(input: unknown): Promise<ActionResult<{ kind: string }>> {
  const parsed = dateOverrideSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const user = await getCurrentUser();
  const { ownerType, ownerId, date, kind, movedToDate, timeMinute, note } = parsed.data;

  if (kind === "reschedule" && !movedToDate) {
    return fail("Choose the date to move this to", { movedToDate: ["Pick a date"] });
  }

  const owner =
    ownerType === "goal"
      ? await prisma.goal.findFirst({ where: { id: ownerId, userId: user.id } })
      : await prisma.habit.findFirst({ where: { id: ownerId, userId: user.id } });
  if (!owner) return fail(`${ownerType === "goal" ? "Goal" : "Habit"} not found`);

  await setDateOverride({
    userId: user.id,
    ownerType,
    ownerId,
    date,
    kind,
    movedToDate,
    timeMinute,
    note,
  });

  await recomputeDay(user.id, date);
  if (movedToDate) await recomputeDay(user.id, movedToDate);
  revalidateAll();
  return succeed({ kind });
}

/** "Restore the normal occurrence." */
export async function removeDateOverride(
  ownerType: "goal" | "habit",
  ownerId: string,
  date: DayKey,
): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  await clearDateOverride(user.id, ownerType, ownerId, date);
  await recomputeDay(user.id, date);
  revalidateAll();
  return succeed(null);
}

export async function reorderGoals(orderedIds: string[]): Promise<ActionResult<{ count: number }>> {
  const user = await getCurrentUser();
  await prisma.$transaction(
    orderedIds.map((id, index) =>
      prisma.goal.updateMany({ where: { id, userId: user.id }, data: { sortOrder: index } }),
    ),
  );
  revalidateAll();
  return succeed({ count: orderedIds.length });
}
