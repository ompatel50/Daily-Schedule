import { describe, expect, it } from "vitest";

import { parseQuickAdd } from "@/lib/logic/quick-add";

// A fixed Monday, so weekday maths is deterministic.
const MONDAY = "2026-03-02";

describe("parseQuickAdd", () => {
  it("keeps plain text as an all-day item", () => {
    const result = parseQuickAdd("Call the dentist", MONDAY);
    expect(result.title).toBe("Call the dentist");
    expect(result.allDay).toBe(true);
    expect(result.date).toBe(MONDAY);
  });

  it("parses a 12-hour time range", () => {
    const result = parseQuickAdd("Gym 6:30-7:30pm", MONDAY);
    expect(result.startMinute).toBe(18 * 60 + 30);
    expect(result.endMinute).toBe(19 * 60 + 30);
    expect(result.allDay).toBe(false);
    expect(result.title).toBe("Gym");
  });

  it("applies a trailing meridiem to the start of a range", () => {
    const result = parseQuickAdd("Deep work 9-11am", MONDAY);
    expect(result.startMinute).toBe(9 * 60);
    expect(result.endMinute).toBe(11 * 60);
  });

  it("parses 24-hour times", () => {
    const result = parseQuickAdd("Standup 09:30", MONDAY);
    expect(result.startMinute).toBe(9 * 60 + 30);
    expect(result.endMinute).toBeNull();
  });

  it("parses a single 'at' time", () => {
    const result = parseQuickAdd("Coffee with Sam at 3pm", MONDAY);
    expect(result.startMinute).toBe(15 * 60);
    expect(result.title).toBe("Coffee with Sam");
  });

  it("understands relative dates", () => {
    expect(parseQuickAdd("Groceries tomorrow", MONDAY).date).toBe("2026-03-03");
    expect(parseQuickAdd("Retro yesterday", MONDAY).date).toBe("2026-03-01");
    expect(parseQuickAdd("Errands today", MONDAY).date).toBe(MONDAY);
  });

  it("resolves weekday names to the next occurrence", () => {
    expect(parseQuickAdd("Meal prep sunday", MONDAY).date).toBe("2026-03-08");
    // Naming today's weekday means next week, not today.
    expect(parseQuickAdd("Review monday", MONDAY).date).toBe("2026-03-09");
  });

  it("accepts an explicit ISO date", () => {
    expect(parseQuickAdd("Flight 2026-04-12", MONDAY).date).toBe("2026-04-12");
  });

  it("reads a #category tag", () => {
    const result = parseQuickAdd("Physio #health", MONDAY);
    expect(result.category).toBe("health");
    expect(result.tags).toEqual([]);
  });

  it("collects non-category tags separately", () => {
    const result = parseQuickAdd("Write spec #deepwork #focus", MONDAY);
    expect(result.tags).toEqual(["deepwork", "focus"]);
    expect(result.title).toBe("Write spec");
  });

  it("reads a !priority flag", () => {
    expect(parseQuickAdd("Ship release !urgent", MONDAY).priority).toBe("urgent");
    expect(parseQuickAdd("Water plants", MONDAY).priority).toBe("medium");
  });

  it("infers a category from keywords", () => {
    expect(parseQuickAdd("Gym session", MONDAY).category).toBe("fitness");
    expect(parseQuickAdd("Team meeting", MONDAY).category).toBe("work");
    expect(parseQuickAdd("Dinner with Alex", MONDAY).category).toBe("meal");
  });

  it("combines every modifier at once", () => {
    const result = parseQuickAdd("Deep work 9-11am !high tomorrow #focus", MONDAY);
    expect(result).toMatchObject({
      title: "Deep work",
      date: "2026-03-03",
      startMinute: 540,
      endMinute: 660,
      priority: "high",
      tags: ["focus"],
      allDay: false,
    });
  });

  it("never loses the input entirely", () => {
    // "#work" alone leaves no title text — fall back to the raw input.
    expect(parseQuickAdd("#work", MONDAY).title).toBe("#work");
  });

  it("ignores impossible times rather than mangling the title", () => {
    const result = parseQuickAdd("Race 26:99", MONDAY);
    expect(result.startMinute).toBeNull();
    expect(result.title).toContain("Race");
  });
});
