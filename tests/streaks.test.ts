import { describe, expect, it } from "vitest";

import { computeStreaks, weeklyProgress, type HabitLike, type LogLike } from "@/lib/logic/streaks";

const daily: HabitLike = {
  id: "h1",
  frequency: "daily",
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  targetPerWeek: 7,
  startDate: "2026-03-01",
};

const done = (date: string): LogLike => ({ date, status: "done" });
const skipped = (date: string): LogLike => ({ date, status: "skipped" });

describe("computeStreaks", () => {
  it("counts a run of consecutive completions", () => {
    const logs = ["2026-03-03", "2026-03-04", "2026-03-05"].map(done);
    const stats = computeStreaks(daily, logs, { from: "2026-03-01", to: "2026-03-05" });
    expect(stats.current).toBe(3);
    expect(stats.longest).toBe(3);
    expect(stats.totalDone).toBe(3);
  });

  it("breaks the streak on a missed due day", () => {
    const logs = ["2026-03-01", "2026-03-02", "2026-03-04", "2026-03-05"].map(done);
    const stats = computeStreaks(daily, logs, { from: "2026-03-01", to: "2026-03-05" });
    expect(stats.current).toBe(2);
    expect(stats.longest).toBe(2);
    expect(stats.totalMissed).toBe(1);
  });

  it("treats a skip as neutral, preserving the streak", () => {
    const logs = [done("2026-03-01"), skipped("2026-03-02"), done("2026-03-03")];
    const stats = computeStreaks(daily, logs, { from: "2026-03-01", to: "2026-03-03" });
    expect(stats.current).toBe(2);
    expect(stats.totalMissed).toBe(0);
  });

  it("does not break the streak just because today is unlogged", () => {
    const logs = ["2026-03-01", "2026-03-02", "2026-03-03"].map(done);
    // "Today" is the 4th and has no log yet — the day isn't over.
    const stats = computeStreaks(daily, logs, { from: "2026-03-01", to: "2026-03-04" });
    expect(stats.current).toBe(3);
    expect(stats.totalMissed).toBe(0);
  });

  it("computes a completion rate over due days", () => {
    const logs = ["2026-03-01", "2026-03-03"].map(done);
    const stats = computeStreaks(daily, logs, { from: "2026-03-01", to: "2026-03-04" });
    // 2 done out of 4 due days.
    expect(stats.completionRate).toBe(50);
    expect(stats.totalDue).toBe(4);
  });

  it("reports days since the last completion", () => {
    const stats = computeStreaks(daily, [done("2026-03-01")], {
      from: "2026-03-01",
      to: "2026-03-05",
    });
    expect(stats.daysSinceLast).toBe(4);
  });

  it("returns zeros for a habit with no logs", () => {
    const stats = computeStreaks(daily, [], { from: "2026-03-01", to: "2026-03-05" });
    expect(stats).toMatchObject({ current: 0, longest: 0, totalDone: 0, daysSinceLast: null });
  });

  it("only counts due days for custom-schedule habits", () => {
    const mwf: HabitLike = { ...daily, frequency: "custom", weekdays: [1, 3, 5] };
    // 2026-03-02 Mon, 03-04 Wed, 03-06 Fri.
    const logs = ["2026-03-02", "2026-03-04", "2026-03-06"].map(done);
    const stats = computeStreaks(mwf, logs, { from: "2026-03-02", to: "2026-03-06" });
    expect(stats.totalDue).toBe(3);
    expect(stats.current).toBe(3);
    expect(stats.completionRate).toBe(100);
  });
});

describe("weeklyProgress", () => {
  it("counts completions inside the containing week", () => {
    const habit: HabitLike = { ...daily, frequency: "weekly", targetPerWeek: 3 };
    // Week of Mon 2026-03-02 → Sun 2026-03-08.
    const logs = [done("2026-03-02"), done("2026-03-05"), done("2026-02-27")];
    const progress = weeklyProgress(habit, logs, "2026-03-04", 1);
    expect(progress.done).toBe(2);
    expect(progress.target).toBe(3);
    expect(progress.days).toHaveLength(7);
  });
});
