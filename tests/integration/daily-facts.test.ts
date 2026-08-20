/**
 * The unified daily fact layer (checkpoint 2.1): every module summarised into
 * one row per user per operational day, kept current incrementally by the
 * write paths, rebuildable in bulk, and read back through `getDailyFacts`
 * with missing data explicitly null — never zero.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { setDayTypeOverride } from "@/server/actions/day-type";
import {
  deleteTransaction,
  saveFinanceAccount,
  saveTransaction,
  setAccountBalance,
  transferBetweenAccounts,
} from "@/server/actions/finance";
import { saveJournalEntry } from "@/server/actions/health";
import { saveHabit } from "@/server/actions/habits";
import { saveGoalWithSchedule } from "@/server/actions/goals";
import { logFood } from "@/server/actions/nutrition";
import { completeTask, reopenTask, saveTask } from "@/server/actions/tasks";
import { scheduleSettingsFor } from "@/server/schedule";
import { getDailyFacts, rebuildSummaries, recomputeDay } from "@/server/summaries";
import { actAs, resetDatabase, twoUsers, type User } from "./helpers";

let alice: User;
let bob: User;

const DAY = "2026-07-30";

async function settingsForAlice() {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: alice.id } });
  return scheduleSettingsFor(user);
}

async function summaryOf(userId: string, date: string) {
  return prisma.calendarDaySummary.findUnique({ where: { userId_date: { userId, date } } });
}

async function factOf(userId: string, date: string) {
  const facts = await getDailyFacts(userId, date, date);
  return facts[0];
}

async function checkingAccount(): Promise<string> {
  const result = await saveFinanceAccount({ name: "Checking", openingBalance: 1000 });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.data.id;
}

async function logMeal(calories: number, protein = 10) {
  const food = await prisma.foodItem.create({
    data: {
      userId: alice.id,
      name: `Meal ${calories}`,
      searchKey: `meal ${calories}`,
      calories,
      protein,
      fiber: 5,
      isCustom: true,
      provider: "custom",
    },
  });
  const result = await logFood({
    date: DAY,
    mealType: "lunch",
    foodItemId: food.id,
    quantity: 1,
    unit: "serving",
  });
  expect(result.ok).toBe(true);
}

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  ({ alice, bob } = await twoUsers());
  actAs(alice);
});

describe("null semantics through getDailyFacts", () => {
  it("reads an unlogged nutrition day as null and a logged one as numbers", async () => {
    // A day with SOME data (a planner block) but no meals.
    await prisma.scheduleItem.create({
      data: { userId: alice.id, title: "Focus", date: DAY, startMinute: 540, endMinute: 600 },
    });
    await recomputeDay(alice.id, DAY);

    const empty = await factOf(alice.id, DAY);
    expect(empty?.calories).toBeNull();
    expect(empty?.fiber).toBeNull();
    expect(empty?.mealCount).toBe(0);
    expect(empty?.targetAdherence).toBeNull();
    expect(empty?.plannedMinutes).toBe(60);

    await logMeal(650);
    const logged = await factOf(alice.id, DAY);
    expect(logged?.calories).toBeCloseTo(650, 0);
    expect(logged?.fiber).toBeCloseTo(5, 0);
    expect(logged?.mealCount).toBe(1);
  });

  it("reads a day with nothing scoreable as score null, not 0", async () => {
    await prisma.financeTransaction.create({
      data: {
        userId: alice.id,
        accountId: (await prisma.financeAccount.create({
          data: { userId: alice.id, name: "Cash" },
        })).id,
        date: DAY,
        amount: -5,
        amountCents: -500,
        category: "groceries",
      },
    });
    await recomputeDay(alice.id, DAY);
    const fact = await factOf(alice.id, DAY);
    expect(fact?.score).toBeNull();
    expect(fact?.scoreApplicable).toBe(0);
    expect(fact?.transactionCount).toBe(1); // counts stay true zeros/values
  });
});

describe("finance facts, incrementally on write", () => {
  it("a saved transaction lands in the day summary without a manual recompute", async () => {
    const accountId = await checkingAccount();
    const saved = await saveTransaction({
      accountId,
      date: DAY,
      amount: -12.5,
      category: "groceries",
    });
    expect(saved.ok).toBe(true);

    const fact = await factOf(alice.id, DAY);
    expect(fact?.spendCents).toBe(1250);
    expect(fact?.incomeCents).toBe(0);
    expect(fact?.transactionCount).toBe(1);
    expect(fact?.spendByCategory).toEqual({ groceries: 1250 });
  });

  it("editing a transaction onto another day recomputes both days", async () => {
    const accountId = await checkingAccount();
    const saved = await saveTransaction({ accountId, date: DAY, amount: -20, category: "groceries" });
    if (!saved.ok) throw new Error(saved.error);

    const moved = await saveTransaction({
      id: saved.data.id,
      accountId,
      date: "2026-07-31",
      amount: -20,
      category: "groceries",
    });
    expect(moved.ok).toBe(true);

    expect((await factOf(alice.id, DAY))?.spendCents).toBe(0);
    expect((await factOf(alice.id, "2026-07-31"))?.spendCents).toBe(2000);
  });

  it("transfers and adjustments count as transactions but never as spend or income", async () => {
    const from = await checkingAccount();
    const savings = await saveFinanceAccount({ name: "Savings", openingBalance: 0 });
    if (!savings.ok) throw new Error(savings.error);

    const transfer = await transferBetweenAccounts({
      fromAccountId: from,
      toAccountId: savings.data.id,
      amount: 100,
      date: DAY,
    });
    expect(transfer.ok).toBe(true);

    const adjusted = await setAccountBalance({ accountId: from, balance: 500, date: DAY });
    expect(adjusted.ok).toBe(true);

    const fact = await factOf(alice.id, DAY);
    expect(fact?.transactionCount).toBe(3); // two legs + one adjustment
    expect(fact?.spendCents).toBe(0);
    expect(fact?.incomeCents).toBe(0);
    expect(fact?.spendByCategory).toEqual({});
  });

  it("deleting a transaction takes it back out of the summary", async () => {
    const accountId = await checkingAccount();
    const saved = await saveTransaction({ accountId, date: DAY, amount: -9, category: "groceries" });
    if (!saved.ok) throw new Error(saved.error);
    expect((await factOf(alice.id, DAY))?.spendCents).toBe(900);

    const deleted = await deleteTransaction(saved.data.id);
    expect(deleted.ok).toBe(true);
    expect((await factOf(alice.id, DAY))?.spendCents).toBe(0);
  });
});

describe("task facts through the operational window", () => {
  it("counts created and completed on the user's today, due-open on the due date", async () => {
    const settings = await settingsForAlice();
    const saved = await saveTask({ title: "Ship the fact layer", dueDate: DAY });
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.error);

    expect((await factOf(alice.id, settings.today))?.tasksCreated).toBe(1);
    expect((await factOf(alice.id, DAY))?.tasksDueOpen).toBe(1);

    const completed = await completeTask(saved.data.id);
    expect(completed.ok).toBe(true);
    expect((await factOf(alice.id, settings.today))?.tasksCompleted).toBe(1);
    expect((await factOf(alice.id, DAY))?.tasksDueOpen).toBe(0);

    const reopened = await reopenTask(saved.data.id);
    expect(reopened.ok).toBe(true);
    expect((await factOf(alice.id, settings.today))?.tasksCompleted).toBe(0);
    expect((await factOf(alice.id, DAY))?.tasksDueOpen).toBe(1);
  });

  it("assigns an instant before the 4 AM reset to the previous operational day", async () => {
    // 06:00Z on Jul 30 is 2 AM in America/New_York (EDT) — before the reset,
    // so the creation belongs to Jul 29.
    await prisma.task.create({
      data: {
        userId: alice.id,
        title: "Night owl",
        createdAt: new Date("2026-07-30T06:00:00Z"),
      },
    });
    await recomputeDay(alice.id, "2026-07-29");
    await recomputeDay(alice.id, "2026-07-30");

    expect((await factOf(alice.id, "2026-07-29"))?.tasksCreated).toBe(1);
    expect((await factOf(alice.id, "2026-07-30"))?.tasksCreated).toBe(0);
  });
});

describe("journal presence", () => {
  it("flips hasJournal on save and back off when the page is emptied", async () => {
    const saved = await saveJournalEntry({ date: DAY, content: "A good day." });
    expect(saved.ok).toBe(true);
    expect((await factOf(alice.id, DAY))?.hasJournal).toBe(true);

    const emptied = await saveJournalEntry({ date: DAY, content: "" });
    expect(emptied.ok).toBe(true);
    expect((await factOf(alice.id, DAY))?.hasJournal).toBe(false);
  });
});

describe("habit facts are pause-aware", () => {
  it("a paused habit counts as paused — never due, never missed", async () => {
    const saved = await saveHabit({
      habit: {
        name: "Stretch",
        startDate: "2026-07-01",
        pausedFrom: "2026-07-25",
        pausedUntil: "2026-08-05",
      },
      schedule: { mode: "every_day" },
    });
    expect(saved.ok).toBe(true);

    await recomputeDay(alice.id, DAY);
    const fact = await factOf(alice.id, DAY);
    expect(fact?.habitsPaused).toBe(1);
    expect(fact?.habitsDue).toBe(0);
    expect(fact?.habitsMissed).toBe(0);
  });
});

describe("day type and target adherence", () => {
  it("stores the resolved day type, override included", async () => {
    await recomputeDay(alice.id, DAY);
    expect((await factOf(alice.id, DAY))?.dayType).toBe("rest");

    await prisma.workout.create({
      data: { userId: alice.id, date: DAY, name: "Lift", status: "completed" },
    });
    await recomputeDay(alice.id, DAY);
    expect((await factOf(alice.id, DAY))?.dayType).toBe("training");

    const overridden = await setDayTypeOverride({ date: DAY, dayType: "rest" });
    expect(overridden.ok).toBe(true); // the action recomputes on its own
    expect((await factOf(alice.id, DAY))?.dayType).toBe("rest");
  });

  it("caches nutrition-target adherence for the day's applicable, measured targets", async () => {
    const goal = await saveGoalWithSchedule({
      goal: {
        domain: "nutrition",
        metric: "calories",
        label: "Calories",
        target: 2200,
        unit: "kcal",
        direction: "lte",
        period: "daily",
        source: "calories",
        dayType: "all",
        active: true,
        startDate: "2026-07-01",
      },
      schedule: {
        mode: "every_day",
        weekdays: [],
        interval: 1,
        timesPerWeek: null,
        monthDay: null,
        enabled: true,
        daypart: "anytime",
        timeMinute: null,
        reminderEnabled: false,
        reminderMinute: null,
      },
    });
    expect(goal.ok).toBe(true);

    // Unlogged: the target has no data, so nothing applies — adherence null.
    await recomputeDay(alice.id, DAY);
    expect((await factOf(alice.id, DAY))?.targetAdherence).toBeNull();

    // Logged under the cap: 1 of 1 met. logFood recomputes on its own.
    await logMeal(1850);
    const fact = await factOf(alice.id, DAY);
    expect(fact?.targetAdherence).toBe(1);
  });
});

describe("workout aggregates", () => {
  it("stores volume over completed sets and the day's type mix", async () => {
    await prisma.workout.create({
      data: {
        userId: alice.id,
        date: DAY,
        name: "Push",
        type: "strength",
        status: "completed",
        sets: {
          create: [
            { exercise: "Bench", setNumber: 1, reps: 8, weightKg: 100, completed: true },
            { exercise: "Bench", setNumber: 2, reps: 8, weightKg: 100, completed: true },
            { exercise: "Bench", setNumber: 3, reps: 8, weightKg: 100, completed: false },
          ],
        },
      },
    });
    await recomputeDay(alice.id, DAY);
    const fact = await factOf(alice.id, DAY);
    expect(fact?.workoutVolumeKg).toBe(1600);
    expect(fact?.workoutTypes).toEqual(["strength"]);
    expect(fact?.workoutCount).toBe(1);
  });
});

describe("rebuild and idempotence", () => {
  it("recomputing the same day twice writes the identical row", async () => {
    const accountId = await checkingAccount();
    await saveTransaction({ accountId, date: DAY, amount: -12.5, category: "groceries" });
    await logMeal(650);

    // Same row id, same data — only the row's own updatedAt stamp moves.
    const first = await summaryOf(alice.id, DAY);
    await recomputeDay(alice.id, DAY);
    const second = await summaryOf(alice.id, DAY);
    const { updatedAt: _a, ...firstData } = first!;
    const { updatedAt: _b, ...secondData } = second!;
    expect(secondData).toEqual(firstData);
  });

  it("a bulk rebuild fills the new columns for rows written before the upgrade", async () => {
    const accountId = await checkingAccount();
    await saveTransaction({ accountId, date: DAY, amount: -30, category: "transport" });
    await saveJournalEntry({ date: DAY, content: "Rode the train." });

    // Simulate a pre-upgrade row: wipe the summary entirely.
    await prisma.calendarDaySummary.deleteMany({ where: { userId: alice.id } });
    expect(await summaryOf(alice.id, DAY)).toBeNull();

    await rebuildSummaries(alice.id, "2026-07-29", "2026-07-31");
    const fact = await factOf(alice.id, DAY);
    expect(fact?.spendCents).toBe(3000);
    expect(fact?.spendByCategory).toEqual({ transport: 3000 });
    expect(fact?.hasJournal).toBe(true);
    expect(fact?.dayType).toBe("rest");
  });
});

describe("isolation", () => {
  it("one user's facts never contain another's data", async () => {
    const accountId = await checkingAccount();
    await saveTransaction({ accountId, date: DAY, amount: -50, category: "groceries" });

    actAs(bob);
    await recomputeDay(bob.id, DAY);
    const fact = await factOf(bob.id, DAY);
    expect(fact?.spendCents).toBe(0);
    expect(fact?.transactionCount).toBe(0);
  });
});
