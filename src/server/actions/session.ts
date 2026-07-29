"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser, prisma } from "@/lib/db";
import { parseTimeToMinute } from "@/lib/date";
import {
  canTransition,
  defaultRestSec,
  elapsedMinutes,
  planSetsFromTemplate,
  planSetsFromWorkout,
  sessionDurationMinutes,
  type PlannedSet,
  type SessionSet,
  type TemplateExerciseLike,
} from "@/lib/logic/session";
import { estimateCaloriesBurned } from "@/lib/logic/workouts";
import { lbToKg } from "@/lib/logic/nutrition";
import { fail, fromZod, succeed, type ActionResult } from "@/lib/validation";
import {
  completeSetSchema,
  startSessionSchema,
  addSessionSetSchema,
} from "@/lib/validation";
import { recomputeDay } from "@/server/summaries";

/**
 * The live workout session.
 *
 * One rule shapes all of it: **a session is the source of truth for what
 * happened, and it is only counted once it ends.** An open session does not
 * feed the day score, because a warm-up you abandoned is not training. Finishing
 * derives the duration from real elapsed time rather than a number typed in
 * advance, and everything downstream — the score, the calendar, Insights — is
 * refreshed through the same `recomputeDay` every other write uses.
 */

function revalidateAll() {
  revalidatePath("/", "layout");
}

async function bodyWeightKg(userId: string): Promise<number> {
  const latest = await prisma.healthMetric.findFirst({
    where: { userId, type: "body_weight" },
    orderBy: { date: "desc" },
  });
  if (!latest) return 75;
  return latest.unit === "kg" ? latest.value : lbToKg(latest.value);
}

/** Keep the planner row in step with the session's status. */
async function syncPlannerItem(userId: string, workoutId: string): Promise<void> {
  const workout = await prisma.workout.findUnique({ where: { id: workoutId } });
  if (!workout) return;

  const startMinute = workout.time ? parseTimeToMinute(workout.time) : null;
  const endMinute =
    startMinute !== null && workout.durationMin > 0
      ? Math.min(1439, startMinute + workout.durationMin)
      : null;

  // An in-progress session is still "planned" on the schedule: it is work
  // outstanding, not work done, and the day score must read it that way.
  const status =
    workout.status === "completed" || workout.status === "abandoned"
      ? "done"
      : workout.status === "skipped"
        ? "skipped"
        : "planned";

  const fields = {
    title: workout.name,
    date: workout.date,
    startMinute,
    endMinute,
    allDay: startMinute === null,
    category: "fitness",
    status,
    completedAt: status === "done" ? (workout.completedAt ?? new Date()) : null,
  };

  const existing = await prisma.scheduleItem.findFirst({ where: { workoutId, userId } });
  if (existing) {
    await prisma.scheduleItem.update({ where: { id: existing.id }, data: fields });
    if (existing.date !== workout.date) await recomputeDay(userId, existing.date);
  } else {
    await prisma.scheduleItem.create({
      data: { ...fields, userId, workoutId, priority: "medium", category: "fitness" },
    });
  }
}

// ---------------------------------------------------------------------------
// Reading the open session
// ---------------------------------------------------------------------------

/**
 * The one open session, if there is one.
 *
 * Deliberately unbounded by date: a session started before midnight is still
 * yours at 00:30, and asking "is anything running" must not depend on which day
 * the UI happens to be showing.
 */
export async function getActiveSession(): Promise<ActionResult<{ id: string; date: string } | null>> {
  const user = await getCurrentUser();
  const open = await prisma.workout.findFirst({
    where: { userId: user.id, status: "in_progress" },
    orderBy: { startedAt: "desc" },
    select: { id: true, date: true },
  });
  return succeed(open);
}

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

function parseTemplateExercises(json: string): TemplateExerciseLike[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as TemplateExerciseLike[]) : [];
  } catch {
    return [];
  }
}

/**
 * Open a session — from a template, by repeating a past workout, or empty.
 *
 * Refuses when one is already open rather than silently starting a second, and
 * returns the existing id so the caller can offer to resume it. Two live
 * sessions have no coherent meaning: which one does the next set belong to?
 */
export async function startSession(input: unknown): Promise<
  ActionResult<{ id: string; resumed: boolean }>
> {
  const parsed = startSessionSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const user = await getCurrentUser();
  const { date, templateId, fromWorkoutId, name, type } = parsed.data;

  const open = await prisma.workout.findFirst({
    where: { userId: user.id, status: "in_progress" },
    select: { id: true },
  });
  if (open) {
    // Not an error the user has to recover from — the UI offers to resume.
    return succeed({ id: open.id, resumed: true });
  }

  let planned: PlannedSet[] = [];
  let sessionName = name?.trim() || "Workout";
  let sessionType: string = type ?? "strength";
  let plannedDuration = 45;
  let intensity = "moderate";
  let notes: string | null = null;
  let linkedTemplateId: string | null = null;

  if (templateId) {
    const template = await prisma.workoutTemplate.findFirst({
      where: { id: templateId, userId: user.id },
    });
    if (!template) return fail("Template not found");

    planned = planSetsFromTemplate(parseTemplateExercises(template.exercises));
    sessionName = template.name;
    sessionType = template.type;
    plannedDuration = template.durationMin;
    intensity = template.intensity;
    notes = template.description ?? null;
    linkedTemplateId = template.id;
  } else if (fromWorkoutId) {
    const source = await prisma.workout.findFirst({
      where: { id: fromWorkoutId, userId: user.id },
      include: { sets: { orderBy: { sortOrder: "asc" } } },
    });
    if (!source) return fail("Workout not found");

    // Last time's numbers become this time's targets.
    planned = planSetsFromWorkout(
      source.sets.map((set) => ({
        exercise: set.exercise,
        setNumber: set.setNumber,
        reps: set.reps,
        weightKg: set.weightKg,
        restSec: set.restSec,
        sortOrder: set.sortOrder,
      })),
    );
    sessionName = source.name;
    sessionType = source.type;
    plannedDuration = source.durationMin || 45;
    intensity = source.intensity;
  }

  const startedAt = new Date();

  const workout = await prisma.workout.create({
    data: {
      userId: user.id,
      date,
      name: sessionName,
      type: sessionType,
      status: "in_progress",
      startedAt,
      // Nothing has happened yet, so nothing is claimed. The duration is
      // derived on finish; this is only the plan's estimate for the planner row.
      durationMin: 0,
      intensity,
      notes,
      templateId: linkedTemplateId,
      restSecDefault: defaultRestSec(planned),
      sets: {
        create: planned.map((set) => ({
          exercise: set.exercise,
          setNumber: set.setNumber,
          targetReps: set.targetReps,
          targetWeightKg: set.targetWeightKg,
          restSec: set.restSec,
          // The difference from logging after the fact: real work outstanding.
          completed: false,
          completedAt: null,
          sortOrder: set.sortOrder,
        })),
      },
    },
  });

  // Put a placeholder length on the planner row so the block has a size.
  await prisma.workout.update({
    where: { id: workout.id },
    data: { durationMin: plannedDuration },
  });

  if (linkedTemplateId) {
    await prisma.workoutTemplate.update({
      where: { id: linkedTemplateId },
      data: { useCount: { increment: 1 }, lastUsed: new Date() },
    });
  }

  await syncPlannerItem(user.id, workout.id);
  await recomputeDay(user.id, date);
  revalidateAll();
  return succeed({ id: workout.id, resumed: false });
}

// ---------------------------------------------------------------------------
// Working through it
// ---------------------------------------------------------------------------

/**
 * Tick a set off, recording what was actually done.
 *
 * Values fall back to the target when the user just taps the checkbox without
 * editing — the common case is "I did what it said". Stamping `completedAt` is
 * what makes the rest timer and the elapsed time reconstructable after a reload.
 */
export async function completeSet(input: unknown): Promise<ActionResult<null>> {
  const parsed = completeSetSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const user = await getCurrentUser();
  const set = await prisma.workoutSet.findFirst({
    where: { id: parsed.data.id, workout: { userId: user.id } },
    include: { workout: { select: { id: true, status: true, date: true } } },
  });
  if (!set) return fail("Set not found");
  if (set.workout.status !== "in_progress") return fail("That session is not open");

  const { reps, weightKg, rpe, notes } = parsed.data;

  await prisma.workoutSet.update({
    where: { id: set.id },
    data: {
      completed: true,
      completedAt: new Date(),
      reps: reps ?? set.reps ?? set.targetReps,
      weightKg: weightKg ?? set.weightKg ?? set.targetWeightKg,
      rpe: rpe ?? set.rpe,
      notes: notes ?? set.notes,
    },
  });

  revalidateAll();
  return succeed(null);
}

/** Untick a set — a mis-tap, or a set you decided to redo. */
export async function uncompleteSet(id: string): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  const set = await prisma.workoutSet.findFirst({
    where: { id, workout: { userId: user.id } },
    include: { workout: { select: { status: true } } },
  });
  if (!set) return fail("Set not found");
  if (set.workout.status !== "in_progress") return fail("That session is not open");

  await prisma.workoutSet.update({
    where: { id: set.id },
    // The recorded values stay: unticking says "not done yet", not "forget what
    // I typed", and re-ticking should not make you enter it again.
    data: { completed: false, completedAt: null },
  });

  revalidateAll();
  return succeed(null);
}

/** Add a set mid-session — an extra one, or a whole extra exercise. */
export async function addSessionSet(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = addSessionSetSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const user = await getCurrentUser();
  const workout = await prisma.workout.findFirst({
    where: { id: parsed.data.workoutId, userId: user.id },
    include: { sets: true },
  });
  if (!workout) return fail("Session not found");
  if (workout.status !== "in_progress") return fail("That session is not open");

  const exercise = parsed.data.exercise.trim();
  const sameExercise = workout.sets.filter(
    (set) => set.exercise.toLowerCase() === exercise.toLowerCase(),
  );
  const lastOfExercise = sameExercise.sort((a, b) => b.setNumber - a.setNumber)[0];
  const maxOrder = workout.sets.reduce((max, set) => Math.max(max, set.sortOrder), -1);

  const created = await prisma.workoutSet.create({
    data: {
      workoutId: workout.id,
      exercise,
      setNumber: (lastOfExercise?.setNumber ?? 0) + 1,
      // A new set of an exercise you are already doing inherits its numbers as
      // the target — you are almost certainly repeating the same thing.
      targetReps: parsed.data.targetReps ?? lastOfExercise?.targetReps ?? null,
      targetWeightKg: parsed.data.targetWeightKg ?? lastOfExercise?.targetWeightKg ?? null,
      restSec: lastOfExercise?.restSec ?? workout.restSecDefault ?? null,
      completed: false,
      sortOrder: maxOrder + 1,
    },
  });

  revalidateAll();
  return succeed({ id: created.id });
}

export async function removeSessionSet(id: string): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  const set = await prisma.workoutSet.findFirst({
    where: { id, workout: { userId: user.id } },
    include: { workout: { select: { status: true } } },
  });
  if (!set) return fail("Set not found");
  if (set.workout.status !== "in_progress") return fail("That session is not open");

  await prisma.workoutSet.delete({ where: { id } });
  revalidateAll();
  return succeed(null);
}

/** Adjust the session's rest length while training. */
export async function setSessionRest(
  workoutId: string,
  restSec: number | null,
): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  const workout = await prisma.workout.findFirst({
    where: { id: workoutId, userId: user.id, status: "in_progress" },
  });
  if (!workout) return fail("That session is not open");

  const clamped =
    restSec === null || restSec <= 0 ? null : Math.min(Math.round(restSec), 3600);

  await prisma.workout.update({ where: { id: workout.id }, data: { restSecDefault: clamped } });
  revalidateAll();
  return succeed(null);
}

// ---------------------------------------------------------------------------
// Ending
// ---------------------------------------------------------------------------

async function closeSession(
  workoutId: string,
  status: "completed" | "abandoned",
): Promise<ActionResult<{ durationMin: number; completedSets: number }>> {
  const user = await getCurrentUser();
  const workout = await prisma.workout.findFirst({
    where: { id: workoutId, userId: user.id },
    include: { sets: true },
  });
  if (!workout) return fail("Session not found");

  if (!canTransition(workout.status, status)) {
    return fail(`A ${workout.status} workout cannot become ${status}`);
  }

  const completedAt = new Date();
  const sets: SessionSet[] = workout.sets.map((set) => ({
    id: set.id,
    exercise: set.exercise,
    setNumber: set.setNumber,
    reps: set.reps,
    weightKg: set.weightKg,
    durationSec: set.durationSec,
    distanceM: set.distanceM,
    targetReps: set.targetReps,
    targetWeightKg: set.targetWeightKg,
    restSec: set.restSec,
    rpe: set.rpe,
    completed: set.completed,
    completedAt: set.completedAt?.toISOString() ?? null,
    sortOrder: set.sortOrder,
  }));

  // Real elapsed time, clamped — see `sessionDurationMinutes`. A typed-in
  // estimate is exactly what a session exists to replace.
  const durationMin = sessionDurationMinutes(workout.startedAt, completedAt, sets);
  const completedSets = sets.filter((set) => set.completed).length;

  const weight = await bodyWeightKg(user.id);
  const caloriesBurned =
    workout.caloriesBurned ??
    estimateCaloriesBurned({
      type: workout.type,
      durationMin,
      intensity: workout.intensity,
      bodyWeightKg: weight,
    });

  await prisma.workout.update({
    where: { id: workout.id },
    data: { status, completedAt, durationMin, caloriesBurned },
  });

  // Sets left outstanding stay outstanding. Marking them done on finish would
  // make the record claim work that was not performed; `totalVolume` already
  // ignores incomplete sets, so the numbers stay honest either way.
  await syncPlannerItem(user.id, workout.id);
  await recomputeDay(user.id, workout.date);
  revalidateAll();
  return succeed({ durationMin, completedSets });
}

/** Finish the session and count it. */
export async function finishSession(
  workoutId: string,
): Promise<ActionResult<{ durationMin: number; completedSets: number }>> {
  return closeSession(workoutId, "completed");
}

/**
 * Stop early, keeping what was done.
 *
 * Distinct from finishing because "I did three of eight sets and stopped" is
 * true and worth recording, and distinct from discarding because it happened.
 */
export async function abandonSession(
  workoutId: string,
): Promise<ActionResult<{ durationMin: number; completedSets: number }>> {
  return closeSession(workoutId, "abandoned");
}

/**
 * Throw the session away — for a mis-tap, not a real workout.
 *
 * Refuses once any set has been ticked: at that point something happened, and
 * "stop early" is the honest option. Prevents a stray tap from erasing work.
 */
export async function discardSession(workoutId: string): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  const workout = await prisma.workout.findFirst({
    where: { id: workoutId, userId: user.id },
    include: { sets: { select: { completed: true } } },
  });
  if (!workout) return fail("Session not found");
  if (workout.status !== "in_progress") return fail("That session is not open");

  if (workout.sets.some((set) => set.completed)) {
    return fail("Some sets are already done — stop the session early instead of discarding it");
  }

  const { date } = workout;
  await prisma.scheduleItem.deleteMany({ where: { workoutId: workout.id, userId: user.id } });
  await prisma.workout.delete({ where: { id: workout.id } });

  await recomputeDay(user.id, date);
  revalidateAll();
  return succeed(null);
}

/**
 * Reopen a finished workout to fix something.
 *
 * The elapsed clock resumes from the original `startedAt`, so reopening to add
 * a forgotten set does not reset the duration to zero.
 */
export async function reopenSession(workoutId: string): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  const workout = await prisma.workout.findFirst({
    where: { id: workoutId, userId: user.id },
  });
  if (!workout) return fail("Workout not found");

  if (!canTransition(workout.status, "in_progress")) {
    return fail(`A ${workout.status} workout cannot be reopened`);
  }

  const open = await prisma.workout.findFirst({
    where: { userId: user.id, status: "in_progress" },
    select: { id: true },
  });
  if (open && open.id !== workout.id) {
    return fail("Finish the session you already have open first");
  }

  await prisma.workout.update({
    where: { id: workout.id },
    data: {
      status: "in_progress",
      completedAt: null,
      // A workout logged after the fact has no start stamp; use its date so the
      // elapsed clock has something to measure from rather than reading zero.
      startedAt: workout.startedAt ?? new Date(),
    },
  });

  await syncPlannerItem(user.id, workout.id);
  await recomputeDay(user.id, workout.date);
  revalidateAll();
  return succeed(null);
}

/** Elapsed minutes for a session, for the server-rendered header. */
export async function sessionElapsed(workoutId: string): Promise<ActionResult<number>> {
  const user = await getCurrentUser();
  const workout = await prisma.workout.findFirst({
    where: { id: workoutId, userId: user.id },
    select: { startedAt: true, completedAt: true },
  });
  if (!workout) return fail("Session not found");
  return succeed(elapsedMinutes(workout.startedAt, workout.completedAt));
}
