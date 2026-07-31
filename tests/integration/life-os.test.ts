/**
 * Life-admin modules (finance, tasks & projects, inbox) against real
 * PostgreSQL: cross-user denial in the same shape as cross-user.test.ts,
 * the money/recurrence behaviour the actions promise, and the read models
 * the dashboard command center is built from.
 *
 * Dates: anything that depends on "today" is derived from the user's own
 * timezone via todayIn — never a hardcoded calendar date. Fixture dates that
 * only need to be *a* day (cross-user rows) use a fixed constant.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { shiftDay } from "@/lib/date";
import { todayIn } from "@/lib/logic/schedule";
import { actAs, resetDatabase, twoUsers } from "./helpers";

import {
  adjustSavingsGoal,
  deleteBill,
  deleteFinanceAccount,
  deleteTransaction,
  markBillPaid,
  saveBill,
  saveFinanceAccount,
  saveTransaction,
  setAccountBalance,
} from "@/server/actions/finance";
import {
  completeTask,
  deleteProject,
  deleteTask,
  reopenTask,
  saveTask,
} from "@/server/actions/tasks";
import { deleteInboxItem, setInboxItemStatus } from "@/server/actions/inbox";
import { getCommandCenterSummary } from "@/server/command-center";
import { getFinanceSummary } from "@/server/finance";
import { getInboxSummary } from "@/server/inbox";
import { getTaskSummary } from "@/server/tasks";
import { searchEverything } from "@/server/queries";

import type { User } from "./helpers";

let alice: User;
let bob: User;

/** A fixed day for rows whose date never meets "today". */
const DAY = "2026-07-15";

const aliceToday = () => todayIn(alice.timezone);

// --- tiny fixture builders (prisma-direct, no action layer) ------------------

function makeAccount(userId: string, overrides: Record<string, unknown> = {}) {
  return prisma.financeAccount.create({
    data: { userId, name: "Checking", ...overrides },
  });
}

function makeBill(userId: string, overrides: Record<string, unknown> = {}) {
  return prisma.bill.create({
    data: {
      userId,
      name: "Rent",
      amount: 100,
      anchorDate: DAY,
      nextDueDate: DAY,
      ...overrides,
    },
  });
}

function makeTask(userId: string, overrides: Record<string, unknown> = {}) {
  return prisma.task.create({
    data: { userId, title: "A task", ...overrides },
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
// Cross-user denial
// ---------------------------------------------------------------------------

describe("unauthenticated requests", () => {
  it("finance actions redirect to sign-in instead of running", async () => {
    actAs(null);
    await expect(deleteTransaction("anything")).rejects.toThrowError(/NEXT_REDIRECT/);
  });

  it("task actions redirect to sign-in instead of running", async () => {
    actAs(null);
    await expect(completeTask("anything")).rejects.toThrowError(/NEXT_REDIRECT/);
  });

  it("inbox actions redirect to sign-in instead of running", async () => {
    actAs(null);
    await expect(deleteInboxItem("anything")).rejects.toThrowError(/NEXT_REDIRECT/);
  });

  it("the command center summary redirects to sign-in instead of running", async () => {
    actAs(null);
    await expect(getCommandCenterSummary()).rejects.toThrowError(/NEXT_REDIRECT/);
  });
});

describe("finance cross-user isolation", () => {
  it("editing another user's account is refused and changes nothing", async () => {
    const account = await makeAccount(bob.id, { name: "Bob's account", openingBalance: 500 });

    const result = await saveFinanceAccount({ id: account.id, name: "Stolen" });
    expect(result.ok).toBe(false);

    const after = await prisma.financeAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(after.name).toBe("Bob's account");
    expect(after.userId).toBe(bob.id);
  });

  it("a transaction aimed at another user's account is refused and writes nothing", async () => {
    const account = await makeAccount(bob.id);

    const result = await saveTransaction({
      accountId: account.id,
      date: DAY,
      amount: -25,
      category: "food",
    });
    expect(result.ok).toBe(false);
    expect(await prisma.financeTransaction.count()).toBe(0);
  });

  it("a transaction attaching another user's bill is refused and writes nothing", async () => {
    const aliceAccount = await makeAccount(alice.id);
    const bobBill = await makeBill(bob.id);

    const result = await saveTransaction({
      accountId: aliceAccount.id,
      billId: bobBill.id,
      date: DAY,
      amount: -25,
      category: "utilities",
    });
    expect(result.ok).toBe(false);
    expect(await prisma.financeTransaction.count()).toBe(0);
  });

  it("paying another user's bill is refused: bill unchanged, no ledger entry", async () => {
    const bill = await makeBill(bob.id, { recurrence: "monthly" });

    const result = await markBillPaid({ billId: bill.id, date: DAY });
    expect(result.ok).toBe(false);

    const after = await prisma.bill.findUniqueOrThrow({ where: { id: bill.id } });
    expect(after.nextDueDate).toBe(DAY);
    expect(after.lastPaidDate).toBeNull();
    expect(await prisma.financeTransaction.count()).toBe(0);
  });

  it("adjusting another user's savings goal is refused", async () => {
    const goal = await prisma.savingsGoal.create({
      data: { userId: bob.id, name: "Bob's fund", targetAmount: 1000, currentAmount: 200 },
    });

    const result = await adjustSavingsGoal({ id: goal.id, amount: 50 });
    expect(result.ok).toBe(false);

    const after = await prisma.savingsGoal.findUniqueOrThrow({ where: { id: goal.id } });
    expect(after.currentAmount).toBe(200);
  });

  it("scoped finance deletes are no-ops on another user's rows", async () => {
    const account = await makeAccount(bob.id);
    const transaction = await prisma.financeTransaction.create({
      data: { userId: bob.id, accountId: account.id, date: DAY, amount: -10 },
    });
    const bill = await makeBill(bob.id);

    expect((await deleteTransaction(transaction.id)).ok).toBe(true); // idempotent no-op
    expect((await deleteBill(bill.id)).ok).toBe(true);
    expect((await deleteFinanceAccount(account.id)).ok).toBe(true);

    expect(await prisma.financeTransaction.findUnique({ where: { id: transaction.id } })).not.toBeNull();
    expect(await prisma.bill.findUnique({ where: { id: bill.id } })).not.toBeNull();
    expect(await prisma.financeAccount.findUnique({ where: { id: account.id } })).not.toBeNull();
  });
});

describe("tasks cross-user isolation", () => {
  it("a task aimed at another user's project is refused", async () => {
    const project = await prisma.project.create({ data: { userId: bob.id, name: "Bob's project" } });

    const result = await saveTask({ title: "Sneaky", projectId: project.id });
    expect(result.ok).toBe(false);
    expect(await prisma.task.count()).toBe(0);
  });

  it("a subtask under another user's task is refused", async () => {
    const parent = await makeTask(bob.id, { title: "Bob's task" });

    const result = await saveTask({ title: "Sneaky subtask", parentId: parent.id });
    expect(result.ok).toBe(false);
    expect(await prisma.task.count()).toBe(1);
  });

  it("completing another user's task is refused and leaves it open", async () => {
    const task = await makeTask(bob.id, { title: "Bob's task" });

    const result = await completeTask(task.id);
    expect(result.ok).toBe(false);

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.status).toBe("open");
    expect(after.completedAt).toBeNull();
  });

  it("scoped task deletes are no-ops on another user's rows", async () => {
    const task = await makeTask(bob.id);

    expect((await deleteTask(task.id)).ok).toBe(true); // idempotent no-op
    expect(await prisma.task.findUnique({ where: { id: task.id } })).not.toBeNull();
  });
});

describe("inbox cross-user isolation", () => {
  it("changing the status of another user's item is refused", async () => {
    const item = await prisma.inboxItem.create({ data: { userId: bob.id, title: "Bob's note" } });

    const result = await setInboxItemStatus(item.id, "done");
    expect(result.ok).toBe(false);

    const after = await prisma.inboxItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.status).toBe("open");
    expect(after.completedAt).toBeNull();
  });

  it("scoped inbox deletes are no-ops on another user's rows", async () => {
    const item = await prisma.inboxItem.create({ data: { userId: bob.id, title: "Bob's note" } });

    expect((await deleteInboxItem(item.id)).ok).toBe(true); // idempotent no-op
    expect(await prisma.inboxItem.findUnique({ where: { id: item.id } })).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Behaviour: bills, balances, task recurrence
// ---------------------------------------------------------------------------

describe("bills", () => {
  it("creating a bill anchors the recurrence on its due date", async () => {
    const result = await saveBill({ name: "Gym", amount: 30, dueDate: "2026-03-15" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const bill = await prisma.bill.findUniqueOrThrow({ where: { id: result.data.id } });
    expect(bill.anchorDate).toBe("2026-03-15");
    expect(bill.nextDueDate).toBe("2026-03-15");
  });

  it("paying a monthly bill anchored on the 31st clamps to short months without drifting", async () => {
    const account = await makeAccount(alice.id);
    const bill = await makeBill(alice.id, {
      amount: 89.5,
      category: "utilities",
      recurrence: "monthly",
      accountId: account.id,
      anchorDate: "2026-01-31",
      nextDueDate: "2026-01-31",
    });

    const first = await markBillPaid({ billId: bill.id, date: "2026-01-31" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // February has no 31st — the occurrence clamps to the 28th…
    expect(first.data.nextDueDate).toBe("2026-02-28");
    expect(first.data.settled).toBe(false);
    expect(first.data.transactionRecorded).toBe(true);

    // …and the ledger got the payment: negative amount, linked to the bill,
    // carrying the bill's category.
    const payment = await prisma.financeTransaction.findFirstOrThrow({
      where: { billId: bill.id },
    });
    expect(payment.userId).toBe(alice.id);
    expect(payment.accountId).toBe(account.id);
    expect(payment.amount).toBe(-89.5);
    expect(payment.category).toBe("utilities");
    expect(payment.date).toBe("2026-01-31");

    // Paying again generates from the ANCHOR, so March returns to the 31st —
    // a clamped February never becomes the new day-of-month.
    const second = await markBillPaid({ billId: bill.id, date: "2026-02-28" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.nextDueDate).toBe("2026-03-31");

    const after = await prisma.bill.findUniqueOrThrow({ where: { id: bill.id } });
    expect(after.nextDueDate).toBe("2026-03-31");
    expect(after.lastPaidDate).toBe("2026-02-28");
  });

  it("recordTransaction:false advances the bill without touching the ledger", async () => {
    const account = await makeAccount(alice.id);
    const bill = await makeBill(alice.id, { recurrence: "monthly", accountId: account.id });

    const result = await markBillPaid({ billId: bill.id, date: DAY, recordTransaction: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.transactionRecorded).toBe(false);
    expect(await prisma.financeTransaction.count()).toBe(0);
  });

  it("a one-time bill settles on payment and refuses a second payment", async () => {
    const bill = await makeBill(alice.id, { recurrence: "once" });

    const result = await markBillPaid({ billId: bill.id, date: DAY });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.settled).toBe(true);
    expect(result.data.nextDueDate).toBeNull();

    const after = await prisma.bill.findUniqueOrThrow({ where: { id: bill.id } });
    expect(after.settledAt).not.toBeNull();

    const again = await markBillPaid({ billId: bill.id, date: DAY });
    expect(again.ok).toBe(false);
  });
});

describe("setAccountBalance", () => {
  it("records the difference as an adjustment so the ledger stays the source of truth", async () => {
    const account = await makeAccount(alice.id, { openingBalance: 100 });
    await prisma.financeTransaction.create({
      data: { userId: alice.id, accountId: account.id, date: DAY, amount: 50, category: "income" },
    });

    const result = await setAccountBalance({ accountId: account.id, balance: 220.75, date: DAY });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.adjustment).toBe(70.75);

    // openingBalance + sum(transactions) now equals exactly what was asked for.
    const total = await prisma.financeTransaction.aggregate({
      where: { accountId: account.id },
      _sum: { amount: true },
    });
    expect(account.openingBalance + (total._sum.amount ?? 0)).toBeCloseTo(220.75, 2);

    const adjustment = await prisma.financeTransaction.findFirstOrThrow({
      where: { accountId: account.id, category: "adjustment" },
    });
    expect(adjustment.amount).toBe(70.75);

    // Asking for the same balance again records nothing.
    const second = await setAccountBalance({ accountId: account.id, balance: 220.75, date: DAY });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.adjustment).toBe(0);
    expect(await prisma.financeTransaction.count({ where: { accountId: account.id } })).toBe(2);
  });
});

describe("task lifecycle and recurrence", () => {
  it("completing a non-repeating task closes it with a completion stamp", async () => {
    const task = await makeTask(alice.id, { dueDate: DAY });

    const result = await completeTask(task.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("completed");
    expect(result.data.nextDue).toBeNull();

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.status).toBe("done");
    expect(after.completedAt).not.toBeNull();
  });

  it("completing an overdue weekly task keeps it open and moves the due date strictly past today", async () => {
    const today = aliceToday();
    const overdue = shiftDay(today, -10);
    const task = await makeTask(alice.id, {
      dueDate: overdue,
      repeat: "weekly",
      repeatEvery: 1,
      repeatAnchor: overdue,
    });

    const result = await completeTask(task.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("advanced");

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.status).toBe("open"); // the repeat IS the task
    expect(after.completedAt).toBeNull();
    // One next occurrence in the future — never a march through missed weeks.
    expect(after.dueDate! > today).toBe(true);
    expect(after.dueDate).toBe(result.data.nextDue);
  });

  it("reopenTask restores a closed task", async () => {
    const task = await makeTask(alice.id);
    await completeTask(task.id);

    const result = await reopenTask(task.id);
    expect(result.ok).toBe(true);

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.status).toBe("open");
    expect(after.completedAt).toBeNull();
  });

  it("a subtask cannot become a parent — nesting stops at one level", async () => {
    const parent = await makeTask(alice.id, { title: "Parent" });
    const subtask = await makeTask(alice.id, { title: "Subtask", parentId: parent.id });

    const result = await saveTask({ title: "Too deep", parentId: subtask.id });
    expect(result.ok).toBe(false);
    expect(await prisma.task.count()).toBe(2);
  });

  it("deleting a project leaves its tasks standing as standalone", async () => {
    const project = await prisma.project.create({ data: { userId: alice.id, name: "Move house" } });
    const task = await makeTask(alice.id, { title: "Pack boxes", projectId: project.id });

    const result = await deleteProject(project.id);
    expect(result.ok).toBe(true);

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.projectId).toBeNull();
  });

  it("deleting an account takes its ledger with it; bills merely lose the default account", async () => {
    const account = await makeAccount(alice.id);
    const transaction = await prisma.financeTransaction.create({
      data: { userId: alice.id, accountId: account.id, date: DAY, amount: -10 },
    });
    const bill = await makeBill(alice.id, { accountId: account.id });

    const result = await deleteFinanceAccount(account.id);
    expect(result.ok).toBe(true);

    expect(await prisma.financeTransaction.findUnique({ where: { id: transaction.id } })).toBeNull();
    const billAfter = await prisma.bill.findUniqueOrThrow({ where: { id: bill.id } });
    expect(billAfter.accountId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

describe("command center summary", () => {
  it("reflects only the caller's data, with correct counts, urgency order and per-currency nets", async () => {
    const today = aliceToday();

    // Alice: three open top-level tasks (one overdue, one due today, one
    // later) plus a subtask that must not inflate the open count.
    const overdueTask = await makeTask(alice.id, { title: "Overdue", dueDate: shiftDay(today, -2) });
    await makeTask(alice.id, { title: "Due today", dueDate: today });
    await makeTask(alice.id, { title: "Later", dueDate: shiftDay(today, 3) });
    await makeTask(alice.id, { title: "Subtask", parentId: overdueTask.id });

    // Alice: bills — one overdue, one due soon, one outside the 14-day window.
    await makeBill(alice.id, { name: "Rent", amount: 1200, nextDueDate: shiftDay(today, -1), anchorDate: shiftDay(today, -1) });
    await makeBill(alice.id, { name: "Internet", amount: 60, nextDueDate: shiftDay(today, 5), anchorDate: shiftDay(today, 5) });
    await makeBill(alice.id, { name: "Insurance", amount: 300, nextDueDate: shiftDay(today, 30), anchorDate: shiftDay(today, 30) });

    // Alice: two USD accounts and one EUR account. Balances derive from
    // openingBalance + transactions; currencies are never summed together.
    const main = await makeAccount(alice.id, { name: "Main", openingBalance: 100 });
    await makeAccount(alice.id, { name: "Cash", openingBalance: 50 });
    await makeAccount(alice.id, { name: "Euro", openingBalance: 20, currency: "EUR" });
    await prisma.financeTransaction.create({
      data: { userId: alice.id, accountId: main.id, date: today, amount: 25.5, category: "income" },
    });
    await prisma.financeTransaction.create({
      data: { userId: alice.id, accountId: main.id, date: today, amount: -10, category: "food" },
    });

    // Alice: two open inbox items, one resolved.
    await prisma.inboxItem.create({ data: { userId: alice.id, title: "Renew passport" } });
    await prisma.inboxItem.create({ data: { userId: alice.id, title: "Call plumber" } });
    await prisma.inboxItem.create({ data: { userId: alice.id, title: "Done thing", status: "done" } });

    // Bob: noise in every module that must not leak into alice's summary.
    await makeTask(bob.id, { title: "Bob overdue", dueDate: shiftDay(today, -5) });
    await makeBill(bob.id, { name: "Bob's rent", nextDueDate: shiftDay(today, 1), anchorDate: shiftDay(today, 1) });
    const bobAccount = await makeAccount(bob.id, { name: "Bob's account", openingBalance: 999 });
    await prisma.financeTransaction.create({
      data: { userId: bob.id, accountId: bobAccount.id, date: today, amount: 500, category: "income" },
    });
    await prisma.inboxItem.create({ data: { userId: bob.id, title: "Bob's note" } });

    const summary = await getCommandCenterSummary();

    // Tasks: subtasks don't count, buckets derive from alice's today.
    expect(summary.tasks.openCount).toBe(3);
    expect(summary.tasks.overdueCount).toBe(1);
    expect(summary.tasks.dueTodayCount).toBe(1);

    // Bills: only the two inside the window, most urgent first.
    expect(summary.finance.billsDueSoon.map((bill) => bill.name)).toEqual(["Rent", "Internet"]);
    expect(summary.finance.billsDueSoonCount).toBe(2);
    expect(summary.finance.billsOverdueCount).toBe(1);

    // Net per currency: USD = 100 + 25.5 − 10 + 50; EUR untouched — and
    // bob's 1499 never appears anywhere.
    const usd = summary.finance.net.find((entry) => entry.currency === "USD");
    const eur = summary.finance.net.find((entry) => entry.currency === "EUR");
    expect(usd).toMatchObject({ net: 165.5, accounts: 2 });
    expect(eur).toMatchObject({ net: 20, accounts: 1 });
    expect(summary.finance.net[0]?.currency).toBe("USD");

    // Month card: income and spending from this month's transactions
    // (both dated today, so the month window always contains them).
    expect(summary.finance.month.income).toBe(25.5);
    expect(summary.finance.month.spending).toBe(10);

    // Inbox: open queue only.
    expect(summary.inbox.openCount).toBe(2);
  });
});

describe("summary lists are bounded", () => {
  it("top tasks ≤ 5, bills due soon ≤ 3, inbox titles ≤ 3", async () => {
    const today = aliceToday();

    for (let index = 0; index < 7; index += 1) {
      await makeTask(alice.id, { title: `Task ${index}`, dueDate: today });
    }
    for (let index = 0; index < 5; index += 1) {
      const due = shiftDay(today, index + 1);
      await makeBill(alice.id, { name: `Bill ${index}`, nextDueDate: due, anchorDate: due });
    }
    for (let index = 0; index < 5; index += 1) {
      await prisma.inboxItem.create({ data: { userId: alice.id, title: `Note ${index}` } });
    }

    const [tasks, finance, inbox] = await Promise.all([
      getTaskSummary(),
      getFinanceSummary(),
      getInboxSummary(),
    ]);

    expect(tasks.openCount).toBe(7);
    expect(tasks.top).toHaveLength(5);

    expect(finance.billsDueSoonCount).toBe(5);
    expect(finance.billsDueSoon).toHaveLength(3);

    expect(inbox.openCount).toBe(5);
    expect(inbox.latest).toHaveLength(3);
  });
});

describe("search", () => {
  it("life-admin search results never span users", async () => {
    const SECRET = "ZQBOBSECRET";

    // Bob salts every new module with the secret…
    await prisma.project.create({ data: { userId: bob.id, name: `${SECRET} plan` } });
    await makeTask(bob.id, { title: `${SECRET} task` });
    const account = await makeAccount(bob.id, { name: `${SECRET} bank` });
    await prisma.financeTransaction.create({
      data: {
        userId: bob.id,
        accountId: account.id,
        date: DAY,
        amount: -12,
        payee: `${SECRET} store`,
      },
    });
    await makeBill(bob.id, { name: `${SECRET} rent` });
    await prisma.savingsGoal.create({
      data: { userId: bob.id, name: `${SECRET} fund`, targetAmount: 100 },
    });
    await prisma.inboxItem.create({ data: { userId: bob.id, title: `${SECRET} note` } });

    // …and can find his own rows,
    actAs(bob);
    const bobRows = await searchEverything(SECRET);
    expect(JSON.stringify(bobRows)).toContain(SECRET);

    // …but no array on alice's result — whatever arrays the result carries —
    // may contain a row mentioning the secret.
    actAs(alice);
    const rows = await searchEverything(SECRET);
    for (const [group, value] of Object.entries(rows)) {
      if (!Array.isArray(value)) continue;
      expect(JSON.stringify(value), `search group "${group}" leaked another user's row`).not.toContain(
        SECRET,
      );
    }
  });
});
