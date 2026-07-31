import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { sweepExpiredUploads } from "@/server/health-upload/session";
import { runScheduledReminderPush } from "@/server/push";

/** Constant-time equality over digests, safe for unequal lengths. */
function secretMatches(candidate: string, expected: string): boolean {
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * The scheduled reminder endpoint. Invoked by a cron (Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET` automatically when the env var is
 * set; any external scheduler must send the same header). Never callable
 * without the secret — a missing or wrong secret is a 401 with no detail,
 * and an unconfigured server refuses outright rather than running open.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }
  const header = request.headers.get("authorization");
  if (!header || !secretMatches(header, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runScheduledReminderPush();

  /**
   * The daily maintenance tick, folded in here rather than given a cron of its
   * own: the free Vercel plan allows two cron jobs in total, and spending one
   * on a single indexed `deleteMany` would be a poor trade.
   *
   * A staged health upload is already swept opportunistically whenever another
   * one is opened, which is enough for an app in use. This covers the case that
   * is not — a deployment nobody has imported into since abandoning an upload —
   * so its parts do not sit in the database indefinitely. Never fatal: a sweep
   * that fails must not cost the reminders their run.
   */
  const sweptUploads = await sweepExpiredUploads().catch(() => 0);

  return NextResponse.json({ ...result, sweptUploads });
}

export const dynamic = "force-dynamic";
