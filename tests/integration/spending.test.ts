/**
 * Spending triggers through the real server path: the tracked-history gate
 * on a fresh account, a stored category-level association surfacing, and
 * isolation. The statistics are pinned in tests/spending.test.ts and
 * tests/correlations.test.ts — this suite proves the wiring.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { shiftDay, weekdayOf } from "@/lib/date";
import { getSpendingReport } from "@/server/insights";
import { resetDatabase, twoUsers, type User } from "./helpers";

let alice: User;
let bob: User;

const TODAY = "2026-08-01";

async function seedSpendDay(userId: string, date: string, dining: number, groceries: number) {
  await prisma.calendarDaySummary.create({
    data: {
      userId,
      date,
      transactionCount: 2,
      spendCents: dining + groceries,
      spendByCategory: JSON.stringify({ dining, groceries }),
    },
  });
}

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  ({ alice, bob } = await twoUsers());
});

describe("getSpendingReport", () => {
  it("reports a fresh account as untracked — no fabricated zero-spend patterns", async () => {
    const report = await getSpendingReport(alice.id, TODAY);
    expect(report.untracked).toBe(true);
    expect(report.trackedDays).toBe(0);
    expect(report.findings).toHaveLength(0);
  });

  it("surfaces a stored weekend–dining association at category level", async () => {
    for (let index = 1; index <= 84; index += 1) {
      const date = shiftDay(TODAY, -index);
      const weekend = weekdayOf(date) === 0 || weekdayOf(date) === 6;
      const dining = weekend ? 3600 + ((index * 31) % 500) : 700 + ((index * 17) % 300);
      await seedSpendDay(alice.id, date, dining, 1800 + ((index * 13) % 400));
    }
    const report = await getSpendingReport(alice.id, TODAY);
    expect(report.untracked).toBe(false);
    expect(report.categories).toContain("dining");

    const finding = report.findings.find(
      (entry) => entry.context === "weekend" && entry.target.category === "dining",
    );
    expect(finding).toBeDefined();
    expect(finding?.direction).toBe("positive");
    expect(finding?.n).toBe(84);
  });

  it("never mixes users", async () => {
    for (let index = 1; index <= 40; index += 1) {
      await seedSpendDay(alice.id, shiftDay(TODAY, -index), 1000, 1000);
    }
    const bobReport = await getSpendingReport(bob.id, TODAY);
    expect(bobReport.untracked).toBe(true);
    expect(bobReport.findings).toHaveLength(0);
  });
});
