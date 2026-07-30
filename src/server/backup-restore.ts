import "server-only";

import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { BACKUP_TABLES, type BackupFile, type BackupTable } from "@/lib/backup-format";

/**
 * Restoring a backup into a *hosted, multi-user* database.
 *
 * The local app restored by upserting every row under its original primary
 * key. In a shared database that is an attack surface: a crafted file
 * carrying someone else's cuids would overwrite their rows and re-point them
 * at the importer. The hosted restore therefore never trusts an id from the
 * file:
 *
 *  1. **Every imported row gets a deterministic new id**,
 *     `hash(userId | oldId)` — so a file's ids can never address another
 *     account's rows, internal relationships survive (every reference is
 *     remapped with the same function), and re-importing the same file is
 *     still idempotent (same input → same ids → duplicates are skipped).
 *  2. **References are resolved strictly inside the file.** A child row
 *     whose parent is not in the file is dropped (required link) or
 *     unlinked (optional link) and reported — it cannot reach across
 *     accounts by construction.
 *  3. **Rows are validated and sanitised before the transaction.** Unknown
 *     columns are dropped and value types are checked against the Prisma
 *     schema (DMMF), so a damaged row is skipped up front and reported —
 *     instead of aborting the Postgres transaction the way an in-transaction
 *     error would.
 *  4. **Writes are batched `createMany … skipDuplicates`** inside one
 *     transaction: a genuine mid-flight failure rolls everything back; a
 *     row that already exists (re-import) or collides with the account's own
 *     data (merge) is skipped without poisoning the transaction.
 *
 * Shared reference data is the one deliberate exception: bundled foods
 * (userId null) already present keep their identity, and provider-cached
 * foods are matched by (provider, externalId) — the same shared-cache
 * behaviour `cacheFood` has — rather than duplicated per import.
 */

// --- id remapping -----------------------------------------------------------

export function remapId(userId: string, oldId: string): string {
  return "i" + createHash("sha256").update(`personal-os-import|${userId}|${oldId}`).digest("hex").slice(0, 24);
}

// --- schema-driven row sanitising ------------------------------------------

const MODEL_BY_TABLE: Record<BackupTable, string> = {
  tags: "Tag",
  foodItems: "FoodItem",
  scheduleTemplates: "ScheduleTemplate",
  habits: "Habit",
  workoutTemplates: "WorkoutTemplate",
  workouts: "Workout",
  workoutSets: "WorkoutSet",
  scheduleItems: "ScheduleItem",
  scheduleItemTags: "ScheduleItemTag",
  habitLogs: "HabitLog",
  meals: "Meal",
  mealEntries: "MealEntry",
  mealTemplates: "MealTemplate",
  mealTemplateItems: "MealTemplateItem",
  healthImportBatches: "HealthImportBatch",
  healthMetrics: "HealthMetric",
  goals: "Goal",
  goalEntries: "GoalEntry",
  scheduleRules: "ScheduleRule",
  scheduleRuleDays: "ScheduleRuleDay",
  scheduleOverrides: "ScheduleOverride",
  journalEntries: "JournalEntry",
  reminders: "Reminder",
  reminderDeliveries: "ReminderDelivery",
  favorites: "FavoriteItem",
  seedBatches: "SeedBatch",
  seedRecords: "SeedRecord",
};

interface ScalarField {
  name: string;
  type: string;
  isRequired: boolean;
  hasDefault: boolean;
  isUpdatedAt: boolean;
}

const scalarFieldCache = new Map<string, ScalarField[]>();

function scalarFieldsOf(modelName: string): ScalarField[] {
  const cached = scalarFieldCache.get(modelName);
  if (cached) return cached;
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === modelName);
  if (!model) throw new Error(`Unknown model ${modelName}`);
  const fields = model.fields
    .filter((f) => f.kind === "scalar")
    .map((f) => ({
      name: f.name,
      type: f.type,
      isRequired: f.isRequired,
      hasDefault: f.hasDefaultValue,
      isUpdatedAt: Boolean(f.isUpdatedAt),
    }));
  scalarFieldCache.set(modelName, fields);
  return fields;
}

/**
 * Keep only known scalar columns, coerce DateTime strings, and type-check
 * everything. Returns null when the row is unusable (missing/invalid required
 * value) — the caller counts and reports it instead of importing garbage.
 */
function sanitizeRow(table: BackupTable, raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const field of scalarFieldsOf(MODEL_BY_TABLE[table])) {
    let value = source[field.name];
    if (value === undefined) {
      // `updatedAt` is auto-filled; anything else required without a default
      // makes the row unusable.
      if (field.isRequired && !field.hasDefault && !field.isUpdatedAt) return null;
      continue;
    }
    if (value === null) {
      if (field.isRequired && !field.hasDefault && !field.isUpdatedAt) return null;
      if (field.isRequired) continue; // let the default fill it
      out[field.name] = null;
      continue;
    }
    switch (field.type) {
      case "String":
        if (typeof value !== "string") return null;
        break;
      case "Int":
        if (typeof value !== "number" || !Number.isFinite(value)) return null;
        value = Math.trunc(value);
        break;
      case "Float":
        if (typeof value !== "number" || !Number.isFinite(value)) return null;
        break;
      case "Boolean":
        if (typeof value !== "boolean") return null;
        break;
      case "DateTime": {
        const date = value instanceof Date ? value : new Date(String(value));
        if (Number.isNaN(date.getTime())) return null;
        value = date;
        break;
      }
      default:
        return null;
    }
    out[field.name] = value;
  }
  return out;
}

// --- the import itself ------------------------------------------------------

export interface TableOutcome {
  table: string;
  inFile: number;
  created: number;
  /** Rows already present (re-import) or colliding with existing data. */
  skipped: number;
  /** Rows dropped before the transaction: damaged, or dangling references. */
  dropped: number;
}

export interface ImportReport {
  mode: "merge" | "replace";
  importedAt: string;
  fileVersion: number;
  perTable: TableOutcome[];
  totalCreated: number;
  totalSkipped: number;
  totalDropped: number;
  profileApplied: boolean;
  /** Per-table row counts owned by the account after the import. */
  verification: Record<string, number>;
  warnings: string[];
}

type Row = Record<string, unknown>;

interface PreparedTable {
  table: BackupTable;
  rows: Row[];
  inFile: number;
  dropped: number;
  /** Rows resolved onto shared records that already exist (bundled foods). */
  reusedShared?: number;
}

/** Fields of the User row a backup is allowed to bring along. */
const SAFE_PROFILE_FIELDS = [
  "name",
  "timezone",
  "birthDate",
  "heightCm",
  "sex",
  "activityLevel",
  "theme",
  "weekStartsOn",
  "unitSystem",
  "dayStartHour",
  "dayEndHour",
  "scoreWeights",
  "scoreOptionalTasks",
  "onboardingState",
] as const;

export async function restoreBackupForUser(
  userId: string,
  file: BackupFile,
  mode: "merge" | "replace",
): Promise<{ report: ImportReport }> {
  const data = file.data ?? {};
  const warnings: string[] = [];
  const map = (oldId: unknown): string | null =>
    typeof oldId === "string" && oldId.length > 0 ? remapId(userId, oldId) : null;

  // ---- collect the file's own id space, table by table ----------------------
  const rowsOf = (table: BackupTable): unknown[] =>
    Array.isArray(data[table]) ? (data[table] as unknown[]) : [];

  const fileIds = new Map<BackupTable, Set<string>>();
  for (const table of BACKUP_TABLES) {
    const ids = new Set<string>();
    for (const raw of rowsOf(table)) {
      const id = (raw as Row)?.id;
      if (typeof id === "string") ids.add(id);
    }
    fileIds.set(table, ids);
  }
  const inFile = (table: BackupTable, id: unknown): boolean =>
    typeof id === "string" && (fileIds.get(table)?.has(id) ?? false);

  // ---- shared foods: resolve identity against the existing database ---------
  // oldFoodId → the id meal entries should reference after import.
  const foodIdMap = new Map<string, string>();
  const foodRowsRaw = rowsOf("foodItems") as Row[];
  const globalCandidates = foodRowsRaw
    .filter((row) => row.userId === null && typeof row.id === "string")
    .map((row) => row.id as string);
  const existingGlobal = globalCandidates.length
    ? await prisma.foodItem.findMany({
        where: { id: { in: globalCandidates }, userId: null },
        select: { id: true },
      })
    : [];
  const keepGlobal = new Set(existingGlobal.map((row) => row.id));

  const externalKeys = foodRowsRaw
    .filter((row) => typeof row.externalId === "string" && typeof row.provider === "string")
    .map((row) => ({ provider: row.provider as string, externalId: row.externalId as string }));
  const existingExternal = externalKeys.length
    ? await prisma.foodItem.findMany({
        where: { OR: externalKeys.map((key) => ({ provider: key.provider, externalId: key.externalId })) },
        select: { id: true, provider: true, externalId: true },
      })
    : [];
  const byExternal = new Map(existingExternal.map((row) => [`${row.provider}|${row.externalId}`, row.id]));

  const foodRowsToCreate: Row[] = [];
  for (const raw of foodRowsRaw) {
    const sanitized = sanitizeRow("foodItems", raw);
    if (!sanitized || typeof sanitized.id !== "string") continue;
    const oldId = sanitized.id;

    if (keepGlobal.has(oldId)) {
      // A bundled food that already exists — reuse it, never modify it.
      foodIdMap.set(oldId, oldId);
      continue;
    }
    const externalKey =
      typeof sanitized.provider === "string" && typeof sanitized.externalId === "string"
        ? `${sanitized.provider}|${sanitized.externalId}`
        : null;
    if (externalKey && byExternal.has(externalKey)) {
      // The shared provider cache already has this food — reuse, never modify.
      foodIdMap.set(oldId, byExternal.get(externalKey)!);
      continue;
    }

    const newId = remapId(userId, oldId);
    foodIdMap.set(oldId, newId);
    const isProviderCached = externalKey !== null && sanitized.cached === true;
    foodRowsToCreate.push({
      ...sanitized,
      id: newId,
      // Provider-cached rows stay in the shared cache (the same place a live
      // search would have put them); everything else belongs to the importer.
      userId: isProviderCached ? null : userId,
    });
  }

  // ---- per-table preparation -------------------------------------------------
  const prepared: PreparedTable[] = [];

  function prepare(
    table: BackupTable,
    transform: (row: Row) => Row | null,
  ): void {
    const raws = rowsOf(table);
    let dropped = 0;
    const rows: Row[] = [];
    for (const raw of raws) {
      const sanitized = sanitizeRow(table, raw);
      if (!sanitized) {
        dropped += 1;
        continue;
      }
      const result = transform(sanitized);
      if (!result) {
        dropped += 1;
        continue;
      }
      rows.push(result);
    }
    prepared.push({ table, rows, inFile: raws.length, dropped });
  }

  const own = (row: Row): Row => ({ ...row, userId });
  const withId = (row: Row): Row | null =>
    typeof row.id === "string" ? { ...row, id: remapId(userId, row.id as string) } : null;

  prepare("tags", (row) => {
    const mapped = withId(row);
    return mapped ? own(mapped) : null;
  });

  // Foods were resolved above (shared-data identity needs database lookups).
  prepared.push({
    table: "foodItems",
    rows: foodRowsToCreate,
    inFile: foodRowsRaw.length,
    dropped: foodRowsRaw.length - foodIdMap.size,
    reusedShared: foodIdMap.size - foodRowsToCreate.length,
  });

  prepare("scheduleTemplates", (row) => {
    const mapped = withId(row);
    return mapped ? own(mapped) : null;
  });

  prepare("habits", (row) => {
    const mapped = withId(row);
    return mapped ? own(mapped) : null;
  });

  prepare("workoutTemplates", (row) => {
    const mapped = withId(row);
    return mapped ? own(mapped) : null;
  });

  prepare("workouts", (row) => {
    const mapped = withId(row);
    if (!mapped) return null;
    mapped.templateId = inFile("workoutTemplates", row.templateId) ? map(row.templateId) : null;
    mapped.importBatchId = inFile("healthImportBatches", row.importBatchId)
      ? map(row.importBatchId)
      : null;
    return own(mapped);
  });

  prepare("workoutSets", (row) => {
    const mapped = withId(row);
    if (!mapped) return null;
    if (!inFile("workouts", row.workoutId)) return null; // dangling — refuse
    mapped.workoutId = map(row.workoutId);
    return mapped;
  });

  // Meals must exist before the schedule items that link to them — the
  // write order below follows real foreign keys, not the export order.
  prepare("meals", (row) => {
    const mapped = withId(row);
    return mapped ? own(mapped) : null;
  });

  prepare("mealEntries", (row) => {
    const mapped = withId(row);
    if (!mapped) return null;
    if (!inFile("meals", row.mealId)) return null;
    const food = typeof row.foodItemId === "string" ? foodIdMap.get(row.foodItemId) : undefined;
    if (!food) return null; // an entry must point at a food we actually have
    mapped.mealId = map(row.mealId);
    mapped.foodItemId = food;
    return mapped;
  });

  prepare("mealTemplates", (row) => {
    const mapped = withId(row);
    return mapped ? own(mapped) : null;
  });

  prepare("mealTemplateItems", (row) => {
    const mapped = withId(row);
    if (!mapped) return null;
    if (!inFile("mealTemplates", row.templateId)) return null;
    const food = typeof row.foodItemId === "string" ? foodIdMap.get(row.foodItemId) : undefined;
    if (!food) return null;
    mapped.templateId = map(row.templateId);
    mapped.foodItemId = food;
    return mapped;
  });

  prepare("scheduleItems", (row) => {
    const mapped = withId(row);
    if (!mapped) return null;
    mapped.habitId = inFile("habits", row.habitId) ? map(row.habitId) : null;
    mapped.workoutId = inFile("workouts", row.workoutId) ? map(row.workoutId) : null;
    mapped.mealId = inFile("meals", row.mealId) ? map(row.mealId) : null;
    mapped.templateId = inFile("scheduleTemplates", row.templateId) ? map(row.templateId) : null;
    mapped.seriesId = inFile("scheduleItems", row.seriesId) ? map(row.seriesId) : null;
    return own(mapped);
  });

  prepare("scheduleItemTags", (row) => {
    if (!inFile("scheduleItems", row.scheduleItemId) || !inFile("tags", row.tagId)) return null;
    return { scheduleItemId: map(row.scheduleItemId), tagId: map(row.tagId) };
  });

  prepare("habitLogs", (row) => {
    const mapped = withId(row);
    if (!mapped) return null;
    if (!inFile("habits", row.habitId)) return null;
    mapped.habitId = map(row.habitId);
    return own(mapped);
  });

  prepare("healthImportBatches", (row) => {
    const mapped = withId(row);
    return mapped ? own(mapped) : null;
  });

  prepare("healthMetrics", (row) => {
    const mapped = withId(row);
    if (!mapped) return null;
    mapped.batchId = inFile("healthImportBatches", row.batchId) ? map(row.batchId) : null;
    return own(mapped);
  });

  prepare("goals", (row) => {
    const mapped = withId(row);
    if (!mapped) return null;
    // A habit-sourced goal keeps its link only when that habit travelled in
    // the same file; a foreign id must never survive into this account.
    mapped.sourceRef = inFile("habits", row.sourceRef) ? map(row.sourceRef) : null;
    return own(mapped);
  });

  prepare("goalEntries", (row) => {
    const mapped = withId(row);
    if (!mapped) return null;
    if (!inFile("goals", row.goalId)) return null;
    mapped.goalId = map(row.goalId);
    return own(mapped);
  });

  const mapOwner = (row: Row): { ownerId: string } | null => {
    if (row.ownerType === "goal" && inFile("goals", row.ownerId)) {
      return { ownerId: map(row.ownerId)! };
    }
    if (row.ownerType === "habit" && inFile("habits", row.ownerId)) {
      return { ownerId: map(row.ownerId)! };
    }
    return null;
  };

  prepare("scheduleRules", (row) => {
    const mapped = withId(row);
    if (!mapped) return null;
    const owner = mapOwner(row);
    if (!owner) return null;
    mapped.ownerId = owner.ownerId;
    return own(mapped);
  });

  prepare("scheduleRuleDays", (row) => {
    if (!inFile("scheduleRules", row.ruleId)) return null;
    return { ...row, ruleId: map(row.ruleId) };
  });

  prepare("scheduleOverrides", (row) => {
    const mapped = withId(row);
    if (!mapped) return null;
    const owner = mapOwner(row);
    if (!owner) return null;
    mapped.ownerId = owner.ownerId;
    return own(mapped);
  });

  prepare("journalEntries", (row) => {
    const mapped = withId(row);
    return mapped ? own(mapped) : null;
  });

  prepare("reminders", (row) => {
    const mapped = withId(row);
    if (!mapped) return null;
    mapped.scheduleItemId = inFile("scheduleItems", row.scheduleItemId)
      ? map(row.scheduleItemId)
      : null;
    return own(mapped);
  });

  prepare("reminderDeliveries", (row) => {
    const mapped = withId(row);
    if (!mapped || typeof mapped.key !== "string") return null;
    // Delivery keys embed record ids (`habit:<id>:<date>`); remap the embedded
    // id so "already delivered" still means the right occurrence.
    const match = /^(habit|goal|reminder):([^:]+):(.*)$/.exec(mapped.key);
    if (match) {
      mapped.key = `${match[1]}:${remapId(userId, match[2])}:${match[3]}`;
    }
    return own(mapped);
  });

  prepare("favorites", (row) => {
    const mapped = withId(row);
    if (!mapped) return null;
    const kind = row.kind;
    if (kind === "food") {
      const food = typeof row.refId === "string" ? foodIdMap.get(row.refId) : undefined;
      if (!food) return null;
      mapped.refId = food;
    } else {
      const table =
        kind === "workout_template"
          ? ("workoutTemplates" as const)
          : kind === "meal_template"
            ? ("mealTemplates" as const)
            : kind === "schedule_template"
              ? ("scheduleTemplates" as const)
              : kind === "habit"
                ? ("habits" as const)
                : null;
      if (!table || !inFile(table, row.refId)) return null;
      mapped.refId = map(row.refId);
    }
    return own(mapped);
  });

  prepare("seedBatches", (row) => {
    const mapped = withId(row);
    return mapped ? own(mapped) : null;
  });

  const SEED_MODEL_TO_TABLE: Record<string, BackupTable> = Object.fromEntries(
    Object.entries(MODEL_BY_TABLE).map(([table, model]) => [model, table as BackupTable]),
  );
  prepare("seedRecords", (row) => {
    const mapped = withId(row);
    if (!mapped) return null;
    if (!inFile("seedBatches", row.batchId)) return null;
    const table = typeof row.model === "string" ? SEED_MODEL_TO_TABLE[row.model] : undefined;
    if (!table || !inFile(table, row.recordId)) return null;
    mapped.batchId = map(row.batchId);
    mapped.recordId =
      table === "foodItems" ? (foodIdMap.get(row.recordId as string) ?? null) : map(row.recordId);
    if (!mapped.recordId) return null;
    return mapped;
  });

  // ---- user profile ----------------------------------------------------------
  const users = Array.isArray(data.users) ? (data.users as Row[]) : [];
  const profileSource = users[0];
  let profileData: Row | null = null;
  if (profileSource && typeof profileSource === "object") {
    const userFields = new Map(scalarFieldsOf("User").map((f) => [f.name, f]));
    profileData = {};
    for (const key of SAFE_PROFILE_FIELDS) {
      const field = userFields.get(key);
      const value = profileSource[key];
      if (!field || value === undefined) continue;
      if (value === null) {
        if (!field.isRequired) profileData[key] = null;
        continue;
      }
      const expected =
        field.type === "String"
          ? "string"
          : field.type === "Boolean"
            ? "boolean"
            : field.type === "Int" || field.type === "Float"
              ? "number"
              : null;
      if (expected && typeof value === expected) profileData[key] = value;
    }
    if (Object.keys(profileData).length === 0) profileData = null;
  }

  // ---- the transaction -------------------------------------------------------
  const outcomes: TableOutcome[] = [];

  await prisma.$transaction(
    async (db) => {
      if (mode === "replace") {
        // Children before parents. Every delete is scoped to this user.
        await db.scheduleItemTag.deleteMany({ where: { scheduleItem: { userId } } });
        await db.mealEntry.deleteMany({ where: { meal: { userId } } });
        await db.mealTemplateItem.deleteMany({ where: { template: { userId } } });
        await db.workoutSet.deleteMany({ where: { workout: { userId } } });
        await db.scheduleItem.deleteMany({ where: { userId } });
        await db.meal.deleteMany({ where: { userId } });
        await db.mealTemplate.deleteMany({ where: { userId } });
        await db.workout.deleteMany({ where: { userId } });
        await db.workoutTemplate.deleteMany({ where: { userId } });
        await db.habitLog.deleteMany({ where: { userId } });
        await db.habit.deleteMany({ where: { userId } });
        await db.healthMetric.deleteMany({ where: { userId } });
        await db.healthImportBatch.deleteMany({ where: { userId } });
        await db.journalEntry.deleteMany({ where: { userId } });
        await db.reminder.deleteMany({ where: { userId } });
        await db.reminderDelivery.deleteMany({ where: { userId } });
        await db.favoriteItem.deleteMany({ where: { userId } });
        await db.goalEntry.deleteMany({ where: { userId } });
        await db.goal.deleteMany({ where: { userId } });
        await db.scheduleRuleDay.deleteMany({ where: { rule: { userId } } });
        await db.scheduleRule.deleteMany({ where: { userId } });
        await db.scheduleOverride.deleteMany({ where: { userId } });
        await db.seedRecord.deleteMany({ where: { batch: { userId } } });
        await db.seedBatch.deleteMany({ where: { userId } });
        await db.tag.deleteMany({ where: { userId } });
        await db.foodItem.deleteMany({ where: { userId } });
        await db.calendarDaySummary.deleteMany({ where: { userId } });
      }

      for (const { table, rows, inFile: fileCount, dropped, reusedShared } of prepared) {
        let created = 0;
        if (rows.length > 0) {
          if (table === "scheduleItems") {
            // Series children reference their parent row — parents first.
            const parents = rows.filter((row) => !row.seriesId);
            const children = rows.filter((row) => row.seriesId);
            const first = await db.scheduleItem.createMany({
              data: parents as never,
              skipDuplicates: true,
            });
            const second = children.length
              ? await db.scheduleItem.createMany({ data: children as never, skipDuplicates: true })
              : { count: 0 };
            created = first.count + second.count;
          } else {
            const delegate = db[
              (MODEL_BY_TABLE[table][0].toLowerCase() +
                MODEL_BY_TABLE[table].slice(1)) as "tag"
            ] as unknown as {
              createMany: (args: { data: unknown; skipDuplicates: boolean }) => Promise<{ count: number }>;
            };
            const result = await delegate.createMany({ data: rows, skipDuplicates: true });
            created = result.count;
          }
        }
        outcomes.push({
          table,
          inFile: fileCount,
          created,
          // "Skipped" = already present: duplicate rows within this account,
          // plus shared records the file resolved onto without touching.
          skipped: rows.length - created + (reusedShared ?? 0),
          dropped,
        });
      }

      if (profileData) {
        await db.user.update({ where: { id: userId }, data: profileData as never });
      }

      // A v1 backup carries no schedules. Anything that arrives without one
      // gets an every-day rule effective from its own start date — which is
      // exactly how it behaved in the version that wrote the file.
      await backfillMissingSchedules(db, userId);
    },
    { timeout: 300_000 },
  );

  const verification: Record<string, number> = {
    tags: await prisma.tag.count({ where: { userId } }),
    foodItems: await prisma.foodItem.count({ where: { userId } }),
    scheduleTemplates: await prisma.scheduleTemplate.count({ where: { userId } }),
    habits: await prisma.habit.count({ where: { userId } }),
    workoutTemplates: await prisma.workoutTemplate.count({ where: { userId } }),
    workouts: await prisma.workout.count({ where: { userId } }),
    workoutSets: await prisma.workoutSet.count({ where: { workout: { userId } } }),
    scheduleItems: await prisma.scheduleItem.count({ where: { userId } }),
    habitLogs: await prisma.habitLog.count({ where: { userId } }),
    meals: await prisma.meal.count({ where: { userId } }),
    mealEntries: await prisma.mealEntry.count({ where: { meal: { userId } } }),
    mealTemplates: await prisma.mealTemplate.count({ where: { userId } }),
    healthImportBatches: await prisma.healthImportBatch.count({ where: { userId } }),
    healthMetrics: await prisma.healthMetric.count({ where: { userId } }),
    goals: await prisma.goal.count({ where: { userId } }),
    goalEntries: await prisma.goalEntry.count({ where: { userId } }),
    scheduleRules: await prisma.scheduleRule.count({ where: { userId } }),
    scheduleOverrides: await prisma.scheduleOverride.count({ where: { userId } }),
    journalEntries: await prisma.journalEntry.count({ where: { userId } }),
    reminders: await prisma.reminder.count({ where: { userId } }),
    favorites: await prisma.favoriteItem.count({ where: { userId } }),
  };

  const report: ImportReport = {
    mode,
    importedAt: new Date().toISOString(),
    fileVersion: file.version,
    perTable: outcomes,
    totalCreated: outcomes.reduce((sum, o) => sum + o.created, 0),
    totalSkipped: outcomes.reduce((sum, o) => sum + o.skipped, 0),
    totalDropped: outcomes.reduce((sum, o) => sum + o.dropped, 0),
    profileApplied: profileData !== null,
    verification,
    warnings,
  };

  return { report };
}

type DbClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Give any goal or habit that arrived without a schedule an every-day rule.
 * Idempotent, and only ever *adds* — a record that already has a schedule is
 * left completely alone.
 */
export async function backfillMissingSchedules(db: DbClient, userId: string): Promise<void> {
  const [goals, habits, rules] = await Promise.all([
    db.goal.findMany({
      where: { userId },
      select: { id: true, startDate: true, createdAt: true, active: true, endDate: true },
    }),
    db.habit.findMany({
      where: { userId },
      select: { id: true, startDate: true, endDate: true, archived: true, timeOfDay: true },
    }),
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
