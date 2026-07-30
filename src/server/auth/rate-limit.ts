/**
 * Database-backed fixed-window rate limiting.
 *
 * Sign-up and password recovery are reachable signed-out, so they need
 * abuse protection that survives serverless cold starts — instances share
 * nothing but the database, exactly like the sign-in lockout counters on
 * the User row. A fixed window is deliberately simple: the guarantee is
 * "an address cannot create accounts or burn recovery attempts endlessly",
 * not traffic shaping.
 *
 * Privacy: raw client IPs are never stored. Bucket keys carry an HMAC of
 * the IP keyed with AUTH_SECRET, so the table is meaningless on its own
 * and two deployments never produce comparable keys.
 */
import "server-only";

import { createHmac } from "node:crypto";
import { headers } from "next/headers";

import { prisma } from "@/lib/prisma";

/**
 * Count one attempt against `key`. Returns true while the attempt is within
 * `limit` per `windowMs`, false once the window is exhausted. The first
 * attempt of a fresh window resets the row in place, so the table never
 * grows beyond one row per active key.
 *
 * Concurrency: the atomic increment means parallel attempts can never lose
 * counts; the reset path uses an upsert so two "first" attempts both land.
 * A rare double-reset at a window boundary under-counts by one attempt at
 * most, which is fine for an abuse fence.
 */
export async function consumeRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<boolean> {
  const now = new Date();

  // Fast path: an unexpired bucket takes the increment atomically.
  const bumped = await prisma.rateLimitBucket.updateMany({
    where: { key, resetAt: { gt: now } },
    data: { count: { increment: 1 } },
  });

  if (bumped.count === 0) {
    // No bucket, or an expired one — start a fresh window at count 1.
    await prisma.rateLimitBucket.upsert({
      where: { key },
      create: { key, count: 1, resetAt: new Date(now.getTime() + windowMs) },
      update: { count: 1, resetAt: new Date(now.getTime() + windowMs) },
    });
    return limit >= 1;
  }

  const bucket = await prisma.rateLimitBucket.findUnique({ where: { key } });
  return (bucket?.count ?? Number.MAX_SAFE_INTEGER) <= limit;
}

/**
 * A privacy-preserving per-client bucket key: `scope:<hmac(ip)>`.
 *
 * The client address comes from the standard forwarding headers the hosting
 * platform sets. Outside a request scope (tests calling actions directly)
 * or with no address available, everything shares one `scope:unknown`
 * bucket — still a fence, just a coarser one, and it fails closed rather
 * than open.
 */
export async function clientRateLimitKey(scope: string): Promise<string> {
  let ip = "";
  try {
    const h = await headers();
    ip =
      h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      h.get("x-real-ip")?.trim() ||
      "";
  } catch {
    // Not in a request scope — fall through to the shared bucket.
  }
  if (!ip) return `${scope}:unknown`;
  const secret = process.env.AUTH_SECRET ?? "personal-os";
  const digest = createHmac("sha256", secret).update(ip).digest("hex").slice(0, 32);
  return `${scope}:${digest}`;
}
