/**
 * Routine (schedule template) application idempotency, end to end against
 * real PostgreSQL: the sourceKey identity written by applyScheduleTemplate,
 * the duplicate detection, the deliberate-second-copy ordinal, and the
 * database unique constraint that backs all of it.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { applyScheduleTemplate, saveScheduleTemplate } from "@/server/actions/planner";
import { actAs, expectUniqueViolation, resetDatabase, twoUsers } from "./helpers";

import type { User } from "./helpers";

let alice: User;

const DAY = "2026-07-30";

async function createRoutine(): Promise<string> {
  const saved = await saveScheduleTemplate({
    name: "Morning routine",
    category: "personal",
    items: [
      { title: "Wake up", startMinute: 420, endMinute: 450 },
      { title: "Plan the day", allDay: true },
    ],
  });
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error("unreachable");
  return saved.data.id;
}

async function keysOnDay(templateId: string): Promise<Array<string | null>> {
  const rows = await prisma.scheduleItem.findMany({
    where: { userId: alice.id, date: DAY, templateId },
    orderBy: { sortOrder: "asc" },
    select: { sourceKey: true },
  });
  return rows.map((row) => row.sourceKey);
}

beforeEach(async () => {
  await resetDatabase();
  ({ alice } = await twoUsers());
  actAs(alice);
});

describe("applyScheduleTemplate", () => {
  it("applying to an empty day writes every row keyed 1:0..", async () => {
    const templateId = await createRoutine();

    const result = await applyScheduleTemplate(templateId, DAY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ status: "applied", created: 2, ordinal: 1 });

    expect(await keysOnDay(templateId)).toEqual(["1:0", "1:1"]);
  });

  it("applying again reports duplicate and writes nothing", async () => {
    const templateId = await createRoutine();
    await applyScheduleTemplate(templateId, DAY);

    const again = await applyScheduleTemplate(templateId, DAY);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.data).toMatchObject({
      status: "duplicate",
      existing: 2,
      templateName: "Morning routine",
      itemCount: 2,
    });

    expect(await keysOnDay(templateId)).toEqual(["1:0", "1:1"]);
  });

  it("a deliberate second copy takes ordinal 2", async () => {
    const templateId = await createRoutine();
    await applyScheduleTemplate(templateId, DAY);

    const copy = await applyScheduleTemplate(templateId, DAY, "duplicate");
    expect(copy.ok).toBe(true);
    if (!copy.ok) return;
    expect(copy.data).toMatchObject({ status: "applied", created: 2, ordinal: 2 });

    expect(await keysOnDay(templateId)).toEqual(["1:0", "1:1", "2:0", "2:1"]);
  });

  it("keep leaves the day alone; replace rewrites it and frees ordinal 1", async () => {
    const templateId = await createRoutine();
    await applyScheduleTemplate(templateId, DAY);
    const originalIds = (
      await prisma.scheduleItem.findMany({ where: { userId: alice.id, date: DAY, templateId } })
    ).map((row) => row.id);

    const kept = await applyScheduleTemplate(templateId, DAY, "keep");
    expect(kept.ok).toBe(true);
    if (kept.ok) expect(kept.data).toMatchObject({ status: "unchanged", existing: 2 });

    const replaced = await applyScheduleTemplate(templateId, DAY, "replace");
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    expect(replaced.data).toMatchObject({ status: "applied", created: 2, removed: 2, ordinal: 1 });

    const rows = await prisma.scheduleItem.findMany({
      where: { userId: alice.id, date: DAY, templateId },
    });
    expect(rows.map((row) => row.sourceKey).sort()).toEqual(["1:0", "1:1"]);
    expect(rows.some((row) => originalIds.includes(row.id))).toBe(false);
  });

  it("the unique constraint rejects a forced duplicate insert", async () => {
    const templateId = await createRoutine();
    await applyScheduleTemplate(templateId, DAY);

    // Bypass the action entirely — the (userId, date, templateId, sourceKey)
    // constraint is the last line of defence and must hold on its own.
    await expectUniqueViolation(
      prisma.scheduleItem.create({
        data: {
          userId: alice.id,
          title: "Forged copy",
          date: DAY,
          templateId,
          sourceKey: "1:0",
        },
      }),
    );

    expect(await keysOnDay(templateId)).toEqual(["1:0", "1:1"]);
  });
});
