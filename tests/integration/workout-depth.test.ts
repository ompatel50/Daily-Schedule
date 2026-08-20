/**
 * Workout depth — set-level superset groups and the progression read model.
 * The pure folding/grouping logic is unit-tested in tests/session.test.ts;
 * these tests pin the database contracts: template groups stamped onto real
 * set rows at session start, the mid-session regroup action's guards, group
 * survival through "repeat workout", and the bounded progression query.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import {
  discardSession,
  setExerciseGroup,
  startSession,
} from "@/server/actions/session";
import { getExerciseProgression, saveWorkoutTemplate } from "@/server/actions/workouts";
import { actAs, resetDatabase, twoUsers, type User } from "./helpers";

let alice: User;
let bob: User;

const DAY = "2026-07-30";

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  ({ alice, bob } = await twoUsers());
  actAs(alice);
});

async function groupedTemplate(): Promise<string> {
  const result = await saveWorkoutTemplate({
    name: "Upper A",
    type: "strength",
    exercises: [
      { exercise: "Bench", sets: 2, reps: 8, weightKg: 60, group: "A" },
      { exercise: "Row", sets: 2, reps: 8, weightKg: 50, group: "A" },
      { exercise: "Curls", sets: 2, reps: 12, weightKg: 15 },
    ],
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("template failed");
  return (result.data as { id: string }).id;
}

describe("superset groups on real sets", () => {
  it("a grouped template stamps its keys onto the session's set rows", async () => {
    const templateId = await groupedTemplate();
    const started = await startSession({ date: DAY, templateId });
    expect(started.ok).toBe(true);

    const sets = await prisma.workoutSet.findMany({
      where: { workout: { userId: alice.id } },
      orderBy: { sortOrder: "asc" },
      select: { exercise: true, supersetGroup: true },
    });
    // Round-robin order with the group riding each grouped set.
    expect(sets.map((set) => [set.exercise, set.supersetGroup])).toEqual([
      ["Bench", "A"],
      ["Row", "A"],
      ["Bench", "A"],
      ["Row", "A"],
      ["Curls", null],
      ["Curls", null],
    ]);
  });

  it("mid-session regrouping writes the sets; clearing sticks", async () => {
    const templateId = await groupedTemplate();
    const started = await startSession({ date: DAY, templateId });
    if (!started.ok) throw new Error("start failed");
    const workoutId = started.data.id;

    const grouped = await setExerciseGroup({ workoutId, exercise: "curls", group: "B" });
    expect(grouped.ok).toBe(true);
    const curls = await prisma.workoutSet.findMany({
      where: { workoutId, exercise: "Curls" },
    });
    expect(curls.every((set) => set.supersetGroup === "B")).toBe(true);

    const cleared = await setExerciseGroup({ workoutId, exercise: "Bench", group: null });
    expect(cleared.ok).toBe(true);
    const bench = await prisma.workoutSet.findMany({ where: { workoutId, exercise: "Bench" } });
    expect(bench.every((set) => set.supersetGroup === null)).toBe(true);
  });

  it("regrouping is refused on a closed session and on another user's session", async () => {
    const templateId = await groupedTemplate();
    const started = await startSession({ date: DAY, templateId });
    if (!started.ok) throw new Error("start failed");

    actAs(bob);
    const stolen = await setExerciseGroup({
      workoutId: started.data.id,
      exercise: "Bench",
      group: "C",
    });
    expect(stolen.ok).toBe(false);

    actAs(alice);
    await discardSession(started.data.id);
    const afterClose = await setExerciseGroup({
      workoutId: started.data.id,
      exercise: "Bench",
      group: "C",
    });
    expect(afterClose.ok).toBe(false);
  });
});

describe("exercise progression", () => {
  it("folds completed sets of completed workouts into per-day points", async () => {
    for (const [date, weight] of [
      ["2026-07-01", 60],
      ["2026-07-08", 62.5],
    ] as const) {
      await prisma.workout.create({
        data: {
          userId: alice.id,
          date,
          name: "Push",
          status: "completed",
          sets: {
            create: [
              { exercise: "Bench", setNumber: 1, reps: 8, weightKg: weight, completed: true },
              { exercise: "Bench", setNumber: 2, reps: 8, weightKg: weight, completed: true },
            ],
          },
        },
      });
    }
    // Noise that must not appear: an incomplete set, a planned workout, and
    // another user's history.
    await prisma.workout.create({
      data: {
        userId: alice.id,
        date: "2026-07-15",
        name: "Planned push",
        status: "planned",
        sets: { create: [{ exercise: "Bench", setNumber: 1, reps: 8, weightKg: 100, completed: false }] },
      },
    });
    await prisma.workout.create({
      data: {
        userId: bob.id,
        date: "2026-07-08",
        name: "Bob push",
        status: "completed",
        sets: { create: [{ exercise: "Bench", setNumber: 1, reps: 8, weightKg: 200, completed: true }] },
      },
    });

    const result = await getExerciseProgression("bench");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.points).toHaveLength(2);
    expect(result.data.points[0]).toMatchObject({ date: "2026-07-01", topWeightKg: 60, sets: 2 });
    expect(result.data.points[1].topWeightKg).toBe(62.5);
  });
});
