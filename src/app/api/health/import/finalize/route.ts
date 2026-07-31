import { rm } from "node:fs/promises";
import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/server/auth/current-user";
import { AppleImportError } from "@/server/apple-health/parse-archive";
import { parseUploadedFile } from "@/server/apple-health/parse-upload";
import { assembleUpload, discardUpload } from "@/server/health-upload/session";
import { stageImport } from "@/server/health-import";
import { logRedactedError } from "@/server/safe-error";

/**
 * Turn a completed staged upload into a preview.
 *
 * This is the one invocation in which the whole archive exists at once, and it
 * exists as a file rather than a buffer: the stored parts are streamed, in
 * order, into this function's own scratch space, and the parser reads it from
 * there exactly as it read the old one-shot upload. Nothing about the parsing,
 * the bounds, the duplicate detection or the preview changed — only how the
 * bytes arrived.
 *
 * Everything is cleaned up in a `finally`, on every path including a parse
 * failure or a crash:
 *
 *  * the reassembled archive, which is transient by design;
 *  * the staged parts, which have no reason to outlive the parse. A failed
 *    parse is deterministic — retrying it would fail identically — so they go
 *    too, and the user is told to choose the file again.
 *
 * Nothing here writes to the health tables. `stageImport` writes the *plan*
 * into the account's own staged rows; the health records themselves are only
 * ever touched by the confirm step.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/**
 * Vercel-only hint, and deliberately conservative.
 *
 * Reassembling a large archive and parsing it legitimately takes longer than a
 * page render, so the default (10–15 s) is too short. But `maxDuration` is
 * validated against the account's plan at deploy time — a value above the
 * plan's ceiling fails the whole deployment rather than being clamped — and the
 * ceiling is 60 s on Hobby. 60 is therefore the highest value every plan
 * accepts, and it is ample: a 181 MB export.xml parses in about five seconds
 * (docs/performance-measurement.md), and reassembly is a bounded number of
 * indexed reads.
 *
 * It has to be a **literal**: Next.js statically analyses route segment config
 * and refuses the build outright for an imported constant. So the number lives
 * here and `MAX_FUNCTION_SECONDS` is what `tests/deploy-config.test.ts` holds
 * every route to — a raised value is otherwise a *deploy-time* failure, which
 * is the worst place to discover one.
 *
 * Self-hosted deployments ignore this entirely — `npm start` has no such
 * limit — which is the answer for an export large enough to need more.
 */
export const maxDuration = 60;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }
  const uploadId = (body as { uploadId?: unknown } | null)?.uploadId;

  const assembled = await assembleUpload(user.id, uploadId);
  if (!assembled.ok) {
    return NextResponse.json({ ok: false, error: assembled.error }, { status: assembled.status });
  }
  const { path, directory, fileName, bytes } = assembled.data;

  try {
    const started = Date.now();
    const parsed = await parseUploadedFile(path, fileName);
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
    if (error instanceof AppleImportError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
    }
    const reference = logRedactedError("health-import-finalize", error);
    return NextResponse.json(
      {
        ok: false,
        error: `The file could not be read and nothing was imported (reference ${reference}).`,
      },
      { status: 500 },
    );
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    await discardUpload(user.id, uploadId);
  }
}
