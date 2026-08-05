import "server-only";

import webpush from "web-push";

import { prisma } from "@/lib/prisma";
import { nowMinuteIn, todayIn } from "@/lib/logic/schedule";
import { getReminderFeedFor, recordReminderDeliveryFor } from "@/server/reminders";
import { logRedactedError } from "@/server/safe-error";

/**
 * Web Push delivery for reminders.
 *
 * The schedule knowledge lives entirely in the reminder feed — the same feed
 * the in-tab watcher uses — so a pushed reminder obeys every suppression rule
 * (rest days, overrides, completion, archived, weekly target met, already
 * delivered) by construction. The `ReminderDelivery` unique key is what makes
 * a reminder fire exactly once ACROSS channels: whichever of the push runner
 * or an open tab claims the key first delivers it; the other stays silent.
 *
 * Payloads carry only the reminder's title and message — never health values,
 * journal text or anything the user didn't put in the reminder themselves —
 * and are encrypted to the browser's own keys by the Web Push protocol.
 */

export function pushConfigured(): boolean {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

export function vapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY ?? null;
}

function configureWebPush(): boolean {
  if (!pushConfigured()) return false;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT ?? "mailto:admin@example.com",
    process.env.VAPID_PUBLIC_KEY as string,
    process.env.VAPID_PRIVATE_KEY as string,
  );
  return true;
}

interface PushPayload {
  title: string;
  body?: string;
  url?: string;
  tag?: string;
}

/**
 * Send to every subscription a user holds. Subscriptions the push service
 * reports gone (404/410) are deleted — that is how a browser revokes.
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<number> {
  if (!configureWebPush()) return 0;

  const subscriptions = await prisma.pushSubscription.findMany({ where: { userId } });
  let delivered = 0;

  for (const subscription of subscriptions) {
    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        JSON.stringify(payload),
        { TTL: 60 * 60 },
      );
      delivered += 1;
    } catch (error) {
      const statusCode = (error as { statusCode?: number })?.statusCode;
      if (statusCode === 404 || statusCode === 410) {
        await prisma.pushSubscription
          .delete({ where: { id: subscription.id } })
          .catch(() => undefined);
      }
      // Anything else (transient 5xx, network): drop this attempt. The
      // delivery ledger was NOT written for a failed push (see runner), so
      // the next run retries within the delivery window.
    }
  }
  return delivered;
}

/** Minute of day encoded in an occurrence's local wall-clock fireAt. */
function fireMinuteOf(fireAt: string): number | null {
  const match = /T(\d{2}):(\d{2})/.exec(fireAt);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** How long past its minute an occurrence may still be pushed. */
const LATE_WINDOW_MINUTES = 30;

export interface PushRunResult {
  usersEvaluated: number;
  delivered: number;
  suppressed: number;
  /** Users whose evaluation threw — skipped, never the whole run. */
  usersFailed: number;
}

/**
 * The scheduled runner: for every user with at least one push subscription,
 * evaluate the schedule-aware feed and push what is due right now in THAT
 * user's timezone. Claiming the ledger key happens before the push — a
 * pushed-and-claimed occurrence will not also toast in an open tab, and a
 * tab that already delivered suppresses the push.
 */
export async function runScheduledReminderPush(): Promise<PushRunResult> {
  const result: PushRunResult = { usersEvaluated: 0, delivered: 0, suppressed: 0, usersFailed: 0 };
  if (!pushConfigured()) return result;

  const subscribedUserIds = await prisma.pushSubscription.findMany({
    select: { userId: true },
    distinct: ["userId"],
  });
  if (subscribedUserIds.length === 0) return result;

  const users = await prisma.user.findMany({
    where: { id: { in: subscribedUserIds.map((row) => row.userId) } },
    select: { id: true, timezone: true, weekStartsOn: true },
  });

  for (const user of users) {
    // One account whose evaluation throws (corrupt timezone, bad imported
    // data, a transient query error) must not starve every user after it in
    // the loop — isolate, count, continue.
    try {
      await pushRemindersForUser(user, result);
    } catch (error) {
      result.usersFailed += 1;
      logRedactedError("reminder-push-user", error);
    }
  }

  return result;
}

async function pushRemindersForUser(
  user: { id: string; timezone: string; weekStartsOn: number },
  result: PushRunResult,
): Promise<void> {
  result.usersEvaluated += 1;
  const feed = await getReminderFeedFor(user);
  if (feed.length === 0) return;

  const nowMinute = nowMinuteIn(user.timezone);
  // The CALENDAR date, deliberately not the operational day: wall-clock
  // fireAt strings carry the true calendar date of the fire time (a 1:00 AM
  // reminder on operational Wednesday is dated Thursday), so due-ness is a
  // straight same-calendar-date comparison. Exact times fire exactly.
  const today = todayIn(user.timezone);

  for (const occurrence of feed) {
    // Two fireAt encodings exist: classic reminders carry a real instant
    // (UTC ISO with zone), habit/goal occurrences carry a local wall-clock
    // string. An instant is compared by epoch; wall-clock due-ness is
    // decided in the user's timezone, never the server's.
    if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(occurrence.fireAt)) {
      const fireMs = Date.parse(occurrence.fireAt);
      if (Number.isNaN(fireMs)) continue;
      const lateMs = Date.now() - fireMs;
      if (lateMs < 0 || lateMs > LATE_WINDOW_MINUTES * 60 * 1000) continue;
    } else {
      if (!occurrence.fireAt.startsWith(today)) continue;
      const fireMinute = fireMinuteOf(occurrence.fireAt);
      if (fireMinute === null) continue;
      if (nowMinute < fireMinute || nowMinute - fireMinute > LATE_WINDOW_MINUTES) continue;
    }

    // Claim the exactly-once key first. If an open tab (or a previous run)
    // already delivered this occurrence, the claim collides and we stay
    // silent.
    try {
      await prisma.reminderDelivery.create({
        data: { userId: user.id, key: occurrence.key },
      });
    } catch {
      result.suppressed += 1;
      continue;
    }

    const sent = await sendPushToUser(user.id, {
      title: occurrence.title,
      body: occurrence.message ?? undefined,
      url: "/today",
      tag: occurrence.key,
    });

    if (sent > 0) {
      result.delivered += 1;
      // Classic reminders advance/disable through the shared path. The
      // ledger row already exists; recordReminderDeliveryFor tolerates that.
      if (occurrence.kind === "reminder" && occurrence.reminderId) {
        await recordReminderDeliveryFor(user.id, occurrence.key, occurrence.reminderId);
      }
    } else {
      // Nothing accepted the push (all subscriptions dead?): release the
      // claim so an open tab can still deliver it.
      await prisma.reminderDelivery
        .deleteMany({ where: { userId: user.id, key: occurrence.key } })
        .catch(() => undefined);
      result.suppressed += 1;
    }
  }
}
