"use server";

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { revalidatePath } from "next/cache";

import {
  BACKUP_VERSION,
  checksumOf,
  inspectBackup,
  type BackupFile,
  type CsvTable,
} from "@/lib/backup-format";
import { getCurrentUser, prisma } from "@/lib/db";
import { fail, succeed, type ActionResult } from "@/lib/validation";
import { rebuildSummaries } from "@/server/summaries";
import { today } from "@/lib/date";

/** Recorded in backup metadata so a file says which app version wrote it. */
const APP_VERSION = "1.1.0";

export async function exportBackup(): Promise<ActionResult<BackupFile>> {
  const user = await getCurrentUser();

  const [
    scheduleItems,
    scheduleItemTags,
    scheduleTemplates,
    habits,
    habitLogs,
    foodItems,
    meals,
    mealEntries,
    mealTemplates,
    mealTemplateItems,
    workouts,
    workoutSets,
    workoutTemplates,
    healthImportBatches,
    healthMetrics,
    goals,
    goalEntries,
    scheduleRules,
    scheduleRuleDays,
    scheduleOverrides,
    journalEntries,
    reminders,
    reminderDeliveries,
    favorites,
    tags,
    seedBatches,
    seedRecords,
  ] = await Promise.all([
    prisma.scheduleItem.findMany({ where: { userId: user.id } }),
    prisma.scheduleItemTag.findMany({ where: { scheduleItem: { userId: user.id } } }),
    prisma.scheduleTemplate.findMany({ where: { userId: user.id } }),
    prisma.habit.findMany({ where: { userId: user.id } }),
    prisma.habitLog.findMany({ where: { userId: user.id } }),
    prisma.foodItem.findMany({ where: { OR: [{ userId: user.id }, { userId: null }] } }),
    prisma.meal.findMany({ where: { userId: user.id } }),
    prisma.mealEntry.findMany({ where: { meal: { userId: user.id } } }),
    prisma.mealTemplate.findMany({ where: { userId: user.id } }),
    prisma.mealTemplateItem.findMany({ where: { template: { userId: user.id } } }),
    prisma.workout.findMany({ where: { userId: user.id } }),
    prisma.workoutSet.findMany({ where: { workout: { userId: user.id } } }),
    prisma.workoutTemplate.findMany({ where: { userId: user.id } }),
    prisma.healthImportBatch.findMany({ where: { userId: user.id } }),
    prisma.healthMetric.findMany({ where: { userId: user.id } }),
    prisma.goal.findMany({ where: { userId: user.id } }),
    prisma.goalEntry.findMany({ where: { userId: user.id } }),
    // The scheduling tables are what make a goal or habit mean anything. A
    // backup without them would restore records that apply on no date at all.
    prisma.scheduleRule.findMany({ where: { userId: user.id } }),
    prisma.scheduleRuleDay.findMany({ where: { rule: { userId: user.id } } }),
    prisma.scheduleOverride.findMany({ where: { userId: user.id } }),
    prisma.journalEntry.findMany({ where: { userId: user.id } }),
    prisma.reminder.findMany({ where: { userId: user.id } }),
    prisma.reminderDelivery.findMany({ where: { userId: user.id } }),
    prisma.favoriteItem.findMany({ where: { userId: user.id } }),
    prisma.tag.findMany({ where: { userId: user.id } }),
    prisma.seedBatch.findMany({ where: { userId: user.id } }),
    prisma.seedRecord.findMany({ where: { batch: { userId: user.id } } }),
  ]);

  const data = {
    users: [user],
    tags,
    scheduleItems,
    scheduleItemTags,
    scheduleTemplates,
    habits,
    habitLogs,
    foodItems,
    meals,
    mealEntries,
    mealTemplates,
    mealTemplateItems,
    workouts,
    workoutSets,
    workoutTemplates,
    healthImportBatches,
    healthMetrics,
    goals,
    goalEntries,
    scheduleRules,
    scheduleRuleDays,
    scheduleOverrides,
    journalEntries,
    reminders,
    reminderDeliveries,
    favorites,
    seedBatches,
    seedRecords,
  };

  const recordCounts = Object.fromEntries(
    Object.entries(data).map(([table, rows]) => [table, rows.length]),
  );
  const exportedAt = new Date().toISOString();

  return succeed({
    version: BACKUP_VERSION,
    exportedAt,
    app: "personal-os" as const,
    meta: {
      version: BACKUP_VERSION,
      appVersion: APP_VERSION,
      exportedAt,
      timezone: user.timezone,
      recordCounts,
      checksum: checksumOf(JSON.stringify(data)),
    },
    data,
  });
}

/**
 * Inspect a backup without importing it, so the UI can show what is in the file
 * and whether it is compatible *before* anything is written.
 */
export async function previewBackup(payload: unknown) {
  return succeed(inspectBackup(payload));
}

/** CSV export of the flat, spreadsheet-friendly tables. */
export async function exportCsv(
  table: CsvTable,
): Promise<ActionResult<{ filename: string; csv: string }>> {
  const user = await getCurrentUser();

  switch (table) {
    case "schedule": {
      const rows = await prisma.scheduleItem.findMany({
        where: { userId: user.id },
        orderBy: { date: "asc" },
      });
      return succeed({
        filename: "schedule.csv",
        csv: toCsv(
          ["date", "title", "category", "priority", "status", "startMinute", "endMinute", "allDay", "notes"],
          rows,
        ),
      });
    }
    case "habits": {
      const rows = await prisma.habitLog.findMany({
        where: { userId: user.id },
        include: { habit: { select: { name: true, category: true } } },
        orderBy: { date: "asc" },
      });
      return succeed({
        filename: "habit-logs.csv",
        csv: toCsv(
          ["date", "habit", "category", "status", "value", "notes"],
          rows.map((row) => ({
            date: row.date,
            habit: row.habit.name,
            category: row.habit.category,
            status: row.status,
            value: row.value,
            notes: row.notes,
          })),
        ),
      });
    }
    case "nutrition": {
      const rows = await prisma.mealEntry.findMany({
        where: { meal: { userId: user.id } },
        include: { meal: true, foodItem: { select: { name: true } } },
        orderBy: { meal: { date: "asc" } },
      });
      return succeed({
        filename: "nutrition.csv",
        csv: toCsv(
          ["date", "meal", "food", "quantity", "unit", "calories", "protein", "carbs", "fat", "fiber", "sugar", "sodium"],
          rows.map((row) => ({
            date: row.meal.date,
            meal: row.meal.label ?? row.meal.type,
            food: row.foodItem.name,
            quantity: row.quantity,
            unit: row.unit,
            calories: row.calories,
            protein: row.protein,
            carbs: row.carbs,
            fat: row.fat,
            fiber: row.fiber,
            sugar: row.sugar,
            sodium: row.sodium,
          })),
        ),
      });
    }
    case "workouts": {
      const rows = await prisma.workout.findMany({
        where: { userId: user.id },
        orderBy: { date: "asc" },
      });
      return succeed({
        filename: "workouts.csv",
        csv: toCsv(
          ["date", "name", "type", "durationMin", "intensity", "caloriesBurned", "distanceKm", "avgHeartRate", "status", "notes"],
          rows,
        ),
      });
    }
    case "health": {
      const rows = await prisma.healthMetric.findMany({
        where: { userId: user.id },
        orderBy: { date: "asc" },
      });
      return succeed({
        filename: "health-metrics.csv",
        csv: toCsv(["date", "type", "value", "unit", "source", "notes"], rows),
      });
    }
    default:
      return fail("Unknown table");
  }
}

function toCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    const text = value instanceof Date ? value.toISOString() : String(value);
    // Quote when the value contains a delimiter, quote or newline.
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const header = columns.join(",");
  const body = rows.map((row) => columns.map((column) => escape(row[column])).join(","));
  return [header, ...body].join("\n");
}

/**
 * Restore from a backup file. `mode: "merge"` upserts by id (safe, additive);
 * `mode: "replace"` wipes the user's data first. Both rebuild the day
 * summaries afterwards so the calendar reflects the restored history.
 */
export async function importBackup(
  payload: unknown,
  mode: "merge" | "replace" = "merge",
): Promise<ActionResult<{ imported: number; tables: string[]; safetySnapshot: string | null }>> {
  const inspection = inspectBackup(payload);
  if (!inspection.ok) return fail(inspection.error ?? "That backup file cannot be imported");

  const file = payload as BackupFile;
  const user = await getCurrentUser();
  const data = file.data;

  // Safety net: snapshot the current database to the OS temp directory before
  // anything is written. Best-effort — the UI also downloads one — but it
  // means even a "replace" import always leaves a way back.
  let safetySnapshot: string | null = null;
  try {
    const snapshot = await exportBackup();
    if (snapshot.ok) {
      const dir = path.join(tmpdir(), "personal-os-backups");
      await mkdir(dir, { recursive: true });
      safetySnapshot = path.join(dir, `pre-import-${Date.now()}.json`);
      await writeFile(safetySnapshot, JSON.stringify(snapshot.data), "utf8");
    }
  } catch {
    safetySnapshot = null;
  }

  let imported = 0;
  const touchedTables: string[] = [];

  try {
    // One transaction: a fatal failure mid-restore rolls the whole import back
    // instead of leaving half a backup applied. Row-level constraint failures
    // are still skipped inside — a partial recovery of a damaged file beats
    // none — but the database can never be left between two states.
    await prisma.$transaction(
      async (db) => {
  if (mode === "replace") {
    // Order matters: children before parents, since SQLite enforces FKs.
    await db.scheduleItemTag.deleteMany({ where: { scheduleItem: { userId: user.id } } });
    await db.mealEntry.deleteMany({ where: { meal: { userId: user.id } } });
    await db.mealTemplateItem.deleteMany({ where: { template: { userId: user.id } } });
    await db.workoutSet.deleteMany({ where: { workout: { userId: user.id } } });
    await db.scheduleItem.deleteMany({ where: { userId: user.id } });
    await db.meal.deleteMany({ where: { userId: user.id } });
    await db.mealTemplate.deleteMany({ where: { userId: user.id } });
    await db.workout.deleteMany({ where: { userId: user.id } });
    await db.workoutTemplate.deleteMany({ where: { userId: user.id } });
    await db.habitLog.deleteMany({ where: { userId: user.id } });
    await db.habit.deleteMany({ where: { userId: user.id } });
    await db.healthMetric.deleteMany({ where: { userId: user.id } });
    await db.healthImportBatch.deleteMany({ where: { userId: user.id } });
    await db.journalEntry.deleteMany({ where: { userId: user.id } });
    await db.reminder.deleteMany({ where: { userId: user.id } });
    await db.reminderDelivery.deleteMany({ where: { userId: user.id } });
    await db.favoriteItem.deleteMany({ where: { userId: user.id } });
    await db.goalEntry.deleteMany({ where: { userId: user.id } });
    await db.goal.deleteMany({ where: { userId: user.id } });
    // Schedules are polymorphic, so they are cleared explicitly rather than
    // cascading from the goal/habit rows.
    await db.scheduleRuleDay.deleteMany({ where: { rule: { userId: user.id } } });
    await db.scheduleRule.deleteMany({ where: { userId: user.id } });
    await db.scheduleOverride.deleteMany({ where: { userId: user.id } });
    await db.seedRecord.deleteMany({ where: { batch: { userId: user.id } } });
    await db.seedBatch.deleteMany({ where: { userId: user.id } });
    await db.tag.deleteMany({ where: { userId: user.id } });
    await db.foodItem.deleteMany({ where: { userId: user.id } });
    await db.calendarDaySummary.deleteMany({ where: { userId: user.id } });
  }

  /** Upsert a table's rows, re-pointing every row at the current user. */
  async function restore<T>(key: string, write: (row: T) => Promise<unknown>) {
    const rows = data[key];
    if (!Array.isArray(rows) || rows.length === 0) return;
    for (const row of rows as T[]) {
      try {
        await write(row);
        imported += 1;
      } catch {
        // Skip rows that violate a constraint rather than aborting the whole
        // restore — a partial recovery beats none.
      }
    }
    touchedTables.push(key);
  }

  const own = <T extends object>(row: T) => ({ ...row, userId: user.id });
  const dates = <T extends Record<string, unknown>>(row: T) => {
    const copy: Record<string, unknown> = { ...row };
    for (const key of ["createdAt", "updatedAt", "completedAt", "lastUsed", "lastUsedAt", "remindAt", "lastFiredAt", "recordedAt", "startAt", "endAt", "startedAt", "removedAt", "retrievedAt", "refreshedAt"]) {
      if (typeof copy[key] === "string") copy[key] = new Date(copy[key] as string);
    }
    return copy as T;
  };

  await restore<{ id: string }>("tags", (row) => {
    const value = own(dates(row)) as never;
    return db.tag.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ id: string }>("foodItems", (row) => {
    const raw = dates(row) as Record<string, unknown>;
    // Bundled foods keep userId null so they stay shared/global.
    const value = (raw.isCustom ? { ...raw, userId: user.id } : raw) as never;
    return db.foodItem.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ id: string }>("scheduleTemplates", (row) => {
    const value = own(dates(row)) as never;
    return db.scheduleTemplate.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ id: string }>("habits", (row) => {
    const value = own(dates(row)) as never;
    return db.habit.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ id: string }>("workoutTemplates", (row) => {
    const value = own(dates(row)) as never;
    return db.workoutTemplate.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ id: string }>("workouts", (row) => {
    const value = own(dates(row)) as never;
    return db.workout.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ id: string }>("workoutSets", (row) => {
    const value = dates(row) as never;
    return db.workoutSet.upsert({ where: { id: row.id }, create: value, update: value });
  });

  // Schedule items reference workouts/meals/habits, so they come after those.
  await restore<{ id: string }>("scheduleItems", (row) => {
    const value = own(dates(row)) as never;
    return db.scheduleItem.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ scheduleItemId: string; tagId: string }>("scheduleItemTags", (row) =>
    db.scheduleItemTag.upsert({
      where: { scheduleItemId_tagId: { scheduleItemId: row.scheduleItemId, tagId: row.tagId } },
      create: row as never,
      update: {},
    }),
  );

  await restore<{ id: string }>("habitLogs", (row) => {
    const value = own(dates(row)) as never;
    return db.habitLog.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ id: string }>("meals", (row) => {
    const value = own(dates(row)) as never;
    return db.meal.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ id: string }>("mealEntries", (row) => {
    const value = dates(row) as never;
    return db.mealEntry.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ id: string }>("mealTemplates", (row) => {
    const value = own(dates(row)) as never;
    return db.mealTemplate.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ id: string }>("mealTemplateItems", (row) =>
    db.mealTemplateItem.upsert({
      where: { id: row.id },
      create: row as never,
      update: row as never,
    }),
  );

  // Batches restore before the metric rows that point at them.
  await restore<{ id: string }>("healthImportBatches", (row) => {
    const value = own(dates(row)) as never;
    return db.healthImportBatch.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ id: string }>("healthMetrics", (row) => {
    const value = own(dates(row)) as never;
    return db.healthMetric.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ id: string }>("goals", (row) => {
    const value = own(dates(row)) as never;
    return db.goal.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ id: string }>("goalEntries", (row) => {
    const value = own(dates(row)) as never;
    return db.goalEntry.upsert({ where: { id: row.id }, create: value, update: value });
  });

  // Schedules come after their owners so the polymorphic ownerId always points
  // at a row that exists by the time the engine reads it.
  await restore<{ id: string }>("scheduleRules", (row) => {
    const value = own(dates(row)) as never;
    return db.scheduleRule.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ ruleId: string; weekday: number }>("scheduleRuleDays", (row) =>
    db.scheduleRuleDay.upsert({
      where: { ruleId_weekday: { ruleId: row.ruleId, weekday: row.weekday } },
      create: row as never,
      update: {},
    }),
  );

  await restore<{ id: string }>("scheduleOverrides", (row) => {
    const value = own(dates(row)) as never;
    return db.scheduleOverride.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ id: string }>("journalEntries", (row) => {
    const value = own(dates(row)) as never;
    return db.journalEntry.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ id: string }>("reminders", (row) => {
    const value = own(dates(row)) as never;
    return db.reminder.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ id: string }>("reminderDeliveries", (row) => {
    const raw = dates(row) as Record<string, unknown>;
    if (typeof raw.deliveredAt === "string") raw.deliveredAt = new Date(raw.deliveredAt);
    const value = { ...raw, userId: user.id } as never;
    return db.reminderDelivery.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ id: string }>("favorites", (row) => {
    const value = own(dates(row)) as never;
    return db.favoriteItem.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ id: string }>("seedBatches", (row) => {
    const value = own(dates(row)) as never;
    return db.seedBatch.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ id: string; model: string; recordId: string }>("seedRecords", (row) => {
    const value = dates(row) as never;
    return db.seedRecord.upsert({
      where: { model_recordId: { model: row.model, recordId: row.recordId } },
      create: value,
      update: value,
    });
  });

  // A v1 backup carries no schedules. Anything that arrives without one gets an
  // every-day rule effective from its own start date — which is exactly how it
  // behaved in the version that wrote the file, so no history changes meaning.
  await backfillMissingSchedules(db, user.id);
      },
      { timeout: 300_000 },
    );
  } catch (error) {
    return fail(
      "The import failed and was rolled back — nothing was changed. " +
        (error instanceof Error ? error.message.slice(0, 300) : ""),
    );
  }

  // Summaries are derived, so rebuild rather than importing them.
  const earliest = await prisma.scheduleItem.findFirst({
    where: { userId: user.id },
    orderBy: { date: "asc" },
    select: { date: true },
  });
  await rebuildSummaries(user.id, earliest?.date ?? today(), today());

  revalidatePath("/", "layout");
  return succeed({ imported, tables: touchedTables, safetySnapshot });
}

/**
 * Give any goal or habit that arrived without a schedule an every-day rule.
 *
 * Idempotent, and only ever *adds* — a record that already has a schedule is
 * left completely alone.
 */
type DbClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

async function backfillMissingSchedules(db: DbClient, userId: string): Promise<void> {
  const [goals, habits, rules] = await Promise.all([
    db.goal.findMany({ where: { userId }, select: { id: true, startDate: true, createdAt: true, active: true, endDate: true } }),
    db.habit.findMany({ where: { userId }, select: { id: true, startDate: true, endDate: true, archived: true, timeOfDay: true } }),
    db.scheduleRule.findMany({ where: { userId }, select: { ownerType: true, ownerId: true } }),
  ]);

  const have = new Set(rules.map((rule) => `${rule.ownerType}:${rule.ownerId}`));
  const dayKey = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

  for (const goal of goals) {
    if (have.has(`goal:${goal.id}`)) continue;
    await db.scheduleRule.create({
      data: {
        userId,
        ownerType: "goal",
        ownerId: goal.id,
        effectiveFrom: goal.startDate ?? dayKey(goal.createdAt),
        effectiveTo: goal.endDate,
        mode: "every_day",
        enabled: goal.active,
      },
    });
  }

  for (const habit of habits) {
    if (have.has(`habit:${habit.id}`)) continue;
    await db.scheduleRule.create({
      data: {
        userId,
        ownerType: "habit",
        ownerId: habit.id,
        effectiveFrom: habit.startDate,
        effectiveTo: habit.endDate,
        mode: "every_day",
        enabled: !habit.archived,
        daypart: habit.timeOfDay,
      },
    });
  }
}

/** Wipe everything and start over. Used by the "reset" button in Settings. */
export async function resetAllData(): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  await importBackup(
    { app: "personal-os", version: BACKUP_VERSION, exportedAt: new Date().toISOString(), data: {} },
    "replace",
  );
  await prisma.calendarDaySummary.deleteMany({ where: { userId: user.id } });
  revalidatePath("/", "layout");
  return succeed(null);
}
