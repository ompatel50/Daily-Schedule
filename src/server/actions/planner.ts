"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/db";
import { type DayKey, daysBetween, shiftDay, today } from "@/lib/date";
import { expandRule, parseRule, serializeRule, type RecurrenceRule } from "@/lib/logic/recurrence";
import { parseQuickAdd } from "@/lib/logic/quick-add";
import {
  fail,
  fromZod,
  quickAddSchema,
  scheduleItemSchema,
  scheduleTemplateSchema,
  succeed,
  type ActionResult,
} from "@/lib/validation";
import { extendSeriesFor, HORIZON_DAYS } from "@/server/series";
import { recomputeDay } from "@/server/summaries";

function revalidateAll() {
  revalidatePath("/", "layout");
}

async function touchDays(userId: string, days: DayKey[]) {
  for (const day of Array.from(new Set(days))) {
    await recomputeDay(userId, day);
  }
}

export async function createScheduleItem(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = scheduleItemSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const user = await getCurrentUser();
  const data = parsed.data;
  const rule = parseRule(data.recurrenceRule ?? null);

  const maxOrder = await prisma.scheduleItem.aggregate({
    where: { userId: user.id, date: data.date },
    _max: { sortOrder: true },
  });

  const base = {
    userId: user.id,
    title: data.title,
    notes: data.notes ?? null,
    startMinute: data.allDay ? null : (data.startMinute ?? null),
    endMinute: data.allDay ? null : (data.endMinute ?? null),
    allDay: data.allDay,
    category: data.category,
    priority: data.priority,
    status: data.status,
    habitId: data.habitId ?? null,
  };

  const parent = await prisma.scheduleItem.create({
    data: {
      ...base,
      date: data.date,
      sortOrder: (maxOrder._max.sortOrder ?? 0) + 1,
      recurrenceRule: serializeRule(rule),
      tags: data.tagIds.length
        ? { create: data.tagIds.map((tagId) => ({ tagId })) }
        : undefined,
    },
  });

  const touched: DayKey[] = [data.date];

  if (rule) {
    const occurrences = expandRule(
      rule,
      data.date,
      shiftDay(data.date, 1),
      shiftDay(data.date, HORIZON_DAYS),
    );
    if (occurrences.length > 0) {
      await prisma.scheduleItem.createMany({
        data: occurrences.map((date) => ({ ...base, date, seriesId: parent.id, sortOrder: 0 })),
      });
      touched.push(...occurrences);
    }
  }

  await touchDays(user.id, touched);
  revalidateAll();
  return succeed({ id: parent.id });
}

export async function quickAddScheduleItem(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = quickAddSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const draft = parseQuickAdd(parsed.data.text, parsed.data.date);
  return createScheduleItem({
    title: draft.title,
    date: draft.date,
    startMinute: draft.startMinute,
    endMinute: draft.endMinute,
    allDay: draft.allDay,
    category: draft.category,
    priority: draft.priority,
    status: "planned",
    tagIds: [],
  });
}

export async function updateScheduleItem(
  input: unknown,
  scope: "one" | "future" = "one",
): Promise<ActionResult<{ id: string }>> {
  const parsed = scheduleItemSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  if (!parsed.data.id) return fail("Missing item id");

  const user = await getCurrentUser();
  const existing = await prisma.scheduleItem.findFirst({
    where: { id: parsed.data.id, userId: user.id },
  });
  if (!existing) return fail("Item not found");

  const data = parsed.data;
  const fields = {
    title: data.title,
    notes: data.notes ?? null,
    startMinute: data.allDay ? null : (data.startMinute ?? null),
    endMinute: data.allDay ? null : (data.endMinute ?? null),
    allDay: data.allDay,
    category: data.category,
    priority: data.priority,
    status: data.status,
    completedAt: data.status === "done" ? (existing.completedAt ?? new Date()) : null,
  };

  await prisma.$transaction(async (tx) => {
    await tx.scheduleItem.update({
      where: { id: existing.id },
      data: {
        ...fields,
        date: data.date,
        // Editing a single occurrence detaches it so a later series edit
        // doesn't silently overwrite the user's change.
        isException: existing.seriesId ? scope === "one" : existing.isException,
      },
    });

    await tx.scheduleItemTag.deleteMany({ where: { scheduleItemId: existing.id } });
    if (data.tagIds.length) {
      await tx.scheduleItemTag.createMany({
        data: data.tagIds.map((tagId) => ({ scheduleItemId: existing.id, tagId })),
      });
    }

    if (scope === "future") {
      const seriesId = existing.seriesId ?? existing.id;
      await tx.scheduleItem.updateMany({
        where: {
          userId: user.id,
          isException: false,
          date: { gt: existing.date },
          OR: [{ seriesId }, { id: seriesId }],
        },
        data: {
          title: fields.title,
          notes: fields.notes,
          startMinute: fields.startMinute,
          endMinute: fields.endMinute,
          allDay: fields.allDay,
          category: fields.category,
          priority: fields.priority,
        },
      });
    }
  });

  await touchDays(user.id, [existing.date, data.date]);
  revalidateAll();
  return succeed({ id: existing.id });
}

export async function toggleScheduleItem(id: string): Promise<ActionResult<{ status: string }>> {
  const user = await getCurrentUser();
  const item = await prisma.scheduleItem.findFirst({ where: { id, userId: user.id } });
  if (!item) return fail("Item not found");

  const status = item.status === "done" ? "planned" : "done";
  await prisma.scheduleItem.update({
    where: { id },
    data: { status, completedAt: status === "done" ? new Date() : null },
  });

  await touchDays(user.id, [item.date]);
  revalidateAll();
  return succeed({ status });
}

export async function setScheduleItemStatus(
  id: string,
  status: "planned" | "done" | "skipped",
): Promise<ActionResult<{ status: string }>> {
  const user = await getCurrentUser();
  const item = await prisma.scheduleItem.findFirst({ where: { id, userId: user.id } });
  if (!item) return fail("Item not found");

  await prisma.scheduleItem.update({
    where: { id },
    data: { status, completedAt: status === "done" ? new Date() : null },
  });

  await touchDays(user.id, [item.date]);
  revalidateAll();
  return succeed({ status });
}

/** Move an item to another day (drag & drop between days, or "push to tomorrow"). */
export async function moveScheduleItem(
  id: string,
  date: DayKey,
  startMinute?: number | null,
): Promise<ActionResult<{ id: string }>> {
  const user = await getCurrentUser();
  const item = await prisma.scheduleItem.findFirst({ where: { id, userId: user.id } });
  if (!item) return fail("Item not found");

  const duration =
    item.startMinute !== null && item.endMinute !== null ? item.endMinute - item.startMinute : null;

  const nextStart = startMinute === undefined ? item.startMinute : startMinute;
  const nextEnd =
    nextStart !== null && duration !== null ? Math.min(1439, nextStart + duration) : item.endMinute;

  await prisma.scheduleItem.update({
    where: { id },
    data: {
      date,
      startMinute: nextStart,
      endMinute: nextStart === null ? null : nextEnd,
      allDay: nextStart === null,
      // A moved occurrence is no longer in lock-step with its series.
      isException: item.seriesId ? true : item.isException,
    },
  });

  await touchDays(user.id, [item.date, date]);
  revalidateAll();
  return succeed({ id });
}

/** Persist a new drag-and-drop ordering for one day. */
export async function reorderScheduleItems(
  date: DayKey,
  orderedIds: string[],
): Promise<ActionResult<{ count: number }>> {
  const user = await getCurrentUser();
  await prisma.$transaction(
    orderedIds.map((id, index) =>
      prisma.scheduleItem.updateMany({
        where: { id, userId: user.id, date },
        data: { sortOrder: index },
      }),
    ),
  );
  revalidateAll();
  return succeed({ count: orderedIds.length });
}

export async function deleteScheduleItem(
  id: string,
  scope: "one" | "future" | "all" = "one",
): Promise<ActionResult<{ deleted: number }>> {
  const user = await getCurrentUser();
  const item = await prisma.scheduleItem.findFirst({ where: { id, userId: user.id } });
  if (!item) return fail("Item not found");

  const seriesId = item.seriesId ?? item.id;
  let deleted = 0;
  const touched: DayKey[] = [item.date];

  if (scope === "one") {
    await prisma.scheduleItem.delete({ where: { id } });
    deleted = 1;
  } else {
    const where =
      scope === "all"
        ? { userId: user.id, OR: [{ id: seriesId }, { seriesId }] }
        : { userId: user.id, date: { gte: item.date }, OR: [{ id: seriesId }, { seriesId }] };

    const affected = await prisma.scheduleItem.findMany({ where, select: { date: true } });
    touched.push(...affected.map((row) => row.date));
    const result = await prisma.scheduleItem.deleteMany({ where });
    deleted = result.count;
  }

  await touchDays(user.id, touched);
  revalidateAll();
  return succeed({ deleted });
}

/** Push everything unfinished from a day to the next day. */
export async function rolloverUnfinished(from: DayKey): Promise<ActionResult<{ moved: number }>> {
  const user = await getCurrentUser();
  const to = shiftDay(from, 1);
  const items = await prisma.scheduleItem.findMany({
    where: { userId: user.id, date: from, status: "planned" },
  });

  if (items.length === 0) return succeed({ moved: 0 });

  await prisma.scheduleItem.updateMany({
    where: { id: { in: items.map((item) => item.id) } },
    data: { date: to, isException: true },
  });

  await touchDays(user.id, [from, to]);
  revalidateAll();
  return succeed({ moved: items.length });
}

/**
 * Keep materialised series topped up to the horizon. Cheap and idempotent.
 * The real work lives in `@/server/series` so the planner page can call it
 * during render (server actions can't revalidate mid-render).
 */
export async function extendSeries(): Promise<ActionResult<{ created: number }>> {
  const user = await getCurrentUser();
  const created = await extendSeriesFor(user.id);
  if (created > 0) revalidateAll();
  return succeed({ created });
}

// --- templates --------------------------------------------------------------

export async function saveScheduleTemplate(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = scheduleTemplateSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const user = await getCurrentUser();
  const { id, items, ...rest } = parsed.data;
  const data = { ...rest, items: JSON.stringify(items), userId: user.id };

  const template = id
    ? await prisma.scheduleTemplate.update({ where: { id }, data })
    : await prisma.scheduleTemplate.create({ data });

  revalidateAll();
  return succeed({ id: template.id });
}

export async function applyScheduleTemplate(
  templateId: string,
  date: DayKey,
): Promise<ActionResult<{ created: number }>> {
  const user = await getCurrentUser();
  const template = await prisma.scheduleTemplate.findFirst({
    where: { id: templateId, userId: user.id },
  });
  if (!template) return fail("Template not found");

  let items: Array<{
    title: string;
    startMinute?: number | null;
    endMinute?: number | null;
    allDay?: boolean;
    category?: string;
    priority?: string;
    notes?: string | null;
  }>;
  try {
    items = JSON.parse(template.items);
  } catch {
    return fail("Template is corrupted");
  }
  if (!Array.isArray(items) || items.length === 0) return fail("Template has no items");

  const maxOrder = await prisma.scheduleItem.aggregate({
    where: { userId: user.id, date },
    _max: { sortOrder: true },
  });
  const offset = (maxOrder._max.sortOrder ?? 0) + 1;

  await prisma.scheduleItem.createMany({
    data: items.map((item, index) => ({
      userId: user.id,
      title: item.title,
      notes: item.notes ?? null,
      date,
      startMinute: item.allDay ? null : (item.startMinute ?? null),
      endMinute: item.allDay ? null : (item.endMinute ?? null),
      allDay: Boolean(item.allDay),
      category: item.category ?? template.category,
      priority: item.priority ?? "medium",
      status: "planned",
      sortOrder: offset + index,
      templateId: template.id,
    })),
  });

  await prisma.scheduleTemplate.update({
    where: { id: template.id },
    data: { useCount: { increment: 1 }, lastUsed: new Date() },
  });

  await touchDays(user.id, [date]);
  revalidateAll();
  return succeed({ created: items.length });
}

export async function deleteScheduleTemplate(id: string): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  await prisma.scheduleTemplate.deleteMany({ where: { id, userId: user.id } });
  revalidateAll();
  return succeed(null);
}

// --- tags -------------------------------------------------------------------

export async function createTag(name: string, color = "slate"): Promise<ActionResult<{ id: string }>> {
  const trimmed = name.trim().toLowerCase();
  if (!trimmed) return fail("Tag name is required");

  const user = await getCurrentUser();
  const tag = await prisma.tag.upsert({
    where: { userId_name: { userId: user.id, name: trimmed } },
    create: { userId: user.id, name: trimmed, color },
    update: { color },
  });

  revalidateAll();
  return succeed({ id: tag.id });
}

export async function deleteTag(id: string): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  await prisma.tag.deleteMany({ where: { id, userId: user.id } });
  revalidateAll();
  return succeed(null);
}

export type { RecurrenceRule };
