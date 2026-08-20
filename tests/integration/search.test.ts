/**
 * Cross-module search — the server half (`searchEverything`).
 *
 * The pure hit-building and ranking is unit-tested in tests/search.test.ts;
 * these tests pin the fetch contracts: which rows match, that the Trash is
 * invisible, that every module's fan-out is bounded, and that nothing ever
 * crosses users.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { searchEverything } from "@/server/queries";
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

describe("meals", () => {
  it("finds a meal by its custom label and by its notes", async () => {
    await prisma.meal.create({
      data: { userId: alice.id, date: DAY, type: "custom", label: "Pre-workout shake" },
    });
    await prisma.meal.create({
      data: { userId: alice.id, date: DAY, type: "lunch", notes: "leftover paella" },
    });

    expect((await searchEverything("pre-workout")).meals).toHaveLength(1);
    expect((await searchEverything("paella")).meals).toHaveLength(1);
  });

  it("does not match on the fixed type vocabulary", async () => {
    await prisma.meal.create({ data: { userId: alice.id, date: DAY, type: "lunch" } });
    // "lunch" as a term must not return every lunch ever logged.
    expect((await searchEverything("lunch")).meals).toHaveLength(0);
  });
});

describe("reminders", () => {
  it("finds a reminder by title and by message, with the fire day resolved", async () => {
    await prisma.reminder.create({
      data: {
        userId: alice.id,
        title: "Take out bins",
        remindAt: new Date("2026-07-31T01:00:00Z"),
        repeat: "weekly",
      },
    });
    await prisma.reminder.create({
      data: {
        userId: alice.id,
        title: "Meds",
        message: "the evening dose",
        remindAt: new Date("2026-07-30T21:00:00Z"),
      },
    });

    const byTitle = (await searchEverything("bins")).reminders;
    expect(byTitle).toHaveLength(1);
    expect(byTitle[0].repeat).toBe("weekly");
    expect(byTitle[0].day).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    expect((await searchEverything("evening dose")).reminders).toHaveLength(1);
  });

  it("carries the planner day for a block-born reminder, unless the block is trashed", async () => {
    const block = await prisma.scheduleItem.create({
      data: { userId: alice.id, title: "Flight", date: "2026-08-02" },
    });
    await prisma.reminder.create({
      data: {
        userId: alice.id,
        title: "Leave for the airport",
        remindAt: new Date("2026-08-02T14:00:00Z"),
        scheduleItemId: block.id,
      },
    });

    const linked = (await searchEverything("airport")).reminders;
    expect(linked[0].blockDate).toBe("2026-08-02");

    await prisma.scheduleItem.update({
      where: { id: block.id },
      data: { deletedAt: new Date() },
    });
    const detached = (await searchEverything("airport")).reminders;
    expect(detached[0].blockDate).toBeNull();
  });
});

describe("soft delete", () => {
  it("trashed rows never appear in search results", async () => {
    const stamp = new Date();
    await prisma.task.create({
      data: { userId: alice.id, title: "Trashed needle task", deletedAt: stamp },
    });
    await prisma.meal.create({
      data: { userId: alice.id, date: DAY, type: "custom", label: "Trashed needle meal", deletedAt: stamp },
    });
    await prisma.reminder.create({
      data: {
        userId: alice.id,
        title: "Trashed needle reminder",
        remindAt: new Date(),
        deletedAt: stamp,
      },
    });
    await prisma.scheduleItem.create({
      data: { userId: alice.id, title: "Trashed needle block", date: DAY, deletedAt: stamp },
    });
    // A live control proves the term itself matches.
    await prisma.task.create({ data: { userId: alice.id, title: "Live needle task" } });

    const rows = await searchEverything("needle");
    expect(rows.tasks.map((task) => task.title)).toEqual(["Live needle task"]);
    expect(rows.meals).toHaveLength(0);
    expect(rows.reminders).toHaveLength(0);
    expect(rows.items).toHaveLength(0);
  });
});

describe("bounds", () => {
  it("caps every module's results so one noisy model cannot crowd out the rest", async () => {
    await prisma.task.createMany({
      data: Array.from({ length: 20 }, (_, index) => ({
        userId: alice.id,
        title: `Bulk needle ${index}`,
      })),
    });
    await prisma.inboxItem.create({ data: { userId: alice.id, title: "needle inbox" } });

    const rows = await searchEverything("needle");
    expect(rows.tasks.length).toBeLessThanOrEqual(8);
    // The noisy module did not starve the quiet one.
    expect(rows.inboxItems).toHaveLength(1);
  });
});

describe("isolation", () => {
  it("meals and reminders never cross users", async () => {
    await prisma.meal.create({
      data: { userId: bob.id, date: DAY, type: "custom", label: "BobSecret meal" },
    });
    await prisma.reminder.create({
      data: { userId: bob.id, title: "BobSecret reminder", remindAt: new Date() },
    });

    const rows = await searchEverything("BobSecret");
    expect(rows.meals).toHaveLength(0);
    expect(rows.reminders).toHaveLength(0);
  });
});
