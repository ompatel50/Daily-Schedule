import { describe, expect, it } from "vitest";

import {
  calculateCompletionRate,
  calculateScheduledStreak,
  calculateWeeklyProgress,
  getOccurrenceForDate,
  getStatusForDate,
  isOverdueOccurrence,
  type CompletionLike,
  type ScheduleRuleLike,
  type ScheduleSettings,
  type SchedulableItem,
} from "@/lib/logic/schedule";

/**
 * The habit rules this app promises, asserted directly. Every one of these was
 * wrong before the schedule engine: a weekday habit was marked missed on
 * Saturday, a skip silently protected a streak, and a 3x/week habit was due
 * every single day.
 */

const MON = "2026-03-02";
const TUE = "2026-03-03";
const WED = "2026-03-04";
const THU = "2026-03-05";
const FRI = "2026-03-06";
const SAT = "2026-03-07";
const SUN = "2026-03-08";

function settings(overrides: Partial<ScheduleSettings> = {}): ScheduleSettings {
  return { weekStartsOn: 1, timezone: "America/New_York", today: SUN, ...overrides };
}

function rule(overrides: Partial<ScheduleRuleLike> = {}): ScheduleRuleLike {
  return {
    id: "rule-1",
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    mode: "every_day",
    interval: 1,
    timesPerWeek: null,
    monthDay: null,
    enabled: true,
    daypart: "anytime",
    timeMinute: null,
    reminderEnabled: false,
    reminderMinute: null,
    weekdays: [],
    ...overrides,
  };
}

function habit(overrides: Partial<SchedulableItem> = {}): SchedulableItem {
  return {
    id: "habit-1",
    startDate: "2026-01-01",
    endDate: null,
    enabled: true,
    rules: [rule()],
    overrides: [],
    ...overrides,
  };
}

function ovr(date: string, kind: string) {
  return { date, kind, movedToDate: null, timeMinute: null, note: null };
}

describe("a weekday habit excludes the weekend", () => {
  const reading = habit({ rules: [rule({ mode: "weekdays", weekdays: [1, 2, 3, 4, 5] })] });
  const config = settings({ today: SUN });

  it("is due Monday through Friday", () => {
    for (const day of [MON, TUE, WED, THU, FRI]) {
      expect(getOccurrenceForDate(reading, day, config).active).toBe(true);
    }
  });

  it("is neutral on Saturday and Sunday — not missed", () => {
    for (const day of [SAT, SUN]) {
      const resolved = getStatusForDate(reading, day, null, config);
      expect(resolved.status).toBe("not_scheduled");
      expect(resolved.status).not.toBe("missed");
    }
  });

  it("keeps the weekend out of the completion denominator", () => {
    const completions = [MON, TUE, WED, THU, FRI].map((date) => ({ date, status: "done" }));
    const stats = calculateCompletionRate(reading, MON, SUN, completions, config);
    expect(stats.opportunities).toBe(5);
    expect(stats.rate).toBe(100);
  });

  it("does not break the streak over the weekend", () => {
    const completions = [
      ...[MON, TUE, WED, THU, FRI].map((date) => ({ date, status: "done" })),
      { date: "2026-03-09", status: "done" }, // the next Monday
    ];
    const result = calculateScheduledStreak(
      reading,
      "2026-03-09",
      completions,
      settings({ today: "2026-03-09" }),
    );
    expect(result.current).toBe(6);
  });
});

describe("streak rules", () => {
  const daily = habit();

  it("a missed scheduled day breaks the streak", () => {
    const completions: CompletionLike[] = [
      { date: MON, status: "done" },
      { date: TUE, status: "done" },
      // WED missed
      { date: THU, status: "done" },
    ];
    const result = calculateScheduledStreak(daily, THU, completions, settings({ today: THU }));
    expect(result.current).toBe(1);
    expect(result.longest).toBe(2);
  });

  it("a deliberate skip breaks the streak", () => {
    const completions: CompletionLike[] = [
      { date: MON, status: "done" },
      { date: TUE, status: "skipped" },
      { date: WED, status: "done" },
    ];
    expect(calculateScheduledStreak(daily, WED, completions, settings({ today: WED })).current).toBe(1);
  });

  it("an excused day does not break the streak", () => {
    const completions: CompletionLike[] = [
      { date: MON, status: "done" },
      { date: TUE, status: "excused" },
      { date: WED, status: "done" },
    ];
    expect(calculateScheduledStreak(daily, WED, completions, settings({ today: WED })).current).toBe(2);
  });

  it("a rest-day override does not break the streak", () => {
    const resting = { ...daily, overrides: [ovr(TUE, "rest")] };
    const completions: CompletionLike[] = [
      { date: MON, status: "done" },
      { date: WED, status: "done" },
    ];
    expect(calculateScheduledStreak(resting, WED, completions, settings({ today: WED })).current).toBe(2);
  });

  it("an unlogged today does not break the streak", () => {
    const completions: CompletionLike[] = [
      { date: MON, status: "done" },
      { date: TUE, status: "done" },
    ];
    expect(calculateScheduledStreak(daily, WED, completions, settings({ today: WED })).current).toBe(2);
  });

  it("a future habit day is never a miss", () => {
    expect(getStatusForDate(daily, FRI, null, settings({ today: WED })).status).toBe("future");
  });
});

describe("a times-per-week habit", () => {
  const meditate = habit({ rules: [rule({ mode: "times_per_week", timesPerWeek: 3 })] });
  const config = settings({ today: THU });

  it("is never required on a specific day", () => {
    for (const day of [MON, TUE, WED, THU, FRI, SAT, SUN]) {
      const occurrence = getOccurrenceForDate(meditate, day, config);
      expect(occurrence.active).toBe(false);
      expect(occurrence.flexible).toBe(true);
    }
  });

  it("never produces a missed day", () => {
    for (const day of [MON, TUE, WED]) {
      expect(getStatusForDate(meditate, day, null, config).status).not.toBe("missed");
    }
  });

  it("reports weekly progress against its own target, not seven", () => {
    const completions = [
      { date: MON, status: "done" },
      { date: WED, status: "done" },
    ];
    const weekly = calculateWeeklyProgress(meditate, THU, completions, config);
    expect(weekly.target).toBe(3);
    expect(weekly.done).toBe(2);
    expect(weekly.remaining).toBe(1);
    expect(weekly.failed).toBe(false);
  });
});

describe("reminders respect the schedule", () => {
  const morningHabit = habit({
    rules: [rule({ mode: "weekdays", weekdays: [1, 2, 3, 4, 5], timeMinute: 7 * 60, reminderEnabled: true })],
  });

  it("an inactive date is never overdue, so no reminder is owed", () => {
    expect(isOverdueOccurrence(morningHabit, SAT, settings({ today: SAT }), { nowMinute: 23 * 60 })).toBe(
      false,
    );
  });

  it("a rest-day override suppresses the reminder", () => {
    const resting = { ...morningHabit, overrides: [ovr(WED, "rest")] };
    expect(isOverdueOccurrence(resting, WED, settings({ today: WED }), { nowMinute: 23 * 60 })).toBe(false);
  });

  it("a scheduled, unfinished, past-time date is overdue", () => {
    expect(
      isOverdueOccurrence(morningHabit, WED, settings({ today: WED }), { nowMinute: 8 * 60 }),
    ).toBe(true);
  });
});

describe("archiving and lifespan preserve history", () => {
  it("an archived habit stops applying but its completions still resolve", () => {
    const archived = habit({ enabled: false });
    expect(getOccurrenceForDate(archived, MON, settings()).active).toBe(false);
    expect(getStatusForDate(archived, MON, { date: MON, status: "done" }, settings()).status).toBe(
      "completed",
    );
  });

  it("days before the start date are not misses", () => {
    const started = habit({ startDate: WED });
    expect(getStatusForDate(started, MON, null, settings()).status).toBe("inactive");
  });
});
