"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser, prisma } from "@/lib/db";
import { type DayKey } from "@/lib/date";
import { todayIn } from "@/lib/logic/schedule";
import {
  fail,
  fromZod,
  habitLogSchema,
  habitWithScheduleSchema,
  succeed,
  type ActionResult,
} from "@/lib/validation";
import { deleteSchedule, setScheduleEnabled, writeSchedule } from "@/server/schedule";
import { recomputeDay } from "@/server/summaries";

function revalidateAll() {
  revalidatePath("/", "layout");
}

/**
 * Create or update a habit and its schedule in one submission.
 *
 * `ScheduleRule` is the authoritative schedule. The legacy `frequency` /
 * `weekdays` / `targetPerWeek` columns are still written, as derived mirrors,
 * so backups taken before this upgrade continue to restore and the raw
 * database stays readable — but nothing reads them for scheduling.
 */
export async function saveHabit(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = habitWithScheduleSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const user = await getCurrentUser();
  const todayKey = todayIn(user.timezone);
  const { habit: fields, schedule, apply } = parsed.data;
  const { id, ...rest } = fields;

  const legacy = toLegacyRecurrence(schedule);

  const data = {
    ...rest,
    description: rest.description ?? null,
    endDate: rest.endDate ?? null,
    timeOfDay: schedule.daypart,
    ...legacy,
    userId: user.id,
  };

  const habit = id
    ? // The userId filter makes an edit of someone else's habit a not-found
      // (P2025) instead of a silent ownership transfer.
      await prisma.habit.update({ where: { id, userId: user.id }, data })
    : await prisma.habit.create({
        data: {
          ...data,
          sortOrder: await prisma.habit.count({ where: { userId: user.id } }),
        },
      });

  await writeSchedule({
    userId: user.id,
    ownerType: "habit",
    ownerId: habit.id,
    input: schedule,
    apply: apply?.mode ?? "forward",
    applyFrom: apply?.from,
    ownerStartDate: rest.startDate,
    today: todayKey,
  });

  await recomputeDay(user.id, todayKey);
  revalidateAll();
  return succeed({ id: habit.id });
}

/**
 * Project a schedule onto the pre-upgrade columns. Lossy by nature — the old
 * shape cannot express "every 3 days" — so anything it cannot represent is
 * recorded as `custom` with the days it does know about.
 */
function toLegacyRecurrence(schedule: {
  mode: string;
  weekdays: number[];
  timesPerWeek: number | null;
}): { frequency: string; weekdays: string; targetPerWeek: number } {
  switch (schedule.mode) {
    case "every_day":
      return { frequency: "daily", weekdays: JSON.stringify([0, 1, 2, 3, 4, 5, 6]), targetPerWeek: 7 };
    case "times_per_week":
      return {
        frequency: "weekly",
        weekdays: JSON.stringify([0, 1, 2, 3, 4, 5, 6]),
        targetPerWeek: Math.min(7, Math.max(1, schedule.timesPerWeek ?? 1)),
      };
    case "weekdays":
      return {
        frequency: "custom",
        weekdays: JSON.stringify([...schedule.weekdays].sort((a, b) => a - b)),
        targetPerWeek: Math.max(1, schedule.weekdays.length),
      };
    default:
      return {
        frequency: "custom",
        weekdays: JSON.stringify(
          schedule.weekdays.length ? [...schedule.weekdays].sort((a, b) => a - b) : [0, 1, 2, 3, 4, 5, 6],
        ),
        targetPerWeek: Math.max(1, schedule.weekdays.length || 7),
      };
  }
}

export async function logHabit(input: unknown): Promise<ActionResult<{ status: string }>> {
  const parsed = habitLogSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const user = await getCurrentUser();
  const { habitId, date, status, value, notes } = parsed.data;

  const habit = await prisma.habit.findFirst({ where: { id: habitId, userId: user.id } });
  if (!habit) return fail("Habit not found");

  await prisma.habitLog.upsert({
    where: { habitId_date: { habitId, date } },
    create: { habitId, userId: user.id, date, status, value: value ?? null, notes: notes ?? null },
    update: { status, value: value ?? null, notes: notes ?? null },
  });

  await recomputeDay(user.id, date);
  revalidateAll();
  return succeed({ status });
}

/**
 * One-click cycling used by the habit checkboxes:
 *   unlogged → done → skipped → unlogged
 *
 * `skipped` is a real miss — it breaks the streak. That is deliberate: the
 * neutral option is "excused", which is a separate, explicit choice rather
 * than something you can reach by clicking twice.
 */
export async function cycleHabitLog(
  habitId: string,
  date: DayKey,
): Promise<ActionResult<{ status: string | null }>> {
  const user = await getCurrentUser();
  const habit = await prisma.habit.findFirst({ where: { id: habitId, userId: user.id } });
  if (!habit) return fail("Habit not found");

  const existing = await prisma.habitLog.findUnique({ where: { habitId_date: { habitId, date } } });

  let next: string | null;
  if (!existing) next = "done";
  else if (existing.status === "done") next = "skipped";
  else next = null;

  if (next === null) {
    await prisma.habitLog.delete({ where: { habitId_date: { habitId, date } } });
  } else {
    await prisma.habitLog.upsert({
      where: { habitId_date: { habitId, date } },
      create: { habitId, userId: user.id, date, status: next },
      update: { status: next },
    });
  }

  await recomputeDay(user.id, date);
  revalidateAll();
  return succeed({ status: next });
}

/**
 * Mark a scheduled day as excused — no credit, but the streak survives.
 * Recorded as a log rather than a schedule override so it reads as "what
 * happened on this day" rather than "this day was never scheduled".
 */
export async function excuseHabit(
  habitId: string,
  date: DayKey,
): Promise<ActionResult<{ status: string }>> {
  const user = await getCurrentUser();
  const habit = await prisma.habit.findFirst({ where: { id: habitId, userId: user.id } });
  if (!habit) return fail("Habit not found");

  await prisma.habitLog.upsert({
    where: { habitId_date: { habitId, date } },
    create: { habitId, userId: user.id, date, status: "excused" },
    update: { status: "excused" },
  });

  await recomputeDay(user.id, date);
  revalidateAll();
  return succeed({ status: "excused" });
}

export async function archiveHabit(id: string, archived = true): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  const habit = await prisma.habit.findFirst({ where: { id, userId: user.id } });
  if (!habit) return fail("Habit not found");

  await prisma.habit.update({ where: { id }, data: { archived } });
  await setScheduleEnabled(user.id, "habit", id, !archived);

  await recomputeDay(user.id, todayIn(user.timezone));
  revalidateAll();
  return succeed(null);
}

export async function deleteHabit(id: string): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  const habit = await prisma.habit.findFirst({ where: { id, userId: user.id } });
  if (!habit) return fail("Habit not found");

  // Logs cascade with the habit; the schedule is polymorphic, so it is removed
  // explicitly rather than relying on a foreign key.
  await prisma.habit.delete({ where: { id } });
  await deleteSchedule(user.id, "habit", id);

  await recomputeDay(user.id, todayIn(user.timezone));
  revalidateAll();
  return succeed(null);
}

export async function reorderHabits(orderedIds: string[]): Promise<ActionResult<{ count: number }>> {
  const user = await getCurrentUser();
  await prisma.$transaction(
    orderedIds.map((id, index) =>
      prisma.habit.updateMany({ where: { id, userId: user.id }, data: { sortOrder: index } }),
    ),
  );
  revalidateAll();
  return succeed({ count: orderedIds.length });
}
