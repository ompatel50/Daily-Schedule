import { NextResponse, type NextRequest } from "next/server";

import { getCurrentUser } from "@/server/auth/current-user";
import { receivePart } from "@/server/health-upload/session";
import { logRedactedError } from "@/server/safe-error";

/**
 * One part of a staged health-import upload.
 *
 * The body is a raw slice of the file — at most `partBytes`, which the session
 * fixed at a value comfortably below every hosting platform's request cap. That
 * is the whole trick: the archive can be any size the deployment will stage,
 * because no single request ever carries more than a few megabytes.
 *
 * `PUT`, not `POST`, because it is idempotent and means it: `(session, index)`
 * is unique, so a part resent after a dropped connection replaces its
 * predecessor. The client retries on that basis, which is what makes a
 * hundred-part upload survive a flaky network.
 *
 * Everything a stranger controls is bounded before it is trusted:
 *
 *  * **authentication first** — an unauthenticated request stores nothing;
 *  * **ownership** — the session is resolved by `(id, userId)`, so an id from
 *    another account does not exist rather than being refused;
 *  * **the index** — outside `[0, totalParts)` is a 400, which is what caps
 *    total stored bytes at `totalParts × partBytes` regardless of how the
 *    client behaves;
 *  * **the length** — counted as it arrives, not read from `Content-Length`;
 *  * **the running total** — recomputed from the stored rows, so a retried
 *    part cannot inflate it past the deployment's ceiling.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/**
 * A part is small, but the connection carrying it may not be fast. This is the
 * highest value every Vercel plan accepts (see `MAX_FUNCTION_SECONDS`), and it
 * has to be a literal — Next.js statically analyses route segment config and
 * refuses the build for an imported constant. `tests/deploy-config.test.ts`
 * holds every route in the app to that ceiling.
 */
export const maxDuration = 60;

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });

  const parameters = request.nextUrl.searchParams;
  try {
    const received = await receivePart(user.id, {
      uploadId: parameters.get("upload"),
      seq: parameters.get("seq"),
      body: request.body,
    });
    if (!received.ok) {
      return NextResponse.json({ ok: false, error: received.error }, { status: received.status });
    }
    return NextResponse.json({ ok: true, ...received.data });
  } catch (error) {
    const reference = logRedactedError("health-upload-part", error);
    return NextResponse.json(
      { ok: false, error: `That part could not be stored (reference ${reference}).` },
      { status: 500 },
    );
  }
}
