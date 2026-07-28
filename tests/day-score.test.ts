import { describe, expect, it } from "vitest";

import {
  calendarStateFor,
  computeDayScore,
  parseScoreWeights,
  validateScoreWeights,
  type ScoreExclusion,
  type ScoreOpportunity,
} from "@/lib/logic/day-score";

const DATE = "2026-03-04";

function opportunity(overrides: Partial<ScoreOpportunity> = {}): ScoreOpportunity {
  return {
    id: "o1",
    label: "Something",
    category: "planner",
    kind: "binary",
    credit: 1,
    met: true,
    pending: false,
    status: "completed",
    detail: "Completed",
    ...overrides,
  };
}

function exclusion(overrides: Partial<ScoreExclusion> = {}): ScoreExclusion {
  return {
    id: "x1",
    label: "Workout",
    category: "goals",
    reason: "rest_day",
    detail: "Rest day",
    ...overrides,
  };
}

describe("only applicable opportunities enter the denominator", () => {
  it("scores two of four as 50%", () => {
    const score = computeDayScore({
      date: DATE,
      opportunities: [
        opportunity({ id: "a", met: true, credit: 1 }),
        opportunity({ id: "b", met: true, credit: 1 }),
        opportunity({ id: "c", met: false, credit: 0, status: "missed" }),
        opportunity({ id: "d", met: false, credit: 0, status: "missed" }),
      ],
      exclusions: [],
    });
    expect(score.score).toBe(50);
    expect(score.totals.applicable).toBe(4);
    expect(score.totals.completed).toBe(2);
  });

  it("excluded records never enter the denominator", () => {
    const score = computeDayScore({
      date: DATE,
      opportunities: [opportunity({ id: "a" })],
      exclusions: [exclusion({ id: "x" }), exclusion({ id: "y", reason: "not_scheduled" })],
    });
    expect(score.score).toBe(100);
    expect(score.totals.applicable).toBe(1);
    expect(score.totals.excluded).toBe(2);
  });

  it("rest days do not lower the score", () => {
    const withRest = computeDayScore({
      date: DATE,
      opportunities: [opportunity({ id: "a" })],
      exclusions: [exclusion({ reason: "rest_day" })],
    });
    const without = computeDayScore({
      date: DATE,
      opportunities: [opportunity({ id: "a" })],
      exclusions: [],
    });
    expect(withRest.score).toBe(without.score);
  });
});

describe("an empty day is not a zero", () => {
  it("returns null rather than 0 when nothing applied", () => {
    const score = computeDayScore({ date: DATE, opportunities: [], exclusions: [] });
    expect(score.score).toBeNull();
    expect(score.hasApplicable).toBe(false);
    expect(score.explanation).toContain("not a zero");
  });

  it("does not divide by zero when a category is empty", () => {
    const score = computeDayScore({
      date: DATE,
      opportunities: [opportunity({ category: "habits" })],
      exclusions: [],
    });
    expect(score.score).toBe(100);
    const planner = score.categories.find((category) => category.category === "planner");
    expect(planner?.percent).toBeNull();
    expect(planner?.weight).toBe(0);
  });

  it("a category with nothing applicable contributes no weight", () => {
    const score = computeDayScore({
      date: DATE,
      opportunities: [
        opportunity({ id: "a", category: "habits", met: true, credit: 1 }),
        opportunity({ id: "b", category: "goals", met: false, credit: 0, status: "missed" }),
      ],
      exclusions: [],
    });
    // Two participating categories, weighted equally: 100% and 0% → 50%.
    expect(score.score).toBe(50);
    expect(score.categories.find((c) => c.category === "planner")?.weight).toBe(0);
    expect(score.categories.find((c) => c.category === "habits")?.weight).toBe(50);
  });
});

describe("partial progress", () => {
  it("is counted proportionally", () => {
    const score = computeDayScore({
      date: DATE,
      opportunities: [
        opportunity({ id: "a", category: "goals", kind: "partial", met: false, credit: 0.75, status: "missed" }),
      ],
      exclusions: [],
    });
    expect(score.score).toBe(75);
    expect(score.categories.find((c) => c.category === "goals")?.partial).toBe(1);
  });

  it("is capped at the intended maximum", () => {
    const score = computeDayScore({
      date: DATE,
      opportunities: [opportunity({ id: "a", kind: "partial", credit: 4, met: true })],
      exclusions: [],
    });
    expect(score.score).toBe(100);
    expect(score.totals.pointsEarned).toBeLessThanOrEqual(score.totals.pointsAvailable);
  });

  it("negative or non-finite credit is treated as zero", () => {
    const score = computeDayScore({
      date: DATE,
      opportunities: [
        opportunity({ id: "a", credit: -3, met: false, status: "missed" }),
        opportunity({ id: "b", credit: Number.NaN, met: false, status: "missed" }),
      ],
      exclusions: [],
    });
    expect(score.score).toBe(0);
  });
});

describe("category and overall totals agree", () => {
  it("the sum of category points equals the day's points", () => {
    const score = computeDayScore({
      date: DATE,
      opportunities: [
        opportunity({ id: "a", category: "planner", credit: 1, met: true }),
        opportunity({ id: "b", category: "planner", credit: 0, met: false, status: "missed" }),
        opportunity({ id: "c", category: "habits", credit: 1, met: true }),
        opportunity({ id: "d", category: "goals", kind: "partial", credit: 0.5, met: false, status: "missed" }),
      ],
      exclusions: [],
    });

    const categorySum = score.categories.reduce((total, c) => total + c.pointsEarned, 0);
    expect(categorySum).toBeCloseTo(score.totals.pointsEarned);
    expect(score.totals.applicable).toBe(4);
    expect(score.totals.completed).toBe(2);
    expect(score.totals.missed).toBe(2);
  });

  it("pending opportunities are counted separately from misses", () => {
    const score = computeDayScore({
      date: DATE,
      opportunities: [
        opportunity({ id: "a", met: false, credit: 0, pending: true, status: "pending" }),
        opportunity({ id: "b", met: false, credit: 0, status: "missed" }),
      ],
      exclusions: [],
    });
    expect(score.totals.pending).toBe(1);
    expect(score.totals.missed).toBe(1);
  });
});

describe("weights", () => {
  it("defaults to equal weighting across participating categories", () => {
    const score = computeDayScore({
      date: DATE,
      opportunities: [
        opportunity({ id: "a", category: "planner" }),
        opportunity({ id: "b", category: "habits" }),
      ],
      exclusions: [],
    });
    expect(score.weights.planner).toBe(50);
    expect(score.weights.habits).toBe(50);
    expect(score.weights.goals).toBe(0);
    expect(score.explanation).toContain("weighting 2 categories equally");
  });

  it("honours configured weights", () => {
    const score = computeDayScore({
      date: DATE,
      opportunities: [
        opportunity({ id: "a", category: "planner", credit: 1, met: true }),
        opportunity({ id: "b", category: "habits", credit: 0, met: false, status: "missed" }),
      ],
      exclusions: [],
      weights: { planner: 80, habits: 20, goals: 0 },
    });
    expect(score.score).toBe(80);
  });

  it("falls back to equal weighting when configured weights land on empty categories", () => {
    const score = computeDayScore({
      date: DATE,
      opportunities: [opportunity({ id: "a", category: "goals", credit: 1, met: true })],
      exclusions: [],
      weights: { planner: 100, habits: 0, goals: 0 },
    });
    expect(score.score).toBe(100);
  });

  it("parses stored weights and rejects malformed ones", () => {
    expect(parseScoreWeights('{"planner":40,"habits":30,"goals":30}')).toEqual({
      planner: 40,
      habits: 30,
      goals: 30,
    });
    expect(parseScoreWeights("not json")).toBeNull();
    expect(parseScoreWeights(null)).toBeNull();
    expect(parseScoreWeights("{}")).toBeNull();
  });

  it("validates that weights total 100", () => {
    expect(validateScoreWeights({ planner: 40, habits: 30, goals: 30 }).valid).toBe(true);
    const bad = validateScoreWeights({ planner: 40, habits: 30, goals: 10 });
    expect(bad.valid).toBe(false);
    expect(bad.message).toContain("100%");
  });
});

describe("explanations", () => {
  it("states the counts and lists exclusions", () => {
    const score = computeDayScore({
      date: DATE,
      opportunities: [
        opportunity({ id: "a", credit: 1, met: true }),
        opportunity({ id: "b", credit: 0, met: false, status: "missed" }),
      ],
      exclusions: [exclusion()],
    });
    expect(score.explanation).toContain("1 of 2 applicable opportunities met");
    expect(score.explanation).toContain("1 item");
  });

  it("says a category with nothing applicable did not affect the score", () => {
    const score = computeDayScore({
      date: DATE,
      opportunities: [opportunity({ category: "planner" })],
      exclusions: [],
    });
    const goals = score.categories.find((category) => category.category === "goals");
    expect(goals?.explanation).toContain("did not affect this score");
  });
});

describe("calendar day states", () => {
  const base = { score: 100, applicable: 3, completed: 3, isFuture: false, hasAnyRecord: true };

  it("marks a fully completed day", () => {
    expect(calendarStateFor(base)).toBe("completed");
  });

  it("marks a partial day", () => {
    expect(calendarStateFor({ ...base, score: 60, completed: 2 })).toBe("partial");
  });

  it("marks a missed day", () => {
    expect(calendarStateFor({ ...base, score: 0, completed: 0 })).toBe("missed");
  });

  it("never marks a future day as missed", () => {
    expect(calendarStateFor({ ...base, score: 0, completed: 0, isFuture: true })).toBe("future");
  });

  it("marks a day with nothing scheduled as open, not missed", () => {
    expect(calendarStateFor({ score: null, applicable: 0, completed: 0, isFuture: false, hasAnyRecord: true })).toBe(
      "open",
    );
  });

  it("distinguishes a rest day from an empty one", () => {
    expect(
      calendarStateFor({
        score: null,
        applicable: 0,
        completed: 0,
        isFuture: false,
        hasAnyRecord: true,
        isRestDay: true,
      }),
    ).toBe("rest");
  });

  it("distinguishes no data from an open day", () => {
    expect(
      calendarStateFor({ score: null, applicable: 0, completed: 0, isFuture: false, hasAnyRecord: false }),
    ).toBe("no_data");
  });
});
