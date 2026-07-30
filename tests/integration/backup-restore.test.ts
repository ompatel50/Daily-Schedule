/**
 * Local-backup → hosted-account migration, against real PostgreSQL.
 *
 * The fixtures are synthetic (never a real user's backup). They carry the
 * *old local app's* id space on purpose: the point of the suite is that
 * those ids are remapped into the authenticated account with every internal
 * relationship intact, and that a file can never write into — or even
 * reference — another account's rows.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { remapId } from "@/server/backup-restore";
import { importBackup, previewBackup, exportBackup } from "@/server/actions/backup";
import { actAs, resetDatabase, twoUsers } from "./helpers";

import type { User } from "@prisma/client";

let alice: User;
let bob: User;

function daysAgo(n: number): string {
  const date = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}
const D1 = daysAgo(3);
const D2 = daysAgo(2);
const NOW = new Date().toISOString();

/** A small but fully-linked synthetic backup in the local app's id space. */
function syntheticBackup(): Record<string, unknown> {
  return {
    app: "personal-os",
    version: 3,
    exportedAt: NOW,
    data: {
      users: [
        {
          id: "old-local-user",
          name: "Local Me",
          email: "local@local",
          timezone: "America/Chicago",
          weekStartsOn: 0,
          unitSystem: "metric",
        },
      ],
      tags: [{ id: "tag1", userId: "old-local-user", name: "deep", color: "blue", createdAt: NOW }],
      foodItems: [
        {
          id: "food-custom",
          userId: "old-local-user",
          name: "My shake",
          calories: 200,
          isCustom: true,
          provider: "custom",
          searchKey: "my shake",
          basis: "per_serving",
          servingSize: 1,
          servingUnit: "serving",
        },
        {
          id: "food-global",
          userId: null,
          name: "Bundled oats",
          calories: 389,
          provider: "local",
          searchKey: "bundled oats",
        },
      ],
      scheduleTemplates: [{ id: "st1", userId: "old-local-user", name: "Morning", items: "[]" }],
      habits: [{ id: "habit1", userId: "old-local-user", name: "Read", startDate: D1 }],
      workoutTemplates: [{ id: "wt1", userId: "old-local-user", name: "Push", exercises: "[]" }],
      workouts: [
        {
          id: "w1",
          userId: "old-local-user",
          date: D1,
          name: "Push day",
          templateId: "wt1",
          status: "completed",
          durationMin: 45,
        },
      ],
      workoutSets: [
        {
          id: "ws1",
          workoutId: "w1",
          exercise: "Bench",
          setNumber: 1,
          reps: 5,
          weightKg: 60,
          completed: true,
        },
      ],
      meals: [{ id: "meal1", userId: "old-local-user", date: D1, type: "breakfast" }],
      mealEntries: [
        {
          id: "me1",
          mealId: "meal1",
          foodItemId: "food-custom",
          quantity: 1,
          unit: "serving",
          calories: 200,
          protein: 20,
          carbs: 10,
          fat: 5,
        },
      ],
      mealTemplates: [],
      mealTemplateItems: [],
      scheduleItems: [
        {
          id: "si-parent",
          userId: "old-local-user",
          title: "Weekly review",
          date: D1,
          allDay: true,
          recurrenceRule: '{"freq":"weekly","interval":1}',
        },
        {
          id: "si-child",
          userId: "old-local-user",
          title: "Weekly review",
          date: D2,
          allDay: true,
          seriesId: "si-parent",
        },
        {
          id: "si-meal",
          userId: "old-local-user",
          title: "Breakfast",
          date: D1,
          allDay: true,
          mealId: "meal1",
        },
      ],
      scheduleItemTags: [{ scheduleItemId: "si-parent", tagId: "tag1" }],
      habitLogs: [
        { id: "hlog1", habitId: "habit1", userId: "old-local-user", date: D1, status: "done" },
      ],
      healthImportBatches: [
        { id: "batch1", userId: "old-local-user", source: "csv", fileType: "csv", fileName: "x.csv" },
      ],
      healthMetrics: [
        {
          id: "hm1",
          userId: "old-local-user",
          date: D1,
          type: "steps",
          value: 10000,
          unit: "count",
          batchId: "batch1",
          fingerprint: `csv|steps|${D1}`,
        },
      ],
      goals: [
        {
          id: "goal1",
          userId: "old-local-user",
          domain: "habit",
          metric: "habit",
          label: "Read daily",
          target: 1,
          source: "habit",
          sourceRef: "habit1",
        },
      ],
      goalEntries: [
        { id: "ge1", goalId: "goal1", userId: "old-local-user", date: D1, status: "done" },
      ],
      scheduleRules: [
        {
          id: "rule1",
          userId: "old-local-user",
          ownerType: "habit",
          ownerId: "habit1",
          effectiveFrom: D1,
          mode: "weekdays",
        },
      ],
      scheduleRuleDays: [
        { ruleId: "rule1", weekday: 1 },
        { ruleId: "rule1", weekday: 3 },
      ],
      scheduleOverrides: [
        {
          id: "ov1",
          userId: "old-local-user",
          ownerType: "habit",
          ownerId: "habit1",
          date: D2,
          kind: "rest",
        },
      ],
      journalEntries: [{ id: "j1", userId: "old-local-user", date: D1, content: "private text" }],
      reminders: [
        {
          id: "rem1",
          userId: "old-local-user",
          title: "Stretch",
          remindAt: NOW,
          scheduleItemId: "si-parent",
        },
      ],
      reminderDeliveries: [
        { id: "rd1", userId: "old-local-user", key: `habit:habit1:${D1}`, deliveredAt: NOW },
      ],
      favorites: [
        { id: "fav1", userId: "old-local-user", kind: "food", refId: "food-custom", label: "My shake" },
      ],
      seedBatches: [],
      seedRecords: [],
    },
  };
}

beforeEach(async () => {
  await resetDatabase();
  ({ alice, bob } = await twoUsers());
  actAs(alice);
});

describe("importing a local backup into an empty hosted account", () => {
  it("remaps every id, preserves every relationship, and applies the profile", async () => {
    const result = await importBackup(syntheticBackup(), "merge");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const id = (oldId: string) => remapId(alice.id, oldId);

    // Owner-scoped records landed in alice's account under new ids.
    const habit = await prisma.habit.findUniqueOrThrow({ where: { id: id("habit1") } });
    expect(habit.userId).toBe(alice.id);
    expect(habit.name).toBe("Read");

    // Relationships travelled: log → habit, goal.sourceRef → habit,
    // rule → habit (+ its weekday rows), override → habit.
    const log = await prisma.habitLog.findUniqueOrThrow({ where: { id: id("hlog1") } });
    expect(log.habitId).toBe(id("habit1"));

    const goal = await prisma.goal.findUniqueOrThrow({ where: { id: id("goal1") } });
    expect(goal.sourceRef).toBe(id("habit1"));

    const rule = await prisma.scheduleRule.findUniqueOrThrow({
      where: { id: id("rule1") },
      include: { days: true },
    });
    expect(rule.ownerId).toBe(id("habit1"));
    expect(rule.days.map((d) => d.weekday).sort()).toEqual([1, 3]);

    const override = await prisma.scheduleOverride.findUniqueOrThrow({ where: { id: id("ov1") } });
    expect(override.ownerId).toBe(id("habit1"));

    // Workout keeps its template link and its sets.
    const workout = await prisma.workout.findUniqueOrThrow({
      where: { id: id("w1") },
      include: { sets: true },
    });
    expect(workout.templateId).toBe(id("wt1"));
    expect(workout.sets).toHaveLength(1);

    // Meal → entry → custom food chain intact.
    const entry = await prisma.mealEntry.findUniqueOrThrow({ where: { id: id("me1") } });
    expect(entry.mealId).toBe(id("meal1"));
    expect(entry.foodItemId).toBe(id("food-custom"));
    const food = await prisma.foodItem.findUniqueOrThrow({ where: { id: id("food-custom") } });
    expect(food.userId).toBe(alice.id);

    // Series parent/child structure preserved; the meal link too.
    const child = await prisma.scheduleItem.findUniqueOrThrow({ where: { id: id("si-child") } });
    expect(child.seriesId).toBe(id("si-parent"));
    const mealItem = await prisma.scheduleItem.findUniqueOrThrow({ where: { id: id("si-meal") } });
    expect(mealItem.mealId).toBe(id("meal1"));

    // Tag attachment, favourite reference, health batch link.
    const tagLinks = await prisma.scheduleItemTag.findMany({
      where: { scheduleItemId: id("si-parent") },
    });
    expect(tagLinks.map((t) => t.tagId)).toEqual([id("tag1")]);
    const favorite = await prisma.favoriteItem.findFirstOrThrow({ where: { userId: alice.id } });
    expect(favorite.refId).toBe(id("food-custom"));
    const metric = await prisma.healthMetric.findUniqueOrThrow({ where: { id: id("hm1") } });
    expect(metric.batchId).toBe(id("batch1"));

    // The delivery ledger's embedded id was rewritten with the same map.
    const delivery = await prisma.reminderDelivery.findFirstOrThrow({
      where: { userId: alice.id },
    });
    expect(delivery.key).toBe(`habit:${id("habit1")}:${D1}`);

    // Reminder re-attached to the remapped schedule item.
    const reminder = await prisma.reminder.findUniqueOrThrow({ where: { id: id("rem1") } });
    expect(reminder.scheduleItemId).toBe(id("si-parent"));

    // Profile: safe fields applied, identity fields untouched.
    const refreshed = await prisma.user.findUniqueOrThrow({ where: { id: alice.id } });
    expect(refreshed.timezone).toBe("America/Chicago");
    expect(refreshed.name).toBe("Local Me");
    expect(refreshed.email).toBe("alice@test.local");

    // Derived summaries were rebuilt.
    expect(await prisma.calendarDaySummary.count({ where: { userId: alice.id } })).toBeGreaterThan(0);

    // The report is honest about what happened.
    expect(result.data.totalCreated).toBeGreaterThan(15);
    expect(result.data.profileApplied).toBe(true);
    expect(result.data.verification.habits).toBe(1);
  });

  it("re-importing the same file creates nothing new", async () => {
    const first = await importBackup(syntheticBackup(), "merge");
    expect(first.ok).toBe(true);
    const countAfterFirst = await prisma.scheduleItem.count({ where: { userId: alice.id } });

    const second = await importBackup(syntheticBackup(), "merge");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.totalCreated).toBe(0);
    expect(await prisma.scheduleItem.count({ where: { userId: alice.id } })).toBe(countAfterFirst);
  });
});

describe("replacement into an existing account", () => {
  it("replace clears the account's previous records first", async () => {
    await prisma.habit.create({ data: { userId: alice.id, name: "Pre-existing", startDate: D1 } });

    const result = await importBackup(syntheticBackup(), "replace");
    expect(result.ok).toBe(true);

    const names = (await prisma.habit.findMany({ where: { userId: alice.id } })).map((h) => h.name);
    expect(names).toEqual(["Read"]);
  });

  it("merge keeps the account's previous records", async () => {
    await prisma.habit.create({ data: { userId: alice.id, name: "Pre-existing", startDate: D1 } });

    const result = await importBackup(syntheticBackup(), "merge");
    expect(result.ok).toBe(true);

    const names = (await prisma.habit.findMany({ where: { userId: alice.id } }))
      .map((h) => h.name)
      .sort();
    expect(names).toEqual(["Pre-existing", "Read"]);
  });
});

describe("preview", () => {
  it("writes nothing", async () => {
    const preview = await previewBackup(syntheticBackup());
    expect(preview.ok).toBe(true);

    expect(await prisma.habit.count()).toBe(0);
    expect(await prisma.scheduleItem.count()).toBe(0);
    expect(await prisma.mealEntry.count()).toBe(0);
  });

  it("warns about a checksum mismatch and an older version", async () => {
    const file = syntheticBackup();
    (file as { meta?: unknown }).meta = { checksum: "deadbeef" };
    const preview = await previewBackup(file);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.data.warnings.join(" ")).toContain("checksum");
  });

  it("refuses a future format version before anything is written", async () => {
    const file = syntheticBackup();
    (file as { version: number }).version = 99;
    const result = await importBackup(file, "merge");
    expect(result.ok).toBe(false);
    expect(await prisma.habit.count()).toBe(0);
  });
});

describe("cross-user safety", () => {
  it("a file carrying another user's real ids cannot touch their rows", async () => {
    const bobHabit = await prisma.habit.create({
      data: { userId: bob.id, name: "Bob's habit", startDate: D1 },
    });

    const file = syntheticBackup();
    const data = (file as { data: Record<string, unknown[]> }).data;
    // The attack: alice's file claims bob's habit id, hoping the import
    // upserts over it.
    data.habits = [
      { id: bobHabit.id, userId: "old-local-user", name: "Poisoned", startDate: D1 },
    ];
    data.habitLogs = [];
    data.goals = [];
    data.goalEntries = [];
    data.scheduleRules = [];
    data.scheduleRuleDays = [];
    data.scheduleOverrides = [];
    data.reminderDeliveries = [];

    const result = await importBackup(file, "merge");
    expect(result.ok).toBe(true);

    // Bob's row is untouched — the file's id was remapped, not trusted.
    const bobAfter = await prisma.habit.findUniqueOrThrow({ where: { id: bobHabit.id } });
    expect(bobAfter.name).toBe("Bob's habit");
    expect(bobAfter.userId).toBe(bob.id);

    // Alice got her own copy under a remapped id.
    const aliceCopy = await prisma.habit.findUniqueOrThrow({
      where: { id: remapId(alice.id, bobHabit.id) },
    });
    expect(aliceCopy.userId).toBe(alice.id);
    expect(aliceCopy.name).toBe("Poisoned");
  });

  it("a child row pointing at another user's parent is dropped, not attached", async () => {
    const bobMeal = await prisma.meal.create({
      data: { userId: bob.id, date: D1, type: "dinner" },
    });

    const file = syntheticBackup();
    const data = (file as { data: Record<string, unknown[]> }).data;
    // The meal is NOT in the file — the entry dangles toward bob's real row.
    data.meals = [];
    (data.mealEntries[0] as Record<string, unknown>).mealId = bobMeal.id;

    const result = await importBackup(file, "merge");
    expect(result.ok).toBe(true);

    expect(await prisma.mealEntry.count({ where: { mealId: bobMeal.id } })).toBe(0);
    const entryOutcome = result.ok
      ? result.data.perTable.find((t) => t.table === "mealEntries")
      : null;
    expect(entryOutcome?.dropped).toBe(1);
  });

  it("global bundled foods that already exist are reused, never modified", async () => {
    const bundled = await prisma.foodItem.create({
      data: {
        id: "food-global",
        userId: null,
        name: "Bundled oats",
        calories: 389,
        provider: "local",
        searchKey: "bundled oats",
      },
    });

    const file = syntheticBackup();
    const data = (file as { data: Record<string, unknown[]> }).data;
    (data.foodItems[1] as Record<string, unknown>).calories = 1; // poisoned value

    const result = await importBackup(file, "merge");
    expect(result.ok).toBe(true);

    const after = await prisma.foodItem.findUniqueOrThrow({ where: { id: bundled.id } });
    expect(after.calories).toBe(389);
    expect(after.userId).toBeNull();
    // And no duplicate copy was created for the importer.
    expect(await prisma.foodItem.count({ where: { name: "Bundled oats" } })).toBe(1);
  });
});

describe("failure handling", () => {
  it("a fatal mid-import failure rolls the whole import back", async () => {
    const file = syntheticBackup();
    const data = (file as { data: Record<string, unknown[]> }).data;
    // Passes shape validation (a finite number) but overflows int4 at write
    // time — a genuine transaction-level failure.
    (data.scheduleItems[0] as Record<string, unknown>).sortOrder = 2 ** 40;

    const result = await importBackup(file, "merge");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("rolled back");

    // Tables written BEFORE the failing one are rolled back too.
    expect(await prisma.habit.count({ where: { userId: alice.id } })).toBe(0);
    expect(await prisma.tag.count({ where: { userId: alice.id } })).toBe(0);
  });

  it("a damaged row is dropped and reported instead of failing the import", async () => {
    const file = syntheticBackup();
    const data = (file as { data: Record<string, unknown[]> }).data;
    data.journalEntries = [
      { id: "j1", userId: "old-local-user", date: D1, content: "good" },
      { id: "j-bad", userId: "old-local-user", date: 12345, content: "bad date type" },
    ];

    const result = await importBackup(file, "merge");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(await prisma.journalEntry.count({ where: { userId: alice.id } })).toBe(1);
    const outcome = result.data.perTable.find((t) => t.table === "journalEntries");
    expect(outcome?.dropped).toBe(1);
    expect(outcome?.created).toBe(1);
  });
});

describe("older backup versions", () => {
  it("a v2-style file without schedule rules gets every-day schedules backfilled", async () => {
    const file = syntheticBackup();
    (file as { version: number }).version = 2;
    const data = (file as { data: Record<string, unknown[]> }).data;
    data.scheduleRules = [];
    data.scheduleRuleDays = [];
    data.healthImportBatches = [];
    data.healthMetrics = [];
    data.reminderDeliveries = [];

    const result = await importBackup(file, "merge");
    expect(result.ok).toBe(true);

    const rules = await prisma.scheduleRule.findMany({ where: { userId: alice.id } });
    // One for the habit, one for the goal — both arrived without schedules.
    expect(rules).toHaveLength(2);
    expect(rules.every((r) => r.mode === "every_day")).toBe(true);
  });
});

describe("hosted export", () => {
  it("exports the account's own data and round-trips through import", async () => {
    await importBackup(syntheticBackup(), "merge");

    const exported = await exportBackup();
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.data.meta.recordCounts.habits).toBe(1);

    // Round-trip: bob importing alice's export gets his own copies and
    // alice's rows stay hers.
    actAs(bob);
    const result = await importBackup(exported.data, "merge");
    expect(result.ok).toBe(true);

    expect(await prisma.habit.count({ where: { userId: bob.id } })).toBe(1);
    expect(await prisma.habit.count({ where: { userId: alice.id } })).toBe(1);
  });
});
