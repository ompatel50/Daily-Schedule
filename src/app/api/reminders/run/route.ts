import { NextResponse, type NextRequest } from "next/server";

import { runScheduledReminderPush } from "@/server/push";

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
  if (header !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runScheduledReminderPush();
  return NextResponse.json(result);
}

export const dynamic = "force-dynamic";
