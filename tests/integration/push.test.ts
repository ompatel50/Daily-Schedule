/**
 * Web Push: endpoint protection, subscription ownership, and the scheduled
 * runner's exactly-once behaviour — with the push transport mocked (this
 * sandbox has no network), everything else real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(async () => ({ statusCode: 201 })),
  },
}));

import webpush from "web-push";

import { prisma } from "@/lib/prisma";
import { scheduleSettingsFor } from "@/server/schedule";
import { runScheduledReminderPush } from "@/server/push";
import {
  getPushStatusAction,
  subscribePushAction,
  unsubscribePushAction,
} from "@/server/actions/push";
import { GET as cronRoute } from "@/app/api/reminders/run/route";
import { actAs, resetDatabase, twoUsers } from "./helpers";

import type { NextRequest } from "next/server";
import type { User } from "./helpers";

let alice: User;
let bob: User;

const SUBSCRIPTION = {
  endpoint: "https://push.example/sub-alice-1",
  keys: { p256dh: "p256dh-key", auth: "auth-key" },
  deviceLabel: "Chrome · Test",
};

function cronRequest(auth?: string): NextRequest {
  return new Request("http://localhost/api/reminders/run", {
    headers: auth ? { authorization: auth } : {},
  }) as unknown as NextRequest;
}

beforeEach(async () => {
  await resetDatabase();
  ({ alice, bob } = await twoUsers());
  actAs(alice);
  process.env.VAPID_PUBLIC_KEY = "test-public";
  process.env.VAPID_PRIVATE_KEY = "test-private";
  process.env.CRON_SECRET = "cron-secret";
  vi.mocked(webpush.sendNotification).mockClear();
  vi.mocked(webpush.sendNotification).mockResolvedValue({ statusCode: 201 } as never);
});

describe("the scheduled endpoint", () => {
  it("refuses without the secret, accepts with it", async () => {
    expect((await cronRoute(cronRequest())).status).toBe(401);
    expect((await cronRoute(cronRequest("Bearer wrong"))).status).toBe(401);
    const ok = await cronRoute(cronRequest("Bearer cron-secret"));
    expect(ok.status).toBe(200);
  });

  it("refuses outright when no secret is configured", async () => {
    delete process.env.CRON_SECRET;
    expect((await cronRoute(cronRequest("Bearer anything"))).status).toBe(503);
    process.env.CRON_SECRET = "cron-secret";
  });
});

describe("subscription ownership", () => {
  it("another user cannot revoke a subscription by id", async () => {
    await subscribePushAction(SUBSCRIPTION);
    const row = await prisma.pushSubscription.findFirstOrThrow({ where: { userId: alice.id } });

    actAs(bob);
    await unsubscribePushAction({ id: row.id });
    expect(await prisma.pushSubscription.count({ where: { id: row.id } })).toBe(1);

    actAs(alice);
    await unsubscribePushAction({ id: row.id });
    expect(await prisma.pushSubscription.count({ where: { id: row.id } })).toBe(0);
  });

  it("a browser re-subscribing under a different account is re-pointed, not duplicated", async () => {
    await subscribePushAction(SUBSCRIPTION);
    actAs(bob);
    await subscribePushAction(SUBSCRIPTION);

    const rows = await prisma.pushSubscription.findMany({
      where: { endpoint: SUBSCRIPTION.endpoint },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(bob.id);
  });

  it("status lists only the caller's devices", async () => {
    await subscribePushAction(SUBSCRIPTION);
    actAs(bob);
    const status = await getPushStatusAction();
    expect(status.ok && status.data.subscriptions).toHaveLength(0);
  });
});

describe("the scheduled runner", () => {
  async function dueReminderFor(user: User) {
    // A classic reminder due a minute ago — an instant, timezone-independent.
    await prisma.reminder.create({
      data: {
        userId: user.id,
        title: "Stretch",
        remindAt: new Date(Date.now() - 60 * 1000),
        repeat: "none",
      },
    });
  }

  it("pushes a due reminder exactly once across runs", async () => {
    await subscribePushAction(SUBSCRIPTION);
    await dueReminderFor(alice);

    const first = await runScheduledReminderPush();
    expect(first.delivered).toBe(1);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    // Payload carries only the reminder's own text.
    const payload = JSON.parse(vi.mocked(webpush.sendNotification).mock.calls[0][1] as string);
    expect(payload.title).toBe("Stretch");

    const second = await runScheduledReminderPush();
    expect(second.delivered).toBe(0);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
  });

  it("a delivery already claimed by an open tab suppresses the push", async () => {
    await subscribePushAction(SUBSCRIPTION);
    await dueReminderFor(alice);
    const reminder = await prisma.reminder.findFirstOrThrow({ where: { userId: alice.id } });
    await prisma.reminderDelivery.create({
      data: { userId: alice.id, key: `reminder:${reminder.id}:${reminder.remindAt.toISOString()}` },
    });

    const result = await runScheduledReminderPush();
    expect(result.delivered).toBe(0);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it("a 410 from the push service deletes the dead subscription", async () => {
    await subscribePushAction(SUBSCRIPTION);
    await dueReminderFor(alice);
    vi.mocked(webpush.sendNotification).mockRejectedValueOnce(
      Object.assign(new Error("gone"), { statusCode: 410 }),
    );

    await runScheduledReminderPush();
    expect(await prisma.pushSubscription.count({ where: { userId: alice.id } })).toBe(0);
  });

  it("does nothing for users without subscriptions and when unconfigured", async () => {
    await dueReminderFor(alice); // no subscription
    const result = await runScheduledReminderPush();
    expect(result.usersEvaluated).toBe(0);

    delete process.env.VAPID_PUBLIC_KEY;
    await subscribePushAction(SUBSCRIPTION).catch(() => undefined);
    const unconfigured = await runScheduledReminderPush();
    expect(unconfigured.delivered).toBe(0);
    process.env.VAPID_PUBLIC_KEY = "test-public";
  });

  it("never pushes a completed habit's reminder (schedule-aware suppression)", async () => {
    await subscribePushAction(SUBSCRIPTION);
    // A daily habit with a reminder minute in the past hour, already done today.
    const habit = await prisma.habit.create({
      data: { userId: alice.id, name: "Read", startDate: "2026-01-01" },
    });
    const nowMinute = new Date().getHours() * 60 + new Date().getMinutes();
    await prisma.scheduleRule.create({
      data: {
        userId: alice.id,
        ownerType: "habit",
        ownerId: habit.id,
        effectiveFrom: "2026-01-01",
        mode: "every_day",
        reminderEnabled: true,
        reminderMinute: Math.max(0, nowMinute - 5),
      },
    });
    // The feed decides "today" as the operational day — the log must too.
    const today = scheduleSettingsFor(alice).today;
    await prisma.habitLog.create({
      data: { userId: alice.id, habitId: habit.id, date: today, status: "done" },
    });

    const result = await runScheduledReminderPush();
    expect(result.delivered).toBe(0);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });
});
