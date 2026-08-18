import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/server/auth/current-user";
import { finalizeBackupUpload } from "@/server/backup-upload";
import { logRedactedError } from "@/server/safe-error";

/**
 * Turn a completed staged backup upload into a preview, or into the import.
 *
 * `action: "preview"` assembles the parts, inspects the file and RELEASES
 * the session — nothing written, parts intact for the confirm click.
 * `action: "import"` assembles again and runs the ordinary importBackup
 * (same remapping, same safety) before discarding the session. See
 * src/server/backup-upload.ts.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** The highest value every Vercel plan accepts; must be a literal. */
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
  const input = (body ?? {}) as { uploadId?: unknown; action?: unknown; mode?: unknown };
  const action = input.action === "import" ? "import" : "preview";
  const mode = input.mode === "replace" ? "replace" : "merge";

  try {
    const result = await finalizeBackupUpload(
      user.id,
      input.uploadId,
      action === "import" ? { action, mode } : { action },
    );
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    }
    return NextResponse.json({ ok: true, ...result.data });
  } catch (error) {
    const reference = logRedactedError("backup-upload-finalize", error);
    return NextResponse.json(
      { ok: false, error: `The backup could not be read (reference ${reference}).` },
      { status: 500 },
    );
  }
}
