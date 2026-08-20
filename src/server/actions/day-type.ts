"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getCurrentUser, prisma } from "@/lib/db";
import { dayKey, fromZod, succeed, type ActionResult } from "@/lib/validation";
import { recomputeDay } from "@/server/summaries";

/**
 * The manual half of the training/rest classification: one override per day,
 * outranking the derived answer (any completed workout = training). Clearing
 * the override (dayType: null) falls back to derivation. The day's summary is
 * recomputed because day-typed targets gate the day score.
 */

const overrideSchema = z.object({
  date: dayKey,
  dayType: z.enum(["training", "rest"]).nullable(),
});

export async function setDayTypeOverride(input: unknown): Promise<ActionResult<null>> {
  const parsed = overrideSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  const user = await getCurrentUser();
  const { date, dayType } = parsed.data;

  if (dayType === null) {
    await prisma.dayTypeOverride.deleteMany({ where: { userId: user.id, date } });
  } else {
    await prisma.dayTypeOverride.upsert({
      where: { userId_date: { userId: user.id, date } },
      create: { userId: user.id, date, dayType },
      update: { dayType },
    });
  }

  await recomputeDay(user.id, date);
  revalidatePath("/", "layout");
  return succeed(null);
}
