import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/server/auth/current-user";
import { buildApplePlan, buildImportPlan } from "@/lib/logic/health-import/rollup";
import { parseHealthCsv } from "@/lib/logic/health-import/csv";
import type { ImportPlan } from "@/lib/logic/health-import/types";
import {
  AppleImportError,
  parseAppleHealthArchive,
} from "@/server/apple-health/parse-archive";
import { MAX_UPLOAD_BYTES } from "@/server/apple-health/limits";
import { detectUploadType, readCsvFile } from "@/server/apple-health/read-text";
import { stageImport } from "@/server/health-import";
import { logRedactedError } from "@/server/safe-error";

/**
 * Health-import upload.
 *
 * A route handler rather than a server action, because an action's body is
 * buffered whole and capped at a few megabytes — and an Apple Health export is
 * routinely hundreds of megabytes. Here the request body is **streamed
 * straight to a temporary file** and never held in memory, then parsed on the
 * server (see `src/server/apple-health/parse-archive.ts`) and staged for
 * preview. Nothing is written to the health tables by this endpoint.
 *
 * Everything a stranger controls is bounded before it is trusted:
 *
 *  * **authentication first** — an unauthenticated request is refused before
 *    a single byte is read, so an anonymous caller cannot make the server
 *    write a temporary file at all;
 *  * **declared size** — a `Content-Length` above the cap is refused up front;
 *  * **actual size** — the write is counted and aborted mid-stream if it
 *    exceeds the cap anyway, because `Content-Length` is a claim, not a fact;
 *  * **file type** — decided from the bytes on disk, never from the name or
 *    the content type the client sent;
 *  * **the parse itself** — bounded by the XML scanner and the ZIP reader,
 *    which is where the entity-expansion and decompression-bomb defences live.
 *
 * The temporary file is removed in a `finally`, on every path including a
 * parse failure, and its contents are never logged.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/**
 * Vercel-only hint, and deliberately conservative.
 *
 * A large export legitimately takes longer than a page render, so the default
 * (10–15 s) is too short. But `maxDuration` is validated against the account's
 * plan at deploy time — a value above the plan's ceiling fails the whole
 * deployment rather than being clamped — and the ceiling is 60 s on Hobby.
 * 60 is therefore the highest value every plan accepts, and it is ample: a
 * 181 MB export.xml parses in about five seconds (docs/performance-measurement.md).
 *
 * Self-hosted deployments ignore this entirely — `npm start` has no such
 * limit — which is the answer for an export large enough to need more.
 */
export const maxDuration = 60;

class UploadTooLarge extends Error {}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { ok: false, error: `That file is larger than the ${gib(MAX_UPLOAD_BYTES)} upload limit.` },
      { status: 413 },
    );
  }
  if (!request.body) {
    return NextResponse.json({ ok: false, error: "No file was uploaded." }, { status: 400 });
  }

  // The name is only ever used as a label. The base name is taken so a path
  // from the user's machine can never be stored or displayed.
  const rawName = request.headers.get("x-file-name") ?? "export.zip";
  const fileName = (decodeFileName(rawName).split(/[\\/]/).pop() ?? "export.zip").slice(0, 200);

  const directory = await mkdtemp(join(tmpdir(), "personal-os-health-"));
  const path = join(directory, `upload-${randomUUID()}`);

  try {
    const bytes = await writeBounded(request.body, path, MAX_UPLOAD_BYTES);
    if (bytes === 0) {
      return NextResponse.json({ ok: false, error: "That file is empty." }, { status: 400 });
    }

    const started = Date.now();
    const parsed = await parseUpload(path, fileName);
    const parseMs = Date.now() - started;

    if (parsed.plan.errors.length > 0) {
      return NextResponse.json(
        { ok: false, error: parsed.plan.errors.join(" ") },
        { status: 400 },
      );
    }

    const staged = await stageImport(user.id, {
      kind: parsed.plan.kind,
      fileType: parsed.fileType,
      fileName,
      fileSize: bytes,
      plan: parsed.plan,
      parseMs,
      xmlBytes: parsed.xmlBytes,
      ignoredFiles: parsed.ignoredFiles,
      errors: parsed.errors,
    });
    if (!staged.ok) return NextResponse.json({ ok: false, error: staged.error }, { status: 400 });

    return NextResponse.json({ ok: true, preview: staged.preview });
  } catch (error) {
    if (error instanceof UploadTooLarge) {
      return NextResponse.json(
        { ok: false, error: `That file is larger than the ${gib(MAX_UPLOAD_BYTES)} upload limit.` },
        { status: 413 },
      );
    }
    if (error instanceof AppleImportError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    }
    const reference = logRedactedError("health-import-upload", error);
    return NextResponse.json(
      {
        ok: false,
        error: `The file could not be read and nothing was imported (reference ${reference}).`,
      },
      { status: 500 },
    );
  } finally {
    // The upload is transient by design: it exists only for the duration of
    // the parse and is removed on every path, success or failure.
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

interface ParsedUpload {
  fileType: "zip" | "xml" | "csv";
  plan: ImportPlan;
  xmlBytes: number;
  ignoredFiles: string[];
  errors: string[];
}

async function parseUpload(path: string, fileName: string): Promise<ParsedUpload> {
  const fileType = await detectUploadType(path, fileName);
  if (!fileType) {
    throw new AppleImportError(
      "Unrecognised file. Supported: an Apple Health export.zip, an export.xml, or a CSV.",
    );
  }

  if (fileType === "csv") {
    const text = await readCsvFile(path);
    return {
      fileType,
      plan: buildImportPlan(parseHealthCsv(text)),
      xmlBytes: 0,
      ignoredFiles: [],
      errors: [],
    };
  }

  const parsed = await parseAppleHealthArchive(path, fileType);
  return {
    fileType,
    plan: buildApplePlan(parsed),
    xmlBytes: parsed.xmlBytes,
    ignoredFiles: parsed.ignoredFiles,
    errors: parsed.errors,
  };
}

/**
 * Stream the request body to disk, counting as it goes. `Content-Length` was
 * already checked, but it is a claim the client makes — this is the check on
 * what actually arrives.
 */
async function writeBounded(
  body: ReadableStream<Uint8Array>,
  path: string,
  limit: number,
): Promise<number> {
  let written = 0;
  const source = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
  const counter = async function* () {
    for await (const chunk of source) {
      const buffer = chunk as Buffer;
      written += buffer.length;
      if (written > limit) throw new UploadTooLarge();
      yield buffer;
    }
  };
  await pipeline(counter(), createWriteStream(path));
  return written;
}

/** `x-file-name` is percent-encoded by the client so it survives as a header. */
function decodeFileName(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function gib(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024 * 1024))} GB`;
}
