import { describe, expect, it } from "vitest";

import { MANUAL_ENTRY_METRICS, MEAL_TYPES } from "@/lib/enums";
import {
  describeCaptureDraft,
  HEALTH_CAPTURE_ALIASES,
  inferMealType,
  parseCapture,
  parseCaptureAs,
  type CaptureDraft,
  type CaptureIntent,
} from "@/lib/logic/capture";
import { parseQuickAdd } from "@/lib/logic/quick-add";

// A Monday, so weekday words resolve deterministically (same anchor the
// quick-add suite uses).
const MONDAY = "2026-03-02";
const OPTS = { baseDate: MONDAY, nowMinute: 12 * 60, unitSystem: "imperial" };

function draftOf(input: string): CaptureDraft {
  return parseCapture(input, OPTS).draft;
}

describe("capture classification — fixture table", () => {
  const table: Array<{ input: string; intent: CaptureIntent }> = [
    // Planner (the historical default — untouched grammar)
    { input: "Gym 6:30-7:30pm #fitness !high tomorrow", intent: "planner" },
    { input: "Deep work 9-11am", intent: "planner" },
    { input: "Call the dentist", intent: "planner" },
    { input: "Meal prep sunday #meal", intent: "planner" },
    // Tasks
    { input: "todo call insurance friday !high", intent: "task" },
    { input: "task renew passport 2026-04-01", intent: "task" },
    { input: "remember to water the plants tomorrow", intent: "task" },
    { input: "todo: email accountant #money", intent: "task" },
    // Expenses
    { input: "spent 12.40 at chipotle", intent: "expense" },
    { input: "-12.40 chipotle dining", intent: "expense" },
    { input: "paid 1,250 rent", intent: "expense" },
    { input: "bought $40 groceries yesterday", intent: "expense" },
    { input: "spent 4.50 coffee", intent: "expense" },
    // Income
    { input: "got paid 2500 salary", intent: "income" },
    { input: "received 120 refund from amazon", intent: "income" },
    { input: "earned 300 freelance", intent: "income" },
    // Health
    { input: "weight 178", intent: "health" },
    { input: "resting hr 54", intent: "health" },
    { input: "steps 12000", intent: "health" },
    { input: "slept 7h30", intent: "health" },
    { input: "sleep 6.5", intent: "health" },
    { input: "water 500ml", intent: "health" },
    { input: "bp 120/80", intent: "health" },
    { input: "weight 80kg yesterday", intent: "health" },
    // Nutrition
    { input: "ate 2 eggs and toast", intent: "nutrition" },
    { input: "had oatmeal for breakfast", intent: "nutrition" },
    { input: "ate 100g chicken breast, rice and broccoli", intent: "nutrition" },
    { input: "had a protein shake", intent: "nutrition" },
    // Workouts
    { input: "ran 3.2 miles 28 min", intent: "workout" },
    { input: "bench 3x8 135", intent: "workout" },
    { input: "walked 45 min", intent: "workout" },
    { input: "cycled 20km 1h", intent: "workout" },
    { input: "squat 5x5 100kg", intent: "workout" },
    // Habits
    { input: "did meditation", intent: "habit" },
    { input: "skipped reading", intent: "habit" },
    { input: "did stretching yesterday", intent: "habit" },
    // Inbox — explicit
    { input: "note look into that book from the podcast", intent: "inbox" },
    { input: "inbox: renew the parking permit thing", intent: "inbox" },
  ];

  for (const row of table) {
    it(`"${row.input}" → ${row.intent}`, () => {
      expect(draftOf(row.input).intent).toBe(row.intent);
    });
  }
});

describe("near-misses route to Inbox, never force-fit", () => {
  const nearMisses = [
    "spent a lovely day at the park", // expense verb, no amount
    "paid attention in class", // expense verb, no amount
    "got paid back eventually maybe", // income verb, no amount
    "ate nothing all morning", // nutrition verb — but "nothing" is a phrase…
    "weight going up lately", // health alias, no reading
    "slept badly", // sleep alias, no duration
    "ran errands downtown", // cardio verb, no distance/duration
  ];

  it("expense/income/health verbs without numbers land in Inbox with the raw text", () => {
    for (const input of [
      "spent a lovely day at the park",
      "paid attention in class",
      "got paid back eventually maybe",
      "weight going up lately",
      "slept badly",
    ]) {
      const draft = draftOf(input);
      expect(draft.intent, input).toBe("inbox");
      if (draft.intent === "inbox") expect(draft.title.length).toBeGreaterThan(0);
    }
  });

  it("a cardio verb without workout numbers is not a workout", () => {
    const draft = draftOf("ran errands downtown");
    expect(draft.intent).toBe("inbox");
  });

  it("nothing in the near-miss table ever throws", () => {
    for (const input of nearMisses) expect(() => draftOf(input)).not.toThrow();
  });

  it("empty input is inbox and harmless", () => {
    expect(draftOf("").intent).toBe("inbox");
  });
});

describe("planner remains the regression baseline", () => {
  it("produces byte-identical results to parseQuickAdd for planner text", () => {
    const inputs = [
      "Gym 6:30-7:30pm #fitness !high tomorrow",
      "Deep work 9-11am",
      "Call the dentist #admin",
      "Standup at 9:15 friday",
    ];
    for (const input of inputs) {
      const draft = draftOf(input);
      expect(draft.intent).toBe("planner");
      if (draft.intent === "planner") {
        expect(draft.planner).toEqual(parseQuickAdd(input, MONDAY));
      }
    }
  });
});

describe("task drafts", () => {
  it("parses due date, priority and tags; title keeps the rest", () => {
    const draft = draftOf("todo call insurance friday !high #admin");
    expect(draft).toMatchObject({
      intent: "task",
      title: "call insurance",
      dueDate: "2026-03-06",
      priority: "high",
      tags: ["admin"],
    });
  });

  it("no date word means no due date — not due today", () => {
    const draft = draftOf("todo call insurance");
    expect(draft).toMatchObject({ intent: "task", dueDate: null });
  });

  it('"today" is an explicit due date', () => {
    const draft = draftOf("todo file expenses today");
    expect(draft).toMatchObject({ intent: "task", dueDate: MONDAY });
  });

  it("time-of-day words survive into the title rather than being lost", () => {
    const draft = draftOf("todo call insurance at 3pm friday");
    expect(draft).toMatchObject({ intent: "task", dueDate: "2026-03-06" });
    if (draft.intent === "task") expect(draft.title).toContain("3pm");
  });
});

describe("money drafts", () => {
  it("expense: amount, payee, positive dollars", () => {
    const draft = draftOf("spent 12.40 at chipotle");
    expect(draft).toMatchObject({
      intent: "expense",
      amount: 12.4,
      payee: "chipotle",
      date: MONDAY,
    });
  });

  it("signed shorthand with a category word", () => {
    const draft = draftOf("-12.40 chipotle dining");
    expect(draft).toMatchObject({
      intent: "expense",
      amount: 12.4,
      payee: "chipotle",
      category: "dining",
    });
  });

  it("thousand separators and category aliases", () => {
    const draft = draftOf("paid 1,250 rent");
    expect(draft).toMatchObject({ intent: "expense", amount: 1250, category: "housing" });
  });

  it("yesterday's purchase lands on yesterday", () => {
    const draft = draftOf("bought $40 groceries yesterday");
    expect(draft).toMatchObject({
      intent: "expense",
      amount: 40,
      category: "groceries",
      date: "2026-03-01",
    });
  });

  it("income defaults its category to income and keeps the source", () => {
    const draft = draftOf("got paid 2500 salary");
    expect(draft).toMatchObject({ intent: "income", amount: 2500, category: "income" });
    const refund = draftOf("received 120 refund from amazon");
    expect(refund).toMatchObject({ intent: "income", amount: 120, payee: "amazon" });
  });
});

describe("health drafts", () => {
  it("bare values carry no unit (the user's display unit applies)", () => {
    expect(draftOf("weight 178")).toMatchObject({
      intent: "health",
      metric: "body_weight",
      value: 178,
      unit: null,
    });
  });

  it("explicit units are preserved for the server to convert", () => {
    expect(draftOf("weight 80kg yesterday")).toMatchObject({
      intent: "health",
      metric: "body_weight",
      value: 80,
      unit: "kg",
      date: "2026-03-01",
    });
  });

  it("resting hr beats the shorter hr-ish aliases", () => {
    expect(draftOf("resting hr 54")).toMatchObject({ metric: "resting_hr", value: 54 });
    expect(draftOf("rhr 55")).toMatchObject({ metric: "resting_hr", value: 55 });
  });

  it("sleep parses clock-style and decimal durations", () => {
    expect(draftOf("slept 7h30")).toMatchObject({ metric: "sleep_hours", value: 7.5 });
    expect(draftOf("slept 7:15")).toMatchObject({ metric: "sleep_hours", value: 7.25 });
    expect(draftOf("sleep 6.5")).toMatchObject({ metric: "sleep_hours", value: 6.5 });
    expect(draftOf("slept 450 min")).toMatchObject({ metric: "sleep_hours", value: 7.5 });
  });

  it("blood pressure splits systolic/diastolic", () => {
    expect(draftOf("bp 120/80")).toMatchObject({
      metric: "blood_pressure",
      value: 120,
      secondaryValue: 80,
    });
  });

  it("every alias targets a manually enterable metric", () => {
    for (const entry of HEALTH_CAPTURE_ALIASES) {
      expect(MANUAL_ENTRY_METRICS, entry.alias).toContain(entry.metric);
    }
  });
});

describe("nutrition drafts", () => {
  it("splits items on commas and 'and', with quantities", () => {
    const draft = draftOf("ate 2 eggs and toast");
    expect(draft).toMatchObject({ intent: "nutrition" });
    if (draft.intent === "nutrition") {
      expect(draft.items).toEqual([
        { phrase: "eggs", quantity: 2, unit: null },
        { phrase: "toast", quantity: 1, unit: null },
      ]);
    }
  });

  it("understands gram quantities and multi-item lists", () => {
    const draft = draftOf("ate 100g chicken breast, rice and broccoli");
    if (draft.intent === "nutrition") {
      expect(draft.items).toEqual([
        { phrase: "chicken breast", quantity: 100, unit: "g" },
        { phrase: "rice", quantity: 1, unit: null },
        { phrase: "broccoli", quantity: 1, unit: null },
      ]);
    } else {
      throw new Error("expected nutrition");
    }
  });

  it("meal words set the meal type; otherwise the clock decides", () => {
    const named = draftOf("had oatmeal for breakfast");
    expect(named).toMatchObject({ intent: "nutrition", mealType: "breakfast" });
    const inferred = draftOf("ate a sandwich");
    expect(inferred).toMatchObject({ intent: "nutrition", mealType: "lunch" }); // nowMinute = noon
  });

  it("inferMealType maps the day sensibly and always returns a valid type", () => {
    expect(inferMealType(8 * 60)).toBe("breakfast");
    expect(inferMealType(13 * 60)).toBe("lunch");
    expect(inferMealType(16 * 60)).toBe("snack");
    expect(inferMealType(19 * 60)).toBe("dinner");
    expect(inferMealType(23 * 60)).toBe("snack");
    expect(MEAL_TYPES).toContain(inferMealType(null));
  });

  it("'with' stays inside a phrase — never a splitter", () => {
    const draft = draftOf("ate toast with butter");
    if (draft.intent === "nutrition") {
      expect(draft.items).toEqual([{ phrase: "toast with butter", quantity: 1, unit: null }]);
    } else {
      throw new Error("expected nutrition");
    }
  });
});

describe("workout drafts", () => {
  it("cardio with miles converts to km and keeps minutes", () => {
    const draft = draftOf("ran 3.2 miles 28 min");
    expect(draft).toMatchObject({
      intent: "workout",
      type: "running",
      durationMin: 28,
    });
    if (draft.intent === "workout") {
      expect(draft.distanceKm).toBeCloseTo(5.15, 1);
      expect(draft.name).toBe("Run");
    }
  });

  it("duration-only cardio works", () => {
    expect(draftOf("walked 45 min")).toMatchObject({
      intent: "workout",
      type: "walking",
      durationMin: 45,
      distanceKm: null,
    });
  });

  it("km and hours parse", () => {
    const draft = draftOf("cycled 20km 1h");
    expect(draft).toMatchObject({ intent: "workout", type: "cycling", durationMin: 60 });
    if (draft.intent === "workout") expect(draft.distanceKm).toBe(20);
  });

  it("strength shorthand: sets, reps, bare weight carries no unit", () => {
    const draft = draftOf("bench 3x8 135");
    expect(draft).toMatchObject({ intent: "workout", type: "strength" });
    if (draft.intent === "workout") {
      expect(draft.strength).toEqual({
        exercise: "Bench",
        sets: 3,
        reps: 8,
        weight: 135,
        weightUnit: null,
      });
    }
  });

  it("explicit kg is preserved", () => {
    const draft = draftOf("squat 5x5 100kg");
    if (draft.intent === "workout") {
      expect(draft.strength).toMatchObject({ weight: 100, weightUnit: "kg" });
    } else {
      throw new Error("expected workout");
    }
  });
});

describe("habit drafts and ambiguity", () => {
  it("did/skipped set the status; date words apply", () => {
    expect(draftOf("did meditation")).toMatchObject({
      intent: "habit",
      query: "meditation",
      status: "done",
      date: MONDAY,
    });
    expect(draftOf("skipped reading")).toMatchObject({ status: "skipped" });
    expect(draftOf("did stretching yesterday")).toMatchObject({ date: "2026-03-01" });
  });

  it("'did bench 3x8 135' is ambiguous between habit and workout — asked, not guessed", () => {
    const parse = parseCapture("did bench 3x8 135", OPTS);
    expect(parse.draft.intent).toBe("habit");
    expect(parse.alternates).toContain("workout");
  });

  it("parseCaptureAs re-reads the same text under the chosen intent", () => {
    const asWorkout = parseCaptureAs("workout", "did bench 3x8 135", OPTS);
    expect(asWorkout.intent).toBe("workout");
    if (asWorkout.intent === "workout") {
      expect(asWorkout.strength).toMatchObject({ exercise: "Bench", sets: 3, reps: 8 });
    }
    const asInbox = parseCaptureAs("inbox", "did bench 3x8 135", OPTS);
    expect(asInbox).toMatchObject({ intent: "inbox", title: "did bench 3x8 135" });
  });
});

describe("descriptions", () => {
  it("every draft kind describes itself", () => {
    const inputs = [
      "Deep work 9-11am",
      "todo call insurance",
      "spent 12.40 at chipotle",
      "got paid 2500 salary",
      "weight 178",
      "ate 2 eggs",
      "ran 3.2 miles 28 min",
      "did meditation",
      "note remember the milk",
    ];
    for (const input of inputs) {
      expect(describeCaptureDraft(draftOf(input)).length, input).toBeGreaterThan(3);
    }
  });
});
