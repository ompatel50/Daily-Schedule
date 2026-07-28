import "server-only";

import { prisma } from "@/lib/db";
import { daysBetween, shiftDay, today } from "@/lib/date";
import { expandRule, parseRule } from "@/lib/logic/recurrence";

/**
 * Recurring planner items are *materialised*: creating a weekly item writes one
 * row per occurrence up to `HORIZON_DAYS` out. Everything downstream
 * (completion, drag & drop, day summaries, the heatmap) then works on concrete
 * rows instead of needing a second, virtual code path.
 *
 * `extendSeriesFor` tops the horizon back up. It lives here rather than in a
 * `"use server"` module because the planner page calls it during render, and
 * server actions may not revalidate mid-render.
 */
export const HORIZON_DAYS = 120;

export async function extendSeriesFor(userId: string): Promise<number> {
  const parents = await prisma.scheduleItem.findMany({
    where: { userId, recurrenceRule: { not: null }, seriesId: null },
  });
  if (parents.length === 0) return 0;

  const horizon = shiftDay(today(), HORIZON_DAYS);
  let created = 0;

  for (const parent of parents) {
    const rule = parseRule(parent.recurrenceRule);
    if (!rule) continue;

    const last = await prisma.scheduleItem.findFirst({
      where: { userId, OR: [{ id: parent.id }, { seriesId: parent.id }] },
      orderBy: { date: "desc" },
      select: { date: true },
    });

    const cursor = last?.date ?? parent.date;
    if (daysBetween(cursor, horizon) <= 0) continue;

    const dates = expandRule(rule, parent.date, shiftDay(cursor, 1), horizon);
    if (dates.length === 0) continue;

    await prisma.scheduleItem.createMany({
      data: dates.map((date) => ({
        userId,
        title: parent.title,
        notes: parent.notes,
        date,
        startMinute: parent.startMinute,
        endMinute: parent.endMinute,
        allDay: parent.allDay,
        category: parent.category,
        priority: parent.priority,
        status: "planned",
        habitId: parent.habitId,
        seriesId: parent.id,
      })),
    });
    created += dates.length;
  }

  return created;
}
