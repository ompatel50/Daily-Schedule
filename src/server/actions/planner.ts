"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/db";
import { type DayKey, daysBetween, shiftDay, today } from "@/lib/date";
import { expandRule, parseRule, serializeRule, type RecurrenceRule } from "@/lib/logic/recurrence";
import { parseQuickAdd } from "@/lib/logic/quick-add";
import {
  planTemplateApplication,
  type TemplateApplyMode,
  type TemplateRow,
} from "@/lib/logic/planner";
import {
  fail,
  fromZod,
  quickAddSchema,
  scheduleItemSchema,
  scheduleTemplateSchema,
  succeed,
  templateApplySchema,
  type ActionResult,
  type SeriesScope,
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

/** Prisma's "unique constraint failed" without importing the runtime error class. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/** What `applyScheduleTemplate` reports back to the UI. */
export type ApplyTemplateResult =
  | { status: "applied"; created: number; removed: number; ordinal: number }
  /** The routine is already on this day. Nothing was written; ask the user. */
  | { status: "duplicate"; existing: number; templateName: string; itemCount: number }
  | { status: "unchanged"; existing: number };

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

/**
 * Edit an item. On a recurring item `scope` decides how far the change reaches:
 * this occurrence only, this one and every later one, or the whole series
 * including the past. Editing a single occurrence detaches it, so a later
 * series-wide edit does not silently overwrite the user's change.
 */
export async function updateScheduleItem(
  input: unknown,
  scope: SeriesScope = "one",
): Promise<ActionResult<{ id: string; updated: number }>> {
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

  let updated = 1;
  const touched: DayKey[] = [existing.date, data.date];

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

    if (scope === "one") return;

    // Series-wide edits carry the *details* across, never the date — moving
    // every occurrence onto one day would collapse the series.
    const seriesId = existing.seriesId ?? existing.id;
    const where = {
      userId: user.id,
      isException: false,
      id: { not: existing.id },
      ...(scope === "future" ? { date: { gt: existing.date } } : {}),
      OR: [{ seriesId }, { id: seriesId }],
    };

    const affected = await tx.scheduleItem.findMany({ where, select: { date: true } });
    touched.push(...affected.map((row) => row.date));

    const result = await tx.scheduleItem.updateMany({
      where,
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
    updated += result.count;
  });

  await touchDays(user.id, touched);
  revalidateAll();
  return succeed({ id: existing.id, updated });
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

/** Delete one occurrence, this one and every later one, or the whole series. */
export async function deleteScheduleItem(
  id: string,
  scope: SeriesScope = "one",
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

/**
 * Stamp a routine onto a day.
 *
 * Applying the same routine to the same day twice used to duplicate it
 * silently. Every row now carries a `sourceKey` unique per
 * `(user, date, template, key)`, so the second attempt is detected instead:
 * `mode: "auto"` reports `status: "duplicate"` and writes nothing, and the
 * caller offers the choice — keep what's there, replace it, or add a second
 * copy deliberately.
 */
export async function applyScheduleTemplate(
  templateId: string,
  date: DayKey,
  mode: TemplateApplyMode = "auto",
): Promise<ActionResult<ApplyTemplateResult>> {
  const parsedInput = templateApplySchema.safeParse({ templateId, date, mode });
  if (!parsedInput.success) return fromZod(parsedInput.error);

  const user = await getCurrentUser();
  const template = await prisma.scheduleTemplate.findFirst({
    where: { id: parsedInput.data.templateId, userId: user.id },
  });
  if (!template) return fail("Template not found");

  let items: TemplateRow[];
  try {
    items = JSON.parse(template.items);
  } catch {
    return fail("Template is corrupted");
  }
  if (!Array.isArray(items) || items.length === 0) return fail("Template has no items");

  const existing = await prisma.scheduleItem.findMany({
    where: { userId: user.id, date, templateId: template.id },
    select: { id: true, sourceKey: true },
  });

  const plan = planTemplateApplication({ rows: items, existing, mode: parsedInput.data.mode });

  if (plan.action === "ask") {
    return succeed({
      status: "duplicate",
      existing: plan.existing,
      templateName: template.name,
      itemCount: items.length,
    });
  }

  if (plan.action === "keep" || plan.create.length === 0) {
    return succeed({ status: "unchanged", existing: plan.existing });
  }

  const maxOrder = await prisma.scheduleItem.aggregate({
    where: { userId: user.id, date },
    _max: { sortOrder: true },
  });
  const offset = (maxOrder._max.sortOrder ?? 0) + 1;

  let created = 0;
  let removed = 0;

  try {
    await prisma.$transaction(async (tx) => {
      if (plan.remove.length > 0) {
        const result = await tx.scheduleItem.deleteMany({
          where: { id: { in: plan.remove }, userId: user.id },
        });
        removed = result.count;
      }

      const result = await tx.scheduleItem.createMany({
        data: plan.create.map(({ row, index, sourceKey }) => ({
          userId: user.id,
          title: row.title,
          notes: row.notes ?? null,
          date,
          startMinute: row.allDay ? null : (row.startMinute ?? null),
          endMinute: row.allDay ? null : (row.endMinute ?? null),
          allDay: Boolean(row.allDay),
          category: row.category ?? template.category,
          priority: row.priority ?? "medium",
          status: "planned",
          sortOrder: offset + index,
          templateId: template.id,
          sourceKey,
        })),
      });
      created = result.count;

      await tx.scheduleTemplate.update({
        where: { id: template.id },
        data: { useCount: { increment: 1 }, lastUsed: new Date() },
      });
    });
  } catch (error) {
    // The unique constraint is the last line of defence — a double-submit that
    // raced past the read above lands here. Nothing was written; say so rather
    // than showing a database error.
    if (isUniqueViolation(error)) {
      return succeed({ status: "unchanged", existing: plan.existing });
    }
    throw error;
  }

  await touchDays(user.id, [date]);
  revalidateAll();
  return succeed({ status: "applied", created, removed, ordinal: plan.ordinal });
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
