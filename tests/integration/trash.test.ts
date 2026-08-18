/**
 * Global undo against real PostgreSQL: soft deletes land in the Trash, the
 * guarded client hides them everywhere (including nested reads), restore is
 * link-aware, purge is final, the 30-day sweep purges only what expired, the
 * backup excludes trashed rows, and none of it crosses user boundaries.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma, prismaIncludingTrashed } from "@/lib/prisma";
import { shiftDay, type DayKey } from "@/lib/date";
import { TRASH_RETENTION_DAYS } from "@/lib/soft-delete";
import { exportBackup, importBackup } from "@/server/actions/backup";
import {
  deleteFinanceAccount,
  deleteTransaction,
  saveTransaction,
  transferBetweenAccounts,
} from "@/server/actions/finance";
import { deleteScheduleItem, createScheduleItem } from "@/server/actions/planner";
import { deleteProject, deleteTask, saveTask } from "@/server/actions/tasks";
import { emptyTrash, purgeTrashItem, restoreTrashItem } from "@/server/actions/trash";
import { getTrashPage, purgeExpiredTrash } from "@/server/trash";
import { scheduleSettingsFor } from "@/server/schedule";
import { actAs, resetDatabase, twoUsers, type User } from "./helpers";

let alice: User;
let bob: User;

const today = (): DayKey => scheduleSettingsFor(alice).today;

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  ({ alice, bob } = await twoUsers());
  actAs(alice);
});

const raw = prismaIncludingTrashed;

describe("the guarded client", () => {
  it("hides trashed rows from finds, counts and nested includes", async () => {
    const project = await prisma.project.create({ data: { userId: alice.id, name: "P" } });
    const live = await prisma.task.create({
      data: { userId: alice.id, title: "Live", projectId: project.id },
    });
    await prisma.task.create({
      data: {
        userId: alice.id,
        title: "Trashed",
        projectId: project.id,
        deletedAt: new Date(),
      },
    });

    expect(await prisma.task.count({ where: { userId: alice.id } })).toBe(1);
    expect(await prisma.task.findFirst({ where: { title: "Trashed" } })).toBeNull();

    // The nested to-many include is filtered too — a live parent never lists
    // trashed children.
    const withTasks = await prisma.project.findFirst({
      where: { id: project.id },
      include: { tasks: true, _count: { select: { tasks: true } } },
    });
    expect(withTasks?.tasks.map((task) => task.id)).toEqual([live.id]);
    expect(withTasks?._count.tasks).toBe(1);

    // The raw client sees everything — that is its documented job.
    expect(await raw.task.count({ where: { userId: alice.id } })).toBe(2);
  });
});

describe("the trash page", () => {
  it("lists what was deleted, from which module, newest first", async () => {
    const task = await prisma.task.create({ data: { userId: alice.id, title: "Old task" } });
    await deleteTask(task.id);
    const account = await prisma.financeAccount.create({
      data: { userId: alice.id, name: "Old account" },
    });
    await deleteFinanceAccount(account.id);

    const page = await getTrashPage();
    expect(page.retentionDays).toBe(TRASH_RETENTION_DAYS);
    expect(page.items.map((item) => item.module)).toEqual(["Finance", "Tasks"]);
    expect(page.items.map((item) => item.title)).toEqual(["Old account", "Old task"]);

    // Bob's trash is empty — nothing leaks across accounts.
    actAs(bob);
    expect((await getTrashPage()).items).toEqual([]);
  });
});

describe("restore, link-aware", () => {
  it("a task comes back with the subtasks its delete removed — not one trashed earlier", async () => {
    const created = await saveTask({ title: "Parent" });
    if (!created.ok) throw new Error("task");
    const parentId = created.data.id;
    const early = await prisma.task.create({
      data: { userId: alice.id, title: "Trashed earlier", parentId },
    });
    await prisma.task.create({ data: { userId: alice.id, title: "Sub", parentId } });
    await deleteTask(early.id);
    await deleteTask(parentId);

    const restored = await restoreTrashItem("Task", parentId);
    expect(restored.ok && restored.data.restored).toBe(2); // parent + "Sub"
    expect(await prisma.task.count({ where: { userId: alice.id } })).toBe(2);
    expect((await raw.task.findUniqueOrThrow({ where: { id: early.id } })).deletedAt).not.toBeNull();
  });

  it("a transfer restores as a pair; a purged counterpart restores detached", async () => {
    const checking = await prisma.financeAccount.create({
      data: { userId: alice.id, name: "Checking" },
    });
    const savings = await prisma.financeAccount.create({
      data: { userId: alice.id, name: "Savings" },
    });
    const transfer = await transferBetweenAccounts({
      fromAccountId: checking.id,
      toAccountId: savings.id,
      amount: 100,
      date: today(),
    });
    if (!transfer.ok) throw new Error("transfer");
    const legs = await prisma.financeTransaction.findMany({
      where: { transferGroupId: transfer.data.transferGroupId },
    });
    expect(legs).toHaveLength(2);

    // Deleting one leg trashes the pair.
    await deleteTransaction(legs[0].id);
    expect(await prisma.financeTransaction.count({ where: { userId: alice.id } })).toBe(0);

    // Restoring either leg restores both.
    const restored = await restoreTrashItem("FinanceTransaction", legs[1].id);
    expect(restored.ok && restored.data.restored).toBe(2);
    expect(await prisma.financeTransaction.count({ where: { userId: alice.id } })).toBe(2);

    // Now trash again, purge the counterpart, and restore: the survivor
    // comes back DETACHED, not as half a transfer.
    await deleteTransaction(legs[0].id);
    await raw.financeTransaction.delete({ where: { id: legs[1].id } });
    const half = await restoreTrashItem("FinanceTransaction", legs[0].id);
    expect(half.ok && half.data.restored).toBe(1);
    const survivor = await prisma.financeTransaction.findUniqueOrThrow({
      where: { id: legs[0].id },
    });
    expect(survivor.transferGroupId).toBeNull();
    expect(survivor.category).not.toBe("transfer");
  });

  it("an account restore brings its ledger back with it", async () => {
    const account = await prisma.financeAccount.create({
      data: { userId: alice.id, name: "Checking" },
    });
    await saveTransaction({
      accountId: account.id,
      date: today(),
      amount: -12.5,
      category: "other",
    });
    await deleteFinanceAccount(account.id);
    expect(await prisma.financeTransaction.count({ where: { userId: alice.id } })).toBe(0);

    const restored = await restoreTrashItem("FinanceAccount", account.id);
    expect(restored.ok && restored.data.restored).toBe(2); // account + its transaction
    expect(await prisma.financeTransaction.count({ where: { userId: alice.id } })).toBe(1);
  });

  it("a one-deleted occurrence gets its series slot back on restore", async () => {
    const start = shiftDay(today(), 2);
    const created = await createScheduleItem({
      title: "Standup",
      date: start,
      startMinute: 9 * 60,
      endMinute: 9 * 60 + 30,
      allDay: false,
      category: "work",
      priority: "medium",
      status: "planned",
      tagIds: [],
      recurrenceRule: JSON.stringify({ freq: "daily", interval: 1 }),
    });
    if (!created.ok) throw new Error("series");
    const victim = await prisma.scheduleItem.findFirstOrThrow({
      where: { seriesId: created.data.id, date: shiftDay(start, 3) },
    });
    await deleteScheduleItem(victim.id, "one");

    const parent = await raw.scheduleItem.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(parent.skipDates).toContain(shiftDay(start, 3));

    const restored = await restoreTrashItem("ScheduleItem", victim.id);
    expect(restored.ok).toBe(true);
    const parentAfter = await raw.scheduleItem.findUniqueOrThrow({
      where: { id: created.data.id },
    });
    expect(parentAfter.skipDates ?? "[]").not.toContain(shiftDay(start, 3));
    expect(
      await prisma.scheduleItem.count({ where: { id: victim.id } }),
    ).toBe(1);
  });

  it("restore and purge are refused across user boundaries", async () => {
    const task = await prisma.task.create({ data: { userId: alice.id, title: "Hers" } });
    await deleteTask(task.id);

    actAs(bob);
    expect((await restoreTrashItem("Task", task.id)).ok).toBe(false);
    expect((await purgeTrashItem("Task", task.id)).ok).toBe(false);
    expect((await raw.task.findUniqueOrThrow({ where: { id: task.id } })).deletedAt).not.toBeNull();
  });
});

describe("purge", () => {
  it("per item is final, and cascades take dependents", async () => {
    const created = await saveTask({ title: "Parent" });
    if (!created.ok) throw new Error("task");
    await prisma.task.create({
      data: { userId: alice.id, title: "Sub", parentId: created.data.id },
    });
    await deleteTask(created.data.id);

    const purged = await purgeTrashItem("Task", created.data.id);
    expect(purged.ok).toBe(true);
    expect(await raw.task.count({ where: { userId: alice.id } })).toBe(0);
    // A live row cannot be purged from the trash surface.
    const live = await prisma.task.create({ data: { userId: alice.id, title: "Live" } });
    expect((await purgeTrashItem("Task", live.id)).ok).toBe(false);
  });

  it("the daily sweep purges only rows older than the retention window", async () => {
    const fresh = await prisma.task.create({
      data: { userId: alice.id, title: "Fresh", deletedAt: new Date() },
    });
    const expired = await prisma.task.create({
      data: {
        userId: alice.id,
        title: "Expired",
        deletedAt: new Date(Date.now() - (TRASH_RETENTION_DAYS + 1) * 86_400_000),
      },
    });

    const purged = await purgeExpiredTrash();
    expect(purged).toBe(1);
    expect(await raw.task.findUnique({ where: { id: expired.id } })).toBeNull();
    expect(await raw.task.findUnique({ where: { id: fresh.id } })).not.toBeNull();
  });

  it("empty trash clears only the caller's trash", async () => {
    const mine = await prisma.task.create({ data: { userId: alice.id, title: "Mine" } });
    await deleteTask(mine.id);
    const his = await prisma.task.create({
      data: { userId: bob.id, title: "His", deletedAt: new Date() },
    });

    const result = await emptyTrash();
    expect(result.ok && result.data.purged).toBe(1);
    expect(await raw.task.findUnique({ where: { id: mine.id } })).toBeNull();
    expect(await raw.task.findUnique({ where: { id: his.id } })).not.toBeNull();
  });
});

describe("backups and the trash", () => {
  it("exports exclude trashed rows; restoring clears the trash for restored tables", async () => {
    const keep = await prisma.task.create({ data: { userId: alice.id, title: "Keep" } });
    const trashed = await prisma.task.create({ data: { userId: alice.id, title: "Gone" } });
    await deleteTask(trashed.id);

    const exported = await exportBackup();
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const titles = exported.data.data.tasks.map((row) => (row as { title: string }).title);
    expect(titles).toEqual(["Keep"]);

    // Merge-restoring into the same account clears the trashed row (it held
    // identity keys) and imports the live one alongside the original.
    const restored = await importBackup(exported.data, "merge");
    expect(restored.ok).toBe(true);
    expect(await raw.task.count({ where: { userId: alice.id, deletedAt: { not: null } } })).toBe(0);
    expect(await prisma.task.count({ where: { userId: alice.id } })).toBe(2);
    expect(await raw.task.findUnique({ where: { id: keep.id } })).not.toBeNull();
  });
});

describe("deleting a project keeps tasks, restoring re-attaches", () => {
  it("round-trips through the trash", async () => {
    const project = await prisma.project.create({ data: { userId: alice.id, name: "Move" } });
    const task = await prisma.task.create({
      data: { userId: alice.id, title: "Pack", projectId: project.id },
    });
    await deleteProject(project.id);
    expect(await prisma.project.count({ where: { userId: alice.id } })).toBe(0);

    const restored = await restoreTrashItem("Project", project.id);
    expect(restored.ok).toBe(true);
    expect(await prisma.project.count({ where: { userId: alice.id } })).toBe(1);
    expect(
      (await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).projectId,
    ).toBe(project.id);
  });
});
