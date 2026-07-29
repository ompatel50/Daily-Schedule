import { describe, expect, it } from "vitest";

import {
  MAX_SESSION_MINUTES,
  WORKOUT_STATUSES,
  WORKOUT_STATUS_META,
  canTransition,
  defaultRestSec,
  describeSetActual,
  describeSetTarget,
  elapsedMinutes,
  formatRest,
  groupByExercise,
  isLive,
  isSessionComplete,
  isWorkoutStatus,
  orderSets,
  planSetsFromTemplate,
  planSetsFromWorkout,
  restState,
  sessionDurationMinutes,
  sessionProgress,
  setOutcome,
  transitionsFrom,
  type SessionSet,
} from "@/lib/logic/session";
import { totalVolume } from "@/lib/logic/workouts";
import { addSessionSetSchema, completeSetSchema, startSessionSchema } from "@/lib/validation";

/**
 * The session is a small state machine plus some clock arithmetic, and both are
 * exactly the kind of thing that breaks quietly: a status transition nobody
 * meant to allow, a duration that reads 14 hours because a session was left open
 * overnight, a rest timer that resets on reload. All of it is pure, so all of it
 * is tested here without a database or a real clock.
 */

function set(overrides: Partial<SessionSet> & { id: string }): SessionSet {
  return {
    exercise: "Squat",
    setNumber: 1,
    reps: null,
    weightKg: null,
    durationSec: null,
    distanceM: null,
    targetReps: 8,
    targetWeightKg: 60,
    restSec: 90,
    rpe: null,
    completed: false,
    completedAt: null,
    sortOrder: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Statuses and transitions
// ---------------------------------------------------------------------------

describe("workout statuses", () => {
  it("recognises exactly the five it defines", () => {
    expect(WORKOUT_STATUSES).toEqual([
      "planned",
      "in_progress",
      "completed",
      "abandoned",
      "skipped",
    ]);
    expect(isWorkoutStatus("in_progress")).toBe(true);
    expect(isWorkoutStatus("finished")).toBe(false);
  });

  it("describes every status", () => {
    for (const status of WORKOUT_STATUSES) {
      expect(WORKOUT_STATUS_META[status].label.length).toBeGreaterThan(0);
      expect(WORKOUT_STATUS_META[status].description.length).toBeGreaterThan(0);
    }
  });

  it("does not count an open session as training", () => {
    // A warm-up you abandoned is not a workout, so a live session must not feed
    // the day score before it ends.
    expect(WORKOUT_STATUS_META.in_progress.countsAsTrained).toBe(false);
    expect(WORKOUT_STATUS_META.planned.countsAsTrained).toBe(false);
    expect(WORKOUT_STATUS_META.skipped.countsAsTrained).toBe(false);
  });

  it("counts a session stopped early as training, because it happened", () => {
    expect(WORKOUT_STATUS_META.abandoned.countsAsTrained).toBe(true);
    expect(WORKOUT_STATUS_META.completed.countsAsTrained).toBe(true);
  });

  it("identifies the live status", () => {
    expect(isLive("in_progress")).toBe(true);
    expect(isLive("completed")).toBe(false);
    expect(isLive("planned")).toBe(false);
  });
});

describe("status transitions", () => {
  it("lets a session be finished or abandoned", () => {
    expect(canTransition("in_progress", "completed")).toBe(true);
    expect(canTransition("in_progress", "abandoned")).toBe(true);
  });

  it("only reaches abandoned from a session that was actually open", () => {
    expect(canTransition("in_progress", "abandoned")).toBe(true);
    expect(canTransition("planned", "abandoned")).toBe(false);
    expect(canTransition("completed", "abandoned")).toBe(false);
    expect(canTransition("skipped", "abandoned")).toBe(false);
  });

  it("allows reopening a finished or abandoned workout", () => {
    expect(canTransition("completed", "in_progress")).toBe(true);
    expect(canTransition("abandoned", "in_progress")).toBe(true);
  });

  it("treats a no-op transition as allowed", () => {
    for (const status of WORKOUT_STATUSES) {
      expect(canTransition(status, status)).toBe(true);
    }
  });

  it("rejects statuses it does not know", () => {
    expect(canTransition("in_progress", "deleted")).toBe(false);
    expect(canTransition("nonsense", "completed")).toBe(false);
  });

  it("never lets a completed workout go back to planned", () => {
    // Real sets have been recorded by then; "planned" would be a lie.
    expect(canTransition("completed", "planned")).toBe(false);
    expect(transitionsFrom("completed")).not.toContain("planned");
  });

  it("exposes the transitions for a status", () => {
    expect(transitionsFrom("in_progress")).toContain("completed");
    expect(transitionsFrom("planned")).toContain("in_progress");
  });
});

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

describe("session progress", () => {
  const sets = [
    set({ id: "a", sortOrder: 0, completed: true, completedAt: "2026-07-28T10:00:00.000Z" }),
    set({ id: "b", sortOrder: 1, completed: true, completedAt: "2026-07-28T10:03:00.000Z" }),
    set({ id: "c", sortOrder: 2 }),
    set({ id: "d", sortOrder: 3 }),
  ];

  it("counts done, remaining and percent", () => {
    const progress = sessionProgress(sets);
    expect(progress).toMatchObject({ total: 4, done: 2, remaining: 2, percent: 50 });
  });

  it("points at the next outstanding set", () => {
    const progress = sessionProgress(sets);
    expect(progress.nextIndex).toBe(2);
    expect(progress.next?.id).toBe("c");
  });

  it("reports no next set once everything is ticked", () => {
    const done = sets.map((item) => ({ ...item, completed: true }));
    const progress = sessionProgress(done);
    expect(progress.nextIndex).toBeNull();
    expect(progress.next).toBeNull();
    expect(progress.percent).toBe(100);
  });

  it("returns 0 percent for an empty session rather than NaN", () => {
    const progress = sessionProgress([]);
    expect(progress.percent).toBe(0);
    expect(progress.total).toBe(0);
    expect(Number.isNaN(progress.percent)).toBe(false);
  });

  it("takes the last tick by clock, not by position", () => {
    // Sets can be done out of order; the rest timer follows the last real tick.
    const outOfOrder = [
      set({ id: "a", sortOrder: 0, completed: true, completedAt: "2026-07-28T10:10:00.000Z" }),
      set({ id: "b", sortOrder: 1, completed: true, completedAt: "2026-07-28T10:02:00.000Z" }),
    ];
    expect(sessionProgress(outOfOrder).lastCompleted?.id).toBe("a");
  });

  it("has no last-completed set before anything is ticked", () => {
    expect(sessionProgress([set({ id: "a" })]).lastCompleted).toBeNull();
  });

  it("knows when a session is finishable", () => {
    expect(isSessionComplete(sets)).toBe(false);
    expect(isSessionComplete(sets.map((item) => ({ ...item, completed: true })))).toBe(true);
    // An empty session is not "complete" — there was nothing to do.
    expect(isSessionComplete([])).toBe(false);
  });

  it("orders sets by sortOrder then set number", () => {
    const shuffled = [
      set({ id: "b", sortOrder: 1, setNumber: 1 }),
      set({ id: "c", sortOrder: 1, setNumber: 2 }),
      set({ id: "a", sortOrder: 0, setNumber: 1 }),
    ];
    expect(orderSets(shuffled).map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("groups by exercise in first-appearance order", () => {
    const mixed = [
      set({ id: "s1", exercise: "Squat", sortOrder: 0, completed: true }),
      set({ id: "b1", exercise: "Bench", sortOrder: 1 }),
      set({ id: "s2", exercise: "Squat", sortOrder: 2 }),
    ];
    const groups = groupByExercise(mixed);
    expect(groups.map((group) => group.exercise)).toEqual(["Squat", "Bench"]);
    expect(groups[0].sets).toHaveLength(2);
    expect(groups[0].done).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

describe("elapsed time", () => {
  const start = "2026-07-28T10:00:00.000Z";

  it("measures to the end stamp when one exists", () => {
    expect(elapsedMinutes(start, "2026-07-28T10:47:00.000Z")).toBe(47);
  });

  it("measures to now while the session is open", () => {
    const now = new Date("2026-07-28T10:12:00.000Z");
    expect(elapsedMinutes(start, null, now)).toBe(12);
  });

  it("returns 0 with no start stamp", () => {
    expect(elapsedMinutes(null, null)).toBe(0);
    expect(elapsedMinutes(undefined, undefined)).toBe(0);
  });

  it("never goes negative when the clock moved backwards", () => {
    expect(elapsedMinutes("2026-07-28T10:00:00.000Z", "2026-07-28T09:00:00.000Z")).toBe(0);
  });

  it("clamps a session left open overnight", () => {
    // Without the clamp this would report ~14 hours of training into the score.
    expect(elapsedMinutes(start, "2026-07-29T02:00:00.000Z")).toBe(MAX_SESSION_MINUTES);
  });

  it("ignores an unparseable stamp instead of producing NaN", () => {
    expect(elapsedMinutes("not a date", null)).toBe(0);
    expect(Number.isNaN(elapsedMinutes(start, "also not a date"))).toBe(false);
  });

  it("accepts Date objects as well as ISO strings", () => {
    expect(elapsedMinutes(new Date(start), new Date("2026-07-28T10:30:00.000Z"))).toBe(30);
  });
});

describe("recorded duration", () => {
  const start = "2026-07-28T10:00:00.000Z";
  const done = [set({ id: "a", completed: true })];

  it("uses real elapsed time", () => {
    expect(sessionDurationMinutes(start, "2026-07-28T10:42:00.000Z", done)).toBe(42);
  });

  it("floors a session that did something at one minute", () => {
    // Rounding to 0 would make a real workout read as "no workout" everywhere.
    expect(sessionDurationMinutes(start, "2026-07-28T10:00:20.000Z", done)).toBe(1);
  });

  it("does not invent a minute for a session where nothing was done", () => {
    const nothing = [set({ id: "a", completed: false })];
    expect(sessionDurationMinutes(start, "2026-07-28T10:00:20.000Z", nothing)).toBe(0);
  });
});

describe("the rest timer", () => {
  const tick = "2026-07-28T10:00:00.000Z";

  it("counts down from the last tick", () => {
    const state = restState(tick, 90, new Date("2026-07-28T10:00:30.000Z"));
    expect(state).toEqual({ remaining: 60, total: 90, resting: true });
  });

  it("reaches zero and stops", () => {
    const state = restState(tick, 90, new Date("2026-07-28T10:02:00.000Z"));
    expect(state.remaining).toBe(0);
    expect(state.resting).toBe(false);
  });

  it("never goes negative", () => {
    expect(restState(tick, 90, new Date("2026-07-28T11:00:00.000Z")).remaining).toBe(0);
  });

  it("is not resting with no rest configured", () => {
    expect(restState(tick, null).resting).toBe(false);
    expect(restState(tick, 0).resting).toBe(false);
  });

  it("is not resting before the first tick", () => {
    expect(restState(null, 90).resting).toBe(false);
  });

  it("survives a reload, because it is derived rather than stored", () => {
    // The same inputs give the same answer regardless of when it is asked —
    // there is no ticking state to lose.
    const later = new Date("2026-07-28T10:00:45.000Z");
    expect(restState(tick, 90, later)).toEqual(restState(tick, 90, later));
    expect(restState(tick, 90, later).remaining).toBe(45);
  });

  it("formats as mm:ss", () => {
    expect(formatRest(90)).toBe("1:30");
    expect(formatRest(5)).toBe("0:05");
    expect(formatRest(0)).toBe("0:00");
    expect(formatRest(-10)).toBe("0:00");
    expect(formatRest(600)).toBe("10:00");
  });
});

// ---------------------------------------------------------------------------
// Planned vs actual
// ---------------------------------------------------------------------------

describe("planned versus actual", () => {
  it("reports a pending set as pending", () => {
    expect(setOutcome(set({ id: "a" }))).toBe("pending");
  });

  it("recognises hitting the target exactly", () => {
    expect(
      setOutcome(set({ id: "a", completed: true, reps: 8, weightKg: 60 })),
    ).toBe("on_target");
  });

  it("recognises beating and missing it", () => {
    expect(setOutcome(set({ id: "a", completed: true, reps: 8, weightKg: 62.5 }))).toBe("over");
    expect(setOutcome(set({ id: "a", completed: true, reps: 8, weightKg: 57.5 }))).toBe("under");
    expect(setOutcome(set({ id: "a", completed: true, reps: 10, weightKg: 60 }))).toBe("over");
    expect(setOutcome(set({ id: "a", completed: true, reps: 6, weightKg: 60 }))).toBe("under");
  });

  it("just says done when there was no plan to compare against", () => {
    expect(
      setOutcome(
        set({ id: "a", completed: true, reps: 8, weightKg: 60, targetReps: null, targetWeightKg: null }),
      ),
    ).toBe("done");
  });

  it("keeps the plan legible next to the outcome", () => {
    const performed = set({ id: "a", completed: true, reps: 8, weightKg: 62.5 });
    expect(describeSetTarget(performed)).toBe("8 × 60 kg");
    expect(describeSetActual(performed)).toBe("8 × 62.5 kg");
  });

  it("describes partial plans without inventing the missing half", () => {
    expect(describeSetTarget(set({ id: "a", targetWeightKg: null }))).toBe("8 reps");
    expect(describeSetTarget(set({ id: "a", targetReps: null }))).toBe("60 kg");
    expect(describeSetTarget(set({ id: "a", targetReps: null, targetWeightKg: null }))).toBe("—");
    expect(describeSetActual(set({ id: "a" }))).toBe("—");
  });
});

// ---------------------------------------------------------------------------
// Seeding a session
// ---------------------------------------------------------------------------

describe("planning sets from a template", () => {
  it("expands each exercise into its sets as targets, none complete", () => {
    const planned = planSetsFromTemplate([
      { exercise: "Squat", sets: 3, reps: 8, weightKg: 60, restSec: 120 },
      { exercise: "Bench", sets: 2, reps: 10, weightKg: 40 },
    ]);

    expect(planned).toHaveLength(5);
    expect(planned[0]).toEqual({
      exercise: "Squat",
      setNumber: 1,
      targetReps: 8,
      targetWeightKg: 60,
      restSec: 120,
      sortOrder: 0,
    });
    // The numbers are the plan, not the outcome — nothing here says "done".
    expect(planned.every((row) => !("completed" in row))).toBe(true);
  });

  it("numbers sets within an exercise and orders across the session", () => {
    const planned = planSetsFromTemplate([
      { exercise: "Squat", sets: 2 },
      { exercise: "Bench", sets: 2 },
    ]);
    expect(planned.map((row) => `${row.exercise}#${row.setNumber}`)).toEqual([
      "Squat#1",
      "Squat#2",
      "Bench#1",
      "Bench#2",
    ]);
    expect(planned.map((row) => row.sortOrder)).toEqual([0, 1, 2, 3]);
  });

  it("skips nameless exercises and clamps absurd set counts", () => {
    expect(planSetsFromTemplate([{ exercise: "   ", sets: 3 }])).toHaveLength(0);
    expect(planSetsFromTemplate([{ exercise: "Squat", sets: 500 }])).toHaveLength(20);
    expect(planSetsFromTemplate([{ exercise: "Squat", sets: 0 }])).toHaveLength(1);
  });

  it("leaves a missing target null rather than guessing zero", () => {
    const planned = planSetsFromTemplate([{ exercise: "Plank", sets: 1 }]);
    expect(planned[0].targetReps).toBeNull();
    expect(planned[0].targetWeightKg).toBeNull();
    expect(planned[0].restSec).toBeNull();
  });

  it("rejects negative numbers from a malformed template", () => {
    const planned = planSetsFromTemplate([
      { exercise: "Squat", sets: 1, reps: -5, weightKg: -10 },
    ]);
    expect(planned[0].targetReps).toBeNull();
    expect(planned[0].targetWeightKg).toBeNull();
  });
});

describe("planning sets from a past workout", () => {
  it("turns last time's results into this time's targets", () => {
    const planned = planSetsFromWorkout([
      { exercise: "Squat", setNumber: 1, reps: 8, weightKg: 60, restSec: 90, sortOrder: 0 },
      { exercise: "Squat", setNumber: 2, reps: 7, weightKg: 60, restSec: 90, sortOrder: 1 },
    ]);
    expect(planned[0].targetReps).toBe(8);
    expect(planned[0].targetWeightKg).toBe(60);
    expect(planned[1].targetReps).toBe(7);
  });

  it("re-sorts and re-indexes so the order is contiguous", () => {
    const planned = planSetsFromWorkout([
      { exercise: "B", setNumber: 1, reps: 5, weightKg: 20, restSec: null, sortOrder: 9 },
      { exercise: "A", setNumber: 1, reps: 5, weightKg: 20, restSec: null, sortOrder: 2 },
    ]);
    expect(planned.map((row) => row.exercise)).toEqual(["A", "B"]);
    expect(planned.map((row) => row.sortOrder)).toEqual([0, 1]);
  });
});

describe("the session's default rest", () => {
  it("takes the first declared rest", () => {
    expect(defaultRestSec([{ restSec: null }, { restSec: 120 }, { restSec: 90 }])).toBe(120);
  });

  it("is null when no set declares one — no timer, not a guessed 90 seconds", () => {
    expect(defaultRestSec([{ restSec: null }, { restSec: 0 }])).toBeNull();
    expect(defaultRestSec([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// How a session's volume is counted
// ---------------------------------------------------------------------------

describe("volume during a session", () => {
  it("counts only what was actually done", () => {
    const sets = [
      { exercise: "Squat", reps: 8, weightKg: 60, completed: true },
      { exercise: "Squat", reps: 8, weightKg: 60, completed: false },
    ];
    // The outstanding set contributes nothing — a half-finished session must not
    // report the volume of a whole one.
    expect(totalVolume(sets)).toBe(480);
  });

  it("counts nothing for a session with no ticks yet", () => {
    expect(totalVolume([{ exercise: "Squat", reps: 8, weightKg: 60, completed: false }])).toBe(0);
  });

  it("does not over-report a finished session that left sets outstanding", () => {
    // The regression this pins: the history list used to force `completed: true`
    // on every row before totalling. That was harmless while every logged set
    // was complete by construction, and became a 3× overstatement the moment a
    // session could be finished with work left undone.
    const finishedEarly = [
      { exercise: "Squat", reps: 5, weightKg: 100, completed: true },
      { exercise: "Squat", reps: 5, weightKg: 100, completed: false },
      { exercise: "Squat", reps: 5, weightKg: 100, completed: false },
    ];
    expect(totalVolume(finishedEarly)).toBe(500);
    expect(totalVolume(finishedEarly.map((set) => ({ ...set, completed: true })))).toBe(1500);
  });

  it("treats a set with no explicit flag as done, so pre-session history is unchanged", () => {
    // Every row written before Phase 10 relied on `completed` defaulting true.
    expect(totalVolume([{ exercise: "Squat", reps: 5, weightKg: 100 }])).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("session validation", () => {
  it("accepts starting from a template, a past workout, or nothing", () => {
    expect(startSessionSchema.safeParse({ date: "2026-07-28", templateId: "t1" }).success).toBe(true);
    expect(startSessionSchema.safeParse({ date: "2026-07-28", fromWorkoutId: "w1" }).success).toBe(true);
    expect(startSessionSchema.safeParse({ date: "2026-07-28" }).success).toBe(true);
  });

  it("requires a real day key", () => {
    expect(startSessionSchema.safeParse({ date: "28/07/2026" }).success).toBe(false);
  });

  it("lets a set be ticked with nothing but its id", () => {
    // The common case: tap the box, accept the target.
    expect(completeSetSchema.safeParse({ id: "s1" }).success).toBe(true);
  });

  it("accepts corrected values and rejects impossible ones", () => {
    expect(completeSetSchema.safeParse({ id: "s1", reps: 8, weightKg: 62.5 }).success).toBe(true);
    expect(completeSetSchema.safeParse({ id: "s1", reps: -1 }).success).toBe(false);
    expect(completeSetSchema.safeParse({ id: "s1", weightKg: -5 }).success).toBe(false);
    expect(completeSetSchema.safeParse({ id: "s1", rpe: 11 }).success).toBe(false);
  });

  it("requires an exercise name when adding a set mid-session", () => {
    expect(addSessionSetSchema.safeParse({ workoutId: "w1", exercise: "Row" }).success).toBe(true);
    expect(addSessionSetSchema.safeParse({ workoutId: "w1", exercise: "  " }).success).toBe(false);
  });
});
