import { describe, expect, it } from "vitest";

import {
  checklistProgress,
  dismissChecklist,
  ONBOARDING_STEPS,
  parseOnboardingState,
  restoreChecklist,
  serializeOnboardingState,
  toggleStep,
} from "@/lib/logic/onboarding";
import { DEMO_MODEL_ORDER } from "../prisma/demo-data";

describe("onboarding steps", () => {
  it("declares unique ids and real destinations", () => {
    const ids = ONBOARDING_STEPS.map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const step of ONBOARDING_STEPS) {
      expect(step.href.startsWith("/"), step.id).toBe(true);
      expect(step.label.length).toBeGreaterThan(0);
      expect(step.detail.length).toBeGreaterThan(0);
    }
  });
});

describe("onboarding state", () => {
  it("parses defensively: empty, garbage and unknown ids all degrade to defaults", () => {
    expect(parseOnboardingState("")).toEqual({ dismissed: false, done: [] });
    expect(parseOnboardingState("{}")).toEqual({ dismissed: false, done: [] });
    expect(parseOnboardingState("not json")).toEqual({ dismissed: false, done: [] });
    expect(parseOnboardingState(null)).toEqual({ dismissed: false, done: [] });
    expect(parseOnboardingState('{"done": ["plan_day", "made_up", 7]}').done).toEqual(["plan_day"]);
    expect(parseOnboardingState('{"dismissed": "yes"}').dismissed).toBe(false);
  });

  it("round-trips through serialize", () => {
    const state = toggleStep(parseOnboardingState("{}"), "add_habit", true);
    expect(parseOnboardingState(serializeOnboardingState(state))).toEqual(state);
  });

  it("toggles steps on and off, ignoring unknown ids, without duplicates", () => {
    let state = parseOnboardingState("{}");
    state = toggleStep(state, "plan_day", true);
    state = toggleStep(state, "plan_day", true);
    expect(state.done).toEqual(["plan_day"]);
    state = toggleStep(state, "nope", true);
    expect(state.done).toEqual(["plan_day"]);
    state = toggleStep(state, "plan_day", false);
    expect(state.done).toEqual([]);
  });

  it("dismiss and restore only touch visibility", () => {
    let state = toggleStep(parseOnboardingState("{}"), "backup", true);
    state = dismissChecklist(state);
    expect(state).toMatchObject({ dismissed: true, done: ["backup"] });
    state = restoreChecklist(state);
    expect(state.dismissed).toBe(false);
    expect(state.done).toEqual(["backup"]);
  });

  it("reports progress against the declared steps", () => {
    const state = toggleStep(parseOnboardingState("{}"), "plan_day", true);
    expect(checklistProgress(state)).toEqual({ done: 1, total: ONBOARDING_STEPS.length });
  });
});

describe("demo removal order", () => {
  it("lists every model exactly once", () => {
    expect(new Set(DEMO_MODEL_ORDER).size).toBe(DEMO_MODEL_ORDER.length);
  });

  it("deletes children before their parents", () => {
    // Pairs where the left row holds a required foreign key to the right one.
    const childBeforeParent: Array<[string, string]> = [
      ["MealEntry", "Meal"],
      ["MealTemplateItem", "MealTemplate"],
      ["WorkoutSet", "Workout"],
      ["HabitLog", "Habit"],
      ["GoalEntry", "Goal"],
    ];
    const position = new Map(DEMO_MODEL_ORDER.map((model, index) => [model as string, index]));
    for (const [child, parent] of childBeforeParent) {
      expect(position.get(child), `${child} before ${parent}`).toBeLessThan(position.get(parent)!);
    }
  });
});
