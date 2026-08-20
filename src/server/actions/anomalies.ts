"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getCurrentUser, prisma } from "@/lib/db";
import { ANOMALY_CATEGORIES } from "@/lib/logic/anomalies";
import { fromZod, succeed, type ActionResult } from "@/lib/validation";

/**
 * The two verbs anomaly nudges answer to.
 *
 * Dismissing records the dismissal (which RAISES that category's detection
 * threshold — src/lib/logic/anomalies.ts — so a nudge the user keeps waving
 * away needs a progressively larger deviation to come back) and claims the
 * signal's ledger key, silencing this occurrence for the rest of its window
 * on every delivery channel.
 *
 * Muting a category stops its detector running at all until unmuted.
 */

const category = z.enum(ANOMALY_CATEGORIES);

const dismissSchema = z.object({
  category,
  /** The signal's ledger key, so the dismissal also silences delivery. */
  key: z.string().min(1).max(200).startsWith("anomaly:"),
});

export async function dismissAnomaly(input: unknown): Promise<ActionResult<null>> {
  const parsed = dismissSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const user = await getCurrentUser();

  await prisma.anomalyPreference.upsert({
    where: { userId_category: { userId: user.id, category: parsed.data.category } },
    create: { userId: user.id, category: parsed.data.category, dismissals: 1 },
    update: { dismissals: { increment: 1 } },
  });
  // Claim the ledger key so no channel re-delivers this occurrence. A
  // collision means it was already delivered — the dismissal still counted.
  await prisma.reminderDelivery
    .create({ data: { userId: user.id, key: parsed.data.key } })
    .catch(() => {});

  revalidatePath("/", "layout");
  return succeed(null);
}

const muteSchema = z.object({ category, muted: z.boolean() });

export async function setAnomalyMuted(input: unknown): Promise<ActionResult<null>> {
  const parsed = muteSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const user = await getCurrentUser();

  await prisma.anomalyPreference.upsert({
    where: { userId_category: { userId: user.id, category: parsed.data.category } },
    create: { userId: user.id, category: parsed.data.category, muted: parsed.data.muted },
    update: { muted: parsed.data.muted },
  });

  revalidatePath("/", "layout");
  return succeed(null);
}
