/**
 * The ReminderDelivery ledger against real PostgreSQL, through the real
 * server functions in src/server/reminders.ts: exactly-once delivery per
 * (user, occurrence key), per-user key scoping, the classic-reminder advance
 * that must happen at most once per occurrence, and the opportunistic sweep
 * of stale ledger rows.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { recordReminderDelivery, recordReminderDeliveryFor } from "@/server/reminders";
import { actAs, resetDatabase, twoUsers } from "./helpers";

import type { User } from "./helpers";

let alice: User;
let bob: User;

const KEY = "habit:h1:2026-07-30";
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await resetDatabase();
  ({ alice, bob } = await twoUsers());
  actAs(alice);
});

describe("exactly-once ledger", () => {
  it("recording the same occurrence key twice creates one row", async () => {
    await recordReminderDelivery(KEY, null);
    await recordReminderDelivery(KEY, null);

    expect(await prisma.reminderDelivery.count({ where: { userId: alice.id, key: KEY } })).toBe(1);
  });

  it("different users may hold the same key", async () => {
    await recordReminderDelivery(KEY, null);

    actAs(bob);
    await recordReminderDelivery(KEY, null);

    expect(await prisma.reminderDelivery.count({ where: { key: KEY } })).toBe(2);
    expect(await prisma.reminderDelivery.count({ where: { userId: bob.id, key: KEY } })).toBe(1);
  });
});

describe("classic reminder advance", () => {
  it("a replayed delivery advances a daily reminder exactly once", async () => {
    const remindAt = new Date("2026-07-30T07:00:00.000Z");
    const reminder = await prisma.reminder.create({
      data: { userId: alice.id, title: "Water", remindAt, repeat: "daily" },
    });
    const key = `reminder:${reminder.id}:${remindAt.toISOString()}`;

    await recordReminderDeliveryFor(alice.id, key, reminder.id);
    // The replay hits the unique ledger and returns before touching the row.
    await recordReminderDeliveryFor(alice.id, key, reminder.id);

    const after = await prisma.reminder.findUniqueOrThrow({ where: { id: reminder.id } });
    expect(after.remindAt.getTime()).toBe(remindAt.getTime() + DAY_MS);
    expect(after.enabled).toBe(true);
    expect(after.lastFiredAt).not.toBeNull();
  });

  it("a one-shot reminder is disabled after delivery", async () => {
    const remindAt = new Date("2026-07-30T07:00:00.000Z");
    const reminder = await prisma.reminder.create({
      data: { userId: alice.id, title: "Renew passport", remindAt, repeat: "none" },
    });

    await recordReminderDeliveryFor(alice.id, `reminder:${reminder.id}:${remindAt.toISOString()}`, reminder.id);

    const after = await prisma.reminder.findUniqueOrThrow({ where: { id: reminder.id } });
    expect(after.enabled).toBe(false);
    expect(after.remindAt.getTime()).toBe(remindAt.getTime());
  });

  it("a delivery never advances another user's reminder", async () => {
    const remindAt = new Date("2026-07-30T07:00:00.000Z");
    const bobReminder = await prisma.reminder.create({
      data: { userId: bob.id, title: "Bob's reminder", remindAt, repeat: "daily" },
    });

    // Alice's ledger write carrying Bob's reminder id: the row is recorded for
    // Alice, but the reminder lookup is userId-scoped and finds nothing.
    await recordReminderDeliveryFor(alice.id, "forged:key:1", bobReminder.id);

    const after = await prisma.reminder.findUniqueOrThrow({ where: { id: bobReminder.id } });
    expect(after.remindAt.getTime()).toBe(remindAt.getTime());
    expect(after.lastFiredAt).toBeNull();
    expect(await prisma.reminderDelivery.count({ where: { userId: alice.id, key: "forged:key:1" } })).toBe(1);
  });
});

describe("ledger sweep", () => {
  it("rows older than seven days are swept on the next delivery — own rows only", async () => {
    const stale = new Date(Date.now() - 8 * DAY_MS);
    await prisma.reminderDelivery.create({
      data: { userId: alice.id, key: "habit:old:2026-07-01", deliveredAt: stale },
    });
    await prisma.reminderDelivery.create({
      data: { userId: bob.id, key: "habit:old:2026-07-01", deliveredAt: stale },
    });

    await recordReminderDeliveryFor(alice.id, KEY, null);

    // Alice's stale row is gone, her fresh one stays, Bob's is not hers to sweep.
    const remaining = await prisma.reminderDelivery.findMany({ select: { userId: true, key: true } });
    expect(remaining).toHaveLength(2);
    expect(remaining).toContainEqual({ userId: alice.id, key: KEY });
    expect(remaining).toContainEqual({ userId: bob.id, key: "habit:old:2026-07-01" });
  });
});
