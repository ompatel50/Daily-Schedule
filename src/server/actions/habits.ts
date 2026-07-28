"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser, prisma } from "@/lib/db";
import { type DayKey, today } from "@/lib/date";
import { fail, fromZod, habitLogSchema, habitSchema, succeed, type ActionResult } from "@/lib/validation";
import { recomputeDay } from "@/server/summaries";

function revalidateAll() {
  revalidatePath("/", "layout");
}

export async function saveHabit(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = habitSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const user = await getCurrentUser();
  const { id, weekdays, ...rest } = parsed.data;

  // A `daily` habit is just "every weekday selected" — normalise so the
  // due-date logic never has to special-case the two representations.
  const normalisedWeekdays =
    rest.frequency === "daily" ? [0, 1, 2, 3, 4, 5, 6] : weekdays.slice().sort();

  const data = {
    ...rest,
    weekdays: JSON.stringify(normalisedWeekdays),
    targetPerWeek:
      rest.frequency === "custom" ? Math.max(1, normalisedWeekdays.length) : rest.targetPerWeek,
    userId: user.id,
  };

  const habit = id
    ? await prisma.habit.update({ where: { id }, data })
    : await prisma.habit.create({
        data: {
          ...data,
          sortOrder: await prisma.habit
            .count({ where: { userId: user.id } })
            .then((count) => count + 1),
        },
      });

  await recomputeDay(user.id, today());
  revalidateAll();
  return succeed({ id: habit.id });
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
 * Three states in one click target keeps the daily ritual fast.
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

export async function archiveHabit(id: string, archived = true): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  await prisma.habit.updateMany({ where: { id, userId: user.id }, data: { archived } });
  await recomputeDay(user.id, today());
  revalidateAll();
  return succeed(null);
}

export async function deleteHabit(id: string): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  await prisma.habit.deleteMany({ where: { id, userId: user.id } });
  await recomputeDay(user.id, today());
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
