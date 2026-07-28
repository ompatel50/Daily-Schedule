"use server";

import { revalidatePath } from "next/cache";

import { BACKUP_VERSION, type BackupFile, type CsvTable } from "@/lib/backup-format";
import { getCurrentUser, prisma } from "@/lib/db";
import { fail, succeed, type ActionResult } from "@/lib/validation";
import { rebuildSummaries } from "@/server/summaries";
import { today } from "@/lib/date";

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
    healthMetrics,
    goals,
    journalEntries,
    reminders,
    favorites,
    tags,
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
    prisma.healthMetric.findMany({ where: { userId: user.id } }),
    prisma.goal.findMany({ where: { userId: user.id } }),
    prisma.journalEntry.findMany({ where: { userId: user.id } }),
    prisma.reminder.findMany({ where: { userId: user.id } }),
    prisma.favoriteItem.findMany({ where: { userId: user.id } }),
    prisma.tag.findMany({ where: { userId: user.id } }),
  ]);

  return succeed({
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    app: "personal-os",
    data: {
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
      healthMetrics,
      goals,
      journalEntries,
      reminders,
      favorites,
    },
  });
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
): Promise<ActionResult<{ imported: number; tables: string[] }>> {
  const file = payload as BackupFile;
  if (!file || typeof file !== "object" || file.app !== "personal-os") {
    return fail("That doesn't look like a Personal OS backup file");
  }
  if (file.version > BACKUP_VERSION) {
    return fail(`Backup version ${file.version} is newer than this app supports`);
  }
  if (!file.data || typeof file.data !== "object") return fail("Backup file has no data");

  const user = await getCurrentUser();
  const data = file.data;

  if (mode === "replace") {
    // Order matters: children before parents, since SQLite enforces FKs.
    await prisma.scheduleItemTag.deleteMany({ where: { scheduleItem: { userId: user.id } } });
    await prisma.mealEntry.deleteMany({ where: { meal: { userId: user.id } } });
    await prisma.mealTemplateItem.deleteMany({ where: { template: { userId: user.id } } });
    await prisma.workoutSet.deleteMany({ where: { workout: { userId: user.id } } });
    await prisma.scheduleItem.deleteMany({ where: { userId: user.id } });
    await prisma.meal.deleteMany({ where: { userId: user.id } });
    await prisma.mealTemplate.deleteMany({ where: { userId: user.id } });
    await prisma.workout.deleteMany({ where: { userId: user.id } });
    await prisma.workoutTemplate.deleteMany({ where: { userId: user.id } });
    await prisma.habitLog.deleteMany({ where: { userId: user.id } });
    await prisma.habit.deleteMany({ where: { userId: user.id } });
    await prisma.healthMetric.deleteMany({ where: { userId: user.id } });
    await prisma.journalEntry.deleteMany({ where: { userId: user.id } });
    await prisma.reminder.deleteMany({ where: { userId: user.id } });
    await prisma.favoriteItem.deleteMany({ where: { userId: user.id } });
    await prisma.goal.deleteMany({ where: { userId: user.id } });
    await prisma.tag.deleteMany({ where: { userId: user.id } });
    await prisma.foodItem.deleteMany({ where: { userId: user.id } });
    await prisma.calendarDaySummary.deleteMany({ where: { userId: user.id } });
  }

  let imported = 0;
  const touchedTables: string[] = [];

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
    for (const key of ["createdAt", "updatedAt", "completedAt", "lastUsed", "lastUsedAt", "remindAt", "lastFiredAt", "recordedAt"]) {
      if (typeof copy[key] === "string") copy[key] = new Date(copy[key] as string);
    }
    return copy as T;
  };

  await restore<{ id: string }>("tags", (row) => {
    const value = own(dates(row)) as never;
    return prisma.tag.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ id: string }>("foodItems", (row) => {
    const raw = dates(row) as Record<string, unknown>;
    // Bundled foods keep userId null so they stay shared/global.
    const value = (raw.isCustom ? { ...raw, userId: user.id } : raw) as never;
    return prisma.foodItem.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ id: string }>("scheduleTemplates", (row) => {
    const value = own(dates(row)) as never;
    return prisma.scheduleTemplate.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ id: string }>("habits", (row) => {
    const value = own(dates(row)) as never;
    return prisma.habit.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ id: string }>("workoutTemplates", (row) => {
    const value = own(dates(row)) as never;
    return prisma.workoutTemplate.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ id: string }>("workouts", (row) => {
    const value = own(dates(row)) as never;
    return prisma.workout.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ id: string }>("workoutSets", (row) => {
    const value = dates(row) as never;
    return prisma.workoutSet.upsert({ where: { id: row.id }, create: value, update: value });
  });

  // Schedule items reference workouts/meals/habits, so they come after those.
  await restore<{ id: string }>("scheduleItems", (row) => {
    const value = own(dates(row)) as never;
    return prisma.scheduleItem.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ scheduleItemId: string; tagId: string }>("scheduleItemTags", (row) =>
    prisma.scheduleItemTag.upsert({
      where: { scheduleItemId_tagId: { scheduleItemId: row.scheduleItemId, tagId: row.tagId } },
      create: row as never,
      update: {},
    }),
  );

  await restore<{ id: string }>("habitLogs", (row) => {
    const value = own(dates(row)) as never;
    return prisma.habitLog.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ id: string }>("meals", (row) => {
    const value = own(dates(row)) as never;
    return prisma.meal.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ id: string }>("mealEntries", (row) => {
    const value = dates(row) as never;
    return prisma.mealEntry.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ id: string }>("mealTemplates", (row) => {
    const value = own(dates(row)) as never;
    return prisma.mealTemplate.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ id: string }>("mealTemplateItems", (row) =>
    prisma.mealTemplateItem.upsert({
      where: { id: row.id },
      create: row as never,
      update: row as never,
    }),
  );

  await restore<{ id: string }>("healthMetrics", (row) => {
    const value = own(dates(row)) as never;
    return prisma.healthMetric.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ id: string }>("goals", (row) => {
    const value = own(dates(row)) as never;
    return prisma.goal.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ id: string }>("journalEntries", (row) => {
    const value = own(dates(row)) as never;
    return prisma.journalEntry.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ id: string }>("reminders", (row) => {
    const value = own(dates(row)) as never;
    return prisma.reminder.upsert({ where: { id: row.id }, create: value, update: value });
  });

  await restore<{ id: string }>("favorites", (row) => {
    const value = own(dates(row)) as never;
    return prisma.favoriteItem.upsert({ where: { id: row.id }, create: value, update: value });
  });

  // Summaries are derived, so rebuild rather than importing them.
  const earliest = await prisma.scheduleItem.findFirst({
    where: { userId: user.id },
    orderBy: { date: "asc" },
    select: { date: true },
  });
  await rebuildSummaries(user.id, earliest?.date ?? today(), today());

  revalidatePath("/", "layout");
  return succeed({ imported, tables: touchedTables });
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
