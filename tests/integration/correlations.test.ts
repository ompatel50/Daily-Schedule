/**
 * Correlation insights through the real server path: the bounded window
 * read over stored daily facts, the honest empty state on a fresh account,
 * and per-user isolation. The statistics themselves are pinned against
 * scipy in tests/correlations.test.ts — this suite proves the wiring.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { shiftDay } from "@/lib/date";
import {
  CORRELATION_CANDIDATES,
  CORRELATION_WINDOW_DAYS,
  MIN_PAIRED_OBSERVATIONS,
} from "@/lib/logic/correlations";
import { getCorrelationReport } from "@/server/insights";
import { resetDatabase, twoUsers, type User } from "./helpers";

let alice: User;
let bob: User;

const TODAY = "2026-08-01";

/** Seed a summary row directly — the storage IS the fact layer; the write
 * paths that fill it are covered by tests/integration/daily-facts.test.ts. */
async function seedDay(
  userId: string,
  date: string,
  data: { sleepHours?: number | null; habitsDue?: number; habitsDone?: number },
) {
  await prisma.calendarDaySummary.create({
    data: {
      userId,
      date,
      sleepHours: data.sleepHours ?? null,
      habitsDue: data.habitsDue ?? 0,
      habitsDone: data.habitsDone ?? 0,
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

describe("getCorrelationReport", () => {
  it("reports every candidate as pending on a fresh account — never fabricates", async () => {
    const report = await getCorrelationReport(alice.id, TODAY);
    expect(report.findings).toHaveLength(0);
    expect(report.tested).toBe(0);
    expect(report.pending).toHaveLength(CORRELATION_CANDIDATES.length);
    expect(report.pending.every((pending) => pending.n === 0)).toBe(true);
  });

  it("surfaces a strong stored association with its sample and window", async () => {
    // 40 days where habit completion moves with sleep, deterministically.
    for (let index = 0; index < 40; index += 1) {
      const sleep = 5 + (index % 8) * 0.5; // 5.0 … 8.5
      await seedDay(alice.id, shiftDay(TODAY, -index), {
        sleepHours: sleep,
        habitsDue: 4,
        habitsDone: Math.min(4, Math.round(sleep - 4)), // 1 … 4, monotone in sleep
      });
    }
    const report = await getCorrelationReport(alice.id, TODAY);
    const finding = report.findings.find((entry) => entry.id === "sleep-habits");
    expect(finding).toBeDefined();
    expect(finding?.n).toBe(40);
    expect(finding?.direction).toBe("positive");
    expect(report.to).toBe(TODAY);
    expect(report.windowDays).toBe(CORRELATION_WINDOW_DAYS);
  });

  it("reads only the bounded window — old rows never join the sample", async () => {
    // 20 paired days inside the window, 20 far outside it.
    for (let index = 0; index < 20; index += 1) {
      await seedDay(alice.id, shiftDay(TODAY, -index), {
        sleepHours: 7,
        habitsDue: 2,
        habitsDone: 1,
      });
      await seedDay(alice.id, shiftDay(TODAY, -(CORRELATION_WINDOW_DAYS + 10 + index)), {
        sleepHours: 7,
        habitsDue: 2,
        habitsDone: 1,
      });
    }
    const report = await getCorrelationReport(alice.id, TODAY);
    const pending = report.pending.find((entry) => entry.id === "sleep-habits");
    expect(pending?.n).toBe(20); // the out-of-window days do not count
    expect(pending?.needed).toBe(MIN_PAIRED_OBSERVATIONS - 20);
  });

  it("never mixes users", async () => {
    for (let index = 0; index < 40; index += 1) {
      const sleep = 5 + (index % 8) * 0.5;
      await seedDay(alice.id, shiftDay(TODAY, -index), {
        sleepHours: sleep,
        habitsDue: 4,
        habitsDone: Math.min(4, Math.round(sleep - 4)),
      });
    }
    const aliceReport = await getCorrelationReport(alice.id, TODAY);
    const bobReport = await getCorrelationReport(bob.id, TODAY);
    expect(aliceReport.findings.length).toBeGreaterThan(0);
    expect(bobReport.findings).toHaveLength(0);
    expect(bobReport.pending.every((pending) => pending.n === 0)).toBe(true);
  });
});
