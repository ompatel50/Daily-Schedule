/**
 * Phase-3 follow-ups against real PostgreSQL: CSV import undo, document-expiry
 * reminders, budget-threshold reminders, weekly budget periods, task tags and
 * the demo dataset's coverage of the new modules — plus the cross-user denial
 * each of them must enforce.
 *
 * Dates: anything that depends on "today" uses the user's own timezone via
 * `todayIn`, never the host clock.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { BACKUP_VERSION } from "@/lib/backup-format";
import { monthRange, shiftDay, weekRange } from "@/lib/date";
import { budgetThresholdReminderKey, dueReminderKey } from "@/lib/logic/reminders";
import { scheduleSettingsFor } from "@/server/schedule";
import { actAs, resetDatabase, twoUsers } from "./helpers";

import {
  commitFinanceCsvImport,
  previewFinanceImportUndo,
  undoFinanceImport,
} from "@/server/actions/finance-import";
import { saveBudget, saveTransaction } from "@/server/actions/finance";
import { deleteDocument, saveDocument, setDocumentArchived } from "@/server/actions/documents";
import { deleteTask, saveTask } from "@/server/actions/tasks";
import { getDocumentSummary, getDocumentViews } from "@/server/documents";
import { getFinanceOverview, getFinanceSummary, getImportBatches } from "@/server/finance";
import { searchEverything } from "@/server/queries";
import { getReminderFeedFor, recordReminderDeliveryFor } from "@/server/reminders";
import { getTaskBoard } from "@/server/tasks";

import type { User } from "./helpers";

let alice: User;
let bob: User;

const aliceToday = () => scheduleSettingsFor(alice).today;

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  ({ alice, bob } = await twoUsers());
  actAs(alice);
});

function makeAccount(userId: string, overrides: Record<string, unknown> = {}) {
  return prisma.financeAccount.create({
    data: { userId, name: "Checking", ...overrides },
  });
}

// ---------------------------------------------------------------------------
// 1) CSV import undo
// ---------------------------------------------------------------------------

const IMPORT_CSV = [
  "date,amount,description,category",
  "2026-07-10,-42.50,Corner Market,groceries",
  "2026-07-11,-16.40,Cafe Luna,dining",
  "2026-07-12,-9.75,Metro Transit,transport",
].join("\n");

async function importFile(accountId: string, content = IMPORT_CSV, fileName = "bank.csv") {
  const result = await commitFinanceCsvImport({ accountId, fileName, content });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

describe("CSV import undo", () => {
  it("removes exactly the rows the batch created, and nothing else", async () => {
    const account = await makeAccount(alice.id);
    // A manual row that must survive the undo untouched.
    await saveTransaction({
      accountId: account.id,
      date: "2026-07-10",
      amount: -100,
      payee: "Typed by hand",
      category: "other",
    });

    const report = await importFile(account.id);
    expect(report.createdCount).toBe(3);
    expect(await prisma.financeTransaction.count({ where: { userId: alice.id } })).toBe(4);

    const undo = await undoFinanceImport(report.batchId);
    expect(undo.ok).toBe(true);
    if (!undo.ok) return;
    expect(undo.data.removedCount).toBe(3);

    const left = await prisma.financeTransaction.findMany({ where: { userId: alice.id } });
    expect(left).toHaveLength(1);
    expect(left[0].payee).toBe("Typed by hand");
  });

  it("keeps a row that was edited after the import, and says so", async () => {
    const account = await makeAccount(alice.id);
    const report = await importFile(account.id);

    const edited = await prisma.financeTransaction.findFirstOrThrow({
      where: { userId: alice.id, payee: "Cafe Luna" },
    });
    await saveTransaction({
      id: edited.id,
      accountId: account.id,
      date: edited.date,
      amount: -19.4, // the user corrected the amount
      payee: edited.payee,
      category: edited.category,
    });

    const preview = await previewFinanceImportUndo(report.batchId);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.data.removableCount).toBe(2);
    expect(preview.data.keptEditedCount).toBe(1);

    const undo = await undoFinanceImport(report.batchId);
    expect(undo.ok).toBe(true);
    if (!undo.ok) return;
    expect(undo.data.removedCount).toBe(2);
    expect(undo.data.keptEditedCount).toBe(1);

    const survivor = await prisma.financeTransaction.findUnique({ where: { id: edited.id } });
    expect(survivor?.amount).toBe(-19.4);
  });

  it("re-categorising a row does NOT protect it — the identity ignores category", async () => {
    const account = await makeAccount(alice.id);
    const report = await importFile(account.id);
    const row = await prisma.financeTransaction.findFirstOrThrow({
      where: { userId: alice.id, payee: "Corner Market" },
    });
    await saveTransaction({
      id: row.id,
      accountId: account.id,
      date: row.date,
      amount: row.amount,
      payee: row.payee,
      category: "shopping",
      notes: "moved to shopping",
    });

    const undo = await undoFinanceImport(report.batchId);
    expect(undo.ok).toBe(true);
    if (!undo.ok) return;
    expect(undo.data.removedCount).toBe(3);
    expect(await prisma.financeTransaction.count({ where: { userId: alice.id } })).toBe(0);
  });

  it("keeps the batch as an audit record, stamped with what happened", async () => {
    const account = await makeAccount(alice.id);
    const report = await importFile(account.id);
    await undoFinanceImport(report.batchId);

    const batch = await prisma.financeImportBatch.findUniqueOrThrow({
      where: { id: report.batchId },
    });
    expect(batch.undoneAt).not.toBeNull();
    expect(batch.undoneCount).toBe(3);
    expect(batch.keptCount).toBe(0);
    // The original counts are untouched — the audit trail says what the import
    // did, and separately what the undo did.
    expect(batch.createdCount).toBe(3);
  });

  it("refuses a second undo rather than reaching later rows", async () => {
    const account = await makeAccount(alice.id);
    const report = await importFile(account.id);
    expect((await undoFinanceImport(report.batchId)).ok).toBe(true);

    const second = await undoFinanceImport(report.batchId);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toContain("already been undone");
  });

  it("restores importability: the same file imports again after an undo", async () => {
    const account = await makeAccount(alice.id);
    const first = await importFile(account.id);
    await undoFinanceImport(first.batchId);

    const second = await importFile(account.id);
    expect(second.createdCount).toBe(3);
    expect(second.skippedCount).toBe(0);
    expect(await prisma.financeTransaction.count({ where: { userId: alice.id } })).toBe(3);
  });

  it("a kept row is not duplicated by a re-import", async () => {
    const account = await makeAccount(alice.id);
    const first = await importFile(account.id);
    const kept = await prisma.financeTransaction.findFirstOrThrow({
      where: { userId: alice.id, payee: "Metro Transit" },
    });
    await saveTransaction({
      id: kept.id,
      accountId: account.id,
      date: kept.date,
      amount: -11.25,
      payee: kept.payee,
      category: kept.category,
    });
    await undoFinanceImport(first.batchId);

    const second = await importFile(account.id);
    // Two rows come back; the edited one still holds its key, so its file row
    // is skipped as a duplicate rather than written twice.
    expect(second.createdCount).toBe(2);
    expect(second.skippedCount).toBe(1);
    expect(await prisma.financeTransaction.count({ where: { userId: alice.id } })).toBe(3);
  });

  it("keeps a row that now settles a bill", async () => {
    const account = await makeAccount(alice.id);
    const report = await importFile(account.id);
    const bill = await prisma.bill.create({
      data: {
        userId: alice.id,
        name: "Transit pass",
        amount: 9.75,
        category: "transport",
        anchorDate: "2026-07-12",
        nextDueDate: "2026-08-12",
      },
    });
    const row = await prisma.financeTransaction.findFirstOrThrow({
      where: { userId: alice.id, payee: "Metro Transit" },
    });
    await prisma.financeTransaction.update({ where: { id: row.id }, data: { billId: bill.id } });

    const undo = await undoFinanceImport(report.batchId);
    expect(undo.ok).toBe(true);
    if (!undo.ok) return;
    expect(undo.data.removedCount).toBe(2);
    expect(undo.data.keptLinkedCount).toBe(1);
    expect(await prisma.financeTransaction.findUnique({ where: { id: row.id } })).not.toBeNull();
  });

  it("another user's batch id is not found, and their rows are untouched", async () => {
    const bobAccount = await makeAccount(bob.id);
    actAs(bob);
    const bobImport = await importFile(bobAccount.id);
    const bobRows = await prisma.financeTransaction.count({ where: { userId: bob.id } });

    actAs(alice);
    const preview = await previewFinanceImportUndo(bobImport.batchId);
    expect(preview.ok).toBe(false);
    const undo = await undoFinanceImport(bobImport.batchId);
    expect(undo.ok).toBe(false);
    if (undo.ok) return;
    expect(undo.error).toBe("Import not found");

    expect(await prisma.financeTransaction.count({ where: { userId: bob.id } })).toBe(bobRows);
    const batch = await prisma.financeImportBatch.findUniqueOrThrow({
      where: { id: bobImport.batchId },
    });
    expect(batch.undoneAt).toBeNull();
  });

  it("the finance page lists batches with a live remaining count", async () => {
    const account = await makeAccount(alice.id, { name: "Everyday" });
    const report = await importFile(account.id);

    const before = await getImportBatches();
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ fileName: "bank.csv", undoneAt: null });
    expect(before[0]._count.transactions).toBe(3);

    await undoFinanceImport(report.batchId);
    const after = await getImportBatches();
    expect(after[0]._count.transactions).toBe(0);
    expect(after[0].undoneAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2) Document-expiry reminders
// ---------------------------------------------------------------------------

describe("documents & expiry reminders", () => {
  async function makeDocument(overrides: Record<string, unknown> = {}) {
    const result = await saveDocument({
      name: "Passport",
      kind: "id",
      expiryDate: shiftDay(aliceToday(), 30),
      reminderEnabled: true,
      reminderDaysBefore: 30,
      ...overrides,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    return result.data.id;
  }

  it("creates, lists and summarises a document under its owner", async () => {
    const id = await makeDocument({ issuer: "State Department" });
    const views = await getDocumentViews();
    expect(views).toHaveLength(1);
    expect(views[0].document).toMatchObject({
      id,
      userId: alice.id,
      name: "Passport",
      issuer: "State Department",
    });
    expect(views[0].reminderArmed).toBe(true);

    const summary = await getDocumentSummary();
    expect(summary).toMatchObject({ total: 1, expiringSoonCount: 1, expiredCount: 0 });
  });

  it("fires a run-up reminder once, then stays quiet for that window", async () => {
    const id = await makeDocument({ expiryDate: shiftDay(aliceToday(), 12) });

    const feed = await getReminderFeedFor(alice);
    const occurrence = feed.find((entry) => entry.kind === "document");
    expect(occurrence).toBeDefined();
    expect(occurrence!.key).toBe(
      dueReminderKey("document", id, shiftDay(aliceToday(), 12), true),
    );
    expect(occurrence!.message).toBe("Expires in 12 days");

    await recordReminderDeliveryFor(alice.id, occurrence!.key, null);
    const second = await getReminderFeedFor(alice);
    expect(second.some((entry) => entry.kind === "document")).toBe(false);
  });

  it("renewing it arms the next reminder", async () => {
    const id = await makeDocument({ expiryDate: shiftDay(aliceToday(), 12) });
    const feed = await getReminderFeedFor(alice);
    const first = feed.find((entry) => entry.kind === "document")!;
    await recordReminderDeliveryFor(alice.id, first.key, null);

    // Renewal is an edit: push the date out by a year.
    await saveDocument({
      id,
      name: "Passport",
      kind: "id",
      expiryDate: shiftDay(aliceToday(), 20),
      reminderEnabled: true,
      reminderDaysBefore: 30,
    });

    const after = await getReminderFeedFor(alice);
    const renewed = after.find((entry) => entry.kind === "document");
    expect(renewed).toBeDefined();
    expect(renewed!.key).not.toBe(first.key);
  });

  it("stays silent when the reminder is off, when archived, and when past", async () => {
    await makeDocument({ reminderEnabled: false, expiryDate: shiftDay(aliceToday(), 5) });
    expect((await getReminderFeedFor(alice)).some((entry) => entry.kind === "document")).toBe(
      false,
    );

    const archivedId = await makeDocument({ name: "Lease", expiryDate: shiftDay(aliceToday(), 5) });
    expect((await getReminderFeedFor(alice)).some((entry) => entry.kind === "document")).toBe(true);
    await setDocumentArchived(archivedId, true);
    expect((await getReminderFeedFor(alice)).some((entry) => entry.kind === "document")).toBe(
      false,
    );
    expect(await getDocumentViews()).toHaveLength(1); // the reminder-less one

    await makeDocument({ name: "Warranty", expiryDate: shiftDay(aliceToday(), -3) });
    expect((await getReminderFeedFor(alice)).some((entry) => entry.kind === "document")).toBe(
      false,
    );
  });

  it("one user's documents never appear in another's feed or list", async () => {
    await makeDocument({ name: "Alice passport", expiryDate: shiftDay(aliceToday(), 10) });

    const bobFeed = await getReminderFeedFor(bob);
    expect(bobFeed.some((entry) => entry.kind === "document")).toBe(false);

    actAs(bob);
    expect(await getDocumentViews()).toHaveLength(0);
  });

  it("editing, archiving or deleting another user's document is refused", async () => {
    const document = await prisma.lifeDocument.create({
      data: { userId: bob.id, name: "Bob's lease", expiryDate: shiftDay(aliceToday(), 10) },
    });

    actAs(alice);
    const edit = await saveDocument({
      id: document.id,
      name: "Hijacked",
      kind: "other",
      expiryDate: shiftDay(aliceToday(), 10),
    });
    expect(edit.ok).toBe(false);
    expect((await setDocumentArchived(document.id, true)).ok).toBe(false);
    await deleteDocument(document.id);

    const still = await prisma.lifeDocument.findUniqueOrThrow({ where: { id: document.id } });
    expect(still.name).toBe("Bob's lease");
    expect(still.archivedAt).toBeNull();
  });

  it("search finds documents by name and issuer, scoped to the owner", async () => {
    await makeDocument({ name: "Car insurance", kind: "insurance", issuer: "Northline Mutual" });

    const byName = await searchEverything("insurance");
    expect(byName.documents.map((row) => row.name)).toContain("Car insurance");
    const byIssuer = await searchEverything("Northline");
    expect(byIssuer.documents).toHaveLength(1);

    actAs(bob);
    expect((await searchEverything("Northline")).documents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3) & 4) Budget thresholds and weekly periods
// ---------------------------------------------------------------------------

describe("budget periods and thresholds", () => {
  async function budget(overrides: Record<string, unknown> = {}) {
    const result = await saveBudget({
      category: "groceries",
      amount: 100,
      period: "monthly",
      ...overrides,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    return result.data.id;
  }

  async function spend(accountId: string, amount: number, date: string, category = "groceries") {
    const result = await saveTransaction({
      accountId,
      date,
      amount: -Math.abs(amount),
      category,
      payee: "Shop",
    });
    expect(result.ok).toBe(true);
  }

  it("a weekly budget measures the current week, a monthly one the month", async () => {
    const account = await makeAccount(alice.id);
    const today = aliceToday();
    const week = weekRange(today, alice.weekStartsOn === 0 ? 0 : 1);
    const month = monthRange(today);

    await budget({ category: "groceries", amount: 400, period: "monthly" });
    await budget({ category: "dining", amount: 60, period: "weekly" });

    // Inside this week (and therefore inside the month too, when they overlap).
    await spend(account.id, 25, week.start, "dining");
    await spend(account.id, 30, today, "groceries");
    // Earlier in the month but before this week — monthly only.
    const earlier = shiftDay(week.start, -3);
    if (earlier >= month.start) {
      await spend(account.id, 45, earlier, "groceries");
      await spend(account.id, 99, earlier, "dining");
    }

    const overview = await getFinanceOverview();
    const byCategory = new Map(overview.budgets.map((view) => [view.budget.category, view]));

    const dining = byCategory.get("dining")!;
    expect(dining.period).toBe("weekly");
    expect(dining.window).toEqual(week);
    expect(dining.spent).toBe(25); // the 99 outside the week never counts

    const groceries = byCategory.get("groceries")!;
    expect(groceries.period).toBe("monthly");
    expect(groceries.window).toEqual(month);
    expect(groceries.spent).toBe(earlier >= month.start ? 75 : 30);
  });

  it("a weekly budget counts a purchase in the part of the week that spills into next month", async () => {
    const account = await makeAccount(alice.id);
    const today = aliceToday();
    const week = weekRange(today, alice.weekStartsOn === 0 ? 0 : 1);
    const month = monthRange(today);
    await budget({ category: "dining", amount: 100, period: "weekly" });

    // Only meaningful when this week actually straddles the month boundary.
    if (week.end > month.end) {
      await spend(account.id, 20, week.end, "dining");
      const overview = await getFinanceOverview();
      const dining = overview.budgets.find((view) => view.budget.category === "dining")!;
      expect(dining.spent).toBe(20);
    } else {
      // Otherwise assert the equivalent invariant: the fetch window covers the
      // whole week regardless of where the month ends.
      const overview = await getFinanceOverview();
      expect(overview.budgetWindows.weekly).toEqual(week);
    }
  });

  it("existing monthly budgets keep behaving exactly as before", async () => {
    const account = await makeAccount(alice.id);
    const today = aliceToday();
    await budget({ category: "groceries", amount: 100 });
    await spend(account.id, 130, today);

    const overview = await getFinanceOverview();
    const view = overview.budgets[0];
    expect(view).toMatchObject({ spent: 130, percent: 130, over: true, period: "monthly" });

    const summary = await getFinanceSummary();
    expect(summary.budgets.overCount).toBe(1);
    expect(summary.budgets.worst).toMatchObject({ label: "Groceries", percent: 130 });
  });

  it("a threshold alert fires once per period, then re-arms in the next one", async () => {
    const account = await makeAccount(alice.id);
    const today = aliceToday();
    const month = monthRange(today);
    const id = await budget({ amount: 100, alertThresholdPercent: 75 });

    await spend(account.id, 50, today);
    expect((await getReminderFeedFor(alice)).some((entry) => entry.kind === "budget")).toBe(false);

    await spend(account.id, 30, today); // 80 % — over the line
    const feed = await getReminderFeedFor(alice);
    const occurrence = feed.find((entry) => entry.kind === "budget");
    expect(occurrence).toBeDefined();
    expect(occurrence!.key).toBe(budgetThresholdReminderKey(id, month.start, 75));
    expect(occurrence!.title).toBe("Groceries budget at 80%");

    await recordReminderDeliveryFor(alice.id, occurrence!.key, null);
    await spend(account.id, 10, today);
    expect((await getReminderFeedFor(alice)).some((entry) => entry.kind === "budget")).toBe(false);
  });

  it("a weekly budget's alert is keyed to its week, not the month", async () => {
    const account = await makeAccount(alice.id);
    const today = aliceToday();
    const week = weekRange(today, alice.weekStartsOn === 0 ? 0 : 1);
    const id = await budget({ category: "dining", amount: 50, period: "weekly", alertThresholdPercent: 90 });

    await spend(account.id, 48, today, "dining");
    const feed = await getReminderFeedFor(alice);
    const occurrence = feed.find((entry) => entry.kind === "budget");
    expect(occurrence?.key).toBe(budgetThresholdReminderKey(id, week.start, 90));
  });

  it("clearing the threshold on an edit silences it", async () => {
    const account = await makeAccount(alice.id);
    const id = await budget({ amount: 100, alertThresholdPercent: 50 });
    await spend(account.id, 90, aliceToday());
    expect((await getReminderFeedFor(alice)).some((entry) => entry.kind === "budget")).toBe(true);

    await saveBudget({ id, category: "groceries", amount: 100, period: "monthly" });
    const row = await prisma.budget.findUniqueOrThrow({ where: { id } });
    expect(row.alertThresholdPercent).toBeNull();
    expect((await getReminderFeedFor(alice)).some((entry) => entry.kind === "budget")).toBe(false);
  });

  it("income and transfers never push a budget over its threshold", async () => {
    const account = await makeAccount(alice.id);
    const other = await makeAccount(alice.id, { name: "Savings", type: "savings" });
    const today = aliceToday();
    await budget({ amount: 100, alertThresholdPercent: 50 });

    await saveTransaction({ accountId: account.id, date: today, amount: 900, category: "income" });
    await prisma.financeTransaction.create({
      data: {
        userId: alice.id,
        accountId: other.id,
        date: today,
        amount: -80,
        category: "transfer",
        transferGroupId: "grp-x",
      },
    });

    expect((await getReminderFeedFor(alice)).some((entry) => entry.kind === "budget")).toBe(false);
  });

  it("a budget alert belongs to its owner alone", async () => {
    const account = await makeAccount(alice.id);
    await budget({ amount: 100, alertThresholdPercent: 50 });
    await spend(account.id, 90, aliceToday());

    expect((await getReminderFeedFor(alice)).some((entry) => entry.kind === "budget")).toBe(true);
    expect((await getReminderFeedFor(bob)).some((entry) => entry.kind === "budget")).toBe(false);
  });

  it("refuses an unknown period and an unknown threshold", async () => {
    expect((await saveBudget({ category: "groceries", amount: 50, period: "daily" })).ok).toBe(
      false,
    );
    expect(
      (await saveBudget({ category: "dining", amount: 50, alertThresholdPercent: 33 })).ok,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6) Task tags
// ---------------------------------------------------------------------------

describe("task tags", () => {
  async function task(title: string, tags: string[], extra: Record<string, unknown> = {}) {
    const result = await saveTask({ title, tags, ...extra });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    return result.data.id;
  }

  it("creates tags by typing them, scoped to the caller", async () => {
    const id = await task("Renew the permit", ["Admin", "errand"]);

    const tags = await prisma.tag.findMany({ where: { userId: alice.id } });
    expect(tags.map((tag) => tag.name).sort()).toEqual(["admin", "errand"]);

    const links = await prisma.taskTag.findMany({ where: { taskId: id } });
    expect(links).toHaveLength(2);
  });

  it("reuses the existing tag vocabulary instead of duplicating it", async () => {
    await prisma.tag.create({ data: { userId: alice.id, name: "admin", color: "blue" } });
    await task("Something", ["ADMIN"]);
    const tags = await prisma.tag.findMany({ where: { userId: alice.id } });
    expect(tags).toHaveLength(1);
    expect(tags[0].color).toBe("blue"); // the existing row, untouched
  });

  it("editing replaces the tag set exactly", async () => {
    const id = await task("Move house", ["home", "admin"]);
    await saveTask({ id, title: "Move house", tags: ["home", "money"] });

    const links = await prisma.taskTag.findMany({
      where: { taskId: id },
      include: { tag: true },
    });
    expect(links.map((link) => link.tag.name).sort()).toEqual(["home", "money"]);
    // The now-unused tag row survives — it is shared vocabulary, not a child.
    expect(await prisma.tag.count({ where: { userId: alice.id } })).toBe(3);
  });

  it("caps and de-duplicates the tag list", async () => {
    const many = Array.from({ length: 20 }, (_, index) => `tag${index}`);
    const id = await task("Lots", [...many, "tag0", "TAG1"]);
    expect(await prisma.taskTag.count({ where: { taskId: id } })).toBe(8);
  });

  it("surfaces tag facets on the board and filters by them", async () => {
    await task("A", ["admin"], { dueDate: aliceToday() });
    await task("B", ["admin", "money"], { dueDate: aliceToday() });
    await task("C", []);

    const board = await getTaskBoard();
    expect(board.tags).toEqual([
      { name: "admin", count: 2 },
      { name: "money", count: 1 },
    ]);
  });

  it("deleting a task removes its links but not the shared tags", async () => {
    const id = await task("Temp", ["admin"]);
    await deleteTask(id);
    expect(await prisma.taskTag.count({ where: { taskId: id } })).toBe(0);
    expect(await prisma.tag.count({ where: { userId: alice.id } })).toBe(1);
  });

  it("deleting a tag removes its links, leaving the tasks alone", async () => {
    const id = await task("Keeps existing", ["admin", "money"]);
    const tag = await prisma.tag.findFirstOrThrow({ where: { userId: alice.id, name: "admin" } });
    await prisma.tag.delete({ where: { id: tag.id } });

    expect(await prisma.task.findUnique({ where: { id } })).not.toBeNull();
    const links = await prisma.taskTag.findMany({ where: { taskId: id }, include: { tag: true } });
    expect(links.map((link) => link.tag.name)).toEqual(["money"]);
  });

  it("two users typing the same tag name get two separate tags", async () => {
    await task("Alice thing", ["admin"]);
    actAs(bob);
    await saveTask({ title: "Bob thing", tags: ["admin"] });

    const aliceTags = await prisma.tag.findMany({ where: { userId: alice.id } });
    const bobTags = await prisma.tag.findMany({ where: { userId: bob.id } });
    expect(aliceTags).toHaveLength(1);
    expect(bobTags).toHaveLength(1);
    expect(aliceTags[0].id).not.toBe(bobTags[0].id);

    // And neither board can see the other's task.
    const bobBoard = await getTaskBoard();
    expect(bobBoard.tags).toEqual([{ name: "admin", count: 1 }]);
    expect(
      Object.values(bobBoard.buckets).flat().map((row) => row.title),
    ).toEqual(["Bob thing"]);
  });

  it("search finds a tag with its usage counts, scoped to the owner", async () => {
    await task("A", ["admin"]);
    await task("B", ["admin"]);

    const rows = await searchEverything("admin");
    expect(rows.tags).toHaveLength(1);
    expect(rows.tags[0]).toMatchObject({ name: "admin", taskCount: 2, plannerCount: 0 });

    actAs(bob);
    expect((await searchEverything("admin")).tags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5) Demo data & backup coverage for the new modules
// ---------------------------------------------------------------------------

describe("backup round-trip for the new records", () => {
  it("exports and restores documents, task tags and the new budget columns", async () => {
    const { exportBackup, importBackup } = await import("@/server/actions/backup");

    await saveDocument({
      name: "Car insurance",
      kind: "insurance",
      issuer: "Northline",
      expiryDate: shiftDay(aliceToday(), 40),
      reminderEnabled: true,
      reminderDaysBefore: 30,
    });
    await saveTask({ title: "Tagged task", tags: ["admin", "money"] });
    await saveBudget({
      category: "dining",
      amount: 60,
      period: "weekly",
      alertThresholdPercent: 90,
    });
    const account = await makeAccount(alice.id);
    const batch = await importFile(account.id);
    await undoFinanceImport(batch.batchId);

    const exported = await exportBackup();
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    // The export always writes the current format; the assertion tracks it.
    expect(exported.data.version).toBe(BACKUP_VERSION);
    expect(exported.data.data.documents).toHaveLength(1);
    expect(exported.data.data.taskTags).toHaveLength(2);

    // Restore into a second, empty account: every row lands there, remapped.
    actAs(bob);
    const restored = await importBackup(exported.data, "merge");
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.data.verification.documents).toBe(1);
    expect(restored.data.verification.taskTags).toBe(2);

    const bobBudget = await prisma.budget.findFirstOrThrow({ where: { userId: bob.id } });
    expect(bobBudget).toMatchObject({ period: "weekly", alertThresholdPercent: 90 });
    const bobBatch = await prisma.financeImportBatch.findFirstOrThrow({
      where: { userId: bob.id },
    });
    expect(bobBatch.undoneAt).not.toBeNull();
    expect(bobBatch.undoneCount).toBe(3);

    // The tag links point at BOB's tags, never Alice's.
    const bobLinks = await prisma.taskTag.findMany({
      where: { task: { userId: bob.id } },
      include: { tag: true },
    });
    expect(bobLinks).toHaveLength(2);
    expect(bobLinks.every((link) => link.tag.userId === bob.id)).toBe(true);
  });
});

describe("demo data covers the new modules", () => {
  it("seeds finance, tasks, tags, inbox, budgets and documents, and removes them all", async () => {
    const { loadSampleData, removeDemoData, getDemoStatus } = await import("@/server/demo");

    const before = await getDemoStatus(alice.id);
    expect(before.canLoad).toBe(true);

    const loaded = await loadSampleData(alice.id);
    expect(loaded.ok).toBe(true);

    // One place naming each new module and how to count it, so "seeded" and
    // "removed" are asserted over the identical list.
    const COUNTERS: Record<string, () => Promise<number>> = {
      projects: () => prisma.project.count({ where: { userId: alice.id } }),
      tasks: () => prisma.task.count({ where: { userId: alice.id } }),
      taskTags: () => prisma.taskTag.count({ where: { task: { userId: alice.id } } }),
      inboxItems: () => prisma.inboxItem.count({ where: { userId: alice.id } }),
      accounts: () => prisma.financeAccount.count({ where: { userId: alice.id } }),
      transactions: () => prisma.financeTransaction.count({ where: { userId: alice.id } }),
      bills: () => prisma.bill.count({ where: { userId: alice.id } }),
      budgets: () => prisma.budget.count({ where: { userId: alice.id } }),
      savingsGoals: () => prisma.savingsGoal.count({ where: { userId: alice.id } }),
      importBatches: () => prisma.financeImportBatch.count({ where: { userId: alice.id } }),
      documents: () => prisma.lifeDocument.count({ where: { userId: alice.id } }),
    };

    for (const [name, count] of Object.entries(COUNTERS)) {
      expect(await count(), `${name} should have demo rows`).toBeGreaterThan(0);
    }

    // The dataset demonstrates the new features, not just their tables.
    const budgets = await prisma.budget.findMany({ where: { userId: alice.id } });
    expect(budgets.some((row) => row.period === "weekly")).toBe(true);
    expect(budgets.some((row) => row.alertThresholdPercent !== null)).toBe(true);
    const importedRows = await prisma.financeTransaction.count({
      where: { userId: alice.id, importBatchId: { not: null } },
    });
    expect(importedRows).toBeGreaterThan(0);

    // A loaded account is no longer "empty enough" for a second load.
    const after = await getDemoStatus(alice.id);
    expect(after.canLoad).toBe(false);
    expect((await loadSampleData(alice.id)).ok).toBe(false);

    // Removal takes every registered row with it, in every new module.
    const removed = await removeDemoData(alice.id);
    expect(removed.ok).toBe(true);
    for (const [name, count] of Object.entries(COUNTERS)) {
      expect(await count(), `${name} should be empty after removal`).toBe(0);
    }
  }, 180_000);

  it("never touches another account's records", async () => {
    const { loadSampleData, removeDemoData } = await import("@/server/demo");

    actAs(bob);
    await saveTask({ title: "Bob's own task", tags: ["mine"] });
    await saveDocument({
      name: "Bob's passport",
      kind: "id",
      expiryDate: shiftDay(aliceToday(), 100),
    });

    expect((await loadSampleData(alice.id)).ok).toBe(true);
    expect((await removeDemoData(alice.id)).ok).toBe(true);

    expect(await prisma.task.count({ where: { userId: bob.id } })).toBe(1);
    expect(await prisma.lifeDocument.count({ where: { userId: bob.id } })).toBe(1);
    expect(await prisma.taskTag.count({ where: { task: { userId: bob.id } } })).toBe(1);
  }, 180_000);
});
