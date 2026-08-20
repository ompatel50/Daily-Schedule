/**
 * Anomaly nudges end to end: detection over stored daily facts, delivery
 * through the reminder feed + ledger (exactly-once, deduplicated), dismissal
 * feeding sensitivity, per-category mute, isolation, and the v14 backup
 * round trip of the preferences table. Detector math is pinned in
 * tests/anomalies.test.ts.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { shiftDay } from "@/lib/date";
import { dismissAnomaly, setAnomalyMuted } from "@/server/actions/anomalies";
import { exportBackup, importBackup } from "@/server/actions/backup";
import { getAnomalyContextFor } from "@/server/anomalies";
import { getReminderFeedFor, recordReminderDeliveryFor } from "@/server/reminders";
import { scheduleSettingsFor } from "@/server/schedule";
import { actAs, resetDatabase, twoUsers, type User } from "./helpers";

let alice: User;
let bob: User;

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  ({ alice, bob } = await twoUsers());
  actAs(alice);
});

async function todayOf(user: User) {
  const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  return { settings: scheduleSettingsFor(row), row };
}

/** Elevated resting HR over a steady 30-day baseline, in summary rows. */
async function seedElevatedHr(userId: string, today: string) {
  for (let daysAgo = 1; daysAgo <= 35; daysAgo += 1) {
    await prisma.calendarDaySummary.create({
      data: {
        userId,
        date: shiftDay(today, -daysAgo),
        restingHr: daysAgo <= 5 ? 64 : 55,
      },
    });
  }
}

describe("detection through the real read path", () => {
  it("surfaces the resting-HR observation with the one-time clinician flag", async () => {
    const { row } = await todayOf(alice);
    await seedElevatedHr(alice.id, scheduleSettingsFor(row).today);

    const context = await getAnomalyContextFor(row);
    const signal = context.report.signals.find((entry) => entry.category === "resting_hr");
    expect(signal).toBeDefined();
    expect(signal?.clinicianNote).toBe(true);
    expect(context.report.ready).toContain("resting_hr");
  });

  it("stays silent on a fresh account", async () => {
    const { row } = await todayOf(alice);
    const context = await getAnomalyContextFor(row);
    expect(context.report.signals).toHaveLength(0);
    expect(context.report.observations).toHaveLength(0);
    expect(context.report.ready).toHaveLength(0);
  });

  it("never mixes users", async () => {
    const { row } = await todayOf(alice);
    await seedElevatedHr(alice.id, scheduleSettingsFor(row).today);

    const bobRow = await prisma.user.findUniqueOrThrow({ where: { id: bob.id } });
    const context = await getAnomalyContextFor(bobRow);
    expect(context.report.observations).toHaveLength(0);
  });
});

describe("delivery through the reminder feed and ledger", () => {
  it("emits an anomaly occurrence, and a claimed key never re-fires", async () => {
    const { row, settings } = await todayOf(alice);
    await seedElevatedHr(alice.id, settings.today);

    const feed = await getReminderFeedFor(row);
    const occurrence = feed.find((entry) => entry.kind === "anomaly");
    expect(occurrence).toBeDefined();
    expect(occurrence?.key.startsWith("anomaly:resting_hr:")).toBe(true);
    // The clinician sentence rides the first delivery.
    expect(occurrence?.message).toContain("clinician");

    // Claim it — the exactly-once path every channel shares.
    const claimed = await recordReminderDeliveryFor(alice.id, occurrence!.key, null);
    expect(claimed).toBe(true);

    const again = await getReminderFeedFor(row);
    expect(again.find((entry) => entry.kind === "anomaly")).toBeUndefined();

    // A second claim collides.
    expect(await recordReminderDeliveryFor(alice.id, occurrence!.key, null)).toBe(false);
  });
});

describe("dismissal and mute", () => {
  it("dismissing raises sensitivity, silences the occurrence, and drops the clinician note", async () => {
    const { row, settings } = await todayOf(alice);
    await seedElevatedHr(alice.id, settings.today);

    const before = await getAnomalyContextFor(row);
    const signal = before.report.signals.find((entry) => entry.category === "resting_hr")!;

    const dismissed = await dismissAnomaly({ category: "resting_hr", key: signal.key });
    expect(dismissed.ok).toBe(true);

    const preference = await prisma.anomalyPreference.findUnique({
      where: { userId_category: { userId: alice.id, category: "resting_hr" } },
    });
    expect(preference?.dismissals).toBe(1);

    // The key is claimed: nothing to deliver this window.
    const after = await getAnomalyContextFor(row);
    expect(after.report.signals.find((entry) => entry.category === "resting_hr")).toBeUndefined();
    // If the deviation still clears the raised threshold, the observation
    // may remain visible — but never with the clinician note again.
    for (const observation of after.report.observations) {
      expect(observation.clinicianNote).toBe(false);
    }
  });

  it("muting a category stops its detector entirely", async () => {
    const { row, settings } = await todayOf(alice);
    await seedElevatedHr(alice.id, settings.today);

    const muted = await setAnomalyMuted({ category: "resting_hr", muted: true });
    expect(muted.ok).toBe(true);

    const context = await getAnomalyContextFor(row);
    expect(context.report.observations).toHaveLength(0);
    expect(context.report.ready).not.toContain("resting_hr");
  });
});

describe("backup v14", () => {
  it("round-trips anomaly preferences", async () => {
    await setAnomalyMuted({ category: "spending", muted: true });
    await prisma.anomalyPreference.update({
      where: { userId_category: { userId: alice.id, category: "spending" } },
      data: { dismissals: 2 },
    });

    const exported = await exportBackup();
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const file = exported.data as {
      version: number;
      data: Record<string, Array<{ category?: string; muted?: boolean; dismissals?: number }>>;
    };
    expect(file.version).toBe(15);
    expect(file.data.anomalyPreferences).toHaveLength(1);
    expect(file.data.anomalyPreferences[0]).toMatchObject({
      category: "spending",
      muted: true,
      dismissals: 2,
    });

    actAs(bob);
    const restored = await importBackup(exported.data, "merge");
    expect(restored.ok).toBe(true);
    const bobPreference = await prisma.anomalyPreference.findFirst({
      where: { userId: bob.id },
    });
    expect(bobPreference).toMatchObject({ category: "spending", muted: true, dismissals: 2 });
  });
});
