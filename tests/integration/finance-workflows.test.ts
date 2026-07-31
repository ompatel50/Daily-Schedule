/**
 * Phase-2 finance workflows and life-admin bridges, against real PostgreSQL:
 * CSV import (preview / commit / idempotency), account transfers, budgets,
 * inbox → task conversion, task → planner scheduling, low-balance reminders —
 * plus the cross-user denial each of them must enforce.
 *
 * Dates: anything that depends on "today" uses the user's own timezone via
 * todayIn. Fixture dates that only need to be *a* day use a fixed constant.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { shiftDay, weekRange } from "@/lib/date";
import { todayIn } from "@/lib/logic/schedule";
import { lowBalanceReminderKey } from "@/lib/logic/reminders";
import { actAs, resetDatabase, twoUsers } from "./helpers";

import {
  deleteBudget,
  deleteTransaction,
  saveBill,
  saveBudget,
  saveFinanceAccount,
  saveTransaction,
  transferBetweenAccounts,
} from "@/server/actions/finance";
import {
  commitFinanceCsvImport,
  previewFinanceCsvImport,
} from "@/server/actions/finance-import";
import { exportBackup, importBackup } from "@/server/actions/backup";
import { convertInboxItemToTask } from "@/server/actions/inbox";
import { scheduleTaskOnPlanner } from "@/server/actions/tasks";
import { getFinanceOverview, getFinanceSummary } from "@/server/finance";
import { getReminderFeedFor, recordReminderDeliveryFor } from "@/server/reminders";
import { searchEverything } from "@/server/queries";

import type { User } from "./helpers";

let alice: User;
let bob: User;

const DAY = "2026-07-15";

const aliceToday = () => todayIn(alice.timezone);

function makeAccount(userId: string, overrides: Record<string, unknown> = {}) {
  return prisma.financeAccount.create({
    data: { userId, name: "Checking", ...overrides },
  });
}

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  ({ alice, bob } = await twoUsers());
  actAs(alice);
});

// ---------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------

const CSV = [
  "date,amount,description,category",
  `${DAY},-42.50,Corner grocery,groceries`,
  `${DAY},-42.50,Corner grocery,groceries`, // deliberate duplicate purchase
  `${DAY},2500.00,Payroll,income`,
  "not-a-date,-10,Broken row,",
].join("\n");

describe("CSV import", () => {
  it("preview reports without writing anything", async () => {
    const account = await makeAccount(alice.id);
    const result = await previewFinanceCsvImport({
      accountId: account.id,
      fileName: "bank.csv",
      content: CSV,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.newCount).toBe(3);
    expect(result.data.duplicateCount).toBe(0);
    expect(result.data.invalidCount).toBe(1);
    expect(result.data.rowCount).toBe(4);
    expect(result.data.sample.map((row) => row.status)).toEqual(["new", "new", "new"]);

    expect(await prisma.financeTransaction.count({ where: { userId: alice.id } })).toBe(0);
    expect(await prisma.financeImportBatch.count({ where: { userId: alice.id } })).toBe(0);
  });

  it("commit writes the rows, the batch record, and links them", async () => {
    const account = await makeAccount(alice.id);
    const result = await commitFinanceCsvImport({
      accountId: account.id,
      fileName: "bank.csv",
      content: CSV,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.createdCount).toBe(3);
    expect(result.data.skippedCount).toBe(0);
    expect(result.data.rejectedCount).toBe(1);

    const rows = await prisma.financeTransaction.findMany({
      where: { userId: alice.id },
      orderBy: { importKey: "asc" },
    });
    expect(rows).toHaveLength(3);
    // Both identical purchases imported — distinct occurrence suffixes.
    const keys = rows.map((row) => row.importKey);
    expect(new Set(keys).size).toBe(3);
    for (const row of rows) {
      expect(row.accountId).toBe(account.id);
      expect(row.importBatchId).toBe(result.data.batchId);
    }

    const batch = await prisma.financeImportBatch.findUniqueOrThrow({
      where: { id: result.data.batchId },
    });
    expect(batch).toMatchObject({
      userId: alice.id,
      accountId: account.id,
      fileName: "bank.csv",
      rowCount: 4,
      createdCount: 3,
      skippedCount: 0,
      rejectedCount: 1,
    });

    // Balance derives from the imported ledger.
    const total = await prisma.financeTransaction.aggregate({
      where: { accountId: account.id },
      _sum: { amount: true },
    });
    expect(total._sum.amount).toBe(2415);
  });

  it("re-importing the same file is a no-op, reported as skips", async () => {
    const account = await makeAccount(alice.id);
    const first = await commitFinanceCsvImport({
      accountId: account.id,
      fileName: "bank.csv",
      content: CSV,
    });
    expect(first.ok).toBe(true);

    const preview = await previewFinanceCsvImport({
      accountId: account.id,
      fileName: "bank.csv",
      content: CSV,
    });
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      expect(preview.data.newCount).toBe(0);
      expect(preview.data.duplicateCount).toBe(3);
    }

    const second = await commitFinanceCsvImport({
      accountId: account.id,
      fileName: "bank.csv",
      content: CSV,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.createdCount).toBe(0);
    expect(second.data.skippedCount).toBe(3);
    expect(await prisma.financeTransaction.count({ where: { userId: alice.id } })).toBe(3);
  });

  it("deleting an imported row then re-importing restores exactly it", async () => {
    const account = await makeAccount(alice.id);
    await commitFinanceCsvImport({ accountId: account.id, fileName: "b.csv", content: CSV });
    const victim = await prisma.financeTransaction.findFirstOrThrow({
      where: { userId: alice.id, amount: 2500 },
    });
    await deleteTransaction(victim.id);

    const again = await commitFinanceCsvImport({
      accountId: account.id,
      fileName: "b.csv",
      content: CSV,
    });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.data.createdCount).toBe(1);
    expect(await prisma.financeTransaction.count({ where: { userId: alice.id } })).toBe(3);
  });

  it("import → backup → replace-restore → re-import still dedups row-for-row", async () => {
    const account = await makeAccount(alice.id);
    await commitFinanceCsvImport({ accountId: account.id, fileName: "b.csv", content: CSV });

    const exported = await exportBackup();
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const restored = await importBackup(exported.data, "replace");
    expect(restored.ok).toBe(true);

    // The account now lives under its remapped id; the same CSV must still
    // collide with every restored row instead of double-counting the ledger.
    const remappedAccount = await prisma.financeAccount.findFirstOrThrow({
      where: { userId: alice.id },
    });
    expect(remappedAccount.id).not.toBe(account.id);
    const again = await commitFinanceCsvImport({
      accountId: remappedAccount.id,
      fileName: "b.csv",
      content: CSV,
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.data.createdCount).toBe(0);
    expect(again.data.skippedCount).toBe(3);
    expect(await prisma.financeTransaction.count({ where: { userId: alice.id } })).toBe(3);
  });

  it("a wholly invalid file fails without writing a batch record", async () => {
    const account = await makeAccount(alice.id);
    const result = await commitFinanceCsvImport({
      accountId: account.id,
      fileName: "junk.csv",
      content: "date,amount\nnope,alsonope",
    });
    expect(result.ok).toBe(false);
    expect(await prisma.financeImportBatch.count({ where: { userId: alice.id } })).toBe(0);
  });

  it("refuses another user's account and archived accounts", async () => {
    const bobAccount = await makeAccount(bob.id);
    const denied = await commitFinanceCsvImport({
      accountId: bobAccount.id,
      fileName: "b.csv",
      content: CSV,
    });
    expect(denied).toMatchObject({ ok: false, error: "Account not found" });
    expect(await prisma.financeTransaction.count()).toBe(0);

    const archived = await makeAccount(alice.id, { archivedAt: new Date() });
    const refused = await previewFinanceCsvImport({
      accountId: archived.id,
      fileName: "b.csv",
      content: CSV,
    });
    expect(refused.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

describe("account transfers", () => {
  it("writes two linked legs atomically and keeps balances exact", async () => {
    const checking = await makeAccount(alice.id, { openingBalance: 1000 });
    const savings = await makeAccount(alice.id, { name: "Savings", type: "savings" });

    const result = await transferBetweenAccounts({
      fromAccountId: checking.id,
      toAccountId: savings.id,
      amount: 250,
      date: DAY,
      notes: "monthly move",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const legs = await prisma.financeTransaction.findMany({
      where: { userId: alice.id, transferGroupId: result.data.transferGroupId },
      orderBy: { amount: "asc" },
    });
    expect(legs).toHaveLength(2);
    expect(legs[0]).toMatchObject({
      accountId: checking.id,
      amount: -250,
      category: "transfer",
      payee: "Transfer to Savings",
    });
    expect(legs[1]).toMatchObject({
      accountId: savings.id,
      amount: 250,
      category: "transfer",
      payee: "Transfer from Checking",
    });
  });

  it("never counts as income or spending in summaries", async () => {
    const checking = await makeAccount(alice.id, { openingBalance: 1000 });
    const savings = await makeAccount(alice.id, { name: "Savings" });
    const today = aliceToday();
    await prisma.financeTransaction.create({
      data: { userId: alice.id, accountId: checking.id, date: today, amount: -50, category: "dining" },
    });
    await transferBetweenAccounts({
      fromAccountId: checking.id,
      toAccountId: savings.id,
      amount: 400,
      date: today,
    });

    const summary = await getFinanceSummary();
    expect(summary.month.income).toBe(0);
    expect(summary.month.spending).toBe(50);
    // The net across accounts is unchanged by the transfer.
    expect(summary.net[0].net).toBe(950);
  });

  it("deleting either leg removes the pair", async () => {
    const a = await makeAccount(alice.id);
    const b = await makeAccount(alice.id, { name: "Other" });
    const result = await transferBetweenAccounts({
      fromAccountId: a.id,
      toAccountId: b.id,
      amount: 10,
      date: DAY,
    });
    expect(result.ok).toBe(true);

    const leg = await prisma.financeTransaction.findFirstOrThrow({
      where: { userId: alice.id, amount: 10 },
    });
    const deletion = await deleteTransaction(leg.id);
    expect(deletion.ok).toBe(true);
    expect(await prisma.financeTransaction.count({ where: { userId: alice.id } })).toBe(0);
  });

  it("refuses to edit a leg through the generic transaction action", async () => {
    const a = await makeAccount(alice.id);
    const b = await makeAccount(alice.id, { name: "Other" });
    await transferBetweenAccounts({ fromAccountId: a.id, toAccountId: b.id, amount: 10, date: DAY });
    const leg = await prisma.financeTransaction.findFirstOrThrow({
      where: { userId: alice.id, amount: -10 },
    });

    const edit = await saveTransaction({
      id: leg.id,
      accountId: a.id,
      date: DAY,
      amount: -99,
      category: "other",
    });
    expect(edit.ok).toBe(false);
    if (!edit.ok) expect(edit.error).toContain("transfer");
    const untouched = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: leg.id } });
    expect(untouched.amount).toBe(-10);
  });

  it("refuses hand-made 'transfer' category rows", async () => {
    const a = await makeAccount(alice.id);
    const result = await saveTransaction({
      accountId: a.id,
      date: DAY,
      amount: -10,
      category: "transfer",
    });
    expect(result.ok).toBe(false);
  });

  it("refuses bills with bookkeeping categories — a 'transfer' bill payment would hide spending", async () => {
    for (const category of ["transfer", "adjustment"]) {
      const result = await saveBill({
        name: "Sneaky",
        amount: 100,
        category,
        recurrence: "monthly",
        dueDate: DAY,
      });
      expect(result.ok).toBe(false);
    }
    expect(await prisma.bill.count()).toBe(0);
  });

  it("refuses cross-currency, same-account, archived and foreign accounts", async () => {
    const usd = await makeAccount(alice.id);
    const eur = await makeAccount(alice.id, { name: "Euro", currency: "EUR" });
    const crossCurrency = await transferBetweenAccounts({
      fromAccountId: usd.id,
      toAccountId: eur.id,
      amount: 10,
      date: DAY,
    });
    expect(crossCurrency.ok).toBe(false);
    if (!crossCurrency.ok) expect(crossCurrency.error).toContain("different currencies");

    const sameAccount = await transferBetweenAccounts({
      fromAccountId: usd.id,
      toAccountId: usd.id,
      amount: 10,
      date: DAY,
    });
    expect(sameAccount.ok).toBe(false);

    const archived = await makeAccount(alice.id, { name: "Old", archivedAt: new Date() });
    const toArchived = await transferBetweenAccounts({
      fromAccountId: usd.id,
      toAccountId: archived.id,
      amount: 10,
      date: DAY,
    });
    expect(toArchived.ok).toBe(false);

    const bobAccount = await makeAccount(bob.id);
    const crossUser = await transferBetweenAccounts({
      fromAccountId: usd.id,
      toAccountId: bobAccount.id,
      amount: 10,
      date: DAY,
    });
    expect(crossUser).toMatchObject({ ok: false, error: "Account not found" });
    expect(await prisma.financeTransaction.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

describe("budgets", () => {
  it("creates, updates and deletes a budget", async () => {
    const created = await saveBudget({ category: "dining", amount: 200 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const updated = await saveBudget({ id: created.data.id, category: "dining", amount: 300 });
    expect(updated.ok).toBe(true);
    expect(
      (await prisma.budget.findUniqueOrThrow({ where: { id: created.data.id } })).amount,
    ).toBe(300);

    const deleted = await deleteBudget(created.data.id);
    expect(deleted.ok).toBe(true);
    expect(await prisma.budget.count({ where: { userId: alice.id } })).toBe(0);
  });

  it("one budget per category — the second create fails with a useful message", async () => {
    await saveBudget({ category: "dining", amount: 200 });
    const second = await saveBudget({ category: "dining", amount: 999 });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain("Dining");
    // Two users may budget the same category independently.
    actAs(bob);
    const bobs = await saveBudget({ category: "dining", amount: 100 });
    expect(bobs.ok).toBe(true);
  });

  it("refuses income and bookkeeping categories", async () => {
    expect((await saveBudget({ category: "income", amount: 10 })).ok).toBe(false);
    expect((await saveBudget({ category: "transfer", amount: 10 })).ok).toBe(false);
    expect((await saveBudget({ category: "adjustment", amount: 10 })).ok).toBe(false);
  });

  it("cross-user: bob cannot edit or delete alice's budget", async () => {
    const created = await saveBudget({ category: "dining", amount: 200 });
    if (!created.ok) throw new Error("setup failed");

    actAs(bob);
    const edit = await saveBudget({ id: created.data.id, category: "dining", amount: 1 });
    expect(edit).toMatchObject({ ok: false, error: "Budget not found" });
    await deleteBudget(created.data.id);

    actAs(alice);
    expect(await prisma.budget.count({ where: { userId: alice.id } })).toBe(1);
  });

  it("the week card never counts future-dated entries", async () => {
    const account = await makeAccount(alice.id);
    const today = aliceToday();
    await prisma.financeTransaction.createMany({
      data: [
        { userId: alice.id, accountId: account.id, date: today, amount: -20, category: "dining" },
        // Rent typed in ahead of time — real spending, but not "the last 7 days".
        {
          userId: alice.id,
          accountId: account.id,
          date: shiftDay(today, 5),
          amount: -1800,
          category: "housing",
        },
      ],
    });
    const overview = await getFinanceOverview();
    expect(overview.week.spending).toBe(20);
  });

  it("the dashboard summary reports over-budget state from this month's spending", async () => {
    const account = await makeAccount(alice.id);
    const today = aliceToday();
    await saveBudget({ category: "dining", amount: 100 });
    await saveBudget({ category: "travel", amount: 500 });
    await prisma.financeTransaction.create({
      data: { userId: alice.id, accountId: account.id, date: today, amount: -130, category: "dining" },
    });

    const summary = await getFinanceSummary();
    expect(summary.budgets.count).toBe(2);
    expect(summary.budgets.overCount).toBe(1);
    expect(summary.budgets.worst).toEqual({ label: "Dining", percent: 130, period: "monthly" });
  });
});

// ---------------------------------------------------------------------------
// Inbox → task conversion
// ---------------------------------------------------------------------------

describe("inbox → task conversion", () => {
  it("creates the task, archives the item, links the two — atomically", async () => {
    const item = await prisma.inboxItem.create({
      data: { userId: alice.id, title: "Call the plumber", notes: "About the leak" },
    });

    const result = await convertInboxItemToTask({
      id: item.id,
      priority: "high",
      dueDate: DAY,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const task = await prisma.task.findUniqueOrThrow({ where: { id: result.data.taskId } });
    expect(task).toMatchObject({
      userId: alice.id,
      title: "Call the plumber",
      notes: "About the leak",
      priority: "high",
      dueDate: DAY,
      status: "open",
    });

    const after = await prisma.inboxItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.status).toBe("archived");
    expect(after.taskId).toBe(task.id);
  });

  it("carries edited fields and a project when given", async () => {
    const project = await prisma.project.create({ data: { userId: alice.id, name: "House" } });
    const item = await prisma.inboxItem.create({ data: { userId: alice.id, title: "orig" } });

    const result = await convertInboxItemToTask({
      id: item.id,
      title: "Renamed while converting",
      notes: "fresh notes",
      projectId: project.id,
      priority: "low",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const task = await prisma.task.findUniqueOrThrow({ where: { id: result.data.taskId } });
    expect(task).toMatchObject({
      title: "Renamed while converting",
      notes: "fresh notes",
      projectId: project.id,
      priority: "low",
    });
  });

  it("never converts twice — until the task is deleted, which frees the link", async () => {
    const item = await prisma.inboxItem.create({ data: { userId: alice.id, title: "Once" } });
    const first = await convertInboxItemToTask({ id: item.id, priority: "medium" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await convertInboxItemToTask({ id: item.id, priority: "medium" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain("already became a task");
    expect(await prisma.task.count({ where: { userId: alice.id } })).toBe(1);

    // Deleting the task SetNulls the link; the item can become a task again.
    await prisma.task.delete({ where: { id: first.data.taskId } });
    const third = await convertInboxItemToTask({ id: item.id, priority: "medium" });
    expect(third.ok).toBe(true);
  });

  it("cross-user: bob cannot convert alice's item, nor attach her project", async () => {
    const item = await prisma.inboxItem.create({ data: { userId: alice.id, title: "Private" } });
    const project = await prisma.project.create({ data: { userId: alice.id, name: "Hers" } });

    actAs(bob);
    const denied = await convertInboxItemToTask({ id: item.id, priority: "medium" });
    expect(denied).toMatchObject({ ok: false, error: "Inbox item not found" });

    const bobItem = await prisma.inboxItem.create({ data: { userId: bob.id, title: "His" } });
    const foreignProject = await convertInboxItemToTask({
      id: bobItem.id,
      projectId: project.id,
      priority: "medium",
    });
    expect(foreignProject).toMatchObject({ ok: false, error: "Project not found" });
    expect(await prisma.task.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Task → planner
// ---------------------------------------------------------------------------

describe("task → planner scheduling", () => {
  it("creates an ordinary planner block linked to the task", async () => {
    const task = await prisma.task.create({
      data: { userId: alice.id, title: "Paint hallway", priority: "high" },
    });
    const result = await scheduleTaskOnPlanner({
      taskId: task.id,
      date: DAY,
      startMinute: 540,
      endMinute: 600,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const item = await prisma.scheduleItem.findUniqueOrThrow({
      where: { id: result.data.scheduleItemId },
    });
    expect(item).toMatchObject({
      userId: alice.id,
      title: "Paint hallway",
      date: DAY,
      allDay: false,
      startMinute: 540,
      endMinute: 600,
      priority: "high",
      taskId: task.id,
      status: "planned",
    });
  });

  it("no time means an all-day block; the same task can block several days", async () => {
    const task = await prisma.task.create({ data: { userId: alice.id, title: "Prep taxes" } });
    const first = await scheduleTaskOnPlanner({ taskId: task.id, date: DAY });
    const second = await scheduleTaskOnPlanner({ taskId: task.id, date: "2026-07-16" });
    expect(first.ok && second.ok).toBe(true);
    const items = await prisma.scheduleItem.findMany({ where: { taskId: task.id } });
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.allDay)).toBe(true);
  });

  it("only open tasks schedule; deleting the task keeps the block, unlinked", async () => {
    const done = await prisma.task.create({
      data: { userId: alice.id, title: "Done thing", status: "done" },
    });
    expect((await scheduleTaskOnPlanner({ taskId: done.id, date: DAY })).ok).toBe(false);

    const task = await prisma.task.create({ data: { userId: alice.id, title: "Doomed" } });
    const result = await scheduleTaskOnPlanner({ taskId: task.id, date: DAY });
    if (!result.ok) throw new Error("setup failed");
    await prisma.task.delete({ where: { id: task.id } });

    const survivor = await prisma.scheduleItem.findUniqueOrThrow({
      where: { id: result.data.scheduleItemId },
    });
    expect(survivor.taskId).toBeNull();
    expect(survivor.title).toBe("Doomed");
  });

  it("cross-user: bob cannot schedule alice's task", async () => {
    const task = await prisma.task.create({ data: { userId: alice.id, title: "Hers" } });
    actAs(bob);
    const denied = await scheduleTaskOnPlanner({ taskId: task.id, date: DAY });
    expect(denied).toMatchObject({ ok: false, error: "Task not found" });
    expect(await prisma.scheduleItem.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Low-balance reminders
// ---------------------------------------------------------------------------

describe("low-balance reminders", () => {
  const feedFor = (user: User) =>
    getReminderFeedFor({ id: user.id, timezone: user.timezone, weekStartsOn: user.weekStartsOn });

  it("an account below its threshold produces one weekly-keyed occurrence", async () => {
    const account = await makeAccount(alice.id, {
      openingBalance: 500,
      lowBalanceThreshold: 100,
    });
    await prisma.financeTransaction.create({
      data: { userId: alice.id, accountId: account.id, date: DAY, amount: -450, category: "other" },
    });

    const feed = await feedFor(alice);
    const low = feed.filter((occurrence) => occurrence.kind === "low_balance");
    expect(low).toHaveLength(1);
    const weekStart = weekRange(aliceToday(), alice.weekStartsOn === 0 ? 0 : 1).start;
    expect(low[0].key).toBe(lowBalanceReminderKey(account.id, weekStart));
    expect(low[0].title).toContain("Checking");
    expect(low[0].message).toContain("$50");
    expect(low[0].message).toContain("$100");
  });

  it("stays silent with no threshold, above the threshold, or archived", async () => {
    await makeAccount(alice.id, { openingBalance: 5 }); // no threshold
    await makeAccount(alice.id, { name: "Healthy", openingBalance: 500, lowBalanceThreshold: 100 });
    await makeAccount(alice.id, {
      name: "Old",
      openingBalance: 0,
      lowBalanceThreshold: 100,
      archivedAt: new Date(),
    });

    const feed = await feedFor(alice);
    expect(feed.filter((occurrence) => occurrence.kind === "low_balance")).toHaveLength(0);
  });

  it("delivery dedups through the ledger — at most once per week", async () => {
    const account = await makeAccount(alice.id, {
      openingBalance: 10,
      lowBalanceThreshold: 100,
    });

    const first = await feedFor(alice);
    const occurrence = first.find((entry) => entry.kind === "low_balance");
    expect(occurrence).toBeDefined();
    if (!occurrence) return;

    await recordReminderDeliveryFor(alice.id, occurrence.key, null);
    const second = await feedFor(alice);
    expect(second.filter((entry) => entry.kind === "low_balance")).toHaveLength(0);

    // Recording the same key twice is harmless (unique collision swallowed).
    await recordReminderDeliveryFor(alice.id, occurrence.key, null);
    expect(
      await prisma.reminderDelivery.count({ where: { userId: alice.id, key: occurrence.key } }),
    ).toBe(1);
    void account;
  });

  it("is user-scoped: bob's feed never sees alice's low account", async () => {
    await makeAccount(alice.id, { openingBalance: 0, lowBalanceThreshold: 100 });
    const feed = await feedFor(bob);
    expect(feed.filter((entry) => entry.kind === "low_balance")).toHaveLength(0);
  });

  it("saveFinanceAccount round-trips the threshold, and clears it when blank", async () => {
    const created = await saveFinanceAccount({
      name: "Watched",
      type: "checking",
      currency: "usd",
      openingBalance: 50,
      lowBalanceThreshold: 100,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    let row = await prisma.financeAccount.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(row.lowBalanceThreshold).toBe(100);

    const cleared = await saveFinanceAccount({
      id: created.data.id,
      name: "Watched",
      type: "checking",
      currency: "USD",
      openingBalance: 50,
      lowBalanceThreshold: null,
    });
    expect(cleared.ok).toBe(true);
    row = await prisma.financeAccount.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(row.lowBalanceThreshold).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Search coverage
// ---------------------------------------------------------------------------

describe("search coverage for the new records", () => {
  it("finds budgets by category, scoped to the caller", async () => {
    await saveBudget({ category: "dining", amount: 200 });
    actAs(bob);
    await saveBudget({ category: "dining", amount: 999 });

    actAs(alice);
    const rows = await searchEverything("din");
    expect(rows.budgets).toHaveLength(1);
    expect(rows.budgets[0].amount).toBe(200);
  });

  it("finds transfer legs by their payee text", async () => {
    const a = await makeAccount(alice.id);
    const b = await makeAccount(alice.id, { name: "Holiday fund" });
    await transferBetweenAccounts({ fromAccountId: a.id, toAccountId: b.id, amount: 25, date: DAY });

    const rows = await searchEverything("Holiday");
    expect(rows.transactions.some((row) => row.payee === "Transfer to Holiday fund")).toBe(true);
  });
});
