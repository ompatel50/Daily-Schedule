"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser, prisma } from "@/lib/db";
import { HEALTH_METRIC_META, type HealthMetricType } from "@/lib/enums";
import { isDayKey } from "@/lib/date";
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

export async function logHealthMetric(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = healthMetricSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const user = await getCurrentUser();
  const { date, type, value, secondaryValue, notes } = parsed.data;
  const meta = HEALTH_METRIC_META[type];

  // Weight is stored in whichever unit the user reads it in; `unit` records
  // that choice so conversions later are unambiguous.
  const unit =
    type === "body_weight" ? (user.unitSystem === "metric" ? "kg" : "lb") : meta.unit;

  const metric = await prisma.healthMetric.upsert({
    where: { userId_date_type_source: { userId: user.id, date, type, source: "manual" } },
    create: {
      userId: user.id,
      date,
      type,
      value,
      unit,
      secondaryValue: secondaryValue ?? null,
      notes: notes ?? null,
      source: "manual",
    },
    update: { value, unit, secondaryValue: secondaryValue ?? null, notes: notes ?? null },
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

/**
 * Bulk entry point shaped like an Apple Health export row. Nothing calls this
 * from the UI yet, but the importer and any future sync land here, and the
 * (source, externalId) unique key makes repeated imports idempotent.
 */
export async function importHealthMetrics(
  rows: Array<{
    date: string;
    type: string;
    value: number;
    unit?: string;
    source?: string;
    externalId?: string;
    recordedAt?: string;
  }>,
): Promise<ActionResult<{ imported: number; skipped: number }>> {
  const user = await getCurrentUser();
  let imported = 0;
  let skipped = 0;
  const touched = new Set<string>();

  for (const row of rows) {
    const type = row.type as HealthMetricType;
    if (!isDayKey(row.date) || !HEALTH_METRIC_META[type] || !Number.isFinite(row.value)) {
      skipped += 1;
      continue;
    }

    const source = row.source ?? "import";
    await prisma.healthMetric.upsert({
      where: { userId_date_type_source: { userId: user.id, date: row.date, type, source } },
      create: {
        userId: user.id,
        date: row.date,
        type,
        value: row.value,
        unit: row.unit ?? HEALTH_METRIC_META[type].unit,
        source,
        externalId: row.externalId ?? null,
        recordedAt: row.recordedAt ? new Date(row.recordedAt) : null,
      },
      update: { value: row.value, externalId: row.externalId ?? null },
    });
    imported += 1;
    touched.add(row.date);
  }

  for (const date of touched) await recomputeDay(user.id, date);
  revalidateAll();
  return succeed({ imported, skipped });
}

// --- goals ------------------------------------------------------------------

export async function saveGoal(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = goalSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const user = await getCurrentUser();
  const { id, ...rest } = parsed.data;

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
    ? await prisma.goal.update({ where: { id: targetId }, data: rest })
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
    await prisma.healthMetric.upsert({
      where: { userId_date_type_source: { userId: user.id, date, type, source: "manual" } },
      create: { userId: user.id, date, type, value, unit: "/5", source: "manual" },
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
    ? await prisma.reminder.update({ where: { id }, data })
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

export async function markReminderFired(id: string): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  const reminder = await prisma.reminder.findFirst({ where: { id, userId: user.id } });
  if (!reminder) return fail("Reminder not found");

  const next = nextOccurrence(reminder.remindAt, reminder.repeat);
  await prisma.reminder.update({
    where: { id },
    data: {
      lastFiredAt: new Date(),
      remindAt: next ?? reminder.remindAt,
      enabled: next !== null,
    },
  });

  return succeed(null);
}

function nextOccurrence(from: Date, repeat: string): Date | null {
  const next = new Date(from);
  switch (repeat) {
    case "daily":
      next.setDate(next.getDate() + 1);
      return next;
    case "weekdays":
      do {
        next.setDate(next.getDate() + 1);
      } while (next.getDay() === 0 || next.getDay() === 6);
      return next;
    case "weekly":
      next.setDate(next.getDate() + 7);
      return next;
    default:
      return null;
  }
}

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
