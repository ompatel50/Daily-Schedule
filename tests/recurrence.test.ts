import { describe, expect, it } from "vitest";

import {
  advanceRuleTo,
  describeRecurrence,
  describeRulePattern,
  describeRuleRange,
  describeRule,
  expandRule,
  matchesRule,
  materializeAnchorFields,
  missingSeriesSlots,
  parseRule,
  parseSkipDates,
  rulesEqual,
  serializeRule,
  serializeSkipDates,
  truncateRuleBefore,
  withSkipDate,
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

describe("the series' active range", () => {
  // The semester schedule from the spec: Mon/Wed/Fri, Aug 24 – Dec 11 2026.
  const semester: RecurrenceRule = {
    freq: "weekly",
    interval: 1,
    byWeekday: [1, 3, 5],
    until: "2026-12-11",
  };
  const anchor = "2026-08-24"; // a Monday

  it("generates nothing before the start date", () => {
    expect(expandRule(semester, anchor, "2026-08-01", "2026-08-23")).toEqual([]);
    expect(matchesRule(semester, anchor, "2026-08-21")).toBe(false); // the Friday before
  });

  it("includes the end date when it matches the pattern — inclusive, exactly", () => {
    const tail = expandRule(semester, anchor, "2026-12-01", "2026-12-31");
    // 2026-12-11 is a Friday: the last occurrence lands ON the end date.
    expect(tail[tail.length - 1]).toBe("2026-12-11");
    expect(tail).toContain("2026-12-11");
  });

  it("generates nothing after the end date", () => {
    expect(expandRule(semester, anchor, "2026-12-12", "2027-02-01")).toEqual([]);
    expect(matchesRule(semester, anchor, "2026-12-14")).toBe(false); // the Monday after
  });

  it("only ever generates pattern days in between", () => {
    const week = expandRule(semester, anchor, "2026-08-24", "2026-08-30");
    expect(week).toEqual(["2026-08-24", "2026-08-26", "2026-08-28"]); // Mon, Wed, Fri
  });

  it("an open-ended rule is bounded only by the requested window", () => {
    const open: RecurrenceRule = { freq: "daily", interval: 1 };
    expect(expandRule(open, anchor, "2027-06-01", "2027-06-03")).toEqual([
      "2027-06-01",
      "2027-06-02",
      "2027-06-03",
    ]);
  });
});

describe("recurrence summaries", () => {
  const semester: RecurrenceRule = {
    freq: "weekly",
    interval: 1,
    byWeekday: [1, 3, 5],
    until: "2026-12-11",
  };

  it("splits the pattern from the range", () => {
    expect(describeRulePattern(semester)).toBe("Every Mon, Wed, Fri");
    expect(describeRuleRange(semester, "2026-08-24")).toBe("Aug 24 – Dec 11");
  });

  it("composes the one-line summary", () => {
    expect(describeRecurrence(semester, "2026-08-24")).toBe("Every Mon, Wed, Fri · Aug 24 – Dec 11");
    expect(describeRecurrence({ freq: "daily", interval: 1 }, "2026-08-24")).toBe(
      "Every day · Starting Aug 24 · No end date",
    );
    expect(describeRecurrence(null, "2026-08-24")).toBe("Does not repeat");
  });
});

describe("skip dates — deleted occurrences that stay deleted", () => {
  it("round-trips a sorted, deduplicated set", () => {
    const stored = serializeSkipDates(["2026-08-26", "2026-08-24", "2026-08-26"]);
    expect(parseSkipDates(stored)).toEqual(["2026-08-24", "2026-08-26"]);
  });

  it("is empty for nothing, junk, or malformed entries", () => {
    expect(parseSkipDates(null)).toEqual([]);
    expect(parseSkipDates("not json")).toEqual([]);
    expect(parseSkipDates('{"a":1}')).toEqual([]);
    expect(parseSkipDates('["2026-08-24","nope",42]')).toEqual(["2026-08-24"]);
    expect(serializeSkipDates([])).toBeNull();
  });

  it("adds idempotently", () => {
    const once = withSkipDate(null, "2026-08-24");
    const twice = withSkipDate(once, "2026-08-24");
    expect(twice).toBe(once);
    expect(parseSkipDates(twice)).toEqual(["2026-08-24"]);
  });
});

describe("series-split helpers", () => {
  it("pins anchor-derived fields so a rule survives re-anchoring", () => {
    // A weekly rule with no explicit weekdays means "the anchor's weekday";
    // 2026-08-24 is a Monday, and that Monday must survive an anchor move.
    const implicitWeekly: RecurrenceRule = { freq: "weekly", interval: 1, byWeekday: [] };
    expect(materializeAnchorFields(implicitWeekly, "2026-08-24").byWeekday).toEqual([1]);

    const implicitMonthly: RecurrenceRule = { freq: "monthly", interval: 1 };
    expect(materializeAnchorFields(implicitMonthly, "2026-08-24").byMonthDay).toBe(24);

    // Explicit fields are never touched.
    const explicit: RecurrenceRule = { freq: "weekly", interval: 1, byWeekday: [2, 4] };
    expect(materializeAnchorFields(explicit, "2026-08-24").byWeekday).toEqual([2, 4]);
  });

  it("truncates the old series to the day before the split", () => {
    const open: RecurrenceRule = { freq: "daily", interval: 1 };
    expect(truncateRuleBefore(open, "2026-10-05").until).toBe("2026-10-04");

    // An end date already earlier than the split stays put.
    const bounded: RecurrenceRule = { freq: "daily", interval: 1, until: "2026-09-01" };
    expect(truncateRuleBefore(bounded, "2026-10-05").until).toBe("2026-09-01");

    // One later is pulled in.
    const later: RecurrenceRule = { freq: "daily", interval: 1, until: "2026-12-11" };
    expect(truncateRuleBefore(later, "2026-10-05").until).toBe("2026-10-04");
  });

  it("advances the series' start without moving a single later occurrence", () => {
    // 2026-08-24 is a Monday; the series runs Mon/Wed/Fri to Dec 11.
    const rule: RecurrenceRule = {
      freq: "weekly",
      interval: 1,
      byWeekday: [1, 3, 5],
      until: "2026-12-11",
    };
    const advanced = advanceRuleTo(rule, "2026-08-24", "2026-09-07");
    // The pattern and the (inclusive) end date are the point of the mirror:
    // trimming the history must not touch what is still ahead.
    expect(advanced.byWeekday).toEqual([1, 3, 5]);
    expect(advanced.until).toBe("2026-12-11");
    expect(expandRule(advanced, "2026-09-07", "2026-09-07", "2026-09-14")).toEqual(
      expandRule(rule, "2026-08-24", "2026-09-07", "2026-09-14"),
    );

    // Anchor-derived fields are pinned against the OLD anchor, so an implicit
    // "every week on the anchor's weekday" cannot drift when the anchor moves.
    const implicit: RecurrenceRule = { freq: "weekly", interval: 1, byWeekday: [] };
    expect(advanceRuleTo(implicit, "2026-08-24", "2026-09-07").byWeekday).toEqual([1]);
    const monthly: RecurrenceRule = { freq: "monthly", interval: 1 };
    expect(advanceRuleTo(monthly, "2026-08-24", "2026-10-24").byMonthDay).toBe(24);

    // A `count` loses exactly the occurrences left behind — never below one.
    const counted: RecurrenceRule = { freq: "daily", interval: 1, count: 10 };
    expect(advanceRuleTo(counted, "2026-08-24", "2026-08-27").count).toBe(7);
    expect(advanceRuleTo(counted, "2026-08-24", "2026-08-24").count).toBe(10);
    expect(advanceRuleTo(counted, "2026-08-24", "2027-08-24").count).toBe(1);
    expect(advanceRuleTo({ freq: "daily", interval: 1 }, "2026-08-24", "2026-08-27").count)
      .toBeUndefined();
  });

  it("compares rules by meaning, not by field order", () => {
    const a: RecurrenceRule = { freq: "weekly", interval: 1, byWeekday: [1, 3], until: "2026-12-11" };
    expect(rulesEqual(a, { ...a, byWeekday: [3, 1] })).toBe(true);
    expect(rulesEqual(a, { ...a, until: undefined })).toBe(false);
    expect(rulesEqual(a, { ...a, byWeekday: [1] })).toBe(false);
    expect(rulesEqual(a, { ...a, freq: "daily" })).toBe(false);
    expect(rulesEqual(null, null)).toBe(true);
    expect(rulesEqual(a, null)).toBe(false);
  });
});

describe("missingSeriesSlots — regeneration in one pure function", () => {
  const daily: RecurrenceRule = { freq: "daily", interval: 1 };

  it("fills the window minus existing rows and deleted slots", () => {
    const slots = missingSeriesSlots({
      rule: daily,
      anchor: "2026-08-24",
      from: "2026-08-25",
      to: "2026-08-29",
      existingSlots: ["2026-08-24", "2026-08-26"],
      skipDates: serializeSkipDates(["2026-08-28"]),
    });
    expect(slots).toEqual(["2026-08-25", "2026-08-27", "2026-08-29"]);
  });

  it("is idempotent: applying its own output leaves nothing to do", () => {
    const first = missingSeriesSlots({
      rule: daily,
      anchor: "2026-08-24",
      from: "2026-08-25",
      to: "2026-08-29",
      existingSlots: ["2026-08-24"],
    });
    const second = missingSeriesSlots({
      rule: daily,
      anchor: "2026-08-24",
      from: "2026-08-25",
      to: "2026-08-29",
      existingSlots: ["2026-08-24", ...first],
    });
    expect(second).toEqual([]);
  });

  it("a moved occurrence's original slot still counts as occupied", () => {
    // The row's date changed, but its slot identity (originalDate) did not —
    // so the vacated day is not refilled.
    const slots = missingSeriesSlots({
      rule: daily,
      anchor: "2026-08-24",
      from: "2026-08-25",
      to: "2026-08-26",
      existingSlots: ["2026-08-24", "2026-08-25", "2026-08-26"],
    });
    expect(slots).toEqual([]);
  });

  it("respects the rule's inclusive end date inside the window", () => {
    const bounded: RecurrenceRule = { freq: "daily", interval: 1, until: "2026-08-27" };
    const slots = missingSeriesSlots({
      rule: bounded,
      anchor: "2026-08-24",
      from: "2026-08-25",
      to: "2026-09-15",
      existingSlots: ["2026-08-24"],
    });
    expect(slots).toEqual(["2026-08-25", "2026-08-26", "2026-08-27"]);
  });
});
