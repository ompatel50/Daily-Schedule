"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser, prisma } from "@/lib/db";
import { displayUnitFor, HEALTH_METRIC_RULES, toCanonical } from "@/lib/logic/health";
import { manualDailyFingerprint } from "@/lib/logic/health-import/rollup";
import {
  fail,
  fromZod,
  goalSchema,
  healthMetricSchema,
  journalSchema,
  reminderSchema,
  settingsSchema,
  succeed,
  type ActionResult,
} from "@/lib/validation";
import { recomputeDay } from "@/server/summaries";

function revalidateAll() {
  revalidatePath("/", "layout");
}

/**
 * Manual entry: one value per metric per day. Logging again replaces the day's
 * manual value — the `manual|type|date` fingerprint is the identity, so this
 * can never collide with (or overwrite) an imported record. Values are stored
 * in the metric's canonical unit; the entry arrives in the user's display unit
 * and is converted here, never guessed later.
 */
export async function logHealthMetric(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = healthMetricSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const user = await getCurrentUser();
  const { date, type, value, secondaryValue, notes, time } = parsed.data;
  const rule = HEALTH_METRIC_RULES[type];
  if (!rule) return fail("Unknown metric type");

  // The entry arrives in the user's display unit for that metric — the same
  // unit the form labelled the field with, resolved through the one table in
  // the aggregation module rather than re-listed here.
  const canonical = toCanonical(type, value, displayUnitFor(type, user.unitSystem));
  if (canonical === null) return fail("That value cannot be stored for this metric");

  const fingerprint = manualDailyFingerprint(type, date);
  const recordedAt = time ? new Date(`${date}T${time}:00`) : null;

  const data = {
    value: canonical,
    unit: rule.canonicalUnit,
    secondaryValue: secondaryValue ?? null,
    notes: notes ?? null,
    recordedAt,
  };

  const metric = await prisma.healthMetric.upsert({
    where: { userId_fingerprint: { userId: user.id, fingerprint } },
    create: { userId: user.id, date, type, source: "manual", fingerprint, ...data },
    update: data,
  });

  await recomputeDay(user.id, date);
  revalidateAll();
  return succeed({ id: metric.id });
}

export async function deleteHealthMetric(id: string): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  const metric = await prisma.healthMetric.findFirst({ where: { id, userId: user.id } });
  if (!metric) return fail("Metric not found");

  await prisma.healthMetric.delete({ where: { id } });
  await recomputeDay(user.id, metric.date);
  revalidateAll();
  return succeed(null);
}

// The pre-Phase-11 bulk `importHealthMetrics` action was removed: the real
// import pipeline lives in `src/server/health-import.ts` (staged preview →
// transactional confirm → removable batches) and is exposed through
// `src/server/actions/health-import.ts`.

// --- goals ------------------------------------------------------------------

export async function saveGoal(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = goalSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const user = await getCurrentUser();
  const { id, ...rest } = parsed.data;

  // Mirror saveGoalWithSchedule: a habit-sourced goal must point at the
  // user's own habit — a foreign id is a live cross-account reference even
  // while nothing dereferences it yet — and no other source carries a ref.
  if (rest.source === "habit") {
    const habit = rest.sourceRef
      ? await prisma.habit.findFirst({
          where: { id: rest.sourceRef, userId: user.id },
          select: { id: true },
        })
      : null;
    if (!habit) return fail("Choose which habit completes this goal");
  } else {
    rest.sourceRef = null;
  }

  // (userId, domain, metric, period) is no longer unique — two goals can
  // legitimately share a metric ("workout Mon/Tue/Thu/Fri" and "4 workouts per
  // week"). Reuse an existing row only when the caller did not supply an id and
  // an identical goal already exists, so the preset buttons stay idempotent.
  const existing = id
    ? null
    : await prisma.goal.findFirst({
        where: {
          userId: user.id,
          domain: rest.domain,
          metric: rest.metric,
          period: rest.period,
          archivedAt: null,
        },
        orderBy: { createdAt: "asc" },
      });

  const targetId = id ?? existing?.id;

  const goal = targetId
    ? await prisma.goal.update({ where: { id: targetId, userId: user.id }, data: rest })
    : await prisma.goal.create({ data: { ...rest, userId: user.id } });

  revalidateAll();
  return succeed({ id: goal.id });
}

export async function deleteGoal(id: string): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  await prisma.goal.deleteMany({ where: { id, userId: user.id } });
  revalidateAll();
  return succeed(null);
}

// --- journal ----------------------------------------------------------------

export async function saveJournalEntry(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = journalSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const user = await getCurrentUser();
  const { date, title, content, mood, energy } = parsed.data;

  // An emptied entry is a delete — avoids accumulating blank rows.
  if (!content.trim() && !title?.trim() && mood == null && energy == null) {
    await prisma.journalEntry.deleteMany({ where: { userId: user.id, date } });
    revalidateAll();
    return succeed({ id: "" });
  }

  const entry = await prisma.journalEntry.upsert({
    where: { userId_date: { userId: user.id, date } },
    create: {
      userId: user.id,
      date,
      title: title ?? null,
      content,
      mood: mood ?? null,
      energy: energy ?? null,
    },
    update: { title: title ?? null, content, mood: mood ?? null, energy: energy ?? null },
  });

  // Mood/energy double as health metrics so they appear on trend charts.
  for (const [type, value] of [
    ["mood", mood],
    ["energy", energy],
  ] as const) {
    if (value == null) continue;
    const fingerprint = manualDailyFingerprint(type, date);
    await prisma.healthMetric.upsert({
      where: { userId_fingerprint: { userId: user.id, fingerprint } },
      create: { userId: user.id, date, type, value, unit: "/5", source: "manual", fingerprint },
      update: { value },
    });
  }

  await recomputeDay(user.id, date);
  revalidateAll();
  return succeed({ id: entry.id });
}

// --- reminders --------------------------------------------------------------

export async function saveReminder(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = reminderSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const user = await getCurrentUser();
  const { id, remindAt, ...rest } = parsed.data;

  const when = new Date(remindAt);
  if (Number.isNaN(when.getTime())) return fail("Invalid reminder time");

  const data = { ...rest, message: rest.message ?? null, remindAt: when, userId: user.id };
  const reminder = id
    ? await prisma.reminder.update({ where: { id, userId: user.id }, data })
    : await prisma.reminder.create({ data });

  revalidateAll();
  return succeed({ id: reminder.id });
}

export async function deleteReminder(id: string): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  await prisma.reminder.deleteMany({ where: { id, userId: user.id } });
  revalidateAll();
  return succeed(null);
}

// `markReminderFired` moved: delivery is recorded by `recordReminderDelivery`
// in src/server/reminders.ts, keyed per occurrence so it is exactly-once even
// across tabs. The watcher calls it via src/server/actions/reminders.ts.

// --- settings ---------------------------------------------------------------

export async function saveSettings(input: unknown): Promise<ActionResult<null>> {
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const user = await getCurrentUser();
  const data = parsed.data;
  if (data.dayEndHour <= data.dayStartHour) {
    return fail("Day end must be after day start", { dayEndHour: ["Must be after the start hour"] });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      ...data,
      birthDate: data.birthDate || null,
      heightCm: data.heightCm ?? null,
      sex: data.sex ?? null,
    },
  });

  revalidateAll();
  return succeed(null);
}
