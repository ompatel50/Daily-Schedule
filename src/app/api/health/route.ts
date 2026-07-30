import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";

/**
 * Deployment health check. Deliberately minimal: reports whether the app can
 * reach its database and nothing else — no versions, no counts, no
 * configuration. Suitable for uptime monitors.
 */
export async function GET(): Promise<NextResponse> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok" });
  } catch {
    return NextResponse.json({ status: "degraded" }, { status: 503 });
  }
}

export const dynamic = "force-dynamic";
