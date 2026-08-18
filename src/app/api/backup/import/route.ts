import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/server/auth/current-user";
import { openBackupUpload } from "@/server/backup-upload";
import { discardUpload } from "@/server/health-upload/session";
import { logRedactedError } from "@/server/safe-error";

/**
 * Open (POST) or abandon (DELETE) a staged BACKUP import upload — the health
 * importer's transport reused for backup JSON, because the same platform edge
 * that refuses a large health archive as one request body refuses a large
 * backup the same way. Authentication comes first on every method; the
 * session is created under `kind: "backup"`, so the health finalize can
 * never be pointed at it.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }
  const input = (body ?? {}) as { fileName?: unknown; fileSize?: unknown };

  try {
    const opened = await openBackupUpload(user.id, {
      fileName: input.fileName,
      fileSize: input.fileSize,
    });
    if (!opened.ok) {
      return NextResponse.json({ ok: false, error: opened.error }, { status: opened.status });
    }
    return NextResponse.json({ ok: true, ...opened.data });
  } catch (error) {
    const reference = logRedactedError("backup-upload-open", error);
    return NextResponse.json(
      { ok: false, error: `The upload could not be started (reference ${reference}).` },
      { status: 500 },
    );
  }
}

/** Owner-scoped; an id from another account deletes nothing and answers 200. */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });

  await discardUpload(user.id, request.nextUrl.searchParams.get("upload"));
  return NextResponse.json({ ok: true });
}
