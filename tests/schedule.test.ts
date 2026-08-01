import { describe, expect, it } from "vitest";

import {
  calculateCompletionRate,
  calculateScheduledOpportunities,
  calculateScheduledStreak,
  calculateWeeklyProgress,
  createStableDateKey,
  describeSchedule,
  getNextScheduledDate,
  getOccurrenceForDate,
  getPreviousScheduledDate,
  getStatusForDate,
  getWeekBounds,
  isItemActiveOnDate,
  isOverdueOccurrence,
  nowMinuteIn,
  normalizeRuleInput,
  resolveEffectiveSchedule,
  todayIn,
  type CompletionLike,
  type ScheduleRuleLike,
  type ScheduleSettings,
  type SchedulableItem,
  wallClockToInstant,
} from "@/lib/logic/schedule";

// 2026-03-02 is a Monday. All fixtures are anchored to it so weekday maths is
// readable rather than something you have to look up.
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

function item(overrides: Partial<SchedulableItem> = {}): SchedulableItem {
  return {
    id: "item-1",
    startDate: null,
    endDate: null,
    enabled: true,
    rules: [rule()],
    overrides: [],
    ...overrides,
  };
}

describe("schedule modes", () => {
  it("every_day applies on all seven days", () => {
    const subject = item();
    for (const day of [MON, TUE, WED, THU, FRI, SAT, SUN]) {
      expect(isItemActiveOnDate(subject, day, settings())).toBe(true);
    }
  });

  it("a single selected weekday applies only on that weekday", () => {
    const subject = item({ rules: [rule({ mode: "weekdays", weekdays: [3] })] });
    expect(isItemActiveOnDate(subject, WED, settings())).toBe(true);
    for (const day of [MON, TUE, THU, FRI, SAT, SUN]) {
      expect(isItemActiveOnDate(subject, day, settings())).toBe(false);
    }
  });

  it("multiple selected weekdays apply on exactly those days", () => {
    // The spec's canonical example: workout Mon, Tue, Thu, Fri.
    const subject = item({ rules: [rule({ mode: "weekdays", weekdays: [1, 2, 4, 5] })] });
    expect(isItemActiveOnDate(subject, MON, settings())).toBe(true);
    expect(isItemActiveOnDate(subject, TUE, settings())).toBe(true);
    expect(isItemActiveOnDate(subject, THU, settings())).toBe(true);
    expect(isItemActiveOnDate(subject, FRI, settings())).toBe(true);
    expect(isItemActiveOnDate(subject, WED, settings())).toBe(false);
    expect(isItemActiveOnDate(subject, SAT, settings())).toBe(false);
    expect(isItemActiveOnDate(subject, SUN, settings())).toBe(false);
  });

  it("weekdays preset covers Mon-Fri and excludes the weekend", () => {
    const subject = item({ rules: [rule({ mode: "weekdays", weekdays: [1, 2, 3, 4, 5] })] });
    for (const day of [MON, TUE, WED, THU, FRI]) {
      expect(isItemActiveOnDate(subject, day, settings())).toBe(true);
    }
    expect(isItemActiveOnDate(subject, SAT, settings())).toBe(false);
    expect(isItemActiveOnDate(subject, SUN, settings())).toBe(false);
  });

  it("weekends preset covers Sat/Sun only", () => {
    const subject = item({ rules: [rule({ mode: "weekdays", weekdays: [0, 6] })] });
    expect(isItemActiveOnDate(subject, SAT, settings())).toBe(true);
    expect(isItemActiveOnDate(subject, SUN, settings())).toBe(true);
    expect(isItemActiveOnDate(subject, WED, settings())).toBe(false);
  });

  it("times_per_week never marks an individual date as required", () => {
    const subject = item({ rules: [rule({ mode: "times_per_week", timesPerWeek: 4 })] });
    for (const day of [MON, TUE, WED, THU, FRI, SAT, SUN]) {
      const occurrence = getOccurrenceForDate(subject, day, settings());
      expect(occurrence.active).toBe(false);
      expect(occurrence.flexible).toBe(true);
      expect(occurrence.state).toBe("flexible");
    }
  });

  it("one_time applies to exactly one date", () => {
    const subject = item({ rules: [rule({ mode: "one_time", effectiveFrom: WED })] });
    expect(isItemActiveOnDate(subject, WED, settings())).toBe(true);
    expect(isItemActiveOnDate(subject, THU, settings())).toBe(false);
  });

  it("interval_days repeats every N days from the anchor", () => {
    const subject = item({
      rules: [rule({ mode: "interval_days", interval: 3, effectiveFrom: MON })],
    });
    expect(isItemActiveOnDate(subject, MON, settings())).toBe(true);
    expect(isItemActiveOnDate(subject, TUE, settings())).toBe(false);
    expect(isItemActiveOnDate(subject, THU, settings())).toBe(true);
    expect(isItemActiveOnDate(subject, SUN, settings())).toBe(true);
  });

  it("interval_weeks skips whole weeks", () => {
    const subject = item({
      rules: [rule({ mode: "interval_weeks", interval: 2, weekdays: [1], effectiveFrom: MON })],
    });
    expect(isItemActiveOnDate(subject, MON, settings())).toBe(true);
    expect(isItemActiveOnDate(subject, "2026-03-09", settings())).toBe(false); // next Monday
    expect(isItemActiveOnDate(subject, "2026-03-16", settings())).toBe(true); // two weeks on
  });

  it("monthly clamps to the last day of short months", () => {
    const subject = item({
      rules: [rule({ mode: "monthly", monthDay: 31, effectiveFrom: "2026-01-31" })],
    });
    expect(isItemActiveOnDate(subject, "2026-01-31", settings())).toBe(true);
    expect(isItemActiveOnDate(subject, "2026-02-28", settings())).toBe(true); // clamped
    expect(isItemActiveOnDate(subject, "2026-02-27", settings())).toBe(false);
    expect(isItemActiveOnDate(subject, "2026-03-31", settings())).toBe(true);
  });
});

describe("lifespan and enablement", () => {
  it("a start date makes earlier dates inactive without calling them missed", () => {
    const subject = item({ startDate: WED });
    const before = getOccurrenceForDate(subject, TUE, settings());
    expect(before.active).toBe(false);
    expect(before.state).toBe("before_start");
    expect(isItemActiveOnDate(subject, WED, settings())).toBe(true);
  });

  it("an end date stops the schedule", () => {
    const subject = item({ endDate: WED });
    expect(isItemActiveOnDate(subject, WED, settings())).toBe(true);
    const after = getOccurrenceForDate(subject, THU, settings());
    expect(after.active).toBe(false);
    expect(after.state).toBe("after_end");
  });

  it("a disabled item is never active", () => {
    const subject = item({ enabled: false });
    expect(getOccurrenceForDate(subject, MON, settings()).state).toBe("disabled");
  });

  it("a disabled schedule version is never active", () => {
    const subject = item({ rules: [rule({ enabled: false })] });
    expect(getOccurrenceForDate(subject, MON, settings()).state).toBe("disabled");
  });
});

describe("effective-dated schedule versions", () => {
  const versioned = item({
    rules: [
      rule({ id: "v1", mode: "weekdays", weekdays: [1], effectiveFrom: "2026-01-01", effectiveTo: "2026-03-03" }),
      rule({ id: "v2", mode: "weekdays", weekdays: [1, 3, 5], effectiveFrom: "2026-03-04" }),
    ],
  });

  it("resolves the version that was in force on the date", () => {
    expect(resolveEffectiveSchedule(versioned, MON)?.id).toBe("v1");
    expect(resolveEffectiveSchedule(versioned, THU)?.id).toBe("v2");
  });

  it("history keeps the old schedule after the schedule is changed", () => {
    // Wednesday 2026-02-25 was not scheduled under v1 and must stay that way.
    expect(isItemActiveOnDate(versioned, "2026-02-25", settings())).toBe(false);
    // But Wednesday after the change is scheduled under v2.
    expect(isItemActiveOnDate(versioned, "2026-03-11", settings())).toBe(true);
  });
});

describe("date overrides", () => {
  const workout = item({ rules: [rule({ mode: "weekdays", weekdays: [1, 2, 4, 5] })] });

  it("a rest override makes a scheduled day neutral", () => {
    const subject = { ...workout, overrides: [ovr(MON, "rest")] };
    const occurrence = getOccurrenceForDate(subject, MON, settings());
    expect(occurrence.active).toBe(false);
    expect(occurrence.state).toBe("rest");
    expect(occurrence.counts).toBe(false);
    expect(occurrence.breaksStreakIfMissed).toBe(false);
  });

  it("an activate override turns an unscheduled day into an opportunity", () => {
    const subject = { ...workout, overrides: [ovr(WED, "activate")] };
    const occurrence = getOccurrenceForDate(subject, WED, settings());
    expect(occurrence.active).toBe(true);
    expect(occurrence.state).toBe("scheduled");
  });

  it("an excused override is neutral, not a miss", () => {
    const subject = { ...workout, overrides: [ovr(MON, "excused")] };
    const resolved = getStatusForDate(subject, MON, null, settings());
    expect(resolved.status).toBe("excused");
  });

  it("a cancel override removes the occurrence entirely", () => {
    const subject = { ...workout, overrides: [ovr(MON, "cancel")] };
    expect(getStatusForDate(subject, MON, null, settings()).status).toBe("canceled");
  });

  it("a reschedule moves the occurrence to the target date", () => {
    const subject = {
      ...workout,
      overrides: [{ date: MON, kind: "reschedule", movedToDate: WED, timeMinute: null, note: null }],
    };
    expect(getOccurrenceForDate(subject, MON, settings()).state).toBe("moved");
    const target = getOccurrenceForDate(subject, WED, settings());
    expect(target.active).toBe(true);
    expect(target.reason).toContain("Moved from");
  });

  it("an override never mutates the parent schedule", () => {
    const subject = { ...workout, overrides: [ovr(MON, "rest")] };
    // The following Monday is untouched.
    expect(isItemActiveOnDate(subject, "2026-03-09", settings())).toBe(true);
  });
});

function ovr(date: string, kind: string) {
  return { date, kind, movedToDate: null, timeMinute: null, note: null };
}

describe("status resolution", () => {
  const weekdayHabit = item({ rules: [rule({ mode: "weekdays", weekdays: [1, 2, 3, 4, 5] })] });

  it("a future scheduled date is never a failure", () => {
    const config = settings({ today: MON });
    expect(getStatusForDate(weekdayHabit, FRI, null, config).status).toBe("future");
  });

  it("today with nothing logged is pending, not missed", () => {
    const config = settings({ today: WED });
    expect(getStatusForDate(weekdayHabit, WED, null, config).status).toBe("pending");
  });

  it("a past scheduled date with nothing logged is missed", () => {
    const config = settings({ today: FRI });
    expect(getStatusForDate(weekdayHabit, WED, null, config).status).toBe("missed");
  });

  it("a weekend day for a weekday habit is not scheduled, not missed", () => {
    const config = settings({ today: SUN });
    expect(getStatusForDate(weekdayHabit, SAT, null, config).status).toBe("not_scheduled");
    expect(getStatusForDate(weekdayHabit, SUN, null, config).status).toBe("not_scheduled");
  });

  it("a completion on an unscheduled day still counts as completed", () => {
    const done: CompletionLike = { date: SAT, status: "done" };
    expect(getStatusForDate(weekdayHabit, SAT, done, settings()).status).toBe("completed");
  });
});

describe("scheduled opportunities are the denominator", () => {
  const config = settings({ today: SUN });
  const workoutGoal = item({ rules: [rule({ mode: "weekdays", weekdays: [1, 2, 4, 5] })] });

  it("counts only scheduled dates in the window", () => {
    const opportunities = calculateScheduledOpportunities(workoutGoal, MON, SUN, config);
    expect(opportunities.map((occurrence) => occurrence.date)).toEqual([MON, TUE, THU, FRI]);
  });

  it("reports 3 of 4 and 75%, never 3 of 7", () => {
    const completions: CompletionLike[] = [
      { date: MON, status: "done" },
      { date: TUE, status: "done" },
      { date: THU, status: "done" },
    ];
    const stats = calculateCompletionRate(workoutGoal, MON, SUN, completions, config);
    expect(stats.opportunities).toBe(4);
    expect(stats.completed).toBe(3);
    expect(stats.missed).toBe(1);
    expect(stats.rate).toBe(75);
  });

  it("rest days leave the denominator entirely", () => {
    const withRest = { ...workoutGoal, overrides: [ovr(TUE, "rest")] };
    const completions: CompletionLike[] = [
      { date: MON, status: "done" },
      { date: THU, status: "done" },
      { date: FRI, status: "done" },
    ];
    const stats = calculateCompletionRate(withRest, MON, SUN, completions, config);
    expect(stats.opportunities).toBe(3);
    expect(stats.rate).toBe(100);
  });

  it("returns a null rate rather than 0% when nothing was scheduled", () => {
    const weekendOnly = item({ rules: [rule({ mode: "weekdays", weekdays: [0, 6] })] });
    const stats = calculateCompletionRate(weekendOnly, MON, FRI, [], config);
    expect(stats.opportunities).toBe(0);
    expect(stats.rate).toBeNull();
  });
});

describe("streaks count scheduled opportunities, not calendar days", () => {
  const mwf = item({
    rules: [rule({ mode: "weekdays", weekdays: [1, 3, 5], effectiveFrom: "2026-03-02" })],
    startDate: "2026-03-02",
  });

  it("six consecutive Mon/Wed/Fri completions is a streak of six", () => {
    const dates = ["2026-03-02", "2026-03-04", "2026-03-06", "2026-03-09", "2026-03-11", "2026-03-13"];
    const completions = dates.map((date) => ({ date, status: "done" }));
    const result = calculateScheduledStreak(mwf, "2026-03-13", completions, settings({ today: "2026-03-13" }));
    expect(result.current).toBe(6);
    expect(result.unit).toBe("occurrences");
  });

  it("unscheduled days neither extend nor break the streak", () => {
    const completions = [
      { date: "2026-03-02", status: "done" },
      { date: "2026-03-04", status: "done" },
    ];
    // Tuesday 03-03 has nothing logged and is not scheduled.
    const result = calculateScheduledStreak(mwf, "2026-03-04", completions, settings({ today: "2026-03-04" }));
    expect(result.current).toBe(2);
  });

  it("a missed scheduled day breaks the streak", () => {
    const completions = [
      { date: "2026-03-02", status: "done" },
      // 03-04 missed
      { date: "2026-03-06", status: "done" },
    ];
    const result = calculateScheduledStreak(mwf, "2026-03-06", completions, settings({ today: "2026-03-06" }));
    expect(result.current).toBe(1);
    expect(result.longest).toBe(1);
  });

  it("an excused day keeps the streak alive", () => {
    const subject = { ...mwf, overrides: [ovr("2026-03-04", "excused")] };
    const completions = [
      { date: "2026-03-02", status: "done" },
      { date: "2026-03-06", status: "done" },
    ];
    const result = calculateScheduledStreak(subject, "2026-03-06", completions, settings({ today: "2026-03-06" }));
    expect(result.current).toBe(2);
  });

  it("a rest day keeps the streak alive", () => {
    const subject = { ...mwf, overrides: [ovr("2026-03-04", "rest")] };
    const completions = [
      { date: "2026-03-02", status: "done" },
      { date: "2026-03-06", status: "done" },
    ];
    const result = calculateScheduledStreak(subject, "2026-03-06", completions, settings({ today: "2026-03-06" }));
    expect(result.current).toBe(2);
  });

  it("a deliberate skip breaks the streak", () => {
    const completions = [
      { date: "2026-03-02", status: "done" },
      { date: "2026-03-04", status: "skipped" },
      { date: "2026-03-06", status: "done" },
    ];
    const result = calculateScheduledStreak(mwf, "2026-03-06", completions, settings({ today: "2026-03-06" }));
    expect(result.current).toBe(1);
  });

  it("an unlogged today does not break the streak", () => {
    const completions = [
      { date: "2026-03-02", status: "done" },
      { date: "2026-03-04", status: "done" },
    ];
    // Friday is today and scheduled, but the day is not over.
    const result = calculateScheduledStreak(mwf, "2026-03-06", completions, settings({ today: "2026-03-06" }));
    expect(result.current).toBe(2);
  });
});

describe("weekly progress", () => {
  const config = settings({ today: THU });
  const fourPerWeek = item({ rules: [rule({ mode: "times_per_week", timesPerWeek: 4 })] });

  it("reports 3 of 4 with one remaining", () => {
    const completions = [
      { date: MON, status: "done" },
      { date: TUE, status: "done" },
      { date: WED, status: "done" },
    ];
    const progress = calculateWeeklyProgress(fourPerWeek, THU, completions, config);
    expect(progress.done).toBe(3);
    expect(progress.target).toBe(4);
    expect(progress.remaining).toBe(1);
    expect(progress.percent).toBe(75);
  });

  it("is not failed before the week ends", () => {
    const progress = calculateWeeklyProgress(fourPerWeek, THU, [], config);
    expect(progress.failed).toBe(false);
    expect(progress.daysLeft).toBeGreaterThan(0);
  });

  it("is failed once the week is over and the target was missed", () => {
    const later = settings({ today: "2026-03-16" });
    const progress = calculateWeeklyProgress(fourPerWeek, THU, [], later);
    expect(progress.failed).toBe(true);
  });

  it("caps the percentage when the target is exceeded", () => {
    const completions = [MON, TUE, WED, THU, FRI, SAT].map((date) => ({ date, status: "done" }));
    const progress = calculateWeeklyProgress(fourPerWeek, THU, completions, config);
    expect(progress.percent).toBe(100);
    expect(progress.remaining).toBe(0);
  });

  it("uses scheduled days as the target for weekday schedules", () => {
    const mtthf = item({ rules: [rule({ mode: "weekdays", weekdays: [1, 2, 4, 5] })] });
    const progress = calculateWeeklyProgress(mtthf, THU, [{ date: MON, status: "done" }], config);
    expect(progress.target).toBe(4);
    expect(progress.done).toBe(1);
  });

  it("a weekly streak counts consecutive weeks that hit the target", () => {
    const completions = [
      // week of 2026-02-23
      { date: "2026-02-23", status: "done" },
      { date: "2026-02-25", status: "done" },
      // week of 2026-03-02
      { date: MON, status: "done" },
      { date: WED, status: "done" },
    ];
    const twice = item({ rules: [rule({ mode: "times_per_week", timesPerWeek: 2 })] });
    const result = calculateScheduledStreak(twice, SUN, completions, settings({ today: SUN }));
    expect(result.unit).toBe("weeks");
    expect(result.current).toBe(2);
  });
});

describe("week bounds respect the week-start preference", () => {
  it("Monday start", () => {
    const bounds = getWeekBounds(WED, { weekStartsOn: 1 });
    expect(bounds.start).toBe(MON);
    expect(bounds.end).toBe(SUN);
    expect(bounds.days).toHaveLength(7);
  });

  it("Sunday start", () => {
    const bounds = getWeekBounds(WED, { weekStartsOn: 0 });
    expect(bounds.start).toBe("2026-03-01");
    expect(bounds.end).toBe("2026-03-07");
  });

  it("a times-per-week target follows the configured week start", () => {
    const twice = item({ rules: [rule({ mode: "times_per_week", timesPerWeek: 2 })] });
    const completions = [{ date: SUN, status: "done" }];

    // With a Monday start, Sunday 03-08 closes the week of 03-02.
    const monday = calculateWeeklyProgress(twice, WED, completions, settings({ weekStartsOn: 1, today: SUN }));
    expect(monday.done).toBe(1);

    // With a Sunday start, Sunday 03-08 belongs to the *next* week.
    const sunday = calculateWeeklyProgress(twice, WED, completions, settings({ weekStartsOn: 0, today: SUN }));
    expect(sunday.done).toBe(0);
  });
});

describe("navigation", () => {
  const mwf = item({ rules: [rule({ mode: "weekdays", weekdays: [1, 3, 5] })] });

  it("finds the next scheduled date", () => {
    expect(getNextScheduledDate(mwf, MON, settings())).toBe(WED);
    expect(getNextScheduledDate(mwf, FRI, settings())).toBe("2026-03-09");
  });

  it("finds the previous scheduled date", () => {
    expect(getPreviousScheduledDate(mwf, WED, settings())).toBe(MON);
  });

  it("returns null when a one-time item has no further occurrence", () => {
    const once = item({ rules: [rule({ mode: "one_time", effectiveFrom: MON })] });
    expect(getNextScheduledDate(once, MON, settings(), 30)).toBeNull();
  });
});

describe("overdue detection", () => {
  const timed = item({
    rules: [rule({ mode: "weekdays", weekdays: [1, 2, 3, 4, 5], timeMinute: 9 * 60 })],
  });

  it("a future date is never overdue", () => {
    expect(isOverdueOccurrence(timed, FRI, settings({ today: MON }))).toBe(false);
  });

  it("a past scheduled date with nothing logged is overdue", () => {
    expect(isOverdueOccurrence(timed, MON, settings({ today: WED }))).toBe(true);
  });

  it("today before the scheduled time is not overdue", () => {
    const config = settings({ today: WED });
    expect(isOverdueOccurrence(timed, WED, config, { nowMinute: 8 * 60 })).toBe(false);
  });

  it("today after the scheduled time is overdue", () => {
    const config = settings({ today: WED });
    expect(isOverdueOccurrence(timed, WED, config, { nowMinute: 10 * 60 })).toBe(true);
  });

  it("a rest day is never overdue", () => {
    const resting = { ...timed, overrides: [ovr(MON, "rest")] };
    expect(isOverdueOccurrence(resting, MON, settings({ today: WED }))).toBe(false);
  });
});

describe("timezone handling", () => {
  it("derives the calendar day in the requested timezone", () => {
    // 03:30 UTC on the 5th is still the 4th in New York.
    const instant = new Date("2026-03-05T03:30:00Z");
    expect(createStableDateKey(instant, "America/New_York")).toBe("2026-03-04");
    expect(createStableDateKey(instant, "UTC")).toBe("2026-03-05");
    expect(createStableDateKey(instant, "Asia/Tokyo")).toBe("2026-03-05");
  });

  it("falls back to the host calendar day for an invalid timezone", () => {
    const instant = new Date(2026, 2, 5, 12, 0, 0);
    expect(createStableDateKey(instant, "Not/AZone")).toBe("2026-03-05");
  });

  it("todayIn respects the timezone", () => {
    const instant = new Date("2026-03-05T02:00:00Z");
    expect(todayIn("America/New_York", instant)).toBe("2026-03-04");
    expect(todayIn("Europe/London", instant)).toBe("2026-03-05");
  });

  it("nowMinuteIn reports local wall-clock minutes", () => {
    const instant = new Date("2026-03-05T15:45:00Z");
    expect(nowMinuteIn("UTC", instant)).toBe(15 * 60 + 45);
    expect(nowMinuteIn("America/New_York", instant)).toBe(10 * 60 + 45); // UTC-5 in March
  });

  it("survives a daylight-saving transition without shifting the day", () => {
    // US DST begins 2026-03-08. Every day around it must still resolve.
    const dstWeek = item({ rules: [rule({ mode: "every_day" })] });
    for (const date of ["2026-03-07", "2026-03-08", "2026-03-09"]) {
      expect(isItemActiveOnDate(dstWeek, date, settings())).toBe(true);
    }
    // And the calendar day of local noon is unchanged across the transition.
    expect(createStableDateKey(new Date("2026-03-08T17:00:00Z"), "America/New_York")).toBe("2026-03-08");
  });
});

describe("boundaries", () => {
  it("handles a month boundary", () => {
    const daily = item({ rules: [rule({ mode: "every_day" })] });
    const opportunities = calculateScheduledOpportunities(daily, "2026-02-27", "2026-03-02", settings());
    expect(opportunities.map((o) => o.date)).toEqual([
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
      "2026-03-02",
    ]);
  });

  it("handles a leap-year February", () => {
    const daily = item({ rules: [rule({ mode: "every_day" })] });
    const opportunities = calculateScheduledOpportunities(daily, "2028-02-28", "2028-03-01", settings());
    expect(opportunities.map((o) => o.date)).toEqual(["2028-02-28", "2028-02-29", "2028-03-01"]);
  });

  it("handles a year boundary", () => {
    const daily = item({ rules: [rule({ mode: "every_day" })] });
    const opportunities = calculateScheduledOpportunities(daily, "2026-12-30", "2027-01-02", settings());
    expect(opportunities.map((o) => o.date)).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
    ]);
  });
});

describe("descriptions", () => {
  it("summarises each mode", () => {
    expect(describeSchedule(rule({ mode: "every_day" }))).toBe("Every day");
    expect(describeSchedule(rule({ mode: "weekdays", weekdays: [1, 2, 3, 4, 5] }))).toBe("Weekdays");
    expect(describeSchedule(rule({ mode: "weekdays", weekdays: [0, 6] }))).toBe("Weekends");
    expect(describeSchedule(rule({ mode: "weekdays", weekdays: [1, 2, 4, 5] }))).toBe("Mon, Tue, Thu, Fri");
    expect(describeSchedule(rule({ mode: "times_per_week", timesPerWeek: 4 }))).toBe("4× per week");
    expect(describeSchedule(rule({ enabled: false }))).toBe("Disabled");
    expect(describeSchedule(null)).toBe("No schedule");
  });
});

describe("rule input normalisation", () => {
  it("drops weekdays for modes that do not use them", () => {
    const normalised = normalizeRuleInput({ mode: "every_day", weekdays: [1, 2, 3] });
    expect(normalised.weekdays).toEqual([]);
  });

  it("clamps times per week into 1-7", () => {
    expect(normalizeRuleInput({ mode: "times_per_week", timesPerWeek: 99 }).timesPerWeek).toBe(7);
    expect(normalizeRuleInput({ mode: "times_per_week", timesPerWeek: 0 }).timesPerWeek).toBe(1);
  });

  it("rejects unknown modes rather than storing them", () => {
    expect(normalizeRuleInput({ mode: "nonsense" }).mode).toBe("every_day");
  });

  it("de-duplicates and sorts weekdays", () => {
    const normalised = normalizeRuleInput({ mode: "weekdays", weekdays: [5, 1, 1, 3] });
    expect(normalised.weekdays).toEqual([1, 3, 5]);
  });
});

describe("wallClockToInstant", () => {
  /**
   * The inverse of createStableDateKey: a naive "YYYY-MM-DDTHH:mm" is the
   * user's OWN clock, so it must resolve against their timezone rather than
   * the machine's. On a hosted deployment the machine is UTC, which is how a
   * 9am reminder becomes a 5am one.
   */
  it("resolves a wall clock in the named zone, not the host's", () => {
    // 09:00 in New York during EDT is 13:00 UTC.
    const summer = wallClockToInstant("2026-08-02T09:00", "America/New_York");
    expect(summer?.toISOString()).toBe("2026-08-02T13:00:00.000Z");

    // The same wall clock in January is EST — 14:00 UTC.
    const winter = wallClockToInstant("2026-01-15T09:00", "America/New_York");
    expect(winter?.toISOString()).toBe("2026-01-15T14:00:00.000Z");
  });

  it("handles zones east of UTC and half-hour offsets", () => {
    expect(wallClockToInstant("2026-08-02T09:00", "Europe/Berlin")?.toISOString()).toBe(
      "2026-08-02T07:00:00.000Z",
    );
    expect(wallClockToInstant("2026-08-02T09:00", "Asia/Kolkata")?.toISOString()).toBe(
      "2026-08-02T03:30:00.000Z",
    );
    expect(wallClockToInstant("2026-08-02T09:00", "UTC")?.toISOString()).toBe(
      "2026-08-02T09:00:00.000Z",
    );
  });

  it("survives a spring-forward boundary without drifting a day", () => {
    // 2026-03-08 02:30 does not exist in New York (clocks jump 02:00 → 03:00).
    // The result must still land on that morning, not the previous day.
    const resolved = wallClockToInstant("2026-03-08T02:30", "America/New_York");
    expect(resolved).not.toBeNull();
    expect(resolved!.toISOString().slice(0, 10)).toBe("2026-03-08");
  });

  it("accepts seconds and a space separator, and refuses anything else", () => {
    expect(wallClockToInstant("2026-08-02 09:00:30", "UTC")?.toISOString()).toBe(
      "2026-08-02T09:00:30.000Z",
    );
    expect(wallClockToInstant("next tuesday", "UTC")).toBeNull();
    expect(wallClockToInstant("2026-08-02", "UTC")).toBeNull();
    expect(wallClockToInstant("", "UTC")).toBeNull();
  });

  it("falls back to the host clock when the zone is unusable", () => {
    const resolved = wallClockToInstant("2026-08-02T09:00", "Not/AZone");
    expect(resolved).not.toBeNull();
  });
});
