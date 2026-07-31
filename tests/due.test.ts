import { describe, expect, it } from "vitest";

import { daysBetween, type DayKey } from "@/lib/date";
import {
  DUE_SOON_DAYS,
  daysUntil,
  describeDueDistance,
  dueBucketOf,
  isOverdue,
  nextOccurrenceAfter,
  type Cadence,
} from "@/lib/logic/due";

const daily = (every = 1): Cadence => ({ unit: "daily", every });
const weekly = (every = 1): Cadence => ({ unit: "weekly", every });
const monthly = (every = 1): Cadence => ({ unit: "monthly", every });
const quarterly = (every = 1): Cadence => ({ unit: "quarterly", every });
const yearly = (every = 1): Cadence => ({ unit: "yearly", every });

/** Feed each result back in as `after` — the series a bill/task actually walks. */
function chain(anchor: DayKey, cadence: Cadence, from: DayKey, steps: number): DayKey[] {
  const out: DayKey[] = [];
  let after = from;
  for (let i = 0; i < steps; i += 1) {
    after = nextOccurrenceAfter(anchor, cadence, after);
    out.push(after);
  }
  return out;
}

describe("nextOccurrenceAfter", () => {
  it("advances a daily cadence by one day", () => {
    expect(nextOccurrenceAfter("2026-01-01", daily(), "2026-01-01")).toBe("2026-01-02");
    expect(nextOccurrenceAfter("2026-01-01", daily(), "2026-01-05")).toBe("2026-01-06");
  });

  it("keeps a daily every=3 series on the anchor's grid", () => {
    // Occurrences: Jan 1, 4, 7, 10...
    expect(nextOccurrenceAfter("2026-01-01", daily(3), "2026-01-01")).toBe("2026-01-04");
    expect(nextOccurrenceAfter("2026-01-01", daily(3), "2026-01-04")).toBe("2026-01-07");
    // A mid-cycle `after` snaps to the grid, not to `after + 3`.
    expect(nextOccurrenceAfter("2026-01-01", daily(3), "2026-01-05")).toBe("2026-01-07");
  });

  it("advances a weekly cadence by seven days", () => {
    expect(nextOccurrenceAfter("2026-01-05", weekly(), "2026-01-05")).toBe("2026-01-12");
    expect(nextOccurrenceAfter("2026-01-05", weekly(), "2026-01-11")).toBe("2026-01-12");
  });

  it("keeps a fortnightly series anchored, skipping the off week", () => {
    // Occurrences: Jan 5, 19, Feb 2...
    expect(nextOccurrenceAfter("2026-01-05", weekly(2), "2026-01-05")).toBe("2026-01-19");
    expect(nextOccurrenceAfter("2026-01-05", weekly(2), "2026-01-06")).toBe("2026-01-19");
    expect(nextOccurrenceAfter("2026-01-05", weekly(2), "2026-01-19")).toBe("2026-02-02");
  });

  it("monthly on the 31st clamps to Feb 28 and RETURNS to the 31st — no drift", () => {
    expect(chain("2026-01-31", monthly(), "2026-01-31", 4)).toEqual([
      "2026-02-28", // 2026 is not a leap year
      "2026-03-31", // back to the true day — never stuck on the 28th
      "2026-04-30", // clamped again in a 30-day month
      "2026-05-31", // and back again
    ]);
  });

  it("monthly on the 31st clamps to Feb 29 in a leap year", () => {
    expect(chain("2024-01-31", monthly(), "2024-01-31", 2)).toEqual([
      "2024-02-29",
      "2024-03-31",
    ]);
  });

  it("quarterly walks three months at a time, clamping without drift", () => {
    // Anchor Jan 31 → Apr 30 → Jul 31 → Oct 31.
    expect(chain("2026-01-31", quarterly(), "2026-01-31", 3)).toEqual([
      "2026-04-30",
      "2026-07-31",
      "2026-10-31",
    ]);
  });

  it("yearly with a Feb-29 anchor clamps to Feb 28 off-years and recovers on the leap year", () => {
    expect(chain("2024-02-29", yearly(), "2024-02-29", 4)).toEqual([
      "2025-02-28",
      "2026-02-28",
      "2027-02-28",
      "2028-02-29", // the anchor day comes back when the calendar allows it
    ]);
  });

  it("returns the anchor itself when the series has not started yet", () => {
    expect(nextOccurrenceAfter("2026-09-01", monthly(), "2026-07-31")).toBe("2026-09-01");
    expect(nextOccurrenceAfter("2026-08-01", daily(), "2026-07-31")).toBe("2026-08-01");
  });

  it("never returns `after` itself — always strictly after", () => {
    const cases: Array<[DayKey, Cadence, DayKey]> = [
      ["2026-01-01", daily(), "2026-01-01"],
      ["2026-01-05", weekly(2), "2026-01-19"],
      ["2026-01-31", monthly(), "2026-02-28"],
      ["2026-01-15", quarterly(), "2026-04-15"],
      ["2024-02-29", yearly(), "2025-02-28"],
    ];
    for (const [anchor, cadence, after] of cases) {
      const next = nextOccurrenceAfter(anchor, cadence, after);
      expect(daysBetween(after, next), `${cadence.unit} from ${after}`).toBeGreaterThan(0);
    }
  });

  it("treats every < 1 as 1", () => {
    expect(nextOccurrenceAfter("2026-01-01", daily(0), "2026-01-01")).toBe("2026-01-02");
    expect(nextOccurrenceAfter("2026-01-05", weekly(-3), "2026-01-05")).toBe("2026-01-12");
  });

  // Regression: the occurrence-index estimate once assumed 28-day months and
  // overshot for anchors years in the past, silently skipping an occurrence
  // (anchor 2023-01-31, after 2026-07-31 returned 2026-09-30 instead of
  // 2026-08-31). The estimate now divides by the unit's MAXIMUM span so it
  // can only undershoot, and the upward walk finds the true first occurrence.
  it("returns the FIRST occurrence even when `after` is years past a monthly anchor", () => {
    expect(nextOccurrenceAfter("2023-01-31", monthly(), "2026-07-31")).toBe("2026-08-31");
  });

  it("stays correct decades past the anchor, in every unit", () => {
    expect(nextOccurrenceAfter("2000-01-31", monthly(), "2026-07-31")).toBe("2026-08-31");
    expect(nextOccurrenceAfter("2000-03-31", quarterly(), "2026-07-30")).toBe("2026-09-30");
    expect(nextOccurrenceAfter("2000-02-29", yearly(), "2026-07-30")).toBe("2027-02-28");
    expect(nextOccurrenceAfter("2000-01-03", weekly(), "2026-07-30")).toBe("2026-08-03");
  });
});

describe("daysUntil / isOverdue / dueBucketOf", () => {
  const today = "2026-07-31";

  it("signs the distance: negative when overdue", () => {
    expect(daysUntil("2026-07-30", today)).toBe(-1);
    expect(daysUntil(today, today)).toBe(0);
    expect(daysUntil("2026-08-01", today)).toBe(1);
    expect(daysUntil("2026-08-08", today)).toBe(8);
  });

  it("is overdue strictly before today, never on it", () => {
    expect(isOverdue("2026-07-30", today)).toBe(true);
    expect(isOverdue(today, today)).toBe(false);
    expect(isOverdue("2026-08-01", today)).toBe(false);
  });

  it("buckets across the default 7-day soon window", () => {
    expect(DUE_SOON_DAYS).toBe(7);
    expect(dueBucketOf("2026-07-30", today)).toBe("overdue"); // yesterday
    expect(dueBucketOf("2026-07-31", today)).toBe("today");
    expect(dueBucketOf("2026-08-01", today)).toBe("soon"); // tomorrow
    expect(dueBucketOf("2026-08-07", today)).toBe("soon"); // +7, inclusive edge
    expect(dueBucketOf("2026-08-08", today)).toBe("later"); // +8, first day out
  });

  it("widens or narrows with a custom soonDays", () => {
    expect(dueBucketOf("2026-08-14", today, 14)).toBe("soon"); // +14
    expect(dueBucketOf("2026-08-15", today, 14)).toBe("later"); // +15
    // soonDays 0 collapses the window: tomorrow is already "later".
    expect(dueBucketOf("2026-08-01", today, 0)).toBe("later");
    expect(dueBucketOf(today, today, 0)).toBe("today");
  });
});

describe("describeDueDistance", () => {
  const today = "2026-07-31";

  it("uses one exact wording per distance", () => {
    expect(describeDueDistance("2026-07-29", today)).toBe("2 days overdue"); // -2
    expect(describeDueDistance("2026-07-30", today)).toBe("1 day overdue"); // -1
    expect(describeDueDistance("2026-07-31", today)).toBe("Due today"); // 0
    expect(describeDueDistance("2026-08-01", today)).toBe("Due tomorrow"); // +1
    expect(describeDueDistance("2026-08-05", today)).toBe("Due in 5 days"); // +5
  });
});
