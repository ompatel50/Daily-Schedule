import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/server/auth/current-user";
import { receiveBackupPart } from "@/server/backup-upload";
import { logRedactedError } from "@/server/safe-error";

/**
 * One part of a staged backup upload — bounded, owner-checked and idempotent
 * on (session, index), exactly like the health part endpoint it mirrors (see
 * that route for the full reasoning; the transport is one and the same).
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** The highest value every Vercel plan accepts; must be a literal. */
export const maxDuration = 60;

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });

  const parameters = request.nextUrl.searchParams;
  try {
    const received = await receiveBackupPart(user.id, {
      uploadId: parameters.get("upload"),
      seq: parameters.get("seq"),
      body: request.body,
    });
    if (!received.ok) {
      return NextResponse.json({ ok: false, error: received.error }, { status: received.status });
    }
    return NextResponse.json({ ok: true, ...received.data });
  } catch (error) {
    const reference = logRedactedError("backup-upload-part", error);
    return NextResponse.json(
      { ok: false, error: `That part could not be stored (reference ${reference}).` },
      { status: 500 },
    );
  }
}
