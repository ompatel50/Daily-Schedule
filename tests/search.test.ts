import { describe, expect, it } from "vitest";

import {
  buildSearchHits,
  emptySearchRows,
  SEARCH_GROUPS,
  type SearchRows,
} from "@/lib/logic/search";

const REF = "2026-07-30";

function rows(partial: Partial<SearchRows>): SearchRows {
  return { ...emptySearchRows(), ...partial };
}

describe("global search hits", () => {
  it("returns nothing for empty rows", () => {
    expect(buildSearchHits(emptySearchRows(), REF)).toEqual([]);
  });

  it("labels dates relative to the SUPPLIED today, not the host clock", () => {
    const hits = buildSearchHits(
      rows({
        items: [
          { id: "a", title: "Deep work", date: "2026-07-30", category: "work" },
          { id: "b", title: "Review", date: "2026-07-29", category: "work" },
        ],
      }),
      REF,
    );
    expect(hits[0].subtitle).toContain("Today");
    expect(hits[1].subtitle).toContain("Yesterday");
  });

  it("sends every entity to the surface that owns it", () => {
    const hits = buildSearchHits(
      rows({
        items: [{ id: "i", title: "Standup", date: "2026-07-30", category: "work" }],
        routines: [{ id: "r", name: "Sunday reset", category: "personal" }],
        habits: [{ id: "h", name: "Stretch", category: "health", archived: false }],
        goals: [{ id: "g", label: "Protein", domain: "nutrition", unit: "g", target: 160 }],
        workouts: [{ id: "w", name: "Lower body", date: "2026-07-28", durationMin: 45 }],
        workoutTemplates: [{ id: "wt", name: "Push day", type: "strength" }],
        foods: [{ id: "f", name: "Oats", brand: null, category: "grain", calories: 389 }],
        mealTemplates: [{ id: "mt", name: "Standard breakfast", mealType: "breakfast" }],
        journal: [{ id: "j", title: null, content: "Long day but good.", date: "2026-07-29" }],
      }),
      REF,
    );

    const byGroup = new Map(hits.map((hit) => [hit.group, hit]));
    expect(byGroup.get("Planner")?.href).toBe("/planner?date=2026-07-30");
    expect(byGroup.get("Routines")?.href).toBe("/planner");
    expect(byGroup.get("Habits")?.href).toBe("/habits");
    expect(byGroup.get("Goals")?.href).toBe("/settings");
    expect(byGroup.get("Workouts")?.href).toBe("/workouts?date=2026-07-28");
    expect(byGroup.get("Templates")?.href).toBe("/workouts");
    expect(byGroup.get("Foods")?.href).toBe("/nutrition");
    expect(byGroup.get("Meal templates")?.href).toBe("/nutrition");
    expect(byGroup.get("Journal")?.href).toBe("/today?date=2026-07-29");
    // every declared group appeared, and ids are namespaced uniquely
    expect(new Set(hits.map((hit) => hit.group)).size).toBe(SEARCH_GROUPS.length);
    expect(new Set(hits.map((hit) => hit.id)).size).toBe(hits.length);
  });

  it("orders groups by declaration order, keeping within-group order stable", () => {
    const hits = buildSearchHits(
      rows({
        journal: [{ id: "j", title: "t", content: "c", date: "2026-07-29" }],
        items: [
          { id: "i1", title: "First", date: "2026-07-30", category: "work" },
          { id: "i2", title: "Second", date: "2026-07-29", category: "work" },
        ],
        foods: [{ id: "f", name: "Oats", brand: null, category: "grain", calories: 389 }],
      }),
      REF,
    );
    expect(hits.map((hit) => hit.group)).toEqual(["Planner", "Planner", "Foods", "Journal"]);
    expect(hits[0].title).toBe("First");
    expect(hits[1].title).toBe("Second");
  });

  it("summarises goals and titles journal entries from their content", () => {
    const hits = buildSearchHits(
      rows({
        goals: [{ id: "g", label: "Protein", domain: "nutrition", unit: "g", target: 160 }],
        journal: [
          { id: "j", title: null, content: "A very long entry ".repeat(10), date: "2026-07-29" },
        ],
      }),
      REF,
    );
    expect(hits[0].subtitle).toBe("nutrition · target 160 g");
    expect(hits[1].title.length).toBeLessThanOrEqual(60);
  });

  it("marks archived habits so a hit never hides that state", () => {
    const hits = buildSearchHits(
      rows({ habits: [{ id: "h", name: "Old habit", category: "health", archived: true }] }),
      REF,
    );
    expect(hits[0].subtitle).toContain("archived");
  });
});
