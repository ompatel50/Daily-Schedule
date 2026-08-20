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
        tasks: [{ id: "t", title: "Renew passport", status: "open", dueDate: "2026-07-30" }],
        projects: [{ id: "p", name: "Move apartments", status: "active" }],
        inboxItems: [{ id: "x", title: "Call the dentist back", status: "open" }],
        tags: [{ id: "tg", name: "admin", taskCount: 3, plannerCount: 1 }],
        documents: [
          { id: "d", name: "Passport", kind: "id", issuer: "State Dept", expiryDate: "2026-09-30" },
        ],
        accounts: [{ id: "acc", name: "Everyday checking", type: "checking", archived: false, currency: "USD" }],
        transactions: [
          { id: "tx", payee: "Grocer", category: "groceries", date: "2026-07-29", amount: -4250, currency: "USD" },
        ],
        bills: [{ id: "bl", name: "Rent", kind: "bill", amount: 180000, nextDueDate: "2026-08-01" }],
        budgets: [{ id: "bu", category: "dining", amount: 25000, period: "monthly" }],
        savingsGoals: [{ id: "sg", name: "Emergency fund", targetAmount: 1000000, currentAmount: 250000 }],
        healthMetrics: [
          {
            type: "body_weight",
            label: "Body weight",
            unit: "lb",
            group: "body",
            count: 412,
            latestDate: "2026-07-29",
            latestValue: 178.4,
          },
        ],
        healthRecords: [
          {
            id: "hr",
            kind: "medication",
            title: "Metformin 500 mg",
            subtitle: "Riverside Clinic",
            date: "2026-07-20",
          },
        ],
        meals: [{ id: "m", date: "2026-07-29", type: "custom", label: "Pre-workout shake" }],
        reminders: [
          { id: "rem", title: "Take out bins", repeat: "weekly", enabled: true, day: "2026-07-31", blockDate: null },
        ],
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
    expect(byGroup.get("Tasks")?.href).toBe("/tasks");
    expect(byGroup.get("Projects")?.href).toBe("/tasks");
    expect(byGroup.get("Inbox")?.href).toBe("/inbox");
    expect(byGroup.get("Accounts")?.href).toBe("/finance");
    expect(byGroup.get("Transactions")?.href).toBe("/finance");
    expect(byGroup.get("Bills")?.href).toBe("/finance");
    expect(byGroup.get("Budgets")?.href).toBe("/finance");
    expect(byGroup.get("Savings goals")?.href).toBe("/finance");
    expect(byGroup.get("Tags")?.href).toBe("/tasks?tag=admin");
    expect(byGroup.get("Documents")?.href).toBe("/inbox");
    // A health metric hit is a route into the chart that owns it, not a row.
    expect(byGroup.get("Health")?.href).toBe("/health/body");
    expect(byGroup.get("Health")?.subtitle).toContain("412 readings");
    expect(byGroup.get("Health records")?.href).toBe("/health/vitals");
    expect(byGroup.get("Health records")?.subtitle).toContain("Medication");
    // A logged meal lands on its own day's nutrition page.
    expect(byGroup.get("Meals")?.href).toBe("/nutrition?date=2026-07-29");
    expect(byGroup.get("Meals")?.title).toBe("Pre-workout shake");
    // Reminders are managed from Settings — the hit deep-links the anchor.
    expect(byGroup.get("Reminders")?.href).toBe("/settings#reminders");
    expect(byGroup.get("Reminders")?.subtitle).toBe("Weekly reminder · Tomorrow");
    // every declared group appeared, and ids are namespaced uniquely
    expect(new Set(hits.map((hit) => hit.group)).size).toBe(SEARCH_GROUPS.length);
    expect(new Set(hits.map((hit) => hit.id)).size).toBe(hits.length);
  });

  it("describes the new entities usefully", () => {
    const hits = buildSearchHits(
      rows({
        tasks: [
          { id: "t1", title: "Overdue thing", status: "open", dueDate: "2026-07-28" },
          { id: "t2", title: "Finished thing", status: "done", dueDate: null },
        ],
        bills: [{ id: "b1", name: "Rent", kind: "bill", amount: 180000, nextDueDate: "2026-07-30" }],
        transactions: [
          { id: "tx", payee: null, category: "groceries", date: "2026-07-30", amount: -4250, currency: "USD" },
        ],
        savingsGoals: [{ id: "sg", name: "Fund", targetAmount: 1000000, currentAmount: 250000 }],
        accounts: [{ id: "a", name: "Old card", type: "credit_card", archived: true, currency: "USD" }],
      }),
      REF,
    );
    const byId = new Map(hits.map((hit) => [hit.id, hit]));
    expect(byId.get("task-t1")?.subtitle).toBe("2 days overdue");
    expect(byId.get("task-t2")?.subtitle).toBe("Done");
    expect(byId.get("bill-b1")?.subtitle).toBe("Bill · $1,800 · Due today");
    // A payee-less transaction titles itself from its category, not an empty string.
    expect(byId.get("txn-tx")?.title).toBe("Groceries");
    expect(byId.get("txn-tx")?.subtitle).toContain("$42.50");
    expect(byId.get("sg-sg")?.subtitle).toBe("$2,500 of $10,000 saved");
    expect(byId.get("acct-a")?.subtitle).toBe("Credit card · archived");
  });

  it("describes tags as filters and documents by their expiry", () => {
    const hits = buildSearchHits(
      rows({
        tags: [
          { id: "g1", name: "admin", taskCount: 3, plannerCount: 0 },
          { id: "g2", name: "money", taskCount: 1, plannerCount: 2 },
          { id: "g3", name: "unused", taskCount: 0, plannerCount: 0 },
        ],
        documents: [
          { id: "d1", name: "Passport", kind: "id", issuer: "State Dept", expiryDate: "2026-08-30" },
          { id: "d2", name: "Lease", kind: "lease", issuer: null, expiryDate: "2026-07-30" },
        ],
      }),
      REF,
    );
    const byId = new Map(hits.map((hit) => [hit.id, hit]));

    // A tag hit IS the filter — following it lands on the narrowed list.
    expect(byId.get("tag-g1")?.title).toBe("#admin");
    expect(byId.get("tag-g1")?.href).toBe("/tasks?tag=admin");
    expect(byId.get("tag-g1")?.subtitle).toBe("3 tasks");
    expect(byId.get("tag-g2")?.subtitle).toBe("1 task · 2 planner items");
    expect(byId.get("tag-g3")?.subtitle).toBe("Tag · not used yet");

    expect(byId.get("doc-d1")?.subtitle).toBe("State Dept · ID & travel · Expires in 31 days");
    expect(byId.get("doc-d2")?.subtitle).toBe("Lease & housing · Expires today");
  });

  it("escapes a tag name that would otherwise break the filter link", () => {
    const [hit] = buildSearchHits(
      rows({ tags: [{ id: "g", name: "deep work", taskCount: 1, plannerCount: 0 }] }),
      REF,
    );
    expect(hit.href).toBe("/tasks?tag=deep%20work");
  });

  it("labels a weekly budget as weekly", () => {
    const [hit] = buildSearchHits(
      rows({ budgets: [{ id: "bu", category: "dining", amount: 6000, period: "weekly" }] }),
      REF,
    );
    expect(hit.subtitle).toBe("$60 weekly");
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

  it("labels meals without a custom label by their type", () => {
    const [hit] = buildSearchHits(
      rows({ meals: [{ id: "m", date: "2026-07-30", type: "lunch", label: null }] }),
      REF,
    );
    expect(hit.title).toBe("Lunch");
    expect(hit.subtitle).toBe("Today · Meal");
  });

  it("shows a disabled reminder as off", () => {
    const [hit] = buildSearchHits(
      rows({
        reminders: [{ id: "r", title: "Stretch", repeat: "none", enabled: false, day: "2026-07-30", blockDate: null }],
      }),
      REF,
    );
    expect(hit.subtitle).toBe("Reminder · Today · off");
  });

  it("deep-links a block-born reminder to its planner day", () => {
    const [hit] = buildSearchHits(
      rows({
        reminders: [
          {
            id: "r",
            title: "Leave for the airport",
            repeat: "none",
            enabled: true,
            day: "2026-08-02",
            blockDate: "2026-08-02",
          },
        ],
      }),
      REF,
    );
    expect(hit.href).toBe("/planner?date=2026-08-02");
  });

  describe("ranking", () => {
    it("floats the group holding an exact title match above earlier groups", () => {
      const hits = buildSearchHits(
        rows({
          // "Tasks" is declared before "Transactions", but the transaction's
          // payee IS the query — its group should lead.
          tasks: [{ id: "t", title: "Email Chipotle catering", status: "open", dueDate: null }],
          transactions: [
            {
              id: "tx",
              payee: "Chipotle",
              category: "dining",
              date: "2026-07-29",
              amount: -1240,
              currency: "USD",
            },
          ],
        }),
        REF,
        "chipotle",
      );
      expect(hits[0].group).toBe("Transactions");
      expect(hits[1].group).toBe("Tasks");
    });

    it("keeps declaration order when no group holds a stronger title match", () => {
      const hits = buildSearchHits(
        rows({
          tasks: [{ id: "t", title: "Buy protein powder", status: "open", dueDate: null }],
          foods: [{ id: "f", name: "Whey protein bar", brand: null, category: "snack", calories: 210 }],
        }),
        REF,
        "protein",
      );
      // Both are word-boundary matches — Tasks is declared first and stays first.
      expect(hits[0].group).toBe("Tasks");
    });

    it("ranks exact over prefix over substring within a group", () => {
      const hits = buildSearchHits(
        rows({
          tasks: [
            { id: "a", title: "Tax return checklist", status: "open", dueDate: null },
            { id: "b", title: "Tax", status: "open", dueDate: null },
            { id: "c", title: "File the tax", status: "open", dueDate: null },
          ],
        }),
        REF,
        "tax",
      );
      expect(hits.map((hit) => hit.id)).toEqual(["task-b", "task-a", "task-c"]);
    });

    it("breaks equal-strength ties by recency", () => {
      const hits = buildSearchHits(
        rows({
          items: [
            { id: "old", title: "Standup", date: "2026-03-01", category: "work" },
            { id: "recent", title: "Standup", date: "2026-07-29", category: "work" },
          ],
        }),
        REF,
        "standup",
      );
      expect(hits[0].id).toBe("item-recent");
      expect(hits[1].id).toBe("item-old");
    });

    it("never reorders groups on recency alone", () => {
      const hits = buildSearchHits(
        rows({
          tasks: [{ id: "t", title: "Renew gym membership", status: "open", dueDate: null }],
          workouts: [{ id: "w", name: "Morning gym session", date: REF, durationMin: 45 }],
        }),
        REF,
        "gym",
      );
      // Both match at word-boundary strength; the workout is more recent but
      // recency must not pull "Workouts" above the earlier-declared "Tasks".
      expect(hits[0].group).toBe("Tasks");
    });
  });
});
