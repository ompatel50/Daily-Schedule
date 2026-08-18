/**
 * Task ↔ planner linking against real PostgreSQL: the completion offer when a
 * linked block is checked off, completion reflection from the task onto its
 * blocks (close vs. advance), detach-on-delete in both directions, the link
 * riding the materialised-occurrence recurrence architecture, and the
 * assistant read tools exposing the link.
 *
 * Days are derived from the user's timezone, never hardcoded, so today/future
 * status logic stays deterministic.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma, prismaIncludingTrashed } from "@/lib/prisma";
import { shiftDay, type DayKey } from "@/lib/date";
import type { ScheduleSettings } from "@/lib/logic/schedule";
import { runTool } from "@/server/ai/tools";
import { scheduleSettingsFor } from "@/server/schedule";
import {
  deleteScheduleItem,
  setScheduleItemStatus,
  toggleScheduleItem,
  updateScheduleItem,
} from "@/server/actions/planner";
import {
  completeTask,
  deleteTask,
  reopenTask,
  scheduleTaskOnPlanner,
} from "@/server/actions/tasks";
import { extendSeriesFor } from "@/server/series";
import { actAs, resetDatabase, twoUsers, type User } from "./helpers";

let alice: User;
let bob: User;

// The OPERATIONAL today — the same boundary completeTask reflects against.
// Between midnight and the daily reset the calendar date is already tomorrow,
// so deriving this from the clock instead would misplace "today's block".
const today = (): DayKey => scheduleSettingsFor(alice).today;

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  ({ alice, bob } = await twoUsers());
  actAs(alice);
});

function makeTask(userId: string, overrides: Record<string, unknown> = {}) {
  return prisma.task.create({ data: { userId, title: "Paint hallway", ...overrides } });
}

/** Schedule `task` on the planner and return the created block's id. */
async function scheduleOn(taskId: string, date: DayKey, startMinute: number | null = null) {
  const result = await scheduleTaskOnPlanner({
    taskId,
    date,
    startMinute,
    endMinute: startMinute !== null ? startMinute + 60 : null,
  });
  if (!result.ok) throw new Error(`scheduling failed: ${result.error}`);
  return result.data.scheduleItemId;
}

describe("the completion offer (block → task)", () => {
  it("marking a linked block done offers the still-open task; un-marking offers nothing", async () => {
    const task = await makeTask(alice.id);
    const blockId = await scheduleOn(task.id, today(), 9 * 60);

    const done = await toggleScheduleItem(blockId);
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.data.status).toBe("done");
    expect(done.data.taskOffer).toEqual({ id: task.id, title: "Paint hallway" });
    // The offer is an offer — nothing was completed automatically.
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("open");

    const undone = await toggleScheduleItem(blockId);
    expect(undone.ok && undone.data.status).toBe("planned");
    expect(undone.ok && undone.data.taskOffer).toBeNull();
  });

  it("no offer for a closed task, an unlinked block, or a skip", async () => {
    const task = await makeTask(alice.id);
    const linked = await scheduleOn(task.id, today());
    await prisma.task.update({ where: { id: task.id }, data: { status: "done" } });
    const closedOffer = await toggleScheduleItem(linked);
    expect(closedOffer.ok && closedOffer.data.taskOffer).toBeNull();

    const plain = await prisma.scheduleItem.create({
      data: { userId: alice.id, title: "Just a block", date: today() },
    });
    const plainOffer = await toggleScheduleItem(plain.id);
    expect(plainOffer.ok && plainOffer.data.taskOffer).toBeNull();

    const other = await makeTask(alice.id, { title: "Other" });
    const skippable = await scheduleOn(other.id, today());
    const skipped = await setScheduleItemStatus(skippable, "skipped");
    expect(skipped.ok && skipped.data.taskOffer).toBeNull();
    // The explicit status path offers the same way the checkbox does.
    const explicit = await setScheduleItemStatus(skippable, "done");
    expect(explicit.ok && explicit.data.taskOffer).toMatchObject({ id: other.id });
  });
});

describe("completion reflection (task → blocks)", () => {
  it("closing a task marks every still-planned linked block done — and only those", async () => {
    const task = await makeTask(alice.id);
    const past = await scheduleOn(task.id, shiftDay(today(), -3));
    const present = await scheduleOn(task.id, today(), 9 * 60);
    const future = await scheduleOn(task.id, shiftDay(today(), 5));
    await setScheduleItemStatus(past, "skipped");

    const result = await completeTask(task.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("completed");
    expect(result.data.blocksCompleted).toBe(2);

    const rows = await prisma.scheduleItem.findMany({
      where: { id: { in: [past, present, future] } },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(past)?.status).toBe("skipped"); // a deliberate "didn't happen" stays
    expect(byId.get(present)?.status).toBe("done");
    expect(byId.get(present)?.completedAt).not.toBeNull();
    expect(byId.get(future)?.status).toBe("done"); // nothing left to reserve time for
  });

  it("advancing a repeating task completes only blocks up to today", async () => {
    const task = await makeTask(alice.id, {
      dueDate: today(),
      repeat: "weekly",
      repeatEvery: 1,
      repeatAnchor: today(),
    });
    const present = await scheduleOn(task.id, today(), 9 * 60);
    const future = await scheduleOn(task.id, shiftDay(today(), 4));

    const result = await completeTask(task.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("advanced");
    expect(result.data.blocksCompleted).toBe(1);

    expect(
      (await prisma.scheduleItem.findUniqueOrThrow({ where: { id: present } })).status,
    ).toBe("done");
    // Time set aside for the next occurrence, which is still coming.
    expect(
      (await prisma.scheduleItem.findUniqueOrThrow({ where: { id: future } })).status,
    ).toBe("planned");
  });

  it("reopening the task leaves reflected blocks done — the sessions happened", async () => {
    const task = await makeTask(alice.id);
    const blockId = await scheduleOn(task.id, today());
    await completeTask(task.id);
    expect((await reopenTask(task.id)).ok).toBe(true);
    expect(
      (await prisma.scheduleItem.findUniqueOrThrow({ where: { id: blockId } })).status,
    ).toBe("done");
  });

  it("cross-user: a foreign block wearing my task's id is never touched", async () => {
    const task = await makeTask(alice.id);
    const mine = await scheduleOn(task.id, today());
    // Simulated corruption — no action can produce this row.
    const foreign = await prisma.scheduleItem.create({
      data: { userId: bob.id, title: "Bob's block", date: today(), taskId: task.id },
    });

    const result = await completeTask(task.id);
    expect(result.ok && result.data.blocksCompleted).toBe(1);
    expect(
      (await prisma.scheduleItem.findUniqueOrThrow({ where: { id: mine } })).status,
    ).toBe("done");
    expect(
      (await prisma.scheduleItem.findUniqueOrThrow({ where: { id: foreign.id } })).status,
    ).toBe("planned");
  });
});

describe("deletes detach, never cascade", () => {
  it("deleting the task keeps the block; the link hides, and purge unlinks", async () => {
    const task = await makeTask(alice.id);
    const blockId = await scheduleOn(task.id, today());
    expect((await deleteTask(task.id)).ok).toBe(true);

    // Soft delete: the block keeps its taskId (restore would re-attach) but
    // the link is dead everywhere — no completion offer, no chip.
    const block = await prisma.scheduleItem.findUniqueOrThrow({ where: { id: blockId } });
    expect(block.taskId).toBe(task.id);
    const toggled = await toggleScheduleItem(blockId);
    expect(toggled.ok && toggled.data.taskOffer).toBeNull();

    // Purging the trashed task detaches for good (schema SetNull).
    await prismaIncludingTrashed.task.delete({ where: { id: task.id } });
    const after = await prisma.scheduleItem.findUniqueOrThrow({ where: { id: blockId } });
    expect(after.taskId).toBeNull();
  });

  it("deleting the block leaves the task open", async () => {
    const task = await makeTask(alice.id);
    const blockId = await scheduleOn(task.id, today());
    expect((await deleteScheduleItem(blockId, "one")).ok).toBe(true);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("open");
  });
});

describe("recurring blocks follow the materialised-occurrence model", () => {
  /** Turn a linked block into a daily series and return its occurrence rows. */
  async function makeLinkedSeries(taskId: string, start: DayKey) {
    const blockId = await scheduleOn(taskId, start, 9 * 60);
    const result = await updateScheduleItem({
      id: blockId,
      title: "Paint hallway",
      date: start,
      startMinute: 9 * 60,
      endMinute: 10 * 60,
      allDay: false,
      category: "admin",
      priority: "medium",
      status: "planned",
      tagIds: [],
      recurrenceRule: JSON.stringify({ freq: "daily", interval: 1 }),
    });
    if (!result.ok) throw new Error(`series failed: ${result.error}`);
    return blockId;
  }

  it("making a linked block recurring carries the link to every occurrence", async () => {
    const task = await makeTask(alice.id);
    const start = shiftDay(today(), 1);
    const parentId = await makeLinkedSeries(task.id, start);

    const occurrences = await prisma.scheduleItem.findMany({ where: { seriesId: parentId } });
    expect(occurrences.length).toBeGreaterThan(10);
    expect(occurrences.every((row) => row.taskId === task.id)).toBe(true);

    // Closing the task reflects across the whole planned series.
    const result = await completeTask(task.id);
    expect(result.ok && result.data.blocksCompleted).toBe(occurrences.length + 1);
    expect(
      await prisma.scheduleItem.count({
        where: { taskId: task.id, status: { not: "done" } },
      }),
    ).toBe(0);
  });

  it("a one-occurrence edit keeps its link, and regeneration re-stamps it", async () => {
    const task = await makeTask(alice.id);
    const start = shiftDay(today(), 1);
    const parentId = await makeLinkedSeries(task.id, start);

    const target = await prisma.scheduleItem.findFirstOrThrow({
      where: { seriesId: parentId, date: shiftDay(start, 3) },
    });
    const edited = await updateScheduleItem(
      {
        id: target.id,
        title: "Paint hallway (long session)",
        date: shiftDay(start, 3),
        startMinute: 14 * 60,
        endMinute: 16 * 60,
        allDay: false,
        category: "admin",
        priority: "medium",
        status: "planned",
        tagIds: [],
        recurrenceRule: null,
      },
      "one",
    );
    expect(edited.ok).toBe(true);
    const exception = await prisma.scheduleItem.findUniqueOrThrow({ where: { id: target.id } });
    expect(exception.isException).toBe(true);
    expect(exception.taskId).toBe(task.id);

    // A raw delete (no skip tombstone) leaves a hole; the horizon top-up
    // refills it — and the regenerated row carries the link.
    const victim = await prisma.scheduleItem.findFirstOrThrow({
      where: { seriesId: parentId, date: shiftDay(start, 5) },
    });
    await prisma.scheduleItem.delete({ where: { id: victim.id } });
    expect(await extendSeriesFor(alice.id)).toBe(1);
    const refilled = await prisma.scheduleItem.findFirstOrThrow({
      where: { seriesId: parentId, originalDate: shiftDay(start, 5) },
    });
    expect(refilled.taskId).toBe(task.id);
  });
});

describe("assistant read tools expose the link (read-only)", () => {
  const ctx = (user: User) => {
    const settings: ScheduleSettings = scheduleSettingsFor(user);
    return { user: user as never, settings, mode: "readonly" as const };
  };

  it("get_schedule names the task a block was scheduled from", async () => {
    const task = await makeTask(alice.id);
    const blockId = await scheduleOn(task.id, shiftDay(today(), 1), 9 * 60);

    const outcome = await runTool(ctx(alice), "get_schedule", {
      from: today(),
      to: shiftDay(today(), 3),
    });
    expect(outcome.ok).toBe(true);
    const items = (outcome.result as { items: Array<Record<string, unknown>> }).items;
    const linked = items.find((item) => item.id === blockId);
    expect(linked?.task).toEqual({ id: task.id, title: "Paint hallway", status: "open" });
    // Unlinked blocks carry no task key at all.
    const plain = await prisma.scheduleItem.create({
      data: { userId: alice.id, title: "Plain", date: shiftDay(today(), 1) },
    });
    const again = await runTool(ctx(alice), "get_schedule", {
      from: today(),
      to: shiftDay(today(), 3),
    });
    const plainItem = (again.result as { items: Array<Record<string, unknown>> }).items.find(
      (item) => item.id === plain.id,
    );
    expect(plainItem && "task" in plainItem).toBe(false);
  });

  it("list_tasks lists a task's upcoming scheduled blocks with date and time", async () => {
    const task = await makeTask(alice.id);
    const blockId = await scheduleOn(task.id, shiftDay(today(), 2), 14 * 60);

    const outcome = await runTool(ctx(alice), "list_tasks", {});
    expect(outcome.ok).toBe(true);
    const buckets = (outcome.result as {
      buckets: Record<string, Array<{ id: string; scheduled?: Array<Record<string, unknown>> }>>;
    }).buckets;
    const row = Object.values(buckets)
      .flat()
      .find((entry) => entry.id === task.id);
    expect(row?.scheduled).toEqual([
      { id: blockId, date: shiftDay(today(), 2), startMinute: 14 * 60, allDay: false },
    ]);
  });
});
