import { describe, expect, it } from "vitest";

import {
  describeRule,
  expandRule,
  matchesRule,
  parseRule,
  serializeRule,
  type RecurrenceRule,
} from "@/lib/logic/recurrence";

describe("matchesRule", () => {
  it("matches daily rules on every day", () => {
    const rule: RecurrenceRule = { freq: "daily", interval: 1 };
    expect(matchesRule(rule, "2026-03-02", "2026-03-02")).toBe(true);
    expect(matchesRule(rule, "2026-03-02", "2026-03-09")).toBe(true);
  });

  it("honours a daily interval", () => {
    const rule: RecurrenceRule = { freq: "daily", interval: 3 };
    expect(matchesRule(rule, "2026-03-02", "2026-03-05")).toBe(true);
    expect(matchesRule(rule, "2026-03-02", "2026-03-06")).toBe(false);
  });

  it("never matches before the anchor", () => {
    const rule: RecurrenceRule = { freq: "daily", interval: 1 };
    expect(matchesRule(rule, "2026-03-02", "2026-03-01")).toBe(false);
  });

  it("matches selected weekdays", () => {
    // 2026-03-02 is a Monday.
    const rule: RecurrenceRule = { freq: "weekly", interval: 1, byWeekday: [1, 3, 5] };
    expect(matchesRule(rule, "2026-03-02", "2026-03-02")).toBe(true); // Mon
    expect(matchesRule(rule, "2026-03-02", "2026-03-03")).toBe(false); // Tue
    expect(matchesRule(rule, "2026-03-02", "2026-03-04")).toBe(true); // Wed
    expect(matchesRule(rule, "2026-03-02", "2026-03-06")).toBe(true); // Fri
  });

  it("falls back to the anchor's weekday when none are given", () => {
    const rule: RecurrenceRule = { freq: "weekly", interval: 1, byWeekday: [] };
    expect(matchesRule(rule, "2026-03-02", "2026-03-09")).toBe(true);
    expect(matchesRule(rule, "2026-03-02", "2026-03-10")).toBe(false);
  });

  it("skips whole weeks when the interval is greater than one", () => {
    const rule: RecurrenceRule = { freq: "weekly", interval: 2, byWeekday: [1] };
    expect(matchesRule(rule, "2026-03-02", "2026-03-02")).toBe(true);
    expect(matchesRule(rule, "2026-03-02", "2026-03-09")).toBe(false);
    expect(matchesRule(rule, "2026-03-02", "2026-03-16")).toBe(true);
  });

  it("respects `until`", () => {
    const rule: RecurrenceRule = { freq: "daily", interval: 1, until: "2026-03-05" };
    expect(matchesRule(rule, "2026-03-02", "2026-03-05")).toBe(true);
    expect(matchesRule(rule, "2026-03-02", "2026-03-06")).toBe(false);
  });

  it("matches the same day of month, clamping to short months", () => {
    const rule: RecurrenceRule = { freq: "monthly", interval: 1 };
    expect(matchesRule(rule, "2026-01-31", "2026-02-28")).toBe(true);
    expect(matchesRule(rule, "2026-01-31", "2026-03-31")).toBe(true);
    expect(matchesRule(rule, "2026-01-31", "2026-03-30")).toBe(false);
  });
});

describe("expandRule", () => {
  it("lists occurrences inside the window", () => {
    const rule: RecurrenceRule = { freq: "weekly", interval: 1, byWeekday: [1, 4] };
    const days = expandRule(rule, "2026-03-02", "2026-03-02", "2026-03-15");
    expect(days).toEqual(["2026-03-02", "2026-03-05", "2026-03-09", "2026-03-12"]);
  });

  it("clips the window to the anchor", () => {
    const rule: RecurrenceRule = { freq: "daily", interval: 1 };
    expect(expandRule(rule, "2026-03-10", "2026-03-01", "2026-03-12")).toEqual([
      "2026-03-10",
      "2026-03-11",
      "2026-03-12",
    ]);
  });

  it("caps the total occurrence count", () => {
    const rule: RecurrenceRule = { freq: "daily", interval: 1, count: 3 };
    expect(expandRule(rule, "2026-03-02", "2026-03-02", "2026-03-30")).toHaveLength(3);
  });

  it("returns nothing for an inverted window", () => {
    const rule: RecurrenceRule = { freq: "daily", interval: 1 };
    expect(expandRule(rule, "2026-03-02", "2026-03-10", "2026-03-01")).toEqual([]);
  });
});

describe("parseRule / serializeRule", () => {
  it("round-trips a valid rule", () => {
    const rule: RecurrenceRule = { freq: "weekly", interval: 2, byWeekday: [1, 3] };
    const parsed = parseRule(serializeRule(rule));
    expect(parsed?.freq).toBe("weekly");
    expect(parsed?.interval).toBe(2);
    expect(parsed?.byWeekday).toEqual([1, 3]);
  });

  it("rejects malformed input rather than throwing", () => {
    expect(parseRule(null)).toBeNull();
    expect(parseRule("not json")).toBeNull();
    expect(parseRule('{"freq":"yearly"}')).toBeNull();
  });

  it("drops out-of-range weekdays", () => {
    expect(parseRule('{"freq":"weekly","interval":1,"byWeekday":[1,9,-2]}')?.byWeekday).toEqual([1]);
  });
});

describe("describeRule", () => {
  it("summarises common patterns", () => {
    expect(describeRule(null)).toBe("Does not repeat");
    expect(describeRule({ freq: "daily", interval: 1 })).toBe("Every day");
    expect(describeRule({ freq: "weekly", interval: 1, byWeekday: [1, 2, 3, 4, 5] })).toBe(
      "Every weekday",
    );
    expect(describeRule({ freq: "weekly", interval: 1, byWeekday: [1, 3] })).toBe("Every Mon, Wed");
  });
});
