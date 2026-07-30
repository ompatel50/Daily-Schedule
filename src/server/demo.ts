import { prisma } from "@/lib/db";
import { type DayKey, shiftDay, toDayKey, today } from "@/lib/date";
import {
  DEMO_MODEL_ORDER,
  FUTURE_DAYS,
  HISTORY_DAYS,
  seedDemoData,
  type DemoModel,
} from "../../prisma/demo-data";
import { rebuildSummaries } from "@/server/summaries";

/**
 * Demo-data management. Every record the generator writes is registered in a
 * SeedBatch, so demo data is identifiable by relationship and removable as a
 * unit — anything the user made themselves is untouched by construction,
 * because it was never registered.
 */

export interface DemoStatus {
  /** The demo batch, if sample data is currently loaded. */
  batch: { id: string; label: string; createdAt: Date; recordCount: number } | null;
  /** Whether the user's tables are empty enough to offer a sample-data load. */
  canLoad: boolean;
  /** Rough count of user records that are NOT part of a demo batch. */
  realRecords: number;
}

/**
 * "Empty enough" means no user-visible records at all. The user row itself and
 * the bundled food table don't count — they exist before any choice is made.
 */
async function countUserRecords(userId: string): Promise<number> {
  const counts = await Promise.all([
    prisma.scheduleItem.count({ where: { userId } }),
    prisma.habit.count({ where: { userId } }),
    prisma.habitLog.count({ where: { userId } }),
    prisma.meal.count({ where: { userId } }),
    prisma.workout.count({ where: { userId } }),
    prisma.goal.count({ where: { userId } }),
    prisma.healthMetric.count({ where: { userId } }),
    prisma.journalEntry.count({ where: { userId } }),
    prisma.scheduleTemplate.count({ where: { userId } }),
    prisma.workoutTemplate.count({ where: { userId } }),
  ]);
  return counts.reduce((sum, count) => sum + count, 0);
}

export async function getDemoStatus(userId: string): Promise<DemoStatus> {
  const [batch, totalRecords] = await Promise.all([
    prisma.seedBatch.findFirst({
      where: { userId, kind: "demo" },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { records: true } } },
    }),
    countUserRecords(userId),
  ]);

  const demoCount = batch?._count.records ?? 0;
  return {
    batch: batch
      ? {
          id: batch.id,
          label: batch.label,
          createdAt: batch.createdAt,
          recordCount: demoCount,
        }
      : null,
    canLoad: batch === null && totalRecords === 0,
    // Registered demo rows span more models than countUserRecords samples, so
    // clamp rather than report a negative number.
    realRecords: Math.max(0, totalRecords - demoCount),
  };
}

/**
 * Load the sample dataset for an empty account. Refuses when anything already
 * exists — sample data is a starting point, not something to mix into a life
 * already being tracked — and refuses a second load outright, which is what
 * makes the action idempotent.
 */
export async function loadSampleData(
  userId: string,
): Promise<{ ok: true; records: number } | { ok: false; error: string }> {
  const status = await getDemoStatus(userId);
  if (status.batch) {
    return { ok: false, error: "Sample data is already loaded." };
  }
  if (!status.canLoad) {
    return {
      ok: false,
      error:
        "You already have records, so loading sample data is disabled — it would mix demo history into your own.",
    };
  }

  const counts = await seedDemoData(prisma, { userId });
  return { ok: true, records: counts.seedRecords };
}

export interface DemoRemovalPreview {
  batchId: string;
  recordCount: number;
  byModel: Array<{ model: string; count: number }>;
}

export async function previewDemoRemoval(userId: string): Promise<DemoRemovalPreview | null> {
  const batch = await prisma.seedBatch.findFirst({
    where: { userId, kind: "demo" },
    orderBy: { createdAt: "desc" },
  });
  if (!batch) return null;

  const groups = await prisma.seedRecord.groupBy({
    by: ["model"],
    where: { batchId: batch.id },
    _count: { _all: true },
  });
  return {
    batchId: batch.id,
    recordCount: groups.reduce((sum, group) => sum + group._count._all, 0),
    byModel: groups
      .map((group) => ({ model: group.model, count: group._count._all }))
      .sort((a, b) => b.count - a.count),
  };
}

const DELETE_BY_MODEL: Record<DemoModel, (ids: string[]) => Promise<unknown>> = {
  MealEntry: (ids) => prisma.mealEntry.deleteMany({ where: { id: { in: ids } } }),
  MealTemplateItem: (ids) => prisma.mealTemplateItem.deleteMany({ where: { id: { in: ids } } }),
  WorkoutSet: (ids) => prisma.workoutSet.deleteMany({ where: { id: { in: ids } } }),
  HabitLog: (ids) => prisma.habitLog.deleteMany({ where: { id: { in: ids } } }),
  GoalEntry: (ids) => prisma.goalEntry.deleteMany({ where: { id: { in: ids } } }),
  ScheduleItem: (ids) => prisma.scheduleItem.deleteMany({ where: { id: { in: ids } } }),
  Meal: (ids) => prisma.meal.deleteMany({ where: { id: { in: ids } } }),
  MealTemplate: (ids) => prisma.mealTemplate.deleteMany({ where: { id: { in: ids } } }),
  Workout: (ids) => prisma.workout.deleteMany({ where: { id: { in: ids } } }),
  WorkoutTemplate: (ids) => prisma.workoutTemplate.deleteMany({ where: { id: { in: ids } } }),
  ScheduleTemplate: (ids) => prisma.scheduleTemplate.deleteMany({ where: { id: { in: ids } } }),
  Habit: (ids) => prisma.habit.deleteMany({ where: { id: { in: ids } } }),
  Goal: (ids) => prisma.goal.deleteMany({ where: { id: { in: ids } } }),
  ScheduleRule: (ids) => prisma.scheduleRule.deleteMany({ where: { id: { in: ids } } }),
  ScheduleOverride: (ids) => prisma.scheduleOverride.deleteMany({ where: { id: { in: ids } } }),
  HealthMetric: (ids) => prisma.healthMetric.deleteMany({ where: { id: { in: ids } } }),
  JournalEntry: (ids) => prisma.journalEntry.deleteMany({ where: { id: { in: ids } } }),
  Reminder: (ids) => prisma.reminder.deleteMany({ where: { id: { in: ids } } }),
  FavoriteItem: (ids) => prisma.favoriteItem.deleteMany({ where: { id: { in: ids } } }),
  Tag: (ids) => prisma.tag.deleteMany({ where: { id: { in: ids } } }),
};

/**
 * Remove exactly the records the demo batch registered — children before
 * parents, chunked, and only ever by recorded id, so records the user created
 * (or imported) since are untouchable by construction. Afterwards every
 * derived day summary in the demo span is recomputed through the same central
 * path every other write uses.
 */
export async function removeDemoData(
  userId: string,
): Promise<{ ok: true; removed: number } | { ok: false; error: string }> {
  const batch = await prisma.seedBatch.findFirst({
    where: { userId, kind: "demo" },
    orderBy: { createdAt: "desc" },
  });
  if (!batch) return { ok: false, error: "No sample data is loaded." };

  const records = await prisma.seedRecord.findMany({
    where: { batchId: batch.id },
    select: { model: true, recordId: true },
  });
  const byModel = new Map<string, string[]>();
  for (const record of records) {
    const list = byModel.get(record.model);
    if (list) list.push(record.recordId);
    else byModel.set(record.model, [record.recordId]);
  }

  let removed = 0;
  for (const model of DEMO_MODEL_ORDER) {
    const ids = byModel.get(model);
    if (!ids || ids.length === 0) continue;
    for (let index = 0; index < ids.length; index += 500) {
      const chunk = ids.slice(index, index + 500);
      await DELETE_BY_MODEL[model](chunk);
    }
    removed += ids.length;
  }

  // The batch (and, by cascade, its records) goes last, so a crash mid-way
  // leaves the remainder still registered and removal simply re-runnable.
  await prisma.seedBatch.delete({ where: { id: batch.id } });

  // The demo span is anchored on when the batch was seeded, not on today —
  // removing months-old sample data must recompute the days it actually wrote.
  const anchor = toDayKey(batch.createdAt);
  const from = shiftDay(anchor, -(HISTORY_DAYS + 7)) as DayKey;
  const seedEnd = shiftDay(anchor, FUTURE_DAYS + 7) as DayKey;
  const now = today();
  await rebuildSummaries(userId, from, seedEnd > now ? seedEnd : now);

  return { ok: true, removed };
}
