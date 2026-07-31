import "server-only";

import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import { prisma } from "@/lib/db";
import {
  MAX_UPLOAD_PARTS,
  UPLOAD_PART_BYTES,
  formatLimit,
  resolveUploadLimit,
  tooLargeMessage,
  type UploadLimit,
} from "@/server/apple-health/limits";

/**
 * The staged upload — the transport half of the health import.
 *
 * ## Why this exists
 *
 * The importer used to POST the whole Apple Health `export.zip` to
 * `/api/health/import` as one request body. That works on a machine you own and
 * is impossible on a serverless platform: Vercel refuses a request body over
 * ~4.5 MB **at the edge**, before any of this app's code runs, and answers
 * `413 FUNCTION_PAYLOAD_TOO_LARGE`. A real Apple Health export is one to three
 * orders of magnitude larger than that, so the hosted importer could not import
 * the one file it exists to import.
 *
 * The fix is to stop making the size of the file and the size of a request the
 * same number. The browser slices the archive into parts below the platform's
 * cap and sends one request per part; the server stores them, owned and
 * bounded; a single later invocation reassembles them into its own scratch
 * space, parses the archive exactly as before, and deletes every part.
 *
 *   open      →  a session is created, server-side, with the part size and the
 *                part count the file will need. Nothing is trusted yet.
 *   receive   →  one part per request. Bounded, owner-checked, idempotent on
 *                (session, index) so a retry over a flaky connection is safe.
 *   assemble  →  the parts are streamed, in order, into a temporary file inside
 *                the invocation that will parse it. Never held in memory.
 *   discard   →  the session and its parts are deleted — on success, on
 *                failure, on abort, and on expiry.
 *
 * ## Why the parts live in the database
 *
 * Because two requests on a serverless platform are not guaranteed to reach the
 * same machine, so appending to a local file across requests silently loses
 * data. The account's own database is the one place both requests can see, it
 * needs no extra service or credential on the free tier, and it inherits the
 * ownership model the rest of the app already has. The bytes are transient: a
 * completed import deletes them within the same invocation that read them.
 *
 * ## What is never trusted
 *
 * The declared file size only *sizes* the upload. What binds is what the server
 * counted: every part's length is measured as it arrives, the total is
 * recomputed from the stored rows before the parse, and the archive's type is
 * decided from its bytes. A part index outside the session's range is refused,
 * so the most a client can store is `totalParts × partBytes` — a bound that
 * holds however the client behaves, including concurrently.
 */

/** How long an abandoned upload survives before it is swept. */
export const UPLOAD_TTL_MS = 60 * 60 * 1000;

/**
 * How long a session with no writes counts as abandoned by its own owner.
 *
 * Shorter than the TTL on purpose: closing the tab mid-upload is the common
 * case, and the parts it left behind are pure storage cost. Opening a new
 * upload clears this account's idle ones first, so a user is never blocked by
 * their own abandoned attempt.
 */
export const UPLOAD_IDLE_MS = 15 * 60 * 1000;

/**
 * How long a session that has received **no parts at all** counts as dead.
 *
 * Much shorter than the idle window, because it is a much stronger signal: a
 * session with zero bytes after two minutes is not an upload in progress, it is
 * a tab that went away between "open" and "first part". That is the failure
 * mode that would otherwise spend an account's upload slots on nothing —
 * observed for real while verifying this change in a browser.
 */
export const UPLOAD_UNSTARTED_MS = 2 * 60 * 1000;

/** Concurrent uploads one account may hold. Bounds staged bytes per user. */
export const MAX_ACTIVE_UPLOADS = 2;

/** Parts fetched per round trip when reassembling. Bounds peak memory. */
const PARTS_PER_READ = 4;

/**
 * The largest byte count the size columns can hold: they are Postgres
 * `INTEGER`, whose maximum is one byte below this app's 2 GB ceiling.
 *
 * Only reachable at the exact boundary, and only self-hosted — but "declare a
 * file of exactly 2 GiB and get a 500 instead of a refusal" is a crash a
 * stranger can ask for, and a refusal is the correct answer either way. Guarded
 * here rather than by shaving a byte off `MAX_UPLOAD_BYTES`, so the number the
 * app advertises stays the round one it means.
 */
const MAX_STORED_BYTES = 2_147_483_647;

export interface OpenedUpload {
  uploadId: string;
  /** The slice size the client must cut the file on. */
  partBytes: number;
  totalParts: number;
  expiresAt: string;
}

export interface UploadProgress {
  receivedParts: number;
  totalParts: number;
  receivedBytes: number;
}

export type UploadResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number };

function fail(error: string, status: number): { ok: false; error: string; status: number } {
  return { ok: false, error, status };
}

/** Base name only — a path from the user's machine is never stored or shown. */
function safeFileName(raw: unknown): string {
  const text = typeof raw === "string" ? raw : "";
  const base = text.split(/[\\/]/).pop() ?? "";
  return (base.trim() || "export.zip").slice(0, 200);
}

// --- opening ------------------------------------------------------------------

/**
 * Start an upload. The size the browser declares is checked against this
 * deployment's ceiling here so a doomed upload is refused in one round trip
 * rather than after several minutes of parts.
 */
export async function openUpload(
  userId: string,
  input: { fileName: unknown; fileSize: unknown },
  limit: UploadLimit = resolveUploadLimit(),
): Promise<UploadResult<OpenedUpload>> {
  const declared = Number(input.fileSize);
  if (!Number.isFinite(declared) || !Number.isInteger(declared) || declared <= 0) {
    return fail("That file is empty.", 400);
  }
  if (declared > limit.bytes || declared > MAX_STORED_BYTES) {
    return fail(tooLargeMessage(limit), 413);
  }

  const totalParts = Math.ceil(declared / UPLOAD_PART_BYTES);
  if (totalParts > MAX_UPLOAD_PARTS) {
    return fail(tooLargeMessage(limit), 413);
  }

  await sweepExpiredUploads();
  // This account's own abandoned attempts go first, so a closed tab never locks
  // its owner out of importing. Two rules, because "abandoned" has two shapes:
  // an upload nobody has written to in a while, and one that never started at
  // all — the latter being what a tab closed on the file picker leaves behind.
  const now = Date.now();
  await prisma.healthUploadSession
    .deleteMany({
      where: {
        userId,
        OR: [
          { updatedAt: { lt: new Date(now - UPLOAD_IDLE_MS) } },
          { receivedParts: 0, createdAt: { lt: new Date(now - UPLOAD_UNSTARTED_MS) } },
        ],
      },
    })
    .catch(() => {});

  const active = await prisma.healthUploadSession.count({ where: { userId } });
  if (active >= MAX_ACTIVE_UPLOADS) {
    return fail(
      "Another import upload is already in progress. Finish or cancel it before starting another.",
      429,
    );
  }

  const session = await prisma.healthUploadSession.create({
    data: {
      userId,
      status: "receiving",
      fileName: safeFileName(input.fileName),
      declaredSize: declared,
      totalParts,
      partBytes: UPLOAD_PART_BYTES,
      expiresAt: new Date(Date.now() + UPLOAD_TTL_MS),
    },
    select: { id: true, totalParts: true, partBytes: true, expiresAt: true },
  });

  return {
    ok: true,
    data: {
      uploadId: session.id,
      partBytes: session.partBytes,
      totalParts: session.totalParts,
      expiresAt: session.expiresAt.toISOString(),
    },
  };
}

// --- receiving ----------------------------------------------------------------

/**
 * Store one part.
 *
 * Idempotent by construction: `(sessionId, seq)` is unique, so a part resent
 * after a dropped connection replaces its predecessor instead of doubling the
 * archive. Every bound is checked against what actually arrived.
 */
export async function receivePart(
  userId: string,
  input: { uploadId: unknown; seq: unknown; body: ReadableStream<Uint8Array> | null },
  limit: UploadLimit = resolveUploadLimit(),
): Promise<UploadResult<UploadProgress>> {
  if (typeof input.uploadId !== "string" || input.uploadId.length === 0) {
    return fail("Unknown upload.", 404);
  }
  const seq = Number(input.seq);
  if (!Number.isInteger(seq) || seq < 0) return fail("Invalid part index.", 400);
  if (!input.body) return fail("That part carried no data.", 400);

  // Owner-scoped: an id belonging to another account does not resolve, so
  // there is nothing to probe for by changing the id.
  const session = await prisma.healthUploadSession.findFirst({
    where: { id: input.uploadId, userId },
    select: { id: true, totalParts: true, partBytes: true, expiresAt: true, status: true },
  });
  if (!session) return fail("That upload has expired. Choose the file again.", 404);
  if (session.expiresAt.getTime() < Date.now()) {
    await discardUpload(userId, session.id);
    return fail("That upload has expired. Choose the file again.", 410);
  }
  if (session.status !== "receiving") {
    return fail("That upload is already being read and cannot take more parts.", 409);
  }
  if (seq >= session.totalParts) return fail("Invalid part index.", 400);

  let data: Uint8Array<ArrayBuffer>;
  try {
    data = await readBounded(input.body, session.partBytes);
  } catch {
    return fail("That part is larger than the upload's part size.", 413);
  }
  if (data.length === 0) return fail("That part carried no data.", 400);

  await prisma.healthUploadPart.upsert({
    where: { sessionId_seq: { sessionId: session.id, seq } },
    create: { sessionId: session.id, seq, size: data.length, data },
    update: { size: data.length, data },
  });

  // Recomputed rather than incremented, so a retried part cannot inflate the
  // total. Concurrent parts may briefly report a stale figure here — it drives
  // the progress bar only. `assembleUpload` recomputes it before it matters.
  const totals = await prisma.healthUploadPart.aggregate({
    where: { sessionId: session.id },
    _count: { _all: true },
    _sum: { size: true },
  });
  const receivedBytes = totals._sum.size ?? 0;
  const receivedParts = totals._count._all;

  // The declared size was bounded, but the parts are what actually arrived: a
  // client that sends full parts where it promised a short last one can push
  // the total past both the deployment's ceiling and the column's range.
  if (receivedBytes > limit.bytes || receivedBytes > MAX_STORED_BYTES) {
    await discardUpload(userId, session.id);
    return fail(tooLargeMessage(limit), 413);
  }

  await prisma.healthUploadSession.update({
    where: { id: session.id },
    data: { receivedBytes, receivedParts },
  });

  return { ok: true, data: { receivedParts, totalParts: session.totalParts, receivedBytes } };
}

/**
 * Read a request body into memory with a hard ceiling.
 *
 * Bounded to one part — a few megabytes — which is the whole reason the archive
 * is sliced. `Content-Length` is a claim, so this counts what arrives and
 * throws the moment it exceeds the budget rather than after.
 */
async function readBounded(
  body: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) throw new Error("part too large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  // Assembled into one owned buffer rather than concatenated as `Buffer`s:
  // Prisma's `Bytes` wants a `Uint8Array` over a plain `ArrayBuffer`, and this
  // is one allocation and one copy either way.
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  return joined;
}

// --- assembling ---------------------------------------------------------------

export interface AssembledUpload {
  /** The reassembled archive on this invocation's own disk. */
  path: string;
  /** Its directory — the caller removes it in a `finally`. */
  directory: string;
  fileName: string;
  bytes: number;
}

/**
 * Reassemble a completed upload into a temporary file.
 *
 * This is the one place the whole archive exists at once, and it exists as a
 * file rather than a buffer: parts are streamed straight through, a handful at
 * a time, so peak memory is a few megabytes whatever the export weighs.
 *
 * Every bound is re-checked here against the stored rows rather than the
 * session's running counters, because the counters are written by concurrent
 * requests and this is the check that matters.
 */
export async function assembleUpload(
  userId: string,
  uploadId: unknown,
  limit: UploadLimit = resolveUploadLimit(),
): Promise<UploadResult<AssembledUpload>> {
  if (typeof uploadId !== "string" || uploadId.length === 0) return fail("Unknown upload.", 404);

  const session = await prisma.healthUploadSession.findFirst({
    where: { id: uploadId, userId },
    select: { id: true, fileName: true, totalParts: true, expiresAt: true },
  });
  if (!session) return fail("That upload has expired. Choose the file again.", 404);
  if (session.expiresAt.getTime() < Date.now()) {
    await discardUpload(userId, session.id);
    return fail("That upload has expired. Choose the file again.", 410);
  }

  const totals = await prisma.healthUploadPart.aggregate({
    where: { sessionId: session.id },
    _count: { _all: true },
    _sum: { size: true },
  });
  const bytes = totals._sum.size ?? 0;
  if (totals._count._all !== session.totalParts) {
    return fail(
      `The upload is incomplete — ${totals._count._all} of ${session.totalParts} parts arrived. ` +
        "Nothing was imported; choose the file again.",
      400,
    );
  }
  if (bytes === 0) return fail("That file is empty.", 400);
  if (bytes > limit.bytes || bytes > MAX_STORED_BYTES) {
    await discardUpload(userId, session.id);
    return fail(tooLargeMessage(limit), 413);
  }

  // Claiming the session stops a second finalize racing the first into the
  // same parse — and, with it, two import sessions from one upload.
  const claimed = await prisma.healthUploadSession.updateMany({
    where: { id: session.id, userId, status: "receiving" },
    data: { status: "parsing", receivedBytes: bytes, receivedParts: totals._count._all },
  });
  if (claimed.count === 0) {
    return fail("That upload is already being read.", 409);
  }

  const directory = await mkdtemp(join(tmpdir(), "personal-os-health-"));
  const path = join(directory, "upload.bin");
  try {
    await pipeline(readParts(session.id, session.totalParts), createWriteStream(path));
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  return { ok: true, data: { path, directory, fileName: session.fileName, bytes } };
}

/**
 * The parts, in order, a few at a time.
 *
 * Ordering is asserted rather than assumed: `(sessionId, seq)` is unique and
 * every index was bounded on arrival, so a complete count already implies a
 * complete run of indices — but a gap here would produce a subtly corrupt
 * archive rather than a loud failure, and that is the wrong trade.
 */
async function* readParts(sessionId: string, totalParts: number): AsyncGenerator<Uint8Array> {
  let expected = 0;
  while (expected < totalParts) {
    const batch = await prisma.healthUploadPart.findMany({
      where: { sessionId, seq: { gte: expected, lt: expected + PARTS_PER_READ } },
      orderBy: { seq: "asc" },
      select: { seq: true, data: true },
    });
    if (batch.length === 0) {
      throw new Error(`staged upload is missing part ${expected}`);
    }
    for (const part of batch) {
      if (part.seq !== expected) {
        throw new Error(`staged upload is missing part ${expected}`);
      }
      expected += 1;
      yield part.data;
    }
  }
}

// --- cleanup ------------------------------------------------------------------

/** Delete an upload and its parts. Owner-scoped; a no-op for anyone else. */
export async function discardUpload(userId: string, uploadId: unknown): Promise<void> {
  if (typeof uploadId !== "string" || uploadId.length === 0) return;
  await prisma.healthUploadSession
    .deleteMany({ where: { id: uploadId, userId } })
    .catch(() => {});
}

/**
 * Remove every expired upload, for every account.
 *
 * Called opportunistically whenever an upload is opened — which is enough on
 * its own for a running app — and again from the daily cron, so a deployment
 * that stops being used does not keep an abandoned archive's parts forever.
 * Deliberately a single indexed `deleteMany` on `expiresAt`: cleanup that costs
 * anything is cleanup that gets turned off.
 */
export async function sweepExpiredUploads(): Promise<number> {
  const removed = await prisma.healthUploadSession
    .deleteMany({ where: { expiresAt: { lt: new Date() } } })
    .catch(() => ({ count: 0 }));
  return removed.count;
}

/** What the import page tells the user about part size, in words. */
export function partSizeNote(): string {
  return formatLimit(UPLOAD_PART_BYTES);
}
