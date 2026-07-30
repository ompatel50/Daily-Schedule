import "server-only";

import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { HEALTH_METRIC_TYPES, WORKOUT_TYPES } from "@/lib/enums";
import { SLEEP_STAGES } from "@/lib/logic/health";
import { fingerprintFor } from "@/lib/logic/health-import/rollup";
import type {
  ImportPlan,
  NormalizedHealthRow,
  RawWorkout,
} from "@/lib/logic/health-import/types";

/**
 * The hosted health-import session: the server-side half of the browser
 * parsing architecture.
 *
 * The browser parses the export in a Web Worker and uploads only normalised
 * rows, in bounded chunks, into a session the SERVER created and owns:
 *
 *   1. `createSession` — authenticated; the id is server-generated and tied
 *      to the user. The browser cannot choose an owner.
 *   2. `appendChunk` — each chunk is bounded, sequence-numbered (the unique
 *      (sessionId, seq) makes a duplicate submission a no-op), and only
 *      attaches to a session the same user owns, while it is `uploading`.
 *   3. `finalizeSession` — every row is validated AGAIN on the server
 *      (types, dates, units, bounds, source allow-list) and every
 *      fingerprint is RECOMPUTED — a tampered client fingerprint cannot
 *      collide with someone else's rows because fingerprints are only ever
 *      queried per-user, and cannot lie about content because the server
 *      derives it from the content it was given. The validated plan becomes
 *      the staged import the existing confirm step writes from.
 *
 * Sessions expire after two hours; expired ones are swept opportunistically
 * on the next session creation. Cancel and confirm both delete the session.
 * Raw exports never reach the server, and nothing here logs row contents.
 */

export const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
/** Bounded chunk: at most this many rows… */
export const MAX_ROWS_PER_CHUNK = 2500;
/** …and at most this much JSON per chunk. */
export const MAX_CHUNK_BYTES = 900 * 1024;
/** A multi-decade export at one row per day per metric fits well inside this. */
export const MAX_CHUNKS = 400;
export const MAX_TOTAL_ROWS = 400_000;

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const isoDate = z
  .string()
  .max(40)
  .refine((value) => !Number.isNaN(new Date(value).getTime()), "invalid timestamp");

/** What a CSV row may claim as its provenance — never "apple_health". */
const CSV_ROW_SOURCES = new Set(["csv", "manual", "estimated", "calculated"]);

const rowSchema = z.object({
  type: z.enum(HEALTH_METRIC_TYPES),
  subtype: z.enum(SLEEP_STAGES).nullable(),
  value: z.number().finite().gte(-1_000_000).lte(100_000_000),
  unit: z.string().max(20),
  minValue: z.number().finite().nullable(),
  maxValue: z.number().finite().nullable(),
  date: z.string().regex(DAY_KEY),
  startAt: isoDate.nullable(),
  endAt: isoDate.nullable(),
  source: z.string().max(40),
  sourceApp: z.string().max(120).nullable(),
  sourceDevice: z.string().max(120).nullable(),
  externalId: z.string().max(200).nullable(),
  notes: z.string().max(500).nullable(),
  sampleCount: z.number().int().min(0).max(1_000_000),
  fingerprint: z.string().max(300),
});

const workoutSchema = z.object({
  type: z.enum(WORKOUT_TYPES),
  name: z.string().min(1).max(120),
  date: z.string().regex(DAY_KEY),
  time: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .nullable(),
  startAt: isoDate,
  endAt: isoDate,
  durationMin: z.number().int().min(1).max(24 * 60),
  distanceKm: z.number().finite().min(0).max(2000).nullable(),
  caloriesBurned: z.number().finite().min(0).max(50000).nullable(),
  sourceApp: z.string().max(120).nullable(),
  externalId: z.string().min(1).max(200),
});

export const chunkPayloadSchema = z.object({
  rows: z.array(rowSchema).max(MAX_ROWS_PER_CHUNK),
  workouts: z.array(workoutSchema).max(MAX_ROWS_PER_CHUNK),
});

export type ChunkPayload = z.infer<typeof chunkPayloadSchema>;

const sessionMetaSchema = z.object({
  source: z.enum(["apple_health", "csv"]),
  fileType: z.enum(["xml", "zip", "csv"]),
  fileName: z.string().min(1).max(200),
  fileSize: z
    .number()
    .int()
    .min(0)
    .max(4 * 1024 * 1024 * 1024),
  totalChunks: z.number().int().min(1).max(MAX_CHUNKS),
  examined: z.number().int().min(0).max(100_000_000),
  invalid: z.number().int().min(0).max(100_000_000),
  unsupported: z
    .array(z.object({ type: z.string().max(200), count: z.number().int().min(0) }))
    .max(200),
  warnings: z.array(z.string().max(400)).max(40),
});

export type SessionMeta = z.infer<typeof sessionMetaSchema>;

async function sweepExpiredSessions(): Promise<void> {
  await prisma.healthImportSession
    .deleteMany({ where: { expiresAt: { lt: new Date() } } })
    .catch(() => {});
}

export async function createSession(
  userId: string,
  meta: unknown,
): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
  const parsed = sessionMetaSchema.safeParse(meta);
  if (!parsed.success) return { ok: false, error: "Invalid import request." };

  await sweepExpiredSessions();

  // Base filename only — never a path from the user's machine.
  const fileName = parsed.data.fileName.split(/[\\/]/).pop() ?? "import";

  const session = await prisma.healthImportSession.create({
    data: {
      userId,
      status: "uploading",
      source: parsed.data.source,
      fileType: parsed.data.fileType,
      fileName,
      fileSize: parsed.data.fileSize,
      totalChunks: parsed.data.totalChunks,
      examined: parsed.data.examined,
      invalid: parsed.data.invalid,
      unsupported: JSON.stringify(parsed.data.unsupported.slice(0, 200)),
      warnings: JSON.stringify(parsed.data.warnings.slice(0, 40)),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });

  return { ok: true, sessionId: session.id };
}

export async function appendChunk(
  userId: string,
  sessionId: string,
  seq: number,
  payloadJson: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (typeof payloadJson !== "string" || payloadJson.length > MAX_CHUNK_BYTES) {
    return { ok: false, error: "That upload chunk is too large." };
  }
  if (!Number.isInteger(seq) || seq < 0 || seq >= MAX_CHUNKS) {
    return { ok: false, error: "Invalid chunk sequence." };
  }

  // Ownership: the session must be this user's, and still accepting chunks.
  const session = await prisma.healthImportSession.findFirst({
    where: { id: sessionId, userId, status: "uploading", expiresAt: { gt: new Date() } },
    select: { id: true, totalChunks: true },
  });
  if (!session) return { ok: false, error: "This import session has expired. Start again." };
  if (seq >= session.totalChunks) return { ok: false, error: "Invalid chunk sequence." };

  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return { ok: false, error: "That upload chunk is not valid." };
  }
  const parsed = chunkPayloadSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, error: "That upload chunk is not valid." };

  try {
    await prisma.healthImportChunk.create({
      data: { sessionId: session.id, seq, payload: payloadJson },
    });
  } catch (error) {
    // Unique (sessionId, seq): a retried submission of the same chunk is fine.
    if ((error as { code?: string })?.code !== "P2002") throw error;
  }
  return { ok: true };
}

/**
 * Reassemble and REVALIDATE everything the browser sent, recomputing every
 * fingerprint from row content. Returns the validated plan; the caller stages
 * it and builds the preview.
 */
export async function assembleValidatedPlan(
  userId: string,
  sessionId: string,
): Promise<
  | { ok: true; session: { id: string; source: string; fileType: string; fileName: string; fileSize: number | null; examined: number; invalid: number; unsupported: Record<string, number>; warnings: string[] }; plan: ImportPlan; rejected: number }
  | { ok: false; error: string }
> {
  const session = await prisma.healthImportSession.findFirst({
    where: { id: sessionId, userId, expiresAt: { gt: new Date() } },
    include: { chunks: { orderBy: { seq: "asc" }, select: { seq: true, payload: true } } },
  });
  if (!session) return { ok: false, error: "This import session has expired. Start again." };

  const seqs = new Set(session.chunks.map((chunk) => chunk.seq));
  if (seqs.size < session.totalChunks) {
    return {
      ok: false,
      error: `The upload is incomplete (${seqs.size} of ${session.totalChunks} parts arrived). Try again.`,
    };
  }

  const rows: NormalizedHealthRow[] = [];
  const workouts: RawWorkout[] = [];
  let rejected = 0;

  for (const chunk of session.chunks) {
    let parsed: ChunkPayload;
    try {
      parsed = chunkPayloadSchema.parse(JSON.parse(chunk.payload));
    } catch {
      return { ok: false, error: "The staged upload is damaged. Start again." };
    }
    for (const row of parsed.rows) {
      // Provenance rules: an XML/ZIP session's rows are Apple Health rows; a
      // CSV may only claim the CSV source set. A forged source would change
      // how the aggregation trusts the value.
      const sourceOk =
        session.source === "apple_health"
          ? row.source === "apple_health"
          : CSV_ROW_SOURCES.has(row.source);
      if (!sourceOk) {
        rejected += 1;
        continue;
      }
      if (rows.length >= MAX_TOTAL_ROWS) {
        return { ok: false, error: "The upload contains more rows than one import supports." };
      }
      const { fingerprint: _clientFingerprint, ...content } = row;
      rows.push({ ...content, fingerprint: fingerprintFor(content) });
    }
    for (const workout of parsed.workouts) {
      if (session.source !== "apple_health") {
        rejected += 1;
        continue;
      }
      workouts.push(workout);
    }
  }

  const dates = [...rows.map((row) => row.date), ...workouts.map((w) => w.date)].sort();

  const byType = new Map<string, { records: number; rows: number; from: string; to: string }>();
  for (const row of rows) {
    const entry = byType.get(row.type) ?? { records: 0, rows: 0, from: row.date, to: row.date };
    entry.records += row.sampleCount || 1;
    entry.rows += 1;
    if (row.date < entry.from) entry.from = row.date;
    if (row.date > entry.to) entry.to = row.date;
    byType.set(row.type, entry);
  }

  let unsupported: Record<string, number> = {};
  try {
    const parsed = JSON.parse(session.unsupported) as Array<{ type: string; count: number }>;
    unsupported = Object.fromEntries(parsed.map((entry) => [entry.type, entry.count]));
  } catch {
    unsupported = {};
  }
  let warnings: string[] = [];
  try {
    warnings = (JSON.parse(session.warnings) as string[]).slice(0, 40);
  } catch {
    warnings = [];
  }

  const plan: ImportPlan = {
    kind: session.source === "apple_health" ? "apple_health" : "csv",
    rows,
    workouts,
    categories: [...byType.entries()].map(([key, entry]) => ({
      key,
      label: key,
      records: entry.records,
      rows: entry.rows,
      dateFrom: entry.from,
      dateTo: entry.to,
    })),
    dateFrom: dates[0] ?? null,
    dateTo: dates[dates.length - 1] ?? null,
    examined: session.examined,
    invalid: session.invalid,
    unsupported,
    errors: [],
    warnings,
  };

  if (workouts.length > 0) {
    plan.categories.push({
      key: "workouts",
      label: "Workouts",
      records: workouts.length,
      rows: workouts.length,
      dateFrom: workouts.map((w) => w.date).sort()[0] ?? null,
      dateTo: workouts.map((w) => w.date).sort().at(-1) ?? null,
    });
  }

  return {
    ok: true,
    session: {
      id: session.id,
      source: session.source,
      fileType: session.fileType,
      fileName: session.fileName,
      fileSize: session.fileSize,
      examined: session.examined,
      invalid: session.invalid,
      unsupported,
      warnings,
    },
    plan,
    rejected,
  };
}
