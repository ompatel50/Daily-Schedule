/**
 * Overlapping health imports through the real import-session actions: a later
 * Apple Health export that re-covers a day with a FULLER value (same
 * fingerprint identity, more samples) updates that row in place, new days are
 * added, nothing is duplicated — and a manually-entered metric is never
 * touched by imports or by batch removal, because a manual fingerprint
 * (`manual|type|date`) can never equal a recomputed import fingerprint.
 * All data is synthetic.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import {
  confirmHealthImportAction,
  createHealthImportSessionAction,
  finalizeHealthImportAction,
  removeImportBatchAction,
  uploadHealthImportChunkAction,
} from "@/server/actions/health-import";
import { fingerprintFor, manualDailyFingerprint } from "@/lib/logic/health-import/rollup";
import { actAs, resetDatabase, twoUsers } from "./helpers";

import type { HealthMetric } from "@prisma/client";
import type { User } from "./helpers";

let alice: User;

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}
const D5 = daysAgo(5);
const D4 = daysAgo(4);
const D3 = daysAgo(3);
const D2 = daysAgo(2);
const D1 = daysAgo(1);

/** One rolled-up Apple steps row. Fingerprint = `ah|steps|<date>|<app>` — the
 *  value is NOT part of the identity, which is what makes the fuller-value
 *  update possible. */
function appleStepsRow(date: string, value: number, sampleCount: number) {
  const content = {
    type: "steps" as const,
    subtype: null,
    value,
    unit: "count",
    minValue: null,
    maxValue: null,
    date,
    startAt: null,
    endAt: null,
    source: "apple_health",
    sourceApp: "TestWatch",
    sourceDevice: null,
    externalId: null,
    notes: null,
    sampleCount,
  };
  return { ...content, fingerprint: fingerprintFor(content) };
}

const META = {
  source: "apple_health" as const,
  fileType: "xml" as const,
  fileName: "synthetic-export.xml",
  fileSize: 5000,
  totalChunks: 1,
  examined: 100,
  invalid: 0,
  unsupported: [],
  warnings: [],
};

async function importSteps(rows: ReturnType<typeof appleStepsRow>[]) {
  const created = await createHealthImportSessionAction(META);
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error("unreachable");
  const sessionId = created.data.sessionId;
  const uploaded = await uploadHealthImportChunkAction({
    sessionId,
    seq: 0,
    payload: JSON.stringify({ rows, workouts: [] }),
  });
  expect(uploaded.ok).toBe(true);
  const finalized = await finalizeHealthImportAction(sessionId);
  expect(finalized.ok).toBe(true);
  if (!finalized.ok) throw new Error("unreachable");
  const confirmed = await confirmHealthImportAction({ token: sessionId, categories: ["steps"] });
  expect(confirmed.ok).toBe(true);
  if (!confirmed.ok) throw new Error("unreachable");
  return { preview: finalized.data, outcome: confirmed.data };
}

async function manualRow(): Promise<HealthMetric> {
  return prisma.healthMetric.findUniqueOrThrow({
    where: { userId_fingerprint: { userId: alice.id, fingerprint: manualDailyFingerprint("steps", D3) } },
  });
}

beforeEach(async () => {
  await resetDatabase();
  ({ alice } = await twoUsers());
  actAs(alice);
});

describe("overlapping imports", () => {
  it("updates the shared day in place, adds new days, duplicates nothing, never touches manual rows", async () => {
    // First export: three days of steps.
    const first = await importSteps([
      appleStepsRow(D5, 8000, 12),
      appleStepsRow(D4, 9000, 14),
      appleStepsRow(D3, 6000, 9),
    ]);
    expect(first.outcome).toMatchObject({ imported: 3, updated: 0, duplicates: 0 });

    // A manually-entered value for the shared day, keyed the way the manual
    // entry UI keys it. Imports must never collide with it.
    await prisma.healthMetric.create({
      data: {
        userId: alice.id,
        date: D3,
        type: "steps",
        value: 4321,
        source: "manual",
        fingerprint: manualDailyFingerprint("steps", D3),
      },
    });
    const manualBefore = await manualRow();

    // Second export overlaps: D3 again, but fuller (the rest of the day's
    // samples arrived), plus two genuinely new days.
    const second = await importSteps([
      appleStepsRow(D3, 11000, 40),
      appleStepsRow(D2, 7000, 11),
      appleStepsRow(D1, 12000, 15),
    ]);

    // The preview already told the truth: one update, two new rows.
    const stepsPreview = second.preview.categories.find((category) => category.key === "steps");
    expect(stepsPreview).toMatchObject({ newRows: 2, updatedRows: 1, unchangedRows: 0 });
    expect(second.outcome).toMatchObject({ imported: 2, updated: 1, duplicates: 0 });

    // The shared day was updated IN PLACE: still one Apple row, carrying the
    // fuller value and the second batch's id.
    const sharedDay = await prisma.healthMetric.findMany({
      where: { userId: alice.id, date: D3, type: "steps", source: "apple_health" },
    });
    expect(sharedDay).toHaveLength(1);
    expect(sharedDay[0]).toMatchObject({ value: 11000, sampleCount: 40, batchId: second.outcome.batchId });

    // Five Apple rows total (D5..D1, one per day) — nothing duplicated.
    expect(
      await prisma.healthMetric.count({ where: { userId: alice.id, type: "steps", source: "apple_health" } }),
    ).toBe(5);

    // The manual row is byte-identical after both imports.
    expect(await manualRow()).toEqual(manualBefore);

    // Removing the second batch takes exactly its three rows — the two new
    // days plus the updated shared-day row it now owns — and nothing else.
    const removed = await removeImportBatchAction(second.outcome.batchId);
    expect(removed.ok).toBe(true);
    if (removed.ok) expect(removed.data.removedMetrics).toBe(3);

    const survivors = await prisma.healthMetric.findMany({
      where: { userId: alice.id, type: "steps" },
      orderBy: { date: "asc" },
    });
    expect(survivors.map((row) => [row.date, row.source])).toEqual([
      [D5, "apple_health"],
      [D4, "apple_health"],
      [D3, "manual"],
    ]);
    expect(await manualRow()).toEqual(manualBefore);
  });

  it("re-importing identical data is a pure no-op on the rows", async () => {
    const rows = [appleStepsRow(D5, 8000, 12), appleStepsRow(D4, 9000, 14)];
    const first = await importSteps(rows);
    expect(first.outcome.imported).toBe(2);

    const again = await importSteps(rows);
    const stepsPreview = again.preview.categories.find((category) => category.key === "steps");
    expect(stepsPreview).toMatchObject({ newRows: 0, updatedRows: 0, unchangedRows: 2 });
    expect(again.outcome).toMatchObject({ imported: 0, updated: 0, duplicates: 2 });
    expect(await prisma.healthMetric.count({ where: { userId: alice.id, type: "steps" } })).toBe(2);
  });
});
