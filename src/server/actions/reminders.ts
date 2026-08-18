"use server";

import { succeed, type ActionResult } from "@/lib/validation";
import type { ReminderOccurrence } from "@/lib/logic/reminders";
import { getReminderFeed, recordReminderDelivery } from "@/server/reminders";

/**
 * The watcher's two calls: refresh the schedule-aware feed (so a habit ticked
 * in another tab stops nagging within minutes) and record a delivery. No
 * revalidation — firing a toast must not re-render the app under the user.
 */

export async function getReminderFeedAction(): Promise<ActionResult<ReminderOccurrence[]>> {
  return succeed(await getReminderFeed());
}

export async function deliverReminderAction(input: {
  key: string;
  reminderId: string | null;
}): Promise<ActionResult<{ fresh: boolean }>> {
  // `fresh` says whether THIS call claimed the occurrence — the watcher only
  // shows the notification when it did, so a push (or another tab) that got
  // there first keeps this tab silent.
  if (typeof input?.key === "string" && input.key.length > 0 && input.key.length <= 200) {
    const fresh = await recordReminderDelivery(input.key, input.reminderId ?? null);
    return succeed({ fresh });
  }
  return succeed({ fresh: false });
}
