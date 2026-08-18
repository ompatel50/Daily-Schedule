/**
 * Phase-9 review + transparency against real PostgreSQL: the weekly review
 * page's read model (reusing the get_week_review computation), one-click
 * roll-forward, the reflection's journal round trip, the Settings data
 * overview, and backup recency — with the cross-user emptiness each of them
 * must keep.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { shiftDay } from "@/lib/date";
import { getWeekBounds } from "@/lib/logic/schedule";
import { exportBackup } from "@/server/actions/backup";
import { saveJournalEntry } from "@/server/actions/health";
import { saveTransaction, saveFinanceAccount, saveBudget } from "@/server/actions/finance";
import { rollTaskForward } from "@/server/actions/tasks";
import { getDataOverview } from "@/server/data-overview";
import { getWeeklyReviewPage } from "@/server/review";
import { scheduleSettingsFor } from "@/server/schedule";
import { actAs, resetDatabase, twoUsers, type User } from "./helpers";

let alice: User;
let bob: User;

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  ({ alice, bob } = await twoUsers());
  actAs(alice);
});

const settings = () => scheduleSettingsFor(alice);

describe("the weekly review page model", () => {
  it("assembles the week: review numbers, unfinished tasks, money, reflection", async () => {
    const today = settings().today;
    const week = getWeekBounds(today, settings());

    await prisma.task.create({
      data: { userId: alice.id, title: "Overdue thing", dueDate: shiftDay(week.start, -3) },
    });
    await prisma.task.create({
      data: { userId: alice.id, title: "This week", dueDate: week.start },
    });
    await prisma.task.create({
      data: { userId: alice.id, title: "Next week already", dueDate: shiftDay(week.end, 3) },
    });
    await prisma.task.create({
      data: { userId: alice.id, title: "Done already", dueDate: week.start, status: "done" },
    });

    const account = await saveFinanceAccount({ name: "Checking" });
    if (!account.ok) throw new Error("account");
    await saveTransaction({
      accountId: account.data.id,
      date: today,
      amount: -25,
      category: "groceries",
    });
    await saveBudget({ category: "groceries", amount: 100, period: "monthly" });

    const page = await getWeeklyReviewPage();
    expect(page.isCurrentWeek).toBe(true);
    expect(page.week.start).toBe(week.start);
    expect(page.nextWeekStart).toBe(shiftDay(week.start, 7));

    // Only OPEN tasks due by the week's end — done and next-week ones stay out.
    expect(page.unfinishedTasks.map((task) => task.title)).toEqual([
      "Overdue thing",
      "This week",
    ]);

    expect(page.money.month.spending).toBe(2500); // integer cents
    expect(page.money.budgets).toHaveLength(1);
    expect(page.money.budgets[0]).toMatchObject({ spent: 2500, effectiveAmount: 10000 });

    // The same engine as the assistant's get_week_review.
    expect(page.review.start).toBe(week.start);
    expect(typeof page.review.focus).toBe("string");
  });

  it("the reflection prefills the day's journal, and saving round-trips", async () => {
    const today = settings().today;
    await saveJournalEntry({ date: today, content: "already wrote this" });

    const page = await getWeeklyReviewPage();
    expect(page.reflection.date).toBe(today);
    expect(page.reflection.content).toBe("already wrote this");

    await saveJournalEntry({
      date: page.reflection.date,
      title: "Weekly review",
      content: "already wrote this\n\nGood week overall.",
    });
    const after = await getWeeklyReviewPage();
    expect(after.reflection.content).toContain("Good week overall");
    expect(
      await prisma.journalEntry.count({ where: { userId: alice.id } }),
    ).toBe(1);
  });

  it("a past week reviews under its own dates and offers next-week navigation", async () => {
    const lastWeekAnchor = shiftDay(settings().today, -7);
    const page = await getWeeklyReviewPage(lastWeekAnchor);
    expect(page.isCurrentWeek).toBe(false);
    expect(page.nextAnchor).not.toBeNull();
    expect(page.reflection.date).toBe(page.week.end);
  });

  it("cross-user: bob's review sees none of alice's week", async () => {
    await prisma.task.create({
      data: { userId: alice.id, title: "Hers", dueDate: settings().today },
    });
    actAs(bob);
    const page = await getWeeklyReviewPage();
    expect(page.unfinishedTasks).toEqual([]);
    expect(page.money.budgets).toEqual([]);
  });
});

describe("roll-forward", () => {
  it("moves an open task's due date and re-anchors a repeat", async () => {
    const today = settings().today;
    const plain = await prisma.task.create({
      data: { userId: alice.id, title: "Plain", dueDate: shiftDay(today, -2) },
    });
    const repeating = await prisma.task.create({
      data: {
        userId: alice.id,
        title: "Weekly",
        dueDate: shiftDay(today, -2),
        repeat: "weekly",
        repeatEvery: 1,
        repeatAnchor: shiftDay(today, -2),
      },
    });

    const to = shiftDay(today, 7);
    expect((await rollTaskForward(plain.id, to)).ok).toBe(true);
    expect((await rollTaskForward(repeating.id, to)).ok).toBe(true);

    const plainAfter = await prisma.task.findUniqueOrThrow({ where: { id: plain.id } });
    expect(plainAfter.dueDate).toBe(to);
    expect(plainAfter.repeatAnchor).toBeNull();
    const repeatingAfter = await prisma.task.findUniqueOrThrow({ where: { id: repeating.id } });
    expect(repeatingAfter).toMatchObject({ dueDate: to, repeatAnchor: to });
  });

  it("refuses closed tasks, foreign tasks and malformed dates", async () => {
    const done = await prisma.task.create({
      data: { userId: alice.id, title: "Done", status: "done", dueDate: settings().today },
    });
    expect((await rollTaskForward(done.id, shiftDay(settings().today, 7))).ok).toBe(false);
    expect((await rollTaskForward(done.id, "not-a-date")).ok).toBe(false);

    const hers = await prisma.task.create({
      data: { userId: alice.id, title: "Hers", dueDate: settings().today },
    });
    actAs(bob);
    expect((await rollTaskForward(hers.id, shiftDay(settings().today, 7))).ok).toBe(false);
  });
});

describe("the data overview", () => {
  it("counts per module with natural date bounds, imports and trash", async () => {
    const account = await prisma.financeAccount.create({
      data: { userId: alice.id, name: "Checking" },
    });
    await prisma.financeTransaction.createMany({
      data: [
        { userId: alice.id, accountId: account.id, date: "2026-01-05", amount: -1 },
        { userId: alice.id, accountId: account.id, date: "2026-06-10", amount: -2 },
      ],
    });
    await prisma.task.create({ data: { userId: alice.id, title: "Live" } });
    await prisma.task.create({
      data: { userId: alice.id, title: "Trashed", deletedAt: new Date() },
    });

    const overview = await getDataOverview();
    const transactions = overview.modules.find((row) => row.module === "Transactions");
    expect(transactions).toMatchObject({ count: 2, oldest: "2026-01-05", newest: "2026-06-10" });
    // Guarded counts: the trashed task is not "your data" — it is your trash.
    expect(overview.modules.find((row) => row.module === "Tasks")?.count).toBe(1);
    expect(overview.trashCount).toBe(1);
    expect(overview.lastFinanceImport).toBeNull();
    expect(overview.lastHealthImport).toBeNull();
  });

  it("backup recency starts never and stamps on export", async () => {
    expect((await getDataOverview()).lastBackupExportAt).toBeNull();
    const exported = await exportBackup();
    expect(exported.ok).toBe(true);
    const after = await getDataOverview();
    expect(after.lastBackupExportAt).not.toBeNull();

    // Bob's account is untouched by alice's export.
    actAs(bob);
    expect((await getDataOverview()).lastBackupExportAt).toBeNull();
  });
});
