import "server-only";

import { prisma } from "@/lib/db";
import { type DayKey, shiftDay } from "@/lib/date";
import {
  HEALTH_METRIC_META,
  HEALTH_RECORD_KIND_META,
  type HealthMetricType,
  type HealthRecordKind,
} from "@/lib/enums";
import type { RawHealthRecord } from "@/lib/logic/health-import/apple-stream";
import { RECORDS_CATEGORY, WORKOUTS_CATEGORY } from "@/lib/logic/health-import/rollup";
import type {
  ImportKind,
  ImportPlan,
  NormalizedHealthRow,
  RawWorkout,
} from "@/lib/logic/health-import/types";
import { isLikelyDuplicateWorkout } from "@/lib/logic/health-import/workout-dup";
import {
  countMerge,
  decideMerge,
  protectedSummary,
  totalProtected,
  type BatchBoundaries,
  type MergeCounts,
  type StoredRow,
} from "@/lib/logic/health-import/merge";
import { classifyHealthUndoRow, planHealthUndo } from "@/lib/logic/health-import/undo";
import { IMPORT_FORMAT_VERSION } from "@/lib/logic/health-import/version";
import { logRedactedError } from "@/server/safe-error";
import { rebuildSummariesForDates } from "@/server/summaries";

/**
 * The staged health import.
 *
 *   upload:  the file is streamed to a temporary path by the route handler and
 *            parsed HERE, on the server (src/server/apple-health). Nothing the
 *            browser says about the file's contents is trusted, because the
 *            browser never reads it.
 *   stage:   the parsed plan is written into the session's chunk rows in
 *            bounded batches, so a decade-long export is staged without ever
 *            holding a 60 MB JSON blob in a column or in memory. The session
 *            row keeps only the summary the preview renders.
 *   preview: counts, categories, date span, and what is already present —
 *            NOTHING is written to the health tables, so cancelling is free.
 *   confirm: replay the staged chunks, filter to the chosen categories, write
 *            in one transaction, record the batch, delete the session,
 *            recompute exactly the days that changed.
 *   cancel:  delete the session (and its staged rows) — owner-checked.
 *   undo:    remove what a batch wrote and still owns, keeping anything the
 *            user has since edited or built on.
 *
 * Ownership is structural: the session id is server-generated and every query
 * in this module is scoped by `userId`, so no request can name another
 * account's session or batch. Sessions expire after two hours and are swept
 * on the next creation.
 */

/** Rows per database round trip. */
const CHUNK = 500;
/** Rows per staged chunk row. */
const STAGE_CHUNK = 2_000;
export const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
/** Concurrent staged imports one account may hold. */
const MAX_ACTIVE_SESSIONS = 3;

// --- the staged summary -------------------------------------------------------

/**
 * What the session row holds between staging and confirming. Deliberately
 * only counts and metadata: the rows themselves live in the chunk table.
 */
interface StagedSummary {
  userId: string;
  kind: ImportKind;
  fileName: string;
  fileSize: number;
  fileType: "xml" | "zip" | "csv";
  startedAt: string;
  parseMs: number;
  xmlBytes: number;
  ignoredFiles: string[];
  errors: string[];
  truncated: boolean;
  categories: CategoryPreview[];
  dateFrom: string | null;
  dateTo: string | null;
  examined: number;
  invalid: number;
  totalRows: number;
  totalWorkouts: number;
  totalRecords: number;
  unsupported: Array<{ type: string; count: number }>;
  warnings: string[];
  /** Apple workout externalIds that already exist — skipped on confirm. */
  exactWorkoutDupes: string[];
  /** externalIds that look like an existing manual workout — skipped + reported. */
  potentialWorkoutDupes: string[];
}

export interface CategoryPreview {
  key: string;
  label: string;
  records: number;
  rows: number;
  dateFrom: string | null;
  dateTo: string | null;
  newRows: number;
  /** Rows an existing reading will be merged with — the file's value wins. */
  updatedRows: number;
  unchangedRows: number;
  /** Rows this import will leave alone because they are no longer its to change. */
  protectedRows: number;
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
  parseMs: number;
  xmlBytes: number;
  truncated: boolean;
  unsupported: Array<{ type: string; count: number }>;
  warnings: string[];
  errors: string[];
  ignoredFiles: string[];
  categories: CategoryPreview[];
}

function categoryLabel(key: string): string {
  if (key === WORKOUTS_CATEGORY) return "Workouts";
  if (key === RECORDS_CATEGORY) return "Health records";
  return HEALTH_METRIC_META[key as HealthMetricType]?.label ?? key;
}

async function chunked<T, R>(items: T[], size: number, run: (chunk: T[]) => Promise<R[]>): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += size) {
    results.push(...(await run(items.slice(index, index + size))));
  }
  return results;
}

// --- staging ------------------------------------------------------------------

async function sweepExpiredSessions(): Promise<void> {
  await prisma.healthImportSession
    .deleteMany({ where: { expiresAt: { lt: new Date() } } })
    .catch(() => {});
}

export interface StageInput {
  kind: ImportKind;
  fileType: "xml" | "zip" | "csv";
  fileName: string;
  fileSize: number;
  plan: ImportPlan;
  parseMs: number;
  xmlBytes: number;
  ignoredFiles: string[];
  errors: string[];
}

/**
 * Turn a freshly parsed plan into a staged, previewable import. Runs the
 * duplicate detection against what is already stored and writes the rows into
 * the session's chunks. Nothing reaches the health tables here.
 */
export async function stageImport(
  userId: string,
  input: StageInput,
): Promise<{ ok: true; preview: ImportPreviewResult } | { ok: false; error: string }> {
  const { plan } = input;
  if (plan.rows.length === 0 && plan.workouts.length === 0 && plan.records.length === 0) {
    return { ok: false, error: "Nothing importable was found in the file." };
  }

  await sweepExpiredSessions();
  const active = await prisma.healthImportSession.count({
    where: { userId, expiresAt: { gt: new Date() } },
  });
  if (active >= MAX_ACTIVE_SESSIONS) {
    return {
      ok: false,
      error: "Too many imports are waiting to be confirmed — finish or cancel one first.",
    };
  }

  // Base filename only — never a path from the user's machine.
  const fileName = (input.fileName.split(/[\\/]/).pop() ?? "import").slice(0, 200);

  const [existingByFp, workoutDupes, existingRecords] = await Promise.all([
    findExistingFingerprints(userId, plan),
    findWorkoutDuplicates(userId, plan.workouts),
    findExistingRecordFingerprints(userId, plan.records),
  ]);
  const boundaries = await loadBatchBoundaries(userId, existingByFp.values());

  // The same decision the confirm step will make, made now so the preview can
  // promise it. Nothing here writes; this is the whole point of the preview.
  const totals: MergeCounts = {
    create: 0,
    merge: 0,
    unchanged: 0,
    protectedEdited: 0,
    protectedForeign: 0,
  };

  const categories: CategoryPreview[] = plan.categories.map((category) => {
    const rows = plan.rows.filter((row) => row.type === category.key);
    let newRows = 0;
    let updatedRows = 0;
    let unchangedRows = 0;
    let protectedRows = 0;
    for (const row of rows) {
      const outcome = decideMerge(row, existingByFp.get(row.fingerprint), boundaries);
      countMerge(outcome, totals);
      if (outcome.decision === "create") newRows += 1;
      else if (outcome.decision === "merge") updatedRows += 1;
      else if (outcome.decision === "unchanged") unchangedRows += 1;
      else protectedRows += 1;
    }
    if (category.key === WORKOUTS_CATEGORY) {
      unchangedRows = workoutDupes.exact.length + workoutDupes.potential.length;
      newRows = plan.workouts.length - unchangedRows;
      protectedRows = 0;
    }
    if (category.key === RECORDS_CATEGORY) {
      unchangedRows = plan.records.filter((record) => existingRecords.has(record.fingerprint)).length;
      newRows = plan.records.length - unchangedRows;
      protectedRows = 0;
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
      protectedRows,
      sample: sampleFor(category.key, plan, rows),
    };
  });

  const warnings = [...plan.warnings];
  if (workoutDupes.potential.length > 0) {
    warnings.push(
      `${workoutDupes.potential.length} imported workout${workoutDupes.potential.length === 1 ? "" : "s"} ` +
        "look like workouts you already logged here (same day, similar time and length). " +
        "They will be skipped rather than merged — your own records stay untouched.",
    );
  }
  // Said plainly and up front: a skip the user is not told about is
  // indistinguishable from data loss.
  const protectedNote = protectedSummary(totals);
  if (protectedNote) warnings.push(protectedNote);

  const summary: StagedSummary = {
    userId,
    kind: plan.kind,
    fileName,
    fileSize: input.fileSize,
    fileType: input.fileType,
    startedAt: new Date(Date.now() - input.parseMs).toISOString(),
    parseMs: input.parseMs,
    xmlBytes: input.xmlBytes,
    ignoredFiles: input.ignoredFiles.slice(0, 20),
    errors: input.errors.slice(0, 40),
    truncated: plan.truncated,
    categories,
    dateFrom: plan.dateFrom,
    dateTo: plan.dateTo,
    examined: plan.examined,
    invalid: plan.invalid,
    totalRows: plan.rows.length,
    totalWorkouts: plan.workouts.length,
    totalRecords: plan.records.length,
    unsupported: Object.entries(plan.unsupported)
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 200),
    warnings: warnings.slice(0, 40),
    exactWorkoutDupes: workoutDupes.exact,
    potentialWorkoutDupes: workoutDupes.potential,
  };

  const session = await prisma.healthImportSession.create({
    data: {
      userId,
      status: "staged",
      source: plan.kind,
      fileType: input.fileType,
      fileName,
      fileSize: input.fileSize,
      examined: plan.examined,
      invalid: plan.invalid,
      unsupported: JSON.stringify(summary.unsupported),
      warnings: JSON.stringify(summary.warnings),
      stagedPlan: JSON.stringify(summary),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });

  try {
    await writeStagedChunks(session.id, plan);
  } catch (error) {
    await prisma.healthImportSession.deleteMany({ where: { id: session.id, userId } });
    throw error;
  }

  return {
    ok: true,
    preview: {
      token: session.id,
      kind: plan.kind,
      fileName,
      fileType: input.fileType,
      fileSize: input.fileSize,
      dateFrom: plan.dateFrom,
      dateTo: plan.dateTo,
      examined: plan.examined,
      invalid: plan.invalid,
      totalRows: plan.rows.length + plan.workouts.length + plan.records.length,
      parseMs: input.parseMs,
      xmlBytes: input.xmlBytes,
      truncated: plan.truncated,
      unsupported: summary.unsupported,
      warnings: summary.warnings,
      errors: summary.errors,
      ignoredFiles: summary.ignoredFiles,
      categories,
    },
  };
}

function sampleFor(
  key: string,
  plan: ImportPlan,
  rows: NormalizedHealthRow[],
): CategoryPreview["sample"] {
  if (key === WORKOUTS_CATEGORY) {
    return plan.workouts.slice(0, 5).map((workout) => ({
      date: workout.date,
      value: workout.durationMin,
      unit: "min",
      subtype: workout.name,
      source: "apple_health",
      sourceApp: workout.sourceApp,
    }));
  }
  if (key === RECORDS_CATEGORY) {
    return plan.records.slice(0, 5).map((record) => ({
      date: record.date,
      value: record.value ?? 0,
      unit: record.unit,
      subtype: record.title,
      source: "apple_health",
      sourceApp: record.sourceApp,
    }));
  }
  return rows.slice(0, 5).map((row) => ({
    date: row.date,
    value: row.value,
    unit: row.unit,
    subtype: row.subtype,
    source: row.source,
    sourceApp: row.sourceApp,
  }));
}

/** Write the plan into the session's chunk rows, bounded per statement. */
async function writeStagedChunks(sessionId: string, plan: ImportPlan): Promise<void> {
  let seq = 0;
  const flush = async (payload: object) => {
    await prisma.healthImportChunk.create({
      data: { sessionId, seq: seq++, payload: JSON.stringify(payload) },
    });
  };
  for (let index = 0; index < plan.rows.length; index += STAGE_CHUNK) {
    await flush({ rows: plan.rows.slice(index, index + STAGE_CHUNK) });
  }
  for (let index = 0; index < plan.workouts.length; index += STAGE_CHUNK) {
    await flush({ workouts: plan.workouts.slice(index, index + STAGE_CHUNK) });
  }
  for (let index = 0; index < plan.records.length; index += STAGE_CHUNK) {
    await flush({ records: plan.records.slice(index, index + STAGE_CHUNK) });
  }
  await prisma.healthImportSession.update({
    where: { id: sessionId },
    data: { totalChunks: seq },
  });
}

/** The columns the merge rule needs, and no more. */
const MERGE_SELECT = {
  id: true,
  fingerprint: true,
  value: true,
  source: true,
  batchId: true,
  updatedAt: true,
} as const;

type FoundRow = { fingerprint: string | null } & Omit<StoredRow, "fingerprint">;

function indexByFingerprint(rows: FoundRow[]): Map<string, StoredRow> {
  const map = new Map<string, StoredRow>();
  for (const row of rows) {
    if (row.fingerprint) map.set(row.fingerprint, row);
  }
  return map;
}

/**
 * Which of the plan's fingerprints already exist, and everything the merge rule
 * needs to decide whether they are still the import's to change.
 *
 * Two strategies, because the two front ends have different shapes. Every
 * Apple fingerprint embeds the row's own date, so one bounded range scan finds
 * every possible collision and costs a single query however many rows the plan
 * has. A CSV row keyed by its `externalId` carries no date in its key — its
 * date may even have changed since the last import — so those are looked up by
 * fingerprint directly, which is affordable because CSVs are small.
 */
async function findExistingFingerprints(
  userId: string,
  plan: ImportPlan,
): Promise<Map<string, StoredRow>> {
  if (plan.rows.length === 0) return new Map();

  if (plan.kind === "apple_health" && plan.dateFrom && plan.dateTo) {
    const rows = await prisma.healthMetric.findMany({
      where: {
        userId,
        // Point-reading fingerprints embed an ISO instant whose day can sit one
        // day either side of the reporting day in a distant timezone, so the
        // window is widened by a day at each end rather than assumed exact.
        date: { gte: shiftDay(plan.dateFrom as DayKey, -1), lte: shiftDay(plan.dateTo as DayKey, 1) },
        fingerprint: { not: null },
      },
      select: MERGE_SELECT,
    });
    return indexByFingerprint(rows);
  }

  const found = await chunked(
    plan.rows.map((row) => row.fingerprint),
    CHUNK,
    (chunk) =>
      prisma.healthMetric.findMany({
        where: { userId, fingerprint: { in: chunk } },
        select: MERGE_SELECT,
      }),
  );
  return indexByFingerprint(found);
}

/**
 * When each import that owns one of these rows finished.
 *
 * The merge rule needs a boundary instant per row to answer "has the user
 * edited this since the import wrote it?" — the same question, and the same
 * boundary, that undo asks. Scoped by `userId`, so a batch id that arrived on a
 * row from anywhere else simply does not resolve and its row is protected
 * rather than merged.
 *
 * Bounded by the number of distinct past imports touching this plan's date
 * range, which is small; chunked anyway so it stays one bounded query even for
 * an account with a long import history.
 */
async function loadBatchBoundaries(
  userId: string,
  stored: Iterable<StoredRow>,
  client: PrismaLike = prisma,
): Promise<BatchBoundaries> {
  const ids = new Set<string>();
  for (const row of stored) {
    if (row.batchId) ids.add(row.batchId);
  }
  if (ids.size === 0) return new Map();

  const batches = await chunked([...ids], CHUNK, (chunk) =>
    client.healthImportBatch.findMany({
      where: { userId, id: { in: chunk } },
      select: { id: true, finishedAt: true, createdAt: true },
    }),
  );
  return new Map(batches.map((batch) => [batch.id, batch.finishedAt ?? batch.createdAt]));
}

/** The subset of the client both `prisma` and a transaction handle satisfy. */
type PrismaLike = Pick<typeof prisma, "healthImportBatch">;

async function findExistingRecordFingerprints(
  userId: string,
  records: RawHealthRecord[],
): Promise<Set<string>> {
  if (records.length === 0) return new Set();
  const found = await chunked(
    records.map((record) => record.fingerprint),
    CHUNK,
    (chunk) =>
      prisma.healthRecord.findMany({
        where: { userId, fingerprint: { in: chunk } },
        select: { fingerprint: true },
      }),
  );
  return new Set(found.map((row) => row.fingerprint as string));
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

// --- loading a staged import --------------------------------------------------

/** Delete a staged session — only the owner's; cancelling twice is fine. */
export async function discardStaged(userId: string, token: string): Promise<void> {
  await prisma.healthImportSession.deleteMany({ where: { id: token, userId } });
}

async function loadSummary(userId: string, token: string): Promise<StagedSummary | null> {
  const session = await prisma.healthImportSession.findFirst({
    where: { id: token, userId, status: "staged", expiresAt: { gt: new Date() } },
    select: { stagedPlan: true },
  });
  if (!session?.stagedPlan) return null;
  try {
    const summary = JSON.parse(session.stagedPlan) as StagedSummary;
    // Belt and braces: the row was found by userId already, but a summary that
    // disagrees about its owner is a corrupt row, not something to write from.
    return summary.userId === userId ? summary : null;
  } catch {
    return null;
  }
}

interface StagedChunk {
  rows?: NormalizedHealthRow[];
  workouts?: RawWorkout[];
  records?: RawHealthRecord[];
}

/** Replay the staged chunks in order. */
async function readStagedChunks(sessionId: string): Promise<StagedChunk[]> {
  const chunks = await prisma.healthImportChunk.findMany({
    where: { sessionId },
    orderBy: { seq: "asc" },
    select: { payload: true },
  });
  return chunks.map((chunk) => JSON.parse(chunk.payload) as StagedChunk);
}

/** The preview again, for a session the user is returning to. */
export async function getStagedPreview(
  userId: string,
  token: string,
): Promise<ImportPreviewResult | null> {
  const summary = await loadSummary(userId, token);
  if (!summary) return null;
  return {
    token,
    kind: summary.kind,
    fileName: summary.fileName,
    fileType: summary.fileType,
    fileSize: summary.fileSize,
    dateFrom: summary.dateFrom,
    dateTo: summary.dateTo,
    examined: summary.examined,
    invalid: summary.invalid,
    totalRows: summary.totalRows + summary.totalWorkouts + summary.totalRecords,
    parseMs: summary.parseMs,
    xmlBytes: summary.xmlBytes,
    truncated: summary.truncated,
    unsupported: summary.unsupported,
    warnings: summary.warnings,
    errors: summary.errors,
    ignoredFiles: summary.ignoredFiles,
    categories: summary.categories,
  };
}

// --- confirm ------------------------------------------------------------------

export interface ImportOutcome {
  batchId: string;
  imported: number;
  /** Existing readings this import merged a fuller value into. */
  updated: number;
  duplicates: number;
  /** Readings left exactly as they were, because they were not this import's. */
  protectedRows: number;
  invalid: number;
  skippedTypes: number;
  workoutsImported: number;
  workoutsSkipped: number;
  recordsImported: number;
  recordsDuplicate: number;
  dateFrom: string | null;
  dateTo: string | null;
  recomputedDays: number;
  durationMs: number;
}

export async function confirmHealthImport(
  userId: string,
  token: string,
  selectedCategories: string[],
): Promise<{ ok: true; outcome: ImportOutcome } | { ok: false; error: string }> {
  const summary = await loadSummary(userId, token);
  if (!summary) {
    return {
      ok: false,
      error: "This import session has expired — nothing was written. Upload the file again.",
    };
  }

  const staged = await readStagedChunks(token);
  const selected = new Set(selectedCategories);
  const rows: NormalizedHealthRow[] = [];
  const allWorkouts: RawWorkout[] = [];
  const allRecords: RawHealthRecord[] = [];
  for (const chunk of staged) {
    if (chunk.rows) rows.push(...chunk.rows.filter((row) => selected.has(row.type)));
    if (chunk.workouts) allWorkouts.push(...chunk.workouts);
    if (chunk.records) allRecords.push(...chunk.records);
  }

  const skipIds = new Set([...summary.exactWorkoutDupes, ...summary.potentialWorkoutDupes]);
  const workouts = selected.has(WORKOUTS_CATEGORY)
    ? allWorkouts.filter((workout) => !skipIds.has(workout.externalId))
    : [];
  const records = selected.has(RECORDS_CATEGORY) ? allRecords : [];

  // Choosing nothing is a mistake worth reporting. Choosing something that
  // turns out to be entirely already-present is NOT: that is what a safe
  // re-import looks like, and it still deserves a batch in the history saying
  // so rather than an error implying the user did something wrong.
  if (selected.size === 0) {
    await discardStaged(userId, token);
    return { ok: false, error: "Nothing was selected, so nothing was imported." };
  }

  const dates = [
    ...rows.map((row) => row.date),
    ...workouts.map((workout) => workout.date),
  ].sort();
  const dateFrom = (dates[0] as DayKey) ?? null;
  const dateTo = (dates[dates.length - 1] as DayKey) ?? null;

  const warningsJson = JSON.stringify(summary.warnings.slice(0, 40));
  const skippedTypes = summary.unsupported.reduce((sum, entry) => sum + entry.count, 0);
  const startedAt = new Date();

  let outcome: ImportOutcome;
  try {
    outcome = await prisma.$transaction(
      async (tx) => {
        const batch = await tx.healthImportBatch.create({
          data: {
            userId,
            source: summary.kind,
            fileType: summary.fileType,
            fileName: summary.fileName,
            fileSize: summary.fileSize,
            status: "completed",
            dateFrom,
            dateTo,
            categories: JSON.stringify([...selected].sort()),
            examined: summary.examined,
            skipped: skippedTypes,
            invalid: summary.invalid,
            warnings: warningsJson,
            errors: JSON.stringify(summary.errors.slice(0, 40)),
            ignoredFiles: JSON.stringify(summary.ignoredFiles),
            xmlBytes: summary.xmlBytes > 0 ? BigInt(summary.xmlBytes) : null,
            formatVersion: IMPORT_FORMAT_VERSION,
            startedAt,
          },
        });

        // Which fingerprints already exist, and whether they are still this
        // import's to change. Re-read inside the transaction rather than reused
        // from the preview: the preview may be hours old, and a row edited in
        // between must be protected on the strength of what is true *now*.
        const existing = new Map<string, StoredRow>();
        for (let index = 0; index < rows.length; index += CHUNK) {
          const chunk = rows.slice(index, index + CHUNK);
          const found = await tx.healthMetric.findMany({
            where: { userId, fingerprint: { in: chunk.map((row) => row.fingerprint) } },
            select: MERGE_SELECT,
          });
          for (const row of found) {
            if (row.fingerprint) existing.set(row.fingerprint, row);
          }
        }
        const boundaries = await loadBatchBoundaries(userId, existing.values(), tx);

        const toCreate: NormalizedHealthRow[] = [];
        const toUpdate: Array<{ id: string; row: NormalizedHealthRow }> = [];
        let duplicates = 0;
        const merges: MergeCounts = {
          create: 0,
          merge: 0,
          unchanged: 0,
          protectedEdited: 0,
          protectedForeign: 0,
        };
        for (const row of rows) {
          const current = existing.get(row.fingerprint);
          const outcome = decideMerge(row, current, boundaries);
          countMerge(outcome, merges);
          if (outcome.decision === "create") toCreate.push(row);
          else if (outcome.decision === "merge") toUpdate.push({ id: (current as StoredRow).id, row });
          else if (outcome.decision === "unchanged") duplicates += 1;
          // `protected` writes nothing at all — that is the whole behaviour.
        }
        const protectedRows = totalProtected(merges);

        for (let index = 0; index < toCreate.length; index += CHUNK) {
          await tx.healthMetric.createMany({
            data: toCreate.slice(index, index + CHUNK).map((row) => ({
              userId,
              batchId: batch.id,
              type: row.type,
              subtype: row.subtype,
              value: row.value,
              unit: row.unit,
              secondaryValue: row.secondaryValue ?? null,
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
        // identity; the value moves to the newer, more complete number, and the
        // row's batch moves with it so undoing the OLD batch cannot delete data
        // the NEW one is now responsible for.
        for (const { id, row } of toUpdate) {
          await tx.healthMetric.update({
            where: { id },
            data: {
              value: row.value,
              secondaryValue: row.secondaryValue ?? null,
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
        for (let index = 0; index < workouts.length; index += CHUNK) {
          const result = await tx.workout.createMany({
            data: workouts.slice(index, index + CHUNK).map((workout) => ({
              userId,
              date: workout.date,
              time: workout.time,
              name: workout.name,
              type: workout.type,
              durationMin: workout.durationMin,
              distanceKm: workout.distanceKm,
              caloriesBurned: workout.caloriesBurned,
              avgHeartRate: workout.avgHeartRate,
              status: "completed",
              startedAt: new Date(workout.startAt),
              completedAt: new Date(workout.endAt),
              source: "apple_health",
              externalId: workout.externalId,
              importBatchId: batch.id,
            })),
            // Two exports overlapping on the same workout must not collide on
            // the (userId, source, externalId) unique index mid-transaction.
            skipDuplicates: true,
          });
          workoutsImported += result.count;
        }

        let recordsImported = 0;
        for (let index = 0; index < records.length; index += CHUNK) {
          const result = await tx.healthRecord.createMany({
            data: records.slice(index, index + CHUNK).map((record) => ({
              userId,
              batchId: batch.id,
              kind: record.kind,
              date: record.date,
              recordedAt: record.recordedAt ? new Date(record.recordedAt) : null,
              startAt: record.startAt ? new Date(record.startAt) : null,
              endAt: record.endAt ? new Date(record.endAt) : null,
              title: record.title.slice(0, 200),
              subtitle: record.subtitle?.slice(0, 200) ?? null,
              value: record.value,
              unit: record.unit,
              detail: JSON.stringify(record.detail).slice(0, 2000),
              source: "apple_health",
              sourceApp: record.sourceApp,
              externalId: record.externalId,
              fingerprint: record.fingerprint,
            })),
            skipDuplicates: true,
          });
          recordsImported += result.count;
        }

        const finishedAt = new Date();
        await tx.healthImportBatch.update({
          where: { id: batch.id },
          data: {
            imported: toCreate.length,
            updated: toUpdate.length,
            duplicates,
            workoutsImported,
            workoutsSkipped: selected.has(WORKOUTS_CATEGORY)
              ? summary.totalWorkouts - workoutsImported
              : 0,
            recordsImported,
            recordsDuplicate: records.length - recordsImported,
            protectedRows,
            finishedAt,
            durationMs: finishedAt.getTime() - startedAt.getTime(),
          },
        });

        return {
          batchId: batch.id,
          imported: toCreate.length,
          updated: toUpdate.length,
          duplicates,
          protectedRows,
          invalid: summary.invalid,
          skippedTypes,
          workoutsImported,
          workoutsSkipped: selected.has(WORKOUTS_CATEGORY)
            ? summary.totalWorkouts - workoutsImported
            : 0,
          recordsImported,
          recordsDuplicate: records.length - recordsImported,
          dateFrom,
          dateTo,
          recomputedDays: 0,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
        };
      },
      { timeout: 600_000, maxWait: 30_000 },
    );
  } catch (error) {
    // The transaction rolled back: no metric, workout, record or batch row
    // survives. Record the failure as its own batch so the history shows it.
    await prisma.healthImportBatch
      .create({
        data: {
          userId,
          source: summary.kind,
          fileType: summary.fileType,
          fileName: summary.fileName,
          fileSize: summary.fileSize,
          status: "failed",
          error: `Import failed (reference ${logRedactedError("health-import", error)})`,
          dateFrom,
          dateTo,
          categories: JSON.stringify([...selected].sort()),
          examined: summary.examined,
          formatVersion: IMPORT_FORMAT_VERSION,
          startedAt,
          finishedAt: new Date(),
        },
      })
      .catch(() => {});
    // The staged import is kept so the user can retry without re-uploading.
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
    ...rows.map((row) => row.date as DayKey),
    ...workouts.map((workout) => workout.date as DayKey),
  ]);
  outcome.recomputedDays = await rebuildSummariesForDates(userId, touched);

  return { ok: true, outcome };
}

// --- batch history ------------------------------------------------------------

export async function listImportBatches(userId: string, take = 50) {
  const batches = await prisma.healthImportBatch.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take,
  });
  return batches.map((batch) => ({
    ...batch,
    // BigInt does not survive the server→client boundary; the byte count is
    // only ever displayed, so it crosses as a number.
    xmlBytes: batch.xmlBytes === null ? null : Number(batch.xmlBytes),
    categoriesList: safeJsonArray(batch.categories),
    warningsList: safeJsonArray(batch.warnings),
    errorsList: safeJsonArray(batch.errors),
    ignoredFilesList: safeJsonArray(batch.ignoredFiles),
  }));
}

export type ImportBatchSummary = Awaited<ReturnType<typeof listImportBatches>>[number];

/** How long ago the last successful import was, bucketed for the UI. */
export type ImportRecency = "never" | "today" | "week" | "month" | "stale";

export interface ImportDashboard {
  /** Newest first, bounded — the searchable history the page renders. */
  batches: ImportBatchSummary[];
  /** True when the account has more imports than `batches` carries. */
  truncated: boolean;
  totals: {
    runs: number;
    completed: number;
    undone: number;
    failed: number;
    readingsWritten: number;
    readingsMerged: number;
    readingsProtected: number;
    workoutsWritten: number;
    recordsWritten: number;
    bytesRead: number;
  };
  lastSuccessful: {
    id: string;
    fileName: string;
    at: Date;
    imported: number;
    daysAgo: number;
  } | null;
  recency: ImportRecency;
  /** Staged imports waiting to be confirmed or cancelled. */
  pending: number;
}

function recencyOf(daysAgo: number | null): ImportRecency {
  if (daysAgo === null) return "never";
  if (daysAgo <= 0) return "today";
  if (daysAgo <= 7) return "week";
  if (daysAgo <= 31) return "month";
  return "stale";
}

/**
 * Everything the import dashboard shows, in five bounded queries.
 *
 * The totals are **aggregates over every batch**, not sums of the page's list —
 * an account with hundreds of imports would otherwise see a "readings written"
 * figure that silently meant "of the most recent hundred". The list itself is
 * capped and says so when it is.
 *
 * Every query is scoped by `userId` and served by the existing
 * `(userId, createdAt)` and `(userId, status)` indexes.
 */
export async function getImportDashboard(
  userId: string,
  today: DayKey,
  take = 100,
): Promise<ImportDashboard> {
  const [batches, totalRuns, byStatus, sums, lastSuccessfulRow, pending] = await Promise.all([
    listImportBatches(userId, take),
    prisma.healthImportBatch.count({ where: { userId } }),
    prisma.healthImportBatch.groupBy({
      by: ["status"],
      where: { userId },
      _count: { _all: true },
    }),
    prisma.healthImportBatch.aggregate({
      where: { userId },
      _sum: {
        imported: true,
        updated: true,
        protectedRows: true,
        workoutsImported: true,
        recordsImported: true,
        fileSize: true,
      },
    }),
    prisma.healthImportBatch.findFirst({
      where: { userId, status: "completed" },
      orderBy: { createdAt: "desc" },
      select: { id: true, fileName: true, createdAt: true, finishedAt: true, imported: true },
    }),
    prisma.healthImportSession.count({
      where: { userId, status: "staged", expiresAt: { gt: new Date() } },
    }),
  ]);

  const countFor = (status: string) =>
    byStatus.find((group) => group.status === status)?._count._all ?? 0;

  const at = lastSuccessfulRow ? (lastSuccessfulRow.finishedAt ?? lastSuccessfulRow.createdAt) : null;
  // Compared in whole days against the user's own today, not the host clock —
  // "2 days ago" must mean the same thing here as everywhere else in the app.
  const daysAgo =
    at === null
      ? null
      : Math.max(
          0,
          Math.round(
            (Date.parse(`${today}T12:00:00Z`) -
              Date.parse(`${at.toISOString().slice(0, 10)}T12:00:00Z`)) /
              86_400_000,
          ),
        );

  return {
    batches,
    truncated: totalRuns > batches.length,
    totals: {
      runs: totalRuns,
      completed: countFor("completed"),
      undone: countFor("removed"),
      failed: countFor("failed"),
      readingsWritten: sums._sum.imported ?? 0,
      readingsMerged: sums._sum.updated ?? 0,
      readingsProtected: sums._sum.protectedRows ?? 0,
      workoutsWritten: sums._sum.workoutsImported ?? 0,
      recordsWritten: sums._sum.recordsImported ?? 0,
      bytesRead: sums._sum.fileSize ?? 0,
    },
    lastSuccessful:
      lastSuccessfulRow && at
        ? {
            id: lastSuccessfulRow.id,
            fileName: lastSuccessfulRow.fileName,
            at,
            imported: lastSuccessfulRow.imported,
            daysAgo: daysAgo ?? 0,
          }
        : null,
    recency: recencyOf(daysAgo),
    pending,
  };
}

function safeJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

// --- undo ----------------------------------------------------------------------

export interface BatchRemovalPreview {
  batchId: string;
  fileName: string;
  /** Rows the batch created that it still owns — what undo would delete. */
  metricCount: number;
  workoutCount: number;
  recordCount: number;
  /** Rows the batch created that undo will KEEP, and why. */
  keptEdited: number;
  keptLinked: number;
  categories: Array<{ type: string; label: string; count: number }>;
  recordKinds: Array<{ kind: string; label: string; count: number }>;
  dateFrom: string | null;
  dateTo: string | null;
  undoneAt: string | null;
}

async function loadBatch(userId: string, batchId: string) {
  return prisma.healthImportBatch.findFirst({ where: { id: batchId, userId } });
}

/** The instant after which a change to a row is the user's, not the import's. */
function importFinishedAt(batch: { finishedAt: Date | null; createdAt: Date }): Date {
  return batch.finishedAt ?? batch.createdAt;
}

/**
 * What an undo would do. Reads only, writes nothing — the preview the
 * confirmation dialog shows before anything is deleted.
 */
export async function previewBatchRemoval(
  userId: string,
  batchId: string,
): Promise<BatchRemovalPreview | null> {
  const batch = await loadBatch(userId, batchId);
  if (!batch || batch.status === "removed") return null;

  const boundary = importFinishedAt(batch);
  const [metrics, workouts, records] = await Promise.all([
    prisma.healthMetric.findMany({
      where: { batchId, userId },
      select: { id: true, type: true, updatedAt: true },
    }),
    prisma.workout.findMany({
      where: { importBatchId: batchId, userId },
      select: {
        id: true,
        updatedAt: true,
        scheduleItem: { select: { id: true } },
        _count: { select: { sets: true } },
      },
    }),
    prisma.healthRecord.findMany({
      where: { batchId, userId },
      select: { id: true, kind: true, updatedAt: true },
    }),
  ]);

  const metricPlan = planHealthUndo(
    metrics.map((row) => ({ id: row.id, updatedAt: row.updatedAt, linked: false })),
    boundary,
  );
  const workoutPlan = planHealthUndo(
    workouts.map((row) => ({
      id: row.id,
      updatedAt: row.updatedAt,
      // A workout that now has sets, or that a planner block points at, has
      // become part of something the user built. Deleting it would take that
      // with it, so the undo keeps it.
      linked: row._count.sets > 0 || row.scheduleItem !== null,
    })),
    boundary,
  );
  const recordPlan = planHealthUndo(
    records.map((row) => ({ id: row.id, updatedAt: row.updatedAt, linked: false })),
    boundary,
  );

  const removableMetrics = new Set(metricPlan.removeIds);
  const byType = new Map<string, number>();
  for (const row of metrics) {
    if (!removableMetrics.has(row.id)) continue;
    byType.set(row.type, (byType.get(row.type) ?? 0) + 1);
  }
  const removableRecords = new Set(recordPlan.removeIds);
  const byKind = new Map<string, number>();
  for (const row of records) {
    if (!removableRecords.has(row.id)) continue;
    byKind.set(row.kind, (byKind.get(row.kind) ?? 0) + 1);
  }

  return {
    batchId,
    fileName: batch.fileName,
    metricCount: metricPlan.removeCount,
    workoutCount: workoutPlan.removeCount,
    recordCount: recordPlan.removeCount,
    keptEdited: metricPlan.keptEdited + workoutPlan.keptEdited + recordPlan.keptEdited,
    keptLinked: metricPlan.keptLinked + workoutPlan.keptLinked + recordPlan.keptLinked,
    categories: [...byType.entries()]
      .map(([type, count]) => ({
        type,
        label: HEALTH_METRIC_META[type as HealthMetricType]?.label ?? type,
        count,
      }))
      .sort((a, b) => b.count - a.count),
    recordKinds: [...byKind.entries()]
      .map(([kind, count]) => ({
        kind,
        label: HEALTH_RECORD_KIND_META[kind as HealthRecordKind]?.plural ?? kind,
        count,
      }))
      .sort((a, b) => b.count - a.count),
    dateFrom: batch.dateFrom,
    dateTo: batch.dateTo,
    undoneAt: batch.undoneAt?.toISOString() ?? null,
  };
}

export interface BatchRemovalReport {
  removedMetrics: number;
  removedWorkouts: number;
  removedRecords: number;
  keptCount: number;
  recomputedDays: number;
}

/**
 * Undo one import — and only that import.
 *
 * Three guarantees, in order of importance:
 *
 *  1. **It can only ever reach this batch's rows.** Every delete is keyed on
 *     `batchId` *and* `userId`. Manual entries were never given a batch;
 *     another import's rows carry that import's id; a row a later import
 *     refreshed had its `batchId` moved to that later batch at the moment it
 *     was refreshed. So there is no path from here to anyone else's data, or
 *     to data this run did not write.
 *  2. **It keeps what you have since made your own.** A row edited after the
 *     import finished, a workout that now has sets or a planner block, are
 *     kept and reported rather than deleted — the same rule finance undo uses.
 *  3. **It happens once.** The batch is stamped `undoneAt`; a second undo is a
 *     no-op instead of a way to reach rows a later import wrote.
 *
 * Every derived number for the affected days is recomputed afterwards through
 * the same central path every other write uses.
 */
export async function removeImportBatch(
  userId: string,
  batchId: string,
): Promise<{ ok: true; report: BatchRemovalReport } | { ok: false; error: string }> {
  const batch = await loadBatch(userId, batchId);
  if (!batch) return { ok: false, error: "Import batch not found." };
  if (batch.undoneAt || batch.status === "removed") {
    return { ok: false, error: "This import has already been undone." };
  }

  const boundary = importFinishedAt(batch);
  const [metrics, workouts, records] = await Promise.all([
    prisma.healthMetric.findMany({
      where: { batchId, userId },
      select: { id: true, date: true, updatedAt: true },
    }),
    prisma.workout.findMany({
      where: { importBatchId: batchId, userId },
      select: {
        id: true,
        date: true,
        updatedAt: true,
        scheduleItem: { select: { id: true } },
        _count: { select: { sets: true } },
      },
    }),
    prisma.healthRecord.findMany({
      where: { batchId, userId },
      select: { id: true, updatedAt: true },
    }),
  ]);

  const metricPlan = planHealthUndo(
    metrics.map((row) => ({ id: row.id, updatedAt: row.updatedAt, linked: false })),
    boundary,
  );
  const workoutPlan = planHealthUndo(
    workouts.map((row) => ({
      id: row.id,
      updatedAt: row.updatedAt,
      linked: row._count.sets > 0 || row.scheduleItem !== null,
    })),
    boundary,
  );
  const recordPlan = planHealthUndo(
    records.map((row) => ({ id: row.id, updatedAt: row.updatedAt, linked: false })),
    boundary,
  );

  // The days a removal changes, collected before anything is deleted.
  const removableMetrics = new Set(metricPlan.removeIds);
  const removableWorkouts = new Set(workoutPlan.removeIds);
  const touchedDates = new Set<DayKey>([
    ...metrics.filter((row) => removableMetrics.has(row.id)).map((row) => row.date as DayKey),
    ...workouts.filter((row) => removableWorkouts.has(row.id)).map((row) => row.date as DayKey),
  ]);

  const keptCount = metricPlan.keptCount + workoutPlan.keptCount + recordPlan.keptCount;

  const report = await prisma.$transaction(
    async (tx) => {
      let removedMetrics = 0;
      for (let index = 0; index < metricPlan.removeIds.length; index += CHUNK) {
        const result = await tx.healthMetric.deleteMany({
          where: { userId, batchId, id: { in: metricPlan.removeIds.slice(index, index + CHUNK) } },
        });
        removedMetrics += result.count;
      }
      let removedWorkouts = 0;
      for (let index = 0; index < workoutPlan.removeIds.length; index += CHUNK) {
        const result = await tx.workout.deleteMany({
          where: {
            userId,
            importBatchId: batchId,
            id: { in: workoutPlan.removeIds.slice(index, index + CHUNK) },
          },
        });
        removedWorkouts += result.count;
      }
      let removedRecords = 0;
      for (let index = 0; index < recordPlan.removeIds.length; index += CHUNK) {
        const result = await tx.healthRecord.deleteMany({
          where: { userId, batchId, id: { in: recordPlan.removeIds.slice(index, index + CHUNK) } },
        });
        removedRecords += result.count;
      }

      await tx.healthImportBatch.update({
        where: { id: batchId },
        data: {
          status: "removed",
          removedAt: new Date(),
          undoneAt: new Date(),
          undoneCount: removedMetrics + removedWorkouts + removedRecords,
          keptCount,
        },
      });

      return { removedMetrics, removedWorkouts, removedRecords, keptCount, recomputedDays: 0 };
    },
    { timeout: 600_000, maxWait: 30_000 },
  );

  report.recomputedDays = await rebuildSummariesForDates(userId, touchedDates);
  return { ok: true, report };
}

export { classifyHealthUndoRow };
export { IMPORT_FORMAT_VERSION };
