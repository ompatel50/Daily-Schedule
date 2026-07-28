"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser, prisma } from "@/lib/db";
import { parseTimeToMinute } from "@/lib/date";
import { estimateCaloriesBurned, expandTemplateExercises, type TemplateExercise } from "@/lib/logic/workouts";
import { lbToKg } from "@/lib/logic/nutrition";
import {
  fail,
  fromZod,
  succeed,
  workoutSchema,
  workoutTemplateSchema,
  type ActionResult,
} from "@/lib/validation";
import { recomputeDay } from "@/server/summaries";

function revalidateAll() {
  revalidatePath("/", "layout");
}

/** Latest logged body weight in kg — needed for calorie estimates. */
async function bodyWeightKg(userId: string): Promise<number> {
  const latest = await prisma.healthMetric.findFirst({
    where: { userId, type: "body_weight" },
    orderBy: { date: "desc" },
  });
  if (!latest) return 75;
  // body_weight is stored in the user's display unit; `unit` records which.
  return latest.unit === "kg" ? latest.value : lbToKg(latest.value);
}

export async function saveWorkout(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = workoutSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const user = await getCurrentUser();
  const { id, sets, addToPlanner, ...rest } = parsed.data;

  const caloriesBurned =
    rest.caloriesBurned ??
    (rest.durationMin > 0
      ? estimateCaloriesBurned({
          type: rest.type,
          durationMin: rest.durationMin,
          intensity: rest.intensity,
          bodyWeightKg: await bodyWeightKg(user.id),
        })
      : null);

  const data = {
    ...rest,
    time: rest.time ?? null,
    notes: rest.notes ?? null,
    distanceKm: rest.distanceKm ?? null,
    avgHeartRate: rest.avgHeartRate ?? null,
    perceivedEffort: rest.perceivedEffort ?? null,
    caloriesBurned,
    userId: user.id,
  };

  const workout = id
    ? await prisma.$transaction(async (tx) => {
        const updated = await tx.workout.update({ where: { id }, data });
        await tx.workoutSet.deleteMany({ where: { workoutId: id } });
        if (sets.length) {
          await tx.workoutSet.createMany({
            data: sets.map((set, index) => ({
              ...normaliseSet(set),
              workoutId: id,
              sortOrder: index,
            })),
          });
        }
        return updated;
      })
    : await prisma.workout.create({
        data: {
          ...data,
          sets: sets.length
            ? { create: sets.map((set, index) => ({ ...normaliseSet(set), sortOrder: index })) }
            : undefined,
        },
      });

  if (addToPlanner) await syncPlannerItem(user.id, workout.id);

  await recomputeDay(user.id, workout.date);
  revalidateAll();
  return succeed({ id: workout.id });
}

function normaliseSet(set: {
  exercise: string;
  setNumber: number;
  reps?: number | null;
  weightKg?: number | null;
  durationSec?: number | null;
  distanceM?: number | null;
  restSec?: number | null;
  rpe?: number | null;
  notes?: string | null;
  completed: boolean;
}) {
  return {
    exercise: set.exercise,
    setNumber: set.setNumber,
    reps: set.reps ?? null,
    weightKg: set.weightKg ?? null,
    durationSec: set.durationSec ?? null,
    distanceM: set.distanceM ?? null,
    restSec: set.restSec ?? null,
    rpe: set.rpe ?? null,
    notes: set.notes ?? null,
    completed: set.completed,
  };
}

/**
 * Workouts show up on the planner as real schedule items, so "what's on today"
 * is one list. The link is 1:1 via `ScheduleItem.workoutId`.
 */
async function syncPlannerItem(userId: string, workoutId: string): Promise<void> {
  const workout = await prisma.workout.findUnique({ where: { id: workoutId } });
  if (!workout) return;

  const startMinute = workout.time ? parseTimeToMinute(workout.time) : null;
  const endMinute =
    startMinute !== null && workout.durationMin > 0
      ? Math.min(1439, startMinute + workout.durationMin)
      : null;

  const fields = {
    title: workout.name,
    date: workout.date,
    startMinute,
    endMinute,
    allDay: startMinute === null,
    category: "fitness",
    status: workout.status === "completed" ? "done" : workout.status === "skipped" ? "skipped" : "planned",
    completedAt: workout.status === "completed" ? new Date() : null,
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

export async function deleteWorkout(id: string): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  const workout = await prisma.workout.findFirst({ where: { id, userId: user.id } });
  if (!workout) return fail("Workout not found");

  // Remove the mirrored planner item too, otherwise the day shows a ghost task.
  await prisma.scheduleItem.deleteMany({ where: { workoutId: id, userId: user.id } });
  await prisma.workout.delete({ where: { id } });

  await recomputeDay(user.id, workout.date);
  revalidateAll();
  return succeed(null);
}

export async function setWorkoutStatus(
  id: string,
  status: "planned" | "completed" | "skipped",
): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  const workout = await prisma.workout.findFirst({ where: { id, userId: user.id } });
  if (!workout) return fail("Workout not found");

  await prisma.workout.update({ where: { id }, data: { status } });
  await syncPlannerItem(user.id, id);
  await recomputeDay(user.id, workout.date);
  revalidateAll();
  return succeed(null);
}

// --- templates --------------------------------------------------------------

export async function saveWorkoutTemplate(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = workoutTemplateSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const user = await getCurrentUser();
  const { id, exercises, ...rest } = parsed.data;
  const data = {
    ...rest,
    description: rest.description ?? null,
    exercises: JSON.stringify(exercises),
    userId: user.id,
  };

  const template = id
    ? await prisma.workoutTemplate.update({ where: { id }, data })
    : await prisma.workoutTemplate.create({ data });

  revalidateAll();
  return succeed({ id: template.id });
}

export async function deleteWorkoutTemplate(id: string): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  await prisma.workoutTemplate.deleteMany({ where: { id, userId: user.id } });
  revalidateAll();
  return succeed(null);
}

/** Turn a template into a real (completed) workout on `date`, in one click. */
export async function startWorkoutFromTemplate(
  templateId: string,
  date: string,
  status: "planned" | "completed" = "completed",
): Promise<ActionResult<{ id: string }>> {
  const user = await getCurrentUser();
  const template = await prisma.workoutTemplate.findFirst({
    where: { id: templateId, userId: user.id },
  });
  if (!template) return fail("Template not found");

  let exercises: TemplateExercise[] = [];
  try {
    exercises = JSON.parse(template.exercises);
  } catch {
    exercises = [];
  }

  const rows = expandTemplateExercises(exercises);

  const result = await saveWorkout({
    date,
    name: template.name,
    type: template.type,
    durationMin: template.durationMin,
    intensity: template.intensity,
    status,
    notes: template.description ?? null,
    sets: rows.map((row, index) => ({
      exercise: row.exercise,
      setNumber: index + 1,
      reps: row.reps ?? null,
      weightKg: row.weightKg ?? null,
      completed: status === "completed",
    })),
    addToPlanner: true,
  });

  if (result.ok) {
    await prisma.workoutTemplate.update({
      where: { id: template.id },
      data: { useCount: { increment: 1 }, lastUsed: new Date() },
    });
    await prisma.workout.update({
      where: { id: result.data.id },
      data: { templateId: template.id },
    });
  }

  revalidateAll();
  return result;
}

/** Repeat a past workout on a new day, carrying the sets over. */
export async function repeatWorkout(id: string, date: string): Promise<ActionResult<{ id: string }>> {
  const user = await getCurrentUser();
  const source = await prisma.workout.findFirst({
    where: { id, userId: user.id },
    include: { sets: { orderBy: { sortOrder: "asc" } } },
  });
  if (!source) return fail("Workout not found");

  return saveWorkout({
    date,
    time: source.time,
    name: source.name,
    type: source.type,
    durationMin: source.durationMin,
    intensity: source.intensity,
    distanceKm: source.distanceKm,
    notes: source.notes,
    status: "completed",
    sets: source.sets.map((set, index) => ({
      exercise: set.exercise,
      setNumber: index + 1,
      reps: set.reps,
      weightKg: set.weightKg,
      durationSec: set.durationSec,
      distanceM: set.distanceM,
      completed: true,
    })),
    addToPlanner: true,
  });
}
