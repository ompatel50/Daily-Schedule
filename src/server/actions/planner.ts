"use server";

import { revalidatePath } from "next/cache";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/db";
import { type DayKey, shiftDay } from "@/lib/date";
import {
  calendarDateForOperationalTime,
  operationalDayOfRecord,
  operationalDayWhere,
} from "@/lib/logic/operational-day";
import { resetMinuteOf } from "@/lib/logic/schedule";
import {
  materializeAnchorFields,
  parseRule,
  parseSkipDates,
  serializeRule,
  serializeSkipDates,
  truncateRuleBefore,
  withSkipDate,
  type RecurrenceRule,
} from "@/lib/logic/recurrence";
import { parseQuickAdd } from "@/lib/logic/quick-add";
import {
  isSchedulingConflict,
  planMove,
  planTemplateApplication,
  type ConflictCandidate,
  type TemplateApplyMode,
  type TemplateRow,
} from "@/lib/logic/planner";
import { comparePlannerSpans } from "@/lib/logic/schedule-span";
import {
  conflictPreviewSchema,
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
import { scheduleSettingsFor } from "@/server/schedule";
import {
  extendSeriesFor,
  materializeSeriesFromAnchor,
  slotOfOccurrence,
} from "@/server/series";
import { recomputeDay } from "@/server/summaries";

function revalidateAll() {
  revalidatePath("/", "layout");
}

async function touchDays(userId: string, days: DayKey[]) {
  for (const day of Array.from(new Set(days))) {
    await recomputeDay(userId, day);
  }
}

/**
 * Planner dates cross this boundary as OPERATIONAL days — the day the user was
 * looking at. Storage keeps calendar dates: a timed entry before the daily
 * reset ("1:00 AM") lands on the next calendar date, which is the real moment
 * it names, and resolves back to the operational day on every read. Summary
 * recomputes are keyed by operational day, so `touchDays` receives
 * `operationalDayOfRecord(...)` of whatever was written.
 */
function resetFor(user: { weekStartsOn: number; timezone: string; dayResetMinute?: number }) {
  return resetMinuteOf(scheduleSettingsFor(user));
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

/**
 * Reference ids arrive from the client and must belong to the current user
 * before they are attached to anything. Returns an error message, or null
 * when everything checks out.
 */
async function checkOwnedRefs(
  userId: string,
  habitId: string | null | undefined,
  tagIds: string[],
): Promise<string | null> {
  if (habitId) {
    const habit = await prisma.habit.findFirst({ where: { id: habitId, userId }, select: { id: true } });
    if (!habit) return "That habit doesn't exist";
  }
  if (tagIds.length) {
    const owned = await prisma.tag.count({ where: { id: { in: tagIds }, userId } });
    if (owned !== new Set(tagIds).size) return "One of those tags doesn't exist";
  }
  return null;
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

  const refError = await checkOwnedRefs(user.id, data.habitId, data.tagIds);
  if (refError) return fail(refError);

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

  // `data.date` is the operational day being planned; an entry timed before
  // the daily reset stores on the next calendar date — the real moment it
  // names — and reads back under the day the user typed it into.
  const reset = resetFor(user);
  const storedDate = calendarDateForOperationalTime(data.date, base.startMinute, reset);

  const maxOrder = await prisma.scheduleItem.aggregate({
    where: { userId: user.id, date: storedDate },
    _max: { sortOrder: true },
  });

  const parent = await prisma.scheduleItem.create({
    data: {
      ...base,
      date: storedDate,
      sortOrder: (maxOrder._max.sortOrder ?? 0) + 1,
      recurrenceRule: serializeRule(rule),
      tags: data.tagIds.length
        ? { create: data.tagIds.map((tagId) => ({ tagId })) }
        : undefined,
    },
  });

  const touched: DayKey[] = [data.date];

  if (rule) {
    // The rule expands over OPERATIONAL days ("every Monday at 1:00 AM" means
    // Monday *nights*), anchored at the day the user was planning; each
    // occurrence stores on its real calendar date. Shared with the horizon
    // top-up and series splitting so all three agree on identity and bounds.
    touched.push(...(await materializeSeriesFromAnchor(prisma, parent, reset)));
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

/** The transaction-client slice these helpers need. */
type Tx = Prisma.TransactionClient;

/** Replace an item's tag links with the given set. */
async function setItemTags(tx: Tx, scheduleItemId: string, tagIds: string[]) {
  await tx.scheduleItemTag.deleteMany({ where: { scheduleItemId } });
  if (tagIds.length) {
    await tx.scheduleItemTag.createMany({
      data: tagIds.map((tagId) => ({ scheduleItemId, tagId })),
    });
  }
}

type ScheduleItemRow = NonNullable<
  Awaited<ReturnType<typeof prisma.scheduleItem.findFirst>>
>;

/**
 * Make `next` the parent of `parent`'s series — used when the first
 * occurrence (the parent row, which doubles as the rule holder) is edited or
 * deleted on its own. The rule's anchor-derived fields are pinned from the
 * OLD anchor first, so "every week" anchored on a Monday still means Mondays
 * after the promotion; a `count` loses the one occurrence being detached.
 * Returns the promoted row's id.
 */
async function promoteNextOccurrence(
  tx: Tx,
  parent: ScheduleItemRow,
  children: ScheduleItemRow[],
  rule: RecurrenceRule,
  reset: number,
): Promise<string> {
  const anchorSlot = slotOfOccurrence(parent, reset);
  const bySlot = (a: ScheduleItemRow, b: ScheduleItemRow) =>
    slotOfOccurrence(a, reset) < slotOfOccurrence(b, reset) ? -1 : 1;
  // Prefer a non-exception child: the promoted row becomes the template new
  // occurrences copy, and an exception's fields were deliberately different.
  const next =
    children.filter((child) => !child.isException).sort(bySlot)[0] ??
    children.slice().sort(bySlot)[0];

  const promotedRule: RecurrenceRule = {
    ...materializeAnchorFields(rule, anchorSlot),
    count: rule.count ? Math.max(1, rule.count - 1) : undefined,
  };

  await tx.scheduleItem.update({
    where: { id: next.id },
    data: {
      seriesId: null,
      isException: false,
      recurrenceRule: serializeRule(promotedRule),
      skipDates: parent.skipDates,
    },
  });
  await tx.scheduleItem.updateMany({
    where: { seriesId: parent.id, id: { not: next.id } },
    data: { seriesId: next.id },
  });
  return next.id;
}

/**
 * Edit an item. On a recurring item `scope` decides how far the change
 * reaches, and the mechanics preserve history by construction:
 *
 *  * `one` — the occurrence becomes an exception: its fields detach, its
 *    series slot stays occupied (so regeneration cannot duplicate it), and
 *    every other occurrence — past and future — is untouched. Editing the
 *    FIRST occurrence promotes the next one to series parent first, so the
 *    series' template is not silently rewritten. Recurrence-rule input is
 *    ignored on this scope: a one-occurrence edit cannot smuggle in a series
 *    change.
 *
 *  * `future` — a series split. The old series stays authoritative through
 *    the day before the selected occurrence (its rule gains/keeps an `until`
 *    there); the selected occurrence becomes the parent of a new series that
 *    starts on its day, carries the edited fields, and uses the submitted
 *    rule — which the form pre-fills from the old rule, so the original end
 *    date is inherited unless the user explicitly changed it. Future
 *    occurrences that were still plain "planned" rows are re-materialised
 *    under the new series; completed, skipped and individually-edited ones
 *    are kept as exceptions rather than destroyed.
 *
 *  * `all` — the existing whole-series behaviour: detail fields carry to the
 *    parent and every non-exception occurrence, dates stay put (only a move
 *    across the daily-reset boundary shifts stored dates, keeping each
 *    occurrence on its operational day). Rule changes are not accepted on
 *    this scope either — reshaping the pattern is exactly what `future` is
 *    for.
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

  const refError = await checkOwnedRefs(user.id, parsed.data.habitId, parsed.data.tagIds);
  if (refError) return fail(refError);

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

  const reset = resetFor(user);
  const storedDate = calendarDateForOperationalTime(data.date, fields.startMinute, reset);
  const inputRule = parseRule(data.recurrenceRule ?? null);

  const isSeriesRow = Boolean(existing.seriesId) || Boolean(existing.recurrenceRule);
  let updated = 1;
  const touched: DayKey[] = [operationalDayOfRecord(existing, reset), data.date];

  // --- a plain, non-recurring item -------------------------------------------
  if (!isSeriesRow) {
    await prisma.$transaction(async (tx) => {
      const row = await tx.scheduleItem.update({
        where: { id: existing.id },
        data: { ...fields, date: storedDate, recurrenceRule: serializeRule(inputRule) },
      });
      await setItemTags(tx, existing.id, data.tagIds);
      if (inputRule) {
        // The item just became a recurring series anchored on its day.
        touched.push(...(await materializeSeriesFromAnchor(tx, row, reset)));
      }
    });
    await touchDays(user.id, touched);
    revalidateAll();
    return succeed({ id: existing.id, updated });
  }

  // --- a recurring series row -------------------------------------------------
  const parent = existing.seriesId
    ? await prisma.scheduleItem.findFirst({ where: { id: existing.seriesId, userId: user.id } })
    : existing;
  const parentRule = parent ? parseRule(parent.recurrenceRule) : null;

  if (!parent || !parentRule) {
    // A detached or malformed series row: edit it as a plain item, exception
    // semantics preserved. Never guess a series shape that isn't there.
    await prisma.$transaction(async (tx) => {
      await tx.scheduleItem.update({
        where: { id: existing.id },
        data: { ...fields, date: storedDate },
      });
      await setItemTags(tx, existing.id, data.tagIds);
    });
    await touchDays(user.id, touched);
    revalidateAll();
    return succeed({ id: existing.id, updated });
  }

  const anchorSlot = slotOfOccurrence(parent, reset);
  /** The boundary the user means: the day they see this occurrence under. */
  const selectedDay = operationalDayOfRecord(existing, reset);

  if (scope === "one") {
    await prisma.$transaction(async (tx) => {
      if (existing.seriesId) {
        // An occurrence: detach the fields, keep the slot occupied.
        await tx.scheduleItem.update({
          where: { id: existing.id },
          data: {
            ...fields,
            date: storedDate,
            isException: true,
            originalDate: existing.originalDate ?? slotOfOccurrence(existing, reset),
          },
        });
        await setItemTags(tx, existing.id, data.tagIds);
        return;
      }

      // The parent row IS the first occurrence. Editing only it must not
      // rewrite the template future occurrences are generated from — promote
      // the next occurrence to parent first, then detach this one.
      const children = await tx.scheduleItem.findMany({ where: { seriesId: existing.id } });
      if (children.length === 0) {
        // A series of one: nothing else to protect. Keep its stored rule
        // (rule edits belong to the "future" scope).
        await tx.scheduleItem.update({
          where: { id: existing.id },
          data: { ...fields, date: storedDate },
        });
        await setItemTags(tx, existing.id, data.tagIds);
        return;
      }

      const newParentId = await promoteNextOccurrence(tx, existing, children, parentRule, reset);
      await tx.scheduleItem.update({
        where: { id: existing.id },
        data: {
          ...fields,
          date: storedDate,
          recurrenceRule: null,
          skipDates: null,
          seriesId: newParentId,
          isException: true,
          originalDate: existing.originalDate ?? anchorSlot,
        },
      });
      await setItemTags(tx, existing.id, data.tagIds);
    });
    await touchDays(user.id, touched);
    revalidateAll();
    return succeed({ id: existing.id, updated });
  }

  if (scope === "future") {
    await prisma.$transaction(async (tx) => {
      const children = await tx.scheduleItem.findMany({ where: { seriesId: parent.id } });
      const isWholeSeries = existing.id === parent.id;

      // Rows from the selected day on are the new series' territory. Plain
      // planned copies are disposable (they re-materialise from the new
      // shape); anything the user touched — completions, skips, exceptions —
      // is kept as an exception. Rows moved to before the selected day read
      // as history and stay with the old series.
      for (const child of children) {
        if (child.id === existing.id) continue;
        const childDay = operationalDayOfRecord(child, reset);
        if (childDay < selectedDay) continue;
        if (!child.isException && child.status === "planned") {
          touched.push(childDay);
          await tx.scheduleItem.delete({ where: { id: child.id } });
        } else if (!isWholeSeries) {
          await tx.scheduleItem.update({
            where: { id: child.id },
            data: {
              seriesId: existing.id,
              isException: true,
              originalDate: child.originalDate ?? slotOfOccurrence(child, reset),
            },
          });
        } else if (!child.isException) {
          await tx.scheduleItem.update({
            where: { id: child.id },
            data: {
              isException: true,
              originalDate: child.originalDate ?? slotOfOccurrence(child, reset),
            },
          });
        }
      }

      // The new series starts on the edited occurrence's day. The rule is
      // exactly what was submitted — the form pre-fills it from the old rule,
      // so an untouched end date is inherited, an explicit change (including
      // "no end date") is respected, and "does not repeat" ends recurrence
      // from here on. Anchor-derived fields are pinned against the new
      // anchor so the rule cannot drift when its anchor moved.
      const newRule = inputRule ? materializeAnchorFields(inputRule, data.date) : null;
      const oldSkips = parseSkipDates(parent.skipDates);

      const newParent = await tx.scheduleItem.update({
        where: { id: existing.id },
        data: {
          ...fields,
          date: storedDate,
          seriesId: null,
          isException: false,
          originalDate: null,
          recurrenceRule: serializeRule(newRule),
          skipDates: serializeSkipDates(oldSkips.filter((day) => day > data.date)),
        },
      });
      await setItemTags(tx, existing.id, data.tagIds);

      if (!isWholeSeries) {
        // The old series stays authoritative through the day before.
        await tx.scheduleItem.update({
          where: { id: parent.id },
          data: {
            recurrenceRule: serializeRule(truncateRuleBefore(parentRule, selectedDay)),
            skipDates: serializeSkipDates(oldSkips.filter((day) => day < selectedDay)),
          },
        });
      }

      if (newRule) {
        touched.push(...(await materializeSeriesFromAnchor(tx, newParent, reset)));
      }
    });
    await touchDays(user.id, touched);
    revalidateAll();
    return succeed({ id: existing.id, updated });
  }

  // --- scope === "all" ---------------------------------------------------------
  // Re-timing across the reset boundary moves every occurrence's calendar
  // date by one, so it stays on the operational day it was planned for:
  // 11:00 PM → 1:00 AM shifts each stored date forward, and back again the
  // other way.
  const wasBeforeReset =
    !existing.allDay && existing.startMinute !== null && existing.startMinute < reset;
  const nowBeforeReset = fields.startMinute !== null && fields.startMinute < reset;
  const seriesDateShift = wasBeforeReset === nowBeforeReset ? 0 : nowBeforeReset ? 1 : -1;

  await prisma.$transaction(async (tx) => {
    await tx.scheduleItem.update({
      where: { id: existing.id },
      data: {
        ...fields,
        date: storedDate,
        isException: existing.seriesId ? false : existing.isException,
      },
    });
    await setItemTags(tx, existing.id, data.tagIds);

    // Detail fields carry across the whole series; dates stay on their own
    // days. The rule itself is deliberately not editable here.
    const seriesId = existing.seriesId ?? existing.id;
    const where = {
      userId: user.id,
      isException: false,
      id: { not: existing.id },
      OR: [{ seriesId }, { id: seriesId }],
    };

    const affected = await tx.scheduleItem.findMany({ where, select: { id: true, date: true } });
    touched.push(
      ...affected.map((row) =>
        operationalDayOfRecord({ date: row.date, startMinute: existing.startMinute }, reset),
      ),
    );

    const detailFields = {
      title: fields.title,
      notes: fields.notes,
      startMinute: fields.startMinute,
      endMinute: fields.endMinute,
      allDay: fields.allDay,
      category: fields.category,
      priority: fields.priority,
    };

    if (seriesDateShift === 0) {
      const result = await tx.scheduleItem.updateMany({ where, data: detailFields });
      updated += result.count;
    } else {
      for (const row of affected) {
        await tx.scheduleItem.update({
          where: { id: row.id },
          data: { ...detailFields, date: shiftDay(row.date, seriesDateShift) },
        });
      }
      updated += affected.length;
    }
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

  await touchDays(user.id, [operationalDayOfRecord(item, resetFor(user))]);
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

  await touchDays(user.id, [operationalDayOfRecord(item, resetFor(user))]);
  revalidateAll();
  return succeed({ status });
}

/** What `moveScheduleItem` reports back to the UI. */
export type MoveItemResult =
  | { status: "moved"; id: string }
  /** The new slot overlaps these titles. Nothing was written; ask the user. */
  | { status: "conflict"; conflicts: string[] };

/**
 * Move an item to another day (drag & drop between days, or "push to
 * tomorrow"), optionally to a new start time.
 *
 * When the destination slot overlaps something, the first call reports
 * `status: "conflict"` and writes nothing; the caller confirms and repeats
 * the call with `confirm: true`. A warning that costs one extra click, never
 * a block — double-booking yourself is sometimes deliberate. `planMove`
 * decides what counts as a clash.
 */
export async function moveScheduleItem(
  id: string,
  date: DayKey,
  startMinute?: number | null,
  options?: { confirm?: boolean },
): Promise<ActionResult<MoveItemResult>> {
  const user = await getCurrentUser();
  const item = await prisma.scheduleItem.findFirst({ where: { id, userId: user.id } });
  if (!item) return fail("Item not found");

  // `date` is the operational day the item is being dropped onto. Resolve the
  // calendar date first (the span planMove will keep is deterministic), so
  // conflicts are checked against the calendar date the item actually lands
  // on.
  const reset = resetFor(user);
  // Mirrors planMove's span rule: undefined keeps the item's time, null
  // clears to all-day. All-day items carry null minutes already.
  const nextStart = startMinute === undefined ? item.startMinute : startMinute;
  const storedDate = calendarDateForOperationalTime(date, nextStart, reset);

  // One calendar date each side too: a cross-midnight block on the previous
  // date reaches into this one, and the moved span's own wrapped end can reach
  // the next. `overlapMinutes` compares real dated positions, so the wider net
  // only ever adds true clashes.
  const targetItems = await prisma.scheduleItem.findMany({
    where: {
      userId: user.id,
      date: { in: [shiftDay(storedDate, -1), storedDate, shiftDay(storedDate, 1)] },
    },
    select: {
      id: true,
      title: true,
      date: true,
      startMinute: true,
      endMinute: true,
      allDay: true,
      status: true,
    },
  });

  const plan = planMove({ item, date: storedDate, startMinute, targetItems });

  if (plan.conflicts.length > 0 && !options?.confirm) {
    return succeed({ status: "conflict", conflicts: plan.conflicts });
  }

  await prisma.scheduleItem.update({
    where: { id },
    data: {
      date: storedDate,
      startMinute: plan.startMinute,
      endMinute: plan.endMinute,
      allDay: plan.allDay,
      // A moved occurrence is no longer in lock-step with its series — but it
      // still occupies its original slot, so the vacated day is not refilled
      // by the next regeneration.
      isException: item.seriesId ? true : item.isException,
      originalDate: item.seriesId ? (item.originalDate ?? slotOfOccurrence(item, reset)) : item.originalDate,
    },
  });

  await touchDays(user.id, [operationalDayOfRecord(item, reset), date]);
  revalidateAll();
  return succeed({ status: "moved", id });
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

/**
 * Delete one occurrence, this one and every later one, or the whole series.
 *
 *  * `one` on an occurrence really deletes the row AND records its slot in
 *    the parent's `skipDates`, so regeneration can never quietly bring it
 *    back. `one` on the FIRST occurrence promotes the next occurrence to
 *    series parent first — deleting the rule holder must not take the whole
 *    series down with it.
 *
 *  * `future` terminates the series at the selected occurrence: the parent's
 *    rule gains an `until` on the day before (so nothing regenerates), and
 *    every row from that day on is removed. History before it is untouched.
 *    Selecting the first occurrence means there is no history to preserve —
 *    the whole series goes.
 *
 *  * `all` deletes the entire series including history — the long-standing
 *    explicit option, kept for exactly that explicit choice.
 */
export async function deleteScheduleItem(
  id: string,
  scope: SeriesScope = "one",
): Promise<ActionResult<{ deleted: number }>> {
  const user = await getCurrentUser();
  const item = await prisma.scheduleItem.findFirst({ where: { id, userId: user.id } });
  if (!item) return fail("Item not found");

  const reset = resetFor(user);
  const isSeriesRow = Boolean(item.seriesId) || Boolean(item.recurrenceRule);
  let deleted = 0;
  const touched: DayKey[] = [operationalDayOfRecord(item, reset)];

  if (scope === "one" || !isSeriesRow) {
    if (item.seriesId) {
      // An occurrence of a series: remember the slot so it stays deleted.
      const slot = slotOfOccurrence(item, reset);
      const parent = await prisma.scheduleItem.findFirst({
        where: { id: item.seriesId, userId: user.id },
        select: { id: true, skipDates: true },
      });
      await prisma.$transaction(async (tx) => {
        await tx.scheduleItem.delete({ where: { id } });
        if (parent) {
          await tx.scheduleItem.update({
            where: { id: parent.id },
            data: { skipDates: withSkipDate(parent.skipDates, slot) },
          });
        }
      });
      deleted = 1;
    } else if (item.recurrenceRule) {
      // The series parent. Hand the series to the next occurrence before the
      // row goes — a cascade here would erase every occurrence.
      const rule = parseRule(item.recurrenceRule);
      const children = await prisma.scheduleItem.findMany({
        where: { seriesId: item.id, userId: user.id },
      });
      if (rule && children.length > 0) {
        await prisma.$transaction(async (tx) => {
          await promoteNextOccurrence(tx, item, children, rule, reset);
          await tx.scheduleItem.delete({ where: { id } });
        });
      } else {
        await prisma.scheduleItem.delete({ where: { id } });
      }
      deleted = 1;
    } else {
      await prisma.scheduleItem.delete({ where: { id } });
      deleted = 1;
    }
  } else if (scope === "future") {
    const parent = item.seriesId
      ? await prisma.scheduleItem.findFirst({ where: { id: item.seriesId, userId: user.id } })
      : item;
    const parentRule = parent ? parseRule(parent.recurrenceRule) : null;
    /** The boundary the user means: the day they see this occurrence under. */
    const selectedDay = operationalDayOfRecord(item, reset);

    if (!parent || item.id === parent.id) {
      // Deleting from the first occurrence on = the whole series; cascade
      // removes the occurrences with the parent.
      const affected = await prisma.scheduleItem.findMany({
        where: { userId: user.id, OR: [{ id: item.id }, { seriesId: item.id }] },
        select: { date: true, startMinute: true },
      });
      touched.push(...affected.map((row) => operationalDayOfRecord(row, reset)));
      await prisma.scheduleItem.delete({ where: { id: item.id } });
      deleted = affected.length;
    } else {
      const children = await prisma.scheduleItem.findMany({
        where: { seriesId: parent.id, userId: user.id },
      });
      // Everything the user sees from this day on goes; an occurrence moved
      // back into the past reads as history and stays.
      const removing = children.filter(
        (child) => operationalDayOfRecord(child, reset) >= selectedDay,
      );
      touched.push(...removing.map((row) => operationalDayOfRecord(row, reset)));
      await prisma.$transaction(async (tx) => {
        if (parentRule) {
          await tx.scheduleItem.update({
            where: { id: parent.id },
            data: {
              recurrenceRule: serializeRule(truncateRuleBefore(parentRule, selectedDay)),
              skipDates: serializeSkipDates(
                parseSkipDates(parent.skipDates).filter((day) => day < selectedDay),
              ),
            },
          });
        }
        const result = await tx.scheduleItem.deleteMany({
          where: { id: { in: removing.map((row) => row.id) }, userId: user.id },
        });
        deleted = result.count;
      });
    }
  } else {
    // scope === "all": the whole series including history, explicitly.
    const seriesId = item.seriesId ?? item.id;
    const where = { userId: user.id, OR: [{ id: seriesId }, { seriesId }] };
    const affected = await prisma.scheduleItem.findMany({
      where,
      select: { date: true, startMinute: true },
    });
    touched.push(...affected.map((row) => operationalDayOfRecord(row, reset)));
    const result = await prisma.scheduleItem.deleteMany({ where });
    deleted = result.count;
  }

  await touchDays(user.id, touched);
  revalidateAll();
  return succeed({ deleted });
}

/** Push everything unfinished from an operational day to the next one. */
export async function rolloverUnfinished(from: DayKey): Promise<ActionResult<{ moved: number }>> {
  const user = await getCurrentUser();
  const reset = resetFor(user);
  const to = shiftDay(from, 1);
  const items = await prisma.scheduleItem.findMany({
    where: { userId: user.id, status: "planned", ...operationalDayWhere(from, reset) },
  });

  if (items.length === 0) return succeed({ moved: 0 });

  // One operational day later is one calendar date later for every record —
  // the after-midnight tail keeps its small-hours time on the following
  // night. Grouped so each distinct calendar date is one updateMany.
  const byDate = new Map<DayKey, string[]>();
  for (const item of items) {
    const list = byDate.get(item.date) ?? [];
    list.push(item.id);
    byDate.set(item.date, list);
  }
  await prisma.$transaction([
    // Series occurrences keep their original slot on record, so the day they
    // vacate is not refilled by the next regeneration. Every row selected
    // here belongs to operational day `from` — that IS the rollover's filter.
    prisma.scheduleItem.updateMany({
      where: {
        id: { in: items.map((item) => item.id) },
        seriesId: { not: null },
        originalDate: null,
      },
      data: { originalDate: from },
    }),
    ...[...byDate.entries()].map(([date, ids]) =>
      prisma.scheduleItem.updateMany({
        where: { id: { in: ids } },
        data: { date: shiftDay(date, 1), isException: true },
      }),
    ),
  ]);

  await touchDays(user.id, [from, to]);
  revalidateAll();
  return succeed({ moved: items.length });
}

/**
 * What would this span land on? The edit dialog calls this as the user types
 * a time, so a real double booking is visible BEFORE saving — computed with
 * the same tolerant conflict rule every warning surface uses, so adjacent
 * blocks stay quiet. Read-only: it never blocks the save, because
 * double-booking yourself is sometimes deliberate.
 */
export async function previewScheduleItemConflicts(input: {
  date: DayKey;
  startMinute: number | null;
  endMinute: number | null;
  allDay: boolean;
  /** The item being edited, so it does not conflict with itself. */
  excludeId?: string;
}): Promise<ActionResult<{ conflicts: string[] }>> {
  const parsed = conflictPreviewSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const user = await getCurrentUser();
  const reset = resetFor(user);
  const data = parsed.data;

  // The draft's real calendar date, plus every span that could reach it: the
  // operational day's two dates and one date each side, so a cross-midnight
  // block from the previous evening (or one spanning the daily reset) is
  // checked at its real position. `overlapMinutes` compares dated spans, so
  // the wider net only ever adds true clashes.
  const draftDate = calendarDateForOperationalTime(
    data.date,
    data.allDay ? null : data.startMinute,
    reset,
  );
  const others = await prisma.scheduleItem.findMany({
    where: {
      userId: user.id,
      date: { in: [shiftDay(draftDate, -1), draftDate, shiftDay(draftDate, 1)] },
    },
    select: {
      id: true,
      title: true,
      date: true,
      startMinute: true,
      endMinute: true,
      allDay: true,
      status: true,
    },
  });

  const draft: ConflictCandidate = {
    id: data.excludeId ?? "__draft__",
    title: "",
    date: draftDate,
    startMinute: data.allDay ? null : data.startMinute,
    endMinute: data.allDay ? null : data.endMinute,
    allDay: data.allDay,
  };

  const conflicts = others
    .filter((other) => isSchedulingConflict(draft, other))
    .sort((a, b) => comparePlannerSpans(a, b))
    .map((other) => other.title);

  return succeed({ conflicts });
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
    ? await prisma.scheduleTemplate.update({ where: { id, userId: user.id }, data })
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

  // The routine is stamped onto an OPERATIONAL day: rows timed before the
  // daily reset (a night routine's 1:00 AM wind-down) store on the next
  // calendar date, so the duplicate check spans both dates the day covers.
  const reset = resetFor(user);
  const existing = await prisma.scheduleItem.findMany({
    where: { userId: user.id, templateId: template.id, ...operationalDayWhere(date, reset) },
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
        data: plan.create.map(({ row, index, sourceKey }) => {
          const startMinute = row.allDay ? null : (row.startMinute ?? null);
          return {
            userId: user.id,
            title: row.title,
            notes: row.notes ?? null,
            date: calendarDateForOperationalTime(date, startMinute, reset),
            startMinute,
            endMinute: row.allDay ? null : (row.endMinute ?? null),
            allDay: Boolean(row.allDay),
            category: row.category ?? template.category,
            priority: row.priority ?? "medium",
            status: "planned",
            sortOrder: offset + index,
            templateId: template.id,
            sourceKey,
          };
        }),
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
