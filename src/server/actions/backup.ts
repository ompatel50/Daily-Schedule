"use server";

import { revalidatePath } from "next/cache";

import {
  BACKUP_VERSION,
  checksumOf,
  inspectBackup,
  type BackupFile,
  type CsvTable,
} from "@/lib/backup-format";
import { getCurrentUser, prisma } from "@/lib/db";
import { restoreBackupForUser, type ImportReport } from "@/server/backup-restore";
import { logRedactedError } from "@/server/safe-error";
import { fail, succeed, type ActionResult } from "@/lib/validation";
import { rebuildSummaries } from "@/server/summaries";
import { today } from "@/lib/date";

/** Recorded in backup metadata so a file says which app version wrote it. */
const APP_VERSION = "1.1.0";

export async function exportBackup(): Promise<ActionResult<BackupFile>> {
  const user = await getCurrentUser();

  // Global foods pinned as favorites are referenced only by refId (no FK),
  // so they are collected up front to be included in the food export below.
  const foodFavorites = await prisma.favoriteItem.findMany({
    where: { userId: user.id, kind: "food" },
    select: { refId: true },
  });
  const favoriteFoodIds = foodFavorites.map((favorite) => favorite.refId);

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
    healthRecords,
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
    projects,
    tasks,
    taskTags,
    financeAccounts,
    financeImportBatches,
    bills,
    financeTransactions,
    savingsGoals,
    budgets,
    inboxItems,
    documents,
    seedBatches,
    seedRecords,
  ] = await Promise.all([
    prisma.scheduleItem.findMany({ where: { userId: user.id } }),
    prisma.scheduleItemTag.findMany({ where: { scheduleItem: { userId: user.id } } }),
    prisma.scheduleTemplate.findMany({ where: { userId: user.id } }),
    prisma.habit.findMany({ where: { userId: user.id } }),
    prisma.habitLog.findMany({ where: { userId: user.id } }),
    // The user's own foods, plus only the GLOBAL rows their data actually
    // references. Exporting the entire shared cache would ship every other
    // account's food-lookup history (and grow without bound as users join);
    // a pruned export restores identically — the restore side resolves
    // shared foods by id and by (provider, externalId).
    prisma.foodItem.findMany({
      where: {
        OR: [
          { userId: user.id },
          {
            userId: null,
            OR: [
              { entries: { some: { meal: { userId: user.id } } } },
              { templateRows: { some: { template: { userId: user.id } } } },
              ...(favoriteFoodIds.length ? [{ id: { in: favoriteFoodIds } }] : []),
            ],
          },
        ],
      },
    }),
    prisma.meal.findMany({ where: { userId: user.id } }),
    prisma.mealEntry.findMany({ where: { meal: { userId: user.id } } }),
    prisma.mealTemplate.findMany({ where: { userId: user.id } }),
    prisma.mealTemplateItem.findMany({ where: { template: { userId: user.id } } }),
    prisma.workout.findMany({ where: { userId: user.id } }),
    prisma.workoutSet.findMany({ where: { workout: { userId: user.id } } }),
    prisma.workoutTemplate.findMany({ where: { userId: user.id } }),
    prisma.healthImportBatch.findMany({ where: { userId: user.id } }),
    prisma.healthMetric.findMany({ where: { userId: user.id } }),
    prisma.healthRecord.findMany({ where: { userId: user.id } }),
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
    prisma.project.findMany({ where: { userId: user.id } }),
    prisma.task.findMany({ where: { userId: user.id } }),
    prisma.taskTag.findMany({ where: { task: { userId: user.id } } }),
    prisma.financeAccount.findMany({ where: { userId: user.id } }),
    prisma.financeImportBatch.findMany({ where: { userId: user.id } }),
    prisma.bill.findMany({ where: { userId: user.id } }),
    prisma.financeTransaction.findMany({ where: { userId: user.id } }),
    prisma.savingsGoal.findMany({ where: { userId: user.id } }),
    prisma.budget.findMany({ where: { userId: user.id } }),
    prisma.inboxItem.findMany({ where: { userId: user.id } }),
    prisma.lifeDocument.findMany({ where: { userId: user.id } }),
    prisma.seedBatch.findMany({ where: { userId: user.id } }),
    prisma.seedRecord.findMany({ where: { batch: { userId: user.id } } }),
  ]);

  // Profile/settings only — never authentication material. A backup lands in
  // cloud drives and email attachments; it must not carry the password hash,
  // token version or lockout state (and the restore side only ever reads the
  // safe profile fields anyway — see SAFE_PROFILE_FIELDS in backup-restore).
  const exportedUser = {
    id: user.id,
    name: user.name,
    timezone: user.timezone,
    birthDate: user.birthDate,
    heightCm: user.heightCm,
    sex: user.sex,
    activityLevel: user.activityLevel,
    theme: user.theme,
    weekStartsOn: user.weekStartsOn,
    unitSystem: user.unitSystem,
    dayStartHour: user.dayStartHour,
    dayEndHour: user.dayEndHour,
    scoreWeights: user.scoreWeights,
    scoreOptionalTasks: user.scoreOptionalTasks,
    onboardingState: user.onboardingState,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };

  const data = {
    users: [exportedUser],
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
    // `xmlBytes` is a BigInt column (an unzipped export can exceed 2 GB, which
    // an Int cannot hold). JSON has no BigInt, so it travels as a number —
    // exact well past any real file size, and the restore accepts either.
    healthImportBatches: healthImportBatches.map((batch) => ({
      ...batch,
      xmlBytes: batch.xmlBytes === null ? null : Number(batch.xmlBytes),
    })),
    healthMetrics,
    healthRecords,
    goals,
    goalEntries,
    scheduleRules,
    scheduleRuleDays,
    scheduleOverrides,
    journalEntries,
    reminders,
    reminderDeliveries,
    favorites,
    projects,
    tasks,
    taskTags,
    financeAccounts,
    financeImportBatches,
    bills,
    financeTransactions,
    savingsGoals,
    budgets,
    inboxItems,
    documents,
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
/**
 * Import a backup into the authenticated account.
 *
 * The heavy lifting — deterministic id remapping (a file's ids can never
 * address another account's rows), intra-file reference validation, row
 * sanitising and the batched transaction — lives in
 * `src/server/backup-restore.ts`. Nothing here trusts an id from the file,
 * and there is no server-side pre-import snapshot: the browser download the
 * UI performs before confirming is the recovery path, because a serverless
 * host's temp directory does not survive the request.
 */
export async function importBackup(
  payload: unknown,
  mode: "merge" | "replace" = "merge",
): Promise<ActionResult<ImportReport>> {
  const inspection = inspectBackup(payload);
  if (!inspection.ok) return fail(inspection.error ?? "That backup file cannot be imported");

  const file = payload as BackupFile;
  const user = await getCurrentUser();

  let report: ImportReport;
  try {
    ({ report } = await restoreBackupForUser(user.id, file, mode));
  } catch (error) {
    const reference = logRedactedError("backup-import", error);
    return fail(
      `The import failed and was rolled back — nothing was changed. (Reference ${reference})`,
    );
  }

  // Summaries are derived, so rebuild rather than importing them. The range
  // covers everything datable the import could have touched.
  const [earliestItem, earliestMeal, earliestLog, earliestMetric, earliestWorkout] =
    await Promise.all([
      prisma.scheduleItem.findFirst({ where: { userId: user.id }, orderBy: { date: "asc" }, select: { date: true } }),
      prisma.meal.findFirst({ where: { userId: user.id }, orderBy: { date: "asc" }, select: { date: true } }),
      prisma.habitLog.findFirst({ where: { userId: user.id }, orderBy: { date: "asc" }, select: { date: true } }),
      prisma.healthMetric.findFirst({ where: { userId: user.id }, orderBy: { date: "asc" }, select: { date: true } }),
      prisma.workout.findFirst({ where: { userId: user.id }, orderBy: { date: "asc" }, select: { date: true } }),
    ]);
  const earliest = [earliestItem, earliestMeal, earliestLog, earliestMetric, earliestWorkout]
    .map((row) => row?.date)
    .filter((date): date is string => typeof date === "string")
    .sort()[0];
  await rebuildSummaries(user.id, earliest ?? today(), today());

  revalidatePath("/", "layout");
  return succeed(report);
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
