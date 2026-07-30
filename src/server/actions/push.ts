"use server";

import { z } from "zod";

import { getCurrentUser, prisma } from "@/lib/db";
import { fail, succeed, type ActionResult } from "@/lib/validation";
import { pushConfigured, vapidPublicKey } from "@/server/push";

/**
 * Web Push subscription management. A subscription belongs to the signed-in
 * account; the endpoint is unique per browser profile, so signing into a
 * different account in the same browser re-points that browser's
 * subscription rather than duplicating it.
 */

const subscriptionSchema = z.object({
  endpoint: z.string().url().max(1000).startsWith("https://"),
  keys: z.object({
    p256dh: z.string().min(1).max(300),
    auth: z.string().min(1).max(200),
  }),
  deviceLabel: z.string().max(80).optional(),
});

export interface PushStatus {
  configured: boolean;
  publicKey: string | null;
  subscriptions: Array<{ id: string; deviceLabel: string | null; createdAt: string }>;
}

export async function getPushStatusAction(): Promise<ActionResult<PushStatus>> {
  const user = await getCurrentUser();
  const subscriptions = await prisma.pushSubscription.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
    select: { id: true, deviceLabel: true, createdAt: true },
  });
  return succeed({
    configured: pushConfigured(),
    publicKey: vapidPublicKey(),
    subscriptions: subscriptions.map((row) => ({
      id: row.id,
      deviceLabel: row.deviceLabel,
      createdAt: row.createdAt.toISOString(),
    })),
  });
}

export async function subscribePushAction(input: unknown): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  if (!pushConfigured()) return fail("Push notifications aren't configured on this server.");

  const parsed = subscriptionSchema.safeParse(input);
  if (!parsed.success) return fail("That subscription is not valid.");

  const { endpoint, keys, deviceLabel } = parsed.data;
  await prisma.pushSubscription.upsert({
    where: { endpoint },
    create: {
      userId: user.id,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      deviceLabel: deviceLabel ?? null,
    },
    // Same browser, possibly a different account now: the subscription
    // follows whoever is signed in on that device.
    update: {
      userId: user.id,
      p256dh: keys.p256dh,
      auth: keys.auth,
      deviceLabel: deviceLabel ?? null,
      lastSeenAt: new Date(),
    },
  });
  return succeed(null);
}

export async function unsubscribePushAction(input: {
  endpoint?: string;
  id?: string;
}): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  if (typeof input?.endpoint === "string") {
    await prisma.pushSubscription.deleteMany({
      where: { userId: user.id, endpoint: input.endpoint },
    });
  } else if (typeof input?.id === "string") {
    await prisma.pushSubscription.deleteMany({ where: { userId: user.id, id: input.id } });
  }
  return succeed(null);
}
