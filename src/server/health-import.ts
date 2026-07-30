import { prisma } from "@/lib/db";
import type { DayKey } from "@/lib/date";
import { HEALTH_METRIC_META, type HealthMetricType } from "@/lib/enums";
import { WORKOUTS_CATEGORY } from "@/lib/logic/health-import/rollup";
import { isLikelyDuplicateWorkout } from "@/lib/logic/health-import/workout-dup";
import type {
  ImportKind,
  ImportPlan,
  NormalizedHealthRow,
  RawWorkout,
} from "@/lib/logic/health-import/types";
import { assembleValidatedPlan } from "@/server/health-import-session";
import { rebuildSummariesForDates } from "@/server/summaries";

/**
 * The staged import workflow — hosted edition.
 *
 *   parse:    happens in the BROWSER (a Web Worker); the raw export never
 *             leaves the user's device. Normalised rows arrive in bounded,
 *             sequence-numbered chunks (src/server/health-import-session.ts).
 *   preview:  `finalizeStagedPreview` revalidates every uploaded row,
 *             recomputes fingerprints, compares against what is already
 *             stored, and stages the validated plan on the session row.
 *             NOTHING is written to the health tables, so cancelling is free.
 *   confirm:  load the staged plan, filter to the chosen categories, write in
 *             one transaction, record the batch, delete the session,
 *             recompute the affected days.
 *   cancel:   delete the session (and its staged data) — owner-checked.
 *
 * Privacy: only normalised rows are ever staged, in the user's own database
 * rows, deleted on confirm/cancel and expired after two hours. No raw export
 * is retained anywhere server-side, nothing in this pipeline performs a
 * network request, and no row contents are logged.
 */

const CHUNK = 400;

interface StagedImport {
  userId: string;
  fileName: string;
  fileSize: number;
  fileType: "xml" | "zip" | "csv";
  createdAt: string;
  plan: ImportPlan;
  /** Apple workout externalIds that already exist — skipped on confirm. */
  exactWorkoutDupes: string[];
  /** externalIds that look like an existing manual workout — skipped + reported. */
  potentialWorkoutDupes: string[];
}

// --- preview ----------------------------------------------------------------

export interface CategoryPreview {
  key: string;
  label: string;
  records: number;
  rows: number;
  dateFrom: string | null;
  dateTo: string | null;
  newRows: number;
  updatedRows: number;
  unchangedRows: number;
  sample: Array<{
    date: string;
    value: number;
    unit: string;
    subtype: string | null;
    source: string;
    sourceApp: string | null;
  }>;
}

export interface ImportPreviewResult {
  token: string;
  kind: ImportKind;
  fileName: string;
  fileType: "xml" | "zip" | "csv";
  fileSize: number;
  dateFrom: string | null;
  dateTo: string | null;
  examined: number;
  invalid: number;
  totalRows: number;
  unsupported: Array<{ type: string; count: number }>;
  warnings: string[];
  categories: CategoryPreview[];
}

function categoryLabel(key: string): string {
  if (key === WORKOUTS_CATEGORY) return "Workouts";
  return HEALTH_METRIC_META[key as HealthMetricType]?.label ?? key;
}

async function chunked<T, R>(items: T[], size: number, run: (chunk: T[]) => Promise<R[]>): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += size) {
    results.push(...(await run(items.slice(index, index + size))));
  }
  return results;
}

/**
 * Turn a fully-uploaded session into a staged, previewable import. Runs the
 * server-side revalidation (see health-import-session.ts), the duplicate
 * detection against what is already stored, and persists the validated plan
 * on the session row — the chunks are deleted once folded in.
 */
export async function finalizeStagedPreview(
  userId: string,
  sessionId: string,
): Promise<{ ok: true; preview: ImportPreviewResult } | { ok: false; error: string }> {
  const assembled = await assembleValidatedPlan(userId, sessionId);
  if (!assembled.ok) return assembled;

  const { session, plan, rejected } = assembled;
  if (plan.rows.length === 0 && plan.workouts.length === 0) {
    await discardStaged(userId, sessionId);
    return { ok: false, error: "Nothing importable was found in the file." };
  }

  // --- duplicate detection against what's already stored ---------------------
  const fingerprints = plan.rows.map((row) => row.fingerprint);
  const existing = await chunked(fingerprints, CHUNK, (chunk) =>
    prisma.healthMetric.findMany({
      where: { userId, fingerprint: { in: chunk } },
      select: { fingerprint: true, value: true },
    }),
  );
  const existingByFp = new Map(existing.map((row) => [row.fingerprint as string, row.value]));

  const workoutDupes = await findWorkoutDuplicates(userId, plan.workouts);

  const categories: CategoryPreview[] = plan.categories.map((category) => {
    const rows = plan.rows.filter((row) => row.type === category.key);
    let newRows = 0;
    let updatedRows = 0;
    let unchangedRows = 0;
    for (const row of rows) {
      const current = existingByFp.get(row.fingerprint);
      if (current === undefined) newRows += 1;
      else if (Math.abs(current - row.value) < 1e-6) unchangedRows += 1;
      else updatedRows += 1;
    }
    if (category.key === WORKOUTS_CATEGORY) {
      newRows =
        plan.workouts.length -
        workoutDupes.exact.length -
        workoutDupes.potential.length;
      unchangedRows = workoutDupes.exact.length + workoutDupes.potential.length;
    }
    return {
      key: category.key,
      label: categoryLabel(category.key),
      records: category.records,
      rows: category.rows,
      dateFrom: category.dateFrom,
      dateTo: category.dateTo,
      newRows,
      updatedRows,
      unchangedRows,
      sample: rows.slice(0, 5).map((row) => ({
        date: row.date,
        value: row.value,
        unit: row.unit,
        subtype: row.subtype,
        source: row.source,
        sourceApp: row.sourceApp,
      })),
    };
  });

  const warnings = [...plan.warnings];
  if (rejected > 0) {
    warnings.push(`${rejected} row${rejected === 1 ? "" : "s"} failed server-side validation and will not be imported.`);
  }
  if (workoutDupes.potential.length > 0) {
    warnings.push(
      `${workoutDupes.potential.length} imported workout${workoutDupes.potential.length === 1 ? "" : "s"} ` +
        "look like workouts you already logged here (same day, similar time and length). " +
        "They will be skipped rather than merged — your own records stay untouched.",
    );
  }

  const staged: StagedImport = {
    userId,
    fileName: session.fileName,
    fileSize: session.fileSize ?? 0,
    fileType: session.fileType as "xml" | "zip" | "csv",
    createdAt: new Date().toISOString(),
    plan,
    exactWorkoutDupes: workoutDupes.exact,
    potentialWorkoutDupes: workoutDupes.potential,
  };

  await prisma.$transaction([
    prisma.healthImportSession.update({
      where: { id: sessionId },
      data: { status: "staged", stagedPlan: JSON.stringify(staged) },
    }),
    // The chunks have been folded into the staged plan — free the space.
    prisma.healthImportChunk.deleteMany({ where: { sessionId } }),
  ]);

  return {
    ok: true,
    preview: {
      token: sessionId,
      kind: plan.kind,
      fileName: session.fileName,
      fileType: session.fileType as "xml" | "zip" | "csv",
      fileSize: session.fileSize ?? 0,
      dateFrom: plan.dateFrom,
      dateTo: plan.dateTo,
      examined: plan.examined,
      invalid: plan.invalid,
      totalRows: plan.rows.length + plan.workouts.length,
      unsupported: Object.entries(plan.unsupported)
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count),
      warnings,
      categories,
    },
  };
}

/** Delete a staged/uploading session — only the owner's, cancelling twice is fine. */
export async function discardStaged(userId: string, token: string): Promise<void> {
  await prisma.healthImportSession.deleteMany({ where: { id: token, userId } });
}

/** Load the owner's staged plan, or null when it expired or is not theirs. */
async function loadStaged(userId: string, token: string): Promise<StagedImport | null> {
  const session = await prisma.healthImportSession.findFirst({
    where: { id: token, userId, status: "staged", expiresAt: { gt: new Date() } },
    select: { stagedPlan: true },
  });
  if (!session?.stagedPlan) return null;
  try {
    const staged = JSON.parse(session.stagedPlan) as StagedImport;
    return staged.userId === userId ? staged : null;
  } catch {
    return null;
  }
}

/**
 * Workout duplicate detection.
 *
 * Exact: the same Apple export row is already in the database (same
 * externalId). Potential: a workout the user logged themselves on the same day
 * whose time and duration are close enough that this is probably the same
 * training. Neither is imported; the potential case is reported, because
 * silently merging or deleting the user's own record is never acceptable.
 */
async function findWorkoutDuplicates(
  userId: string,
  workouts: RawWorkout[],
): Promise<{ exact: string[]; potential: string[] }> {
  if (workouts.length === 0) return { exact: [], potential: [] };

  const ids = workouts.map((workout) => workout.externalId);
  const existingRows = await chunked(ids, CHUNK, (chunk) =>
    prisma.workout.findMany({
      where: { userId, source: "apple_health", externalId: { in: chunk } },
      select: { externalId: true },
    }),
  );
  const exact = new Set(existingRows.map((row) => row.externalId as string));

  const dates = [...new Set(workouts.map((workout) => workout.date))];
  const sameDay = await chunked(dates, CHUNK, (chunk) =>
    prisma.workout.findMany({
      where: { userId, date: { in: chunk }, source: { not: "apple_health" } },
      select: { date: true, time: true, durationMin: true },
    }),
  );
  const byDate = new Map<string, typeof sameDay>();
  for (const row of sameDay) {
    const group = byDate.get(row.date);
    if (group) group.push(row);
    else byDate.set(row.date, [row]);
  }

  const potential: string[] = [];
  for (const workout of workouts) {
    if (exact.has(workout.externalId)) continue;
    const candidates = byDate.get(workout.date) ?? [];
    if (candidates.some((candidate) => isLikelyDuplicateWorkout(candidate, workout))) {
      potential.push(workout.externalId);
    }
  }

  return { exact: [...exact], potential };
}

// --- confirm ----------------------------------------------------------------

export interface ImportOutcome {
  batchId: string;
  imported: number;
  updated: number;
  duplicates: number;
  invalid: number;
  skippedTypes: number;
  workoutsImported: number;
  workoutsSkipped: number;
  dateFrom: string | null;
  dateTo: string | null;
  recomputedDays: number;
}

export async function confirmHealthImport(
  userId: string,
  token: string,
  selectedCategories: string[],
): Promise<{ ok: true; outcome: ImportOutcome } | { ok: false; error: string }> {
  const staged = await loadStaged(userId, token);
  if (!staged) {
    return {
      ok: false,
      error: "This import session has expired — nothing was written. Upload the file again.",
    };
  }

  const selected = new Set(selectedCategories);
  const rows = staged.plan.rows.filter((row) => selected.has(row.type));
  const includeWorkouts = selected.has(WORKOUTS_CATEGORY);
  const skipIds = new Set([...staged.exactWorkoutDupes, ...staged.potentialWorkoutDupes]);
  const workouts = includeWorkouts
    ? staged.plan.workouts.filter((workout) => !skipIds.has(workout.externalId))
    : [];

  if (rows.length === 0 && workouts.length === 0) {
    await discardStaged(userId, token);
    return { ok: false, error: "Nothing was selected, so nothing was imported." };
  }

  const dates = [...rows.map((row) => row.date), ...workouts.map((workout) => workout.date)].sort();
  const dateFrom = (dates[0] as DayKey) ?? null;
  const dateTo = (dates[dates.length - 1] as DayKey) ?? null;

  const warningsJson = JSON.stringify(staged.plan.warnings.slice(0, 40));
  const skippedTypes = Object.values(staged.plan.unsupported).reduce((sum, count) => sum + count, 0);

  let outcome: ImportOutcome;
  try {
    outcome = await prisma.$transaction(
      async (tx) => {
        const batch = await tx.healthImportBatch.create({
          data: {
            userId,
            source: staged.plan.kind,
            fileType: staged.fileType,
            fileName: staged.fileName,
            fileSize: staged.fileSize,
            status: "completed",
            dateFrom,
            dateTo,
            categories: JSON.stringify([...selected].sort()),
            examined: staged.plan.examined,
            skipped: skippedTypes,
            invalid: staged.plan.invalid,
            warnings: warningsJson,
          },
        });

        // Which fingerprints already exist decides create vs update vs no-op.
        const existing = new Map<string, { id: string; value: number }>();
        for (let index = 0; index < rows.length; index += CHUNK) {
          const chunk = rows.slice(index, index + CHUNK);
          const found = await tx.healthMetric.findMany({
            where: { userId, fingerprint: { in: chunk.map((row) => row.fingerprint) } },
            select: { id: true, fingerprint: true, value: true },
          });
          for (const row of found) existing.set(row.fingerprint as string, row);
        }

        const toCreate: NormalizedHealthRow[] = [];
        const toUpdate: Array<{ id: string; row: NormalizedHealthRow }> = [];
        let duplicates = 0;
        for (const row of rows) {
          const current = existing.get(row.fingerprint);
          if (!current) toCreate.push(row);
          else if (Math.abs(current.value - row.value) < 1e-6) duplicates += 1;
          else toUpdate.push({ id: current.id, row });
        }

        for (let index = 0; index < toCreate.length; index += CHUNK) {
          await tx.healthMetric.createMany({
            data: toCreate.slice(index, index + CHUNK).map((row) => ({
              userId,
              batchId: batch.id,
              type: row.type,
              subtype: row.subtype,
              value: row.value,
              unit: row.unit,
              minValue: row.minValue,
              maxValue: row.maxValue,
              date: row.date,
              startAt: row.startAt ? new Date(row.startAt) : null,
              endAt: row.endAt ? new Date(row.endAt) : null,
              recordedAt: row.startAt ? new Date(row.startAt) : null,
              source: row.source,
              sourceApp: row.sourceApp,
              sourceDevice: row.sourceDevice,
              externalId: row.externalId,
              notes: row.notes,
              sampleCount: row.sampleCount,
              fingerprint: row.fingerprint,
            })),
          });
        }

        // A re-import found a fuller value for a row it wrote before (a later
        // Apple export contains the rest of the day). The fingerprint is the
        // identity; the value moves to the newer, more complete number.
        for (const { id, row } of toUpdate) {
          await tx.healthMetric.update({
            where: { id },
            data: {
              value: row.value,
              minValue: row.minValue,
              maxValue: row.maxValue,
              startAt: row.startAt ? new Date(row.startAt) : null,
              endAt: row.endAt ? new Date(row.endAt) : null,
              sampleCount: row.sampleCount,
              batchId: batch.id,
            },
          });
        }

        let workoutsImported = 0;
        for (const workout of workouts) {
          await tx.workout.create({
            data: {
              userId,
              date: workout.date,
              time: workout.time,
              name: workout.name,
              type: workout.type,
              durationMin: workout.durationMin,
              distanceKm: workout.distanceKm,
              caloriesBurned: workout.caloriesBurned,
              status: "completed",
              startedAt: new Date(workout.startAt),
              completedAt: new Date(workout.endAt),
              source: "apple_health",
              externalId: workout.externalId,
              importBatchId: batch.id,
            },
          });
          workoutsImported += 1;
        }

        const workoutsSkipped = includeWorkouts
          ? staged.plan.workouts.length - workoutsImported
          : 0;

        await tx.healthImportBatch.update({
          where: { id: batch.id },
          data: {
            imported: toCreate.length,
            updated: toUpdate.length,
            duplicates,
            workoutsImported,
            workoutsSkipped,
          },
        });

        return {
          batchId: batch.id,
          imported: toCreate.length,
          updated: toUpdate.length,
          duplicates,
          invalid: staged.plan.invalid,
          skippedTypes,
          workoutsImported,
          workoutsSkipped,
          dateFrom,
          dateTo,
          recomputedDays: 0,
        };
      },
      { timeout: 120_000 },
    );
  } catch (error) {
    // The transaction rolled back: no metric, workout or batch row survives.
    // Record the failure as its own batch so the history shows what happened.
    await prisma.healthImportBatch
      .create({
        data: {
          userId,
          source: staged.plan.kind,
          fileType: staged.fileType,
          fileName: staged.fileName,
          fileSize: staged.fileSize,
          status: "failed",
          error: error instanceof Error ? error.message.slice(0, 500) : "Unknown error",
          dateFrom,
          dateTo,
          categories: JSON.stringify([...selected].sort()),
          examined: staged.plan.examined,
        },
      })
      .catch(() => {});
    // The staged file is kept so the user can retry without re-uploading.
    return {
      ok: false,
      error:
        "The import failed and was rolled back — nothing was written. " +
        "Your existing records are untouched. You can retry the import.",
    };
  }

  await discardStaged(userId, token);

  // Rebuild exactly the days that received data (each widened to its week),
  // not the whole first-to-last span — the difference between seconds and
  // minutes on a sparse multi-year import.
  const touched = new Set<DayKey>([
    ...rows.map((row) => row.date),
    ...workouts.map((workout) => workout.date),
  ]);
  outcome.recomputedDays = await rebuildSummariesForDates(userId, touched);

  return { ok: true, outcome };
}

// --- batch history & removal ------------------------------------------------

export async function listImportBatches(userId: string) {
  const batches = await prisma.healthImportBatch.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return batches.map((batch) => ({
    ...batch,
    categoriesList: safeJsonArray(batch.categories),
    warningsList: safeJsonArray(batch.warnings),
  }));
}

function safeJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export interface BatchRemovalPreview {
  batchId: string;
  fileName: string;
  metricCount: number;
  workoutCount: number;
  categories: Array<{ type: string; count: number }>;
  dateFrom: string | null;
  dateTo: string | null;
}

/** What removal would delete — shown before the confirmation. */
export async function previewBatchRemoval(
  userId: string,
  batchId: string,
): Promise<BatchRemovalPreview | null> {
  const batch = await prisma.healthImportBatch.findFirst({ where: { id: batchId, userId } });
  if (!batch || batch.status === "removed") return null;

  const [byType, workoutCount] = await Promise.all([
    prisma.healthMetric.groupBy({
      by: ["type"],
      where: { batchId },
      _count: { _all: true },
    }),
    prisma.workout.count({ where: { importBatchId: batchId } }),
  ]);

  return {
    batchId,
    fileName: batch.fileName,
    metricCount: byType.reduce((sum, group) => sum + group._count._all, 0),
    workoutCount,
    categories: byType
      .map((group) => ({ type: group.type, count: group._count._all }))
      .sort((a, b) => b.count - a.count),
    dateFrom: batch.dateFrom,
    dateTo: batch.dateTo,
  };
}

/**
 * Remove one batch's records — and only that batch's. Manual entries and other
 * batches are untouched by construction (the delete is keyed on batchId), and
 * every derived number is recomputed afterwards through the same central path
 * every other write uses.
 */
export async function removeImportBatch(
  userId: string,
  batchId: string,
): Promise<{ ok: true; removedMetrics: number; removedWorkouts: number } | { ok: false; error: string }> {
  const batch = await prisma.healthImportBatch.findFirst({ where: { id: batchId, userId } });
  if (!batch) return { ok: false, error: "Import batch not found." };
  if (batch.status === "removed") return { ok: false, error: "This batch was already removed." };

  // Collect the exact days the removal will change before deleting.
  const touchedDates = new Set<DayKey>([
    ...(await prisma.healthMetric.findMany({
      where: { batchId, userId },
      select: { date: true },
      distinct: ["date"],
    })).map((row) => row.date as DayKey),
    ...(await prisma.workout.findMany({
      where: { importBatchId: batchId, userId },
      select: { date: true },
      distinct: ["date"],
    })).map((row) => row.date as DayKey),
  ]);

  const [removedMetrics, removedWorkouts] = await prisma.$transaction(async (tx) => {
    const metrics = await tx.healthMetric.deleteMany({ where: { batchId, userId } });
    const workouts = await tx.workout.deleteMany({ where: { importBatchId: batchId, userId } });
    await tx.healthImportBatch.update({
      where: { id: batchId },
      data: { status: "removed", removedAt: new Date() },
    });
    return [metrics.count, workouts.count];
  });

  await rebuildSummariesForDates(userId, touchedDates);

  return { ok: true, removedMetrics, removedWorkouts };
}
