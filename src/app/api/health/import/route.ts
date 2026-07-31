import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/server/auth/current-user";
import { discardUpload, openUpload } from "@/server/health-upload/session";
import { logRedactedError } from "@/server/safe-error";

/**
 * Open (POST) or abandon (DELETE) a staged health-import upload.
 *
 * This endpoint used to *be* the upload: the browser POSTed the entire Apple
 * Health `export.zip` here as one request body. On a serverless platform that
 * is not a slow path, it is an impossible one — Vercel refuses a body over
 * ~4.5 MB at the edge with `413 FUNCTION_PAYLOAD_TOO_LARGE` before any code in
 * this repository runs, and a real export is far larger. So the file no longer
 * travels as a body at all. This call agrees the *shape* of the upload —
 * how many parts, of what size — and the parts follow, one request each, to
 * `/api/health/import/part`.
 *
 * Nothing here reads a file, so nothing here is expensive. What it does do is
 * refuse a doomed upload in a single round trip: an export larger than this
 * deployment can stage is rejected now, with a message that says why, rather
 * than after several minutes of parts.
 *
 * Authentication comes first on every method: an unauthenticated caller cannot
 * create a session, and therefore cannot store a single byte.
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
    const opened = await openUpload(user.id, {
      fileName: input.fileName,
      fileSize: input.fileSize,
    });
    if (!opened.ok) {
      return NextResponse.json({ ok: false, error: opened.error }, { status: opened.status });
    }
    return NextResponse.json({ ok: true, ...opened.data });
  } catch (error) {
    const reference = logRedactedError("health-upload-open", error);
    return NextResponse.json(
      { ok: false, error: `The upload could not be started (reference ${reference}).` },
      { status: 500 },
    );
  }
}

/**
 * Abandon an upload. Called when the user cancels or navigates away, so the
 * staged parts go immediately rather than waiting for the sweep. Owner-scoped:
 * an id from another account deletes nothing and still answers 200, because a
 * distinguishable response is a way to test whether an id exists.
 */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });

  await discardUpload(user.id, request.nextUrl.searchParams.get("upload"));
  return NextResponse.json({ ok: true });
}
