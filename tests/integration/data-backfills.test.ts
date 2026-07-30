/**
 * The three data backfills in prisma/migrations-data/, run directly against
 * real PostgreSQL with representative pre-upgrade state. Each one must be
 * idempotent: a second run reports nothing to do and leaves every row
 * byte-identical (asserted by snapshotting the affected tables around it).
 */
import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { run as runScheduleBackfill } from "../../prisma/migrations-data/001-schedules";
import { run as runSourceKeyBackfill } from "../../prisma/migrations-data/002-template-source-keys";
import { run as runFingerprintBackfill } from "../../prisma/migrations-data/003-health-fingerprints";
import { resetDatabase, twoUsers } from "./helpers";

import type { User } from "@prisma/client";

let alice: User;

beforeEach(async () => {
  await resetDatabase();
  ({ alice } = await twoUsers());
});

/** Ordered full-row snapshots of the tables a backfill touches. */
async function scheduleSnapshot() {
  return {
    rules: await prisma.scheduleRule.findMany({ orderBy: { id: "asc" } }),
    days: await prisma.scheduleRuleDay.findMany({ orderBy: [{ ruleId: "asc" }, { weekday: "asc" }] }),
    goals: await prisma.goal.findMany({ orderBy: { id: "asc" } }),
    habits: await prisma.habit.findMany({ orderBy: { id: "asc" } }),
  };
}

describe("001-schedules — ScheduleRule backfill for goals and habits", () => {
  it("creates the spec'd rules from legacy columns, then a second run is a no-op", async () => {
    // Pre-upgrade state: a goal and three habits, none with a ScheduleRule.
    const goal = await prisma.goal.create({
      data: {
        userId: alice.id,
        domain: "nutrition",
        metric: "protein",
        label: "Protein",
        target: 140,
        source: "manual",
        active: true,
      },
    });
    const customHabit = await prisma.habit.create({
      data: {
        userId: alice.id,
        name: "Stretch",
        frequency: "custom",
        weekdays: "[1,3,5]",
        startDate: "2026-01-05",
      },
    });
    const weeklyHabit = await prisma.habit.create({
      data: {
        userId: alice.id,
        name: "Swim",
        frequency: "weekly",
        targetPerWeek: 3,
        startDate: "2026-01-05",
      },
    });
    const corruptHabit = await prisma.habit.create({
      data: {
        userId: alice.id,
        name: "Read",
        frequency: "custom",
        weekdays: "not-json",
        startDate: "2026-01-05",
      },
    });

    const notes = await runScheduleBackfill(prisma);
    expect(notes.join(" ")).toContain("1 schedule rules created, 1 rows enriched");
    expect(notes.join(" ")).toContain("3 schedule rules created (2 recurrence recovered, 1 defaulted to every day)");

    // Goal: every-day rule effective from creation day, plus enriched columns.
    const goalRule = await prisma.scheduleRule.findFirstOrThrow({
      where: { ownerType: "goal", ownerId: goal.id },
    });
    expect(goalRule.userId).toBe(alice.id);
    expect(goalRule.mode).toBe("every_day");
    expect(goalRule.enabled).toBe(true);
    const enriched = await prisma.goal.findUniqueOrThrow({ where: { id: goal.id } });
    expect(enriched.startDate).toBe(goalRule.effectiveFrom);
    expect(enriched.source).toBe("protein");

    // Habits: recurrence recovered where the legacy columns allow it.
    const customRule = await prisma.scheduleRule.findFirstOrThrow({
      where: { ownerType: "habit", ownerId: customHabit.id },
      include: { days: { orderBy: { weekday: "asc" } } },
    });
    expect(customRule.mode).toBe("weekdays");
    expect(customRule.days.map((day) => day.weekday)).toEqual([1, 3, 5]);

    const weeklyRule = await prisma.scheduleRule.findFirstOrThrow({
      where: { ownerType: "habit", ownerId: weeklyHabit.id },
    });
    expect(weeklyRule.mode).toBe("times_per_week");
    expect(weeklyRule.timesPerWeek).toBe(3);

    const corruptRule = await prisma.scheduleRule.findFirstOrThrow({
      where: { ownerType: "habit", ownerId: corruptHabit.id },
    });
    expect(corruptRule.mode).toBe("every_day");

    // Idempotency: the second run reports nothing to do and changes no rows.
    const before = await scheduleSnapshot();
    const secondNotes = await runScheduleBackfill(prisma);
    expect(secondNotes.join(" ")).toContain("nothing to do");
    expect(await scheduleSnapshot()).toEqual(before);
  });
});

describe("002-template-source-keys — sourceKey backfill on routine-applied items", () => {
  it("keys null-sourceKey routine rows 1:0.. by sortOrder, then a second run is a no-op", async () => {
    const template = await prisma.scheduleTemplate.create({
      data: { userId: alice.id, name: "Morning", items: "[]" },
    });
    // Pre-upgrade rows: templateId set, sourceKey null — written out of order so
    // the backfill's sortOrder ordering is what the assertion actually checks.
    const second = await prisma.scheduleItem.create({
      data: { userId: alice.id, title: "Plan", date: "2026-07-01", sortOrder: 2, templateId: template.id },
    });
    const first = await prisma.scheduleItem.create({
      data: { userId: alice.id, title: "Wake", date: "2026-07-01", sortOrder: 1, templateId: template.id },
    });
    // A hand-made item never gets a key — it did not come from a routine.
    const manual = await prisma.scheduleItem.create({
      data: { userId: alice.id, title: "Dentist", date: "2026-07-01", sortOrder: 3 },
    });

    const notes = await runSourceKeyBackfill(prisma);
    expect(notes.join(" ")).toContain("2 routine-applied items keyed across 1 day/routine group(s)");

    const rows = await prisma.scheduleItem.findMany({ orderBy: { sortOrder: "asc" } });
    expect(rows.find((row) => row.id === first.id)?.sourceKey).toBe("1:0");
    expect(rows.find((row) => row.id === second.id)?.sourceKey).toBe("1:1");
    expect(rows.find((row) => row.id === manual.id)?.sourceKey).toBeNull();

    const before = await prisma.scheduleItem.findMany({ orderBy: { id: "asc" } });
    const secondNotes = await runSourceKeyBackfill(prisma);
    expect(secondNotes.join(" ")).toContain("nothing to do");
    expect(await prisma.scheduleItem.findMany({ orderBy: { id: "asc" } })).toEqual(before);
  });
});

describe("003-health-fingerprints — dedup fingerprints on pre-upgrade rows", () => {
  it("fingerprints null rows as source|type|date, then a second run is a no-op", async () => {
    const manual = await prisma.healthMetric.create({
      data: { userId: alice.id, date: "2026-01-01", type: "steps", value: 8000, source: "manual" },
    });
    const csv = await prisma.healthMetric.create({
      data: { userId: alice.id, date: "2026-01-02", type: "sleep_hours", value: 7.5, source: "csv" },
    });

    const notes = await runFingerprintBackfill(prisma);
    expect(notes.join(" ")).toContain("fingerprinted 2 pre-upgrade metric rows");

    expect(
      (await prisma.healthMetric.findUniqueOrThrow({ where: { id: manual.id } })).fingerprint,
    ).toBe("manual|steps|2026-01-01");
    expect(
      (await prisma.healthMetric.findUniqueOrThrow({ where: { id: csv.id } })).fingerprint,
    ).toBe("csv|sleep_hours|2026-01-02");

    const before = await prisma.healthMetric.findMany({ orderBy: { id: "asc" } });
    const secondNotes = await runFingerprintBackfill(prisma);
    expect(secondNotes.join(" ")).toContain("nothing to do");
    expect(await prisma.healthMetric.findMany({ orderBy: { id: "asc" } })).toEqual(before);
  });

  it("skips a row whose computed fingerprint already exists instead of failing", async () => {
    // A half-upgraded database: the fingerprint this row would get is taken.
    const taken = await prisma.healthMetric.create({
      data: {
        userId: alice.id,
        date: "2026-01-01",
        type: "steps",
        value: 9000,
        source: "manual",
        fingerprint: "manual|steps|2026-01-01",
      },
    });
    const colliding = await prisma.healthMetric.create({
      data: { userId: alice.id, date: "2026-01-01", type: "steps", value: 8000, source: "manual" },
    });

    const notes = await runFingerprintBackfill(prisma);
    expect(notes.join(" ")).toContain("skipped 1 rows whose fingerprint already existed");

    // Neither row was harmed: the collision skipped, the original untouched.
    expect(
      (await prisma.healthMetric.findUniqueOrThrow({ where: { id: colliding.id } })).fingerprint,
    ).toBeNull();
    const survivor = await prisma.healthMetric.findUniqueOrThrow({ where: { id: taken.id } });
    expect(survivor.value).toBe(9000);
    expect(survivor.fingerprint).toBe("manual|steps|2026-01-01");
  });
});
