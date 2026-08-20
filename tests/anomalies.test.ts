import { describe, expect, it } from "vitest";

import { shiftDay } from "@/lib/date";
import {
  ANOMALY_WEEKLY_LIMIT,
  CLINICIAN_NOTE,
  type AnomalyInput,
  detectAnomalies,
  scaledMad,
} from "@/lib/logic/anomalies";
import type { DailyFact } from "@/lib/logic/daily-facts";
import { factsFrom } from "./fixtures/daily-fact";

/**
 * The anomaly engine: robust baselines, per-detector history gates, the hard
 * weekly budget, dismissal-driven sensitivity, mutes, and observation-only
 * copy. Everything a nudge is allowed (and forbidden) to do, pinned.
 */

const TODAY = "2026-03-12";
const START = shiftDay(TODAY, -69); // 70 days of history ending today
const WEEK_START = "2026-03-09";

/** Build facts by days-before-today, the way the detectors look at them. */
function history(build: (daysAgo: number) => Partial<DailyFact>) {
  return factsFrom(START, 70, (index) => build(69 - index));
}

function run(
  facts: DailyFact[],
  overrides: Partial<AnomalyInput> = {},
) {
  return detectAnomalies({
    facts,
    today: TODAY,
    weekStart: WEEK_START,
    habits: [],
    preferences: {},
    deliveredThisWeek: 0,
    deliveredKeys: new Set(),
    ...overrides,
  });
}

describe("scaledMad", () => {
  it("is the scaled median absolute deviation, robust to one outlier", () => {
    expect(scaledMad([10, 10, 10, 10])).toBe(0);
    // Median 12, absolute deviations [2,1,0,1,88] → MAD 1 → ×1.4826.
    expect(scaledMad([10, 11, 12, 13, 100])).toBeCloseTo(1.4826, 4);
  });
});

describe("resting heart rate", () => {
  const steady = (daysAgo: number): Partial<DailyFact> =>
    daysAgo >= 6 && daysAgo <= 35 ? { restingHr: daysAgo % 2 === 0 ? 55 : 56 } : {};

  it("fires after a sustained run above the baseline band", () => {
    const facts = history((daysAgo) =>
      daysAgo >= 1 && daysAgo <= 5 ? { restingHr: 64 } : steady(daysAgo),
    );
    const report = run(facts);
    const signal = report.signals.find((entry) => entry.category === "resting_hr");
    expect(signal).toBeDefined();
    expect(signal?.key).toBe(`anomaly:resting_hr:${WEEK_START}`);
    expect(signal?.message).toContain("bpm");
    expect(signal?.clinicianNote).toBe(true); // first time — the one brief note
    expect(report.ready).toContain("resting_hr");
  });

  it("stays quiet without enough baseline history — a new account gets nothing", () => {
    // Only 15 measured baseline days: below the 20-day gate.
    const facts = history((daysAgo) =>
      daysAgo >= 1 && daysAgo <= 5
        ? { restingHr: 80 }
        : daysAgo >= 6 && daysAgo <= 20
          ? { restingHr: 55 }
          : {},
    );
    const report = run(facts);
    expect(report.signals.find((entry) => entry.category === "resting_hr")).toBeUndefined();
    expect(report.ready).not.toContain("resting_hr");
  });

  it("dismissals raise the threshold and retire the clinician note", () => {
    // Readings modestly above baseline: enough at base sensitivity, not
    // after two dismissals.
    const facts = history((daysAgo) =>
      daysAgo >= 1 && daysAgo <= 5 ? { restingHr: 60 } : steady(daysAgo),
    );
    const fresh = run(facts);
    expect(fresh.signals.find((entry) => entry.category === "resting_hr")).toBeDefined();

    const onceDismissed = run(facts, {
      preferences: { resting_hr: { muted: false, dismissals: 1 } },
    });
    const stillFiring = onceDismissed.signals.find((entry) => entry.category === "resting_hr");
    if (stillFiring) expect(stillFiring.clinicianNote).toBe(false);

    const twiceDismissed = run(facts, {
      preferences: { resting_hr: { muted: false, dismissals: 2 } },
    });
    expect(
      twiceDismissed.signals.find((entry) => entry.category === "resting_hr"),
    ).toBeUndefined();
  });
});

describe("sleep debt", () => {
  const baseline = (daysAgo: number): Partial<DailyFact> =>
    daysAgo >= 8 && daysAgo <= 37 ? { sleepHours: 7.5 } : {};

  it("fires when the last week runs well below the 30-day median", () => {
    const facts = history((daysAgo) =>
      daysAgo >= 1 && daysAgo <= 7 ? { sleepHours: 6.5 } : baseline(daysAgo),
    );
    const signal = run(facts).signals.find((entry) => entry.category === "sleep_debt");
    expect(signal).toBeDefined();
    expect(signal?.message).toMatch(/7 nights/);
  });

  it("stays quiet for an ordinary week", () => {
    const facts = history((daysAgo) =>
      daysAgo >= 1 && daysAgo <= 7 ? { sleepHours: 7.0 } : baseline(daysAgo),
    );
    expect(run(facts).signals.find((entry) => entry.category === "sleep_debt")).toBeUndefined();
  });
});

describe("habit streak breaks", () => {
  const yesterday = shiftDay(TODAY, -1);

  it("notes a long streak that broke yesterday — factually, per habit", () => {
    const report = run(history(() => ({})), {
      habits: [
        { name: "Meditate", streakBeforeBreak: 30, brokeOn: yesterday },
        { name: "Read", streakBeforeBreak: 12, brokeOn: yesterday }, // too short
        { name: "Stretch", streakBeforeBreak: 40, brokeOn: shiftDay(TODAY, -3) }, // stale
      ],
    });
    const signals = report.signals.filter((entry) => entry.category === "habit_streak");
    expect(signals).toHaveLength(1);
    expect(signals[0].title).toBe("Meditate streak ended");
    expect(signals[0].key).toContain("meditate");
    expect(signals[0].key).toContain(yesterday);
  });

  it("dismissals raise the streak floor", () => {
    const report = run(history(() => ({})), {
      habits: [{ name: "Meditate", streakBeforeBreak: 25, brokeOn: yesterday }],
      preferences: { habit_streak: { muted: false, dismissals: 1 } }, // floor 28
    });
    expect(report.signals.filter((entry) => entry.category === "habit_streak")).toHaveLength(0);
  });
});

describe("workout frequency", () => {
  it("fires when the current fortnight falls to half the usual rate", () => {
    const facts = history((daysAgo) =>
      daysAgo >= 15 && daysAgo <= 56 && daysAgo % 3 === 0 ? { workoutCount: 1 } : {},
    );
    const signal = run(facts).signals.find((entry) => entry.category === "workout_frequency");
    expect(signal).toBeDefined();
    expect(signal?.message).toMatch(/0 workouts in the last 14 days/);
  });

  it("needs a real training baseline before a drop means anything", () => {
    // One workout a fortnight is not a rate whose halving is a signal.
    const facts = history((daysAgo) =>
      daysAgo === 20 || daysAgo === 40 ? { workoutCount: 1 } : {},
    );
    const report = run(facts);
    expect(report.signals.find((entry) => entry.category === "workout_frequency")).toBeUndefined();
    expect(report.ready).not.toContain("workout_frequency");
  });
});

describe("spending", () => {
  const withDining = (dailyRecent: number, dailyUsual: number) =>
    history((daysAgo) => {
      if (daysAgo >= 1 && daysAgo <= 7) {
        return { spendByCategory: { dining: dailyRecent }, transactionCount: 1 };
      }
      if (daysAgo >= 8 && daysAgo <= 63) {
        return { spendByCategory: { dining: dailyUsual }, transactionCount: 1 };
      }
      return {};
    });

  it("fires per category when a week lands far outside its usual range", () => {
    const signal = run(withDining(2000, 300)).signals.find(
      (entry) => entry.category === "spending",
    );
    expect(signal).toBeDefined();
    expect(signal?.key).toBe(`anomaly:spending:dining:${WEEK_START}`);
    expect(signal?.title).toContain("Dining");
    expect(signal?.message).toMatch(/\$/);
  });

  it("stays quiet for ordinary variation and for sparse categories", () => {
    expect(
      run(withDining(360, 300)).signals.find((entry) => entry.category === "spending"),
    ).toBeUndefined();

    // Active in only 3 of 8 baseline weeks: below the activity gate.
    const sparse = history((daysAgo) =>
      daysAgo === 10 || daysAgo === 20 || daysAgo === 30
        ? { spendByCategory: { travel: 50000 }, transactionCount: 1 }
        : {},
    );
    const report = run(sparse);
    expect(report.signals.find((entry) => entry.category === "spending")).toBeUndefined();
    expect(report.ready).not.toContain("spending");
  });
});

describe("budget, dedup, mutes and copy", () => {
  const everything = () => {
    const facts = history((daysAgo) => {
      const fact: Partial<DailyFact> = {};
      if (daysAgo >= 1 && daysAgo <= 5) fact.restingHr = 64;
      else if (daysAgo >= 6 && daysAgo <= 35) fact.restingHr = 55;
      if (daysAgo >= 1 && daysAgo <= 7) fact.sleepHours = 6.0;
      else if (daysAgo >= 8 && daysAgo <= 37) fact.sleepHours = 7.5;
      if (daysAgo >= 15 && daysAgo <= 56 && daysAgo % 3 === 0) fact.workoutCount = 1;
      fact.spendByCategory =
        daysAgo >= 1 && daysAgo <= 7
          ? { dining: 2000 }
          : daysAgo >= 8 && daysAgo <= 63
            ? { dining: 300 }
            : {};
      return fact;
    });
    return { facts, habits: [{ name: "Meditate", streakBeforeBreak: 30, brokeOn: shiftDay(TODAY, -1) }] };
  };

  it("caps delivery at the weekly limit, health first, but reports every observation", () => {
    const { facts, habits } = everything();
    const report = run(facts, { habits });
    expect(report.observations.length).toBe(5);
    expect(report.signals.length).toBe(ANOMALY_WEEKLY_LIMIT);
    expect(report.signals.map((signal) => signal.category)).toEqual([
      "resting_hr",
      "sleep_debt",
      "habit_streak",
    ]);
  });

  it("counts earlier deliveries against the budget and never re-delivers a claimed key", () => {
    const { facts, habits } = everything();
    const twoUsed = run(facts, { habits, deliveredThisWeek: 2 });
    expect(twoUsed.signals.length).toBe(1);

    const claimed = run(facts, {
      habits,
      deliveredKeys: new Set([`anomaly:resting_hr:${WEEK_START}`]),
    });
    expect(claimed.signals.map((signal) => signal.category)).toEqual([
      "sleep_debt",
      "habit_streak",
      "workout_frequency",
    ]);
    // The claimed signal is still a live observation for the card.
    expect(claimed.observations.some((signal) => signal.category === "resting_hr")).toBe(true);
  });

  it("skips a muted category entirely", () => {
    const { facts, habits } = everything();
    const report = run(facts, {
      habits,
      preferences: { spending: { muted: true, dismissals: 0 } },
    });
    expect(report.observations.some((signal) => signal.category === "spending")).toBe(false);
    expect(report.ready).not.toContain("spending");
  });

  it("says nothing at all on an empty account", () => {
    const report = run([]);
    expect(report.signals).toHaveLength(0);
    expect(report.observations).toHaveLength(0);
    expect(report.ready).toHaveLength(0);
  });

  it("keeps every message observational — no diagnosis, alarm or advice", () => {
    const { facts, habits } = everything();
    const report = run(facts, { habits });
    for (const signal of report.observations) {
      expect(`${signal.title} ${signal.message}`).not.toMatch(
        /diagnos|condition|disease|risk|warning|urgent|should|see a doctor|advice|too much|overspend/i,
      );
    }
    // The clinician sentence itself: brief, no alarm.
    expect(CLINICIAN_NOTE).not.toMatch(/urgent|immediately|risk|warning/i);
    expect(CLINICIAN_NOTE.length).toBeLessThan(100);
  });
});
