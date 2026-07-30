/**
 * The hosted health-import session, against real PostgreSQL: ownership,
 * chunk sequencing, server-side revalidation, preview/confirm/cancel/expiry.
 * All data is synthetic.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import {
  cancelHealthImportAction,
  confirmHealthImportAction,
  createHealthImportSessionAction,
  finalizeHealthImportAction,
  removeImportBatchAction,
  uploadHealthImportChunkAction,
} from "@/server/actions/health-import";
import { fingerprintFor } from "@/lib/logic/health-import/rollup";
import { actAs, resetDatabase, twoUsers } from "./helpers";

import type { User } from "./helpers";

let alice: User;
let bob: User;

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}
const D1 = daysAgo(3);
const D2 = daysAgo(2);

function stepsRow(date: string, value: number) {
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
    source: "csv",
    sourceApp: null,
    sourceDevice: null,
    externalId: null,
    notes: null,
    sampleCount: 1,
  };
  return { ...content, fingerprint: fingerprintFor(content) };
}

const META = {
  source: "csv" as const,
  fileType: "csv" as const,
  fileName: "synthetic.csv",
  fileSize: 1000,
  totalChunks: 1,
  examined: 2,
  invalid: 0,
  unsupported: [],
  warnings: [],
};

async function createStagedSession(rows = [stepsRow(D1, 10000), stepsRow(D2, 12000)]) {
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
  return sessionId;
}

beforeEach(async () => {
  await resetDatabase();
  ({ alice, bob } = await twoUsers());
  actAs(alice);
});

describe("session ownership", () => {
  it("chunks cannot be attached to another user's session", async () => {
    const created = await createHealthImportSessionAction(META);
    if (!created.ok) throw new Error("create failed");

    actAs(bob);
    const result = await uploadHealthImportChunkAction({
      sessionId: created.data.sessionId,
      seq: 0,
      payload: JSON.stringify({ rows: [stepsRow(D1, 1)], workouts: [] }),
    });
    expect(result.ok).toBe(false);
    expect(await prisma.healthImportChunk.count()).toBe(0);
  });

  it("another user cannot finalize, confirm or cancel a session", async () => {
    const sessionId = await createStagedSession();

    actAs(bob);
    expect((await finalizeHealthImportAction(sessionId)).ok).toBe(false);
    await cancelHealthImportAction(sessionId);
    // Bob's cancel deleted nothing.
    expect(await prisma.healthImportSession.count({ where: { id: sessionId } })).toBe(1);

    actAs(alice);
    const finalized = await finalizeHealthImportAction(sessionId);
    expect(finalized.ok).toBe(true);

    actAs(bob);
    const confirmed = await confirmHealthImportAction({ token: sessionId, categories: ["steps"] });
    expect(confirmed.ok).toBe(false);
    expect(await prisma.healthMetric.count()).toBe(0);
  });
});

describe("chunk validation", () => {
  it("a duplicate chunk submission is a no-op, not a duplicate", async () => {
    const created = await createHealthImportSessionAction(META);
    if (!created.ok) throw new Error("create failed");
    const payload = JSON.stringify({ rows: [stepsRow(D1, 10000)], workouts: [] });

    expect((await uploadHealthImportChunkAction({ sessionId: created.data.sessionId, seq: 0, payload })).ok).toBe(true);
    expect((await uploadHealthImportChunkAction({ sessionId: created.data.sessionId, seq: 0, payload })).ok).toBe(true);
    expect(await prisma.healthImportChunk.count()).toBe(1);
  });

  it("rejects out-of-range sequence numbers and malformed rows", async () => {
    const created = await createHealthImportSessionAction(META);
    if (!created.ok) throw new Error("create failed");
    const sessionId = created.data.sessionId;

    expect(
      (await uploadHealthImportChunkAction({
        sessionId,
        seq: 5, // session declared totalChunks: 1
        payload: JSON.stringify({ rows: [], workouts: [] }),
      })).ok,
    ).toBe(false);

    expect(
      (await uploadHealthImportChunkAction({
        sessionId,
        seq: 0,
        payload: JSON.stringify({ rows: [{ type: "not-a-metric", value: "x" }], workouts: [] }),
      })).ok,
    ).toBe(false);
  });

  it("finalize refuses an incomplete upload", async () => {
    const created = await createHealthImportSessionAction({ ...META, totalChunks: 3 });
    if (!created.ok) throw new Error("create failed");
    await uploadHealthImportChunkAction({
      sessionId: created.data.sessionId,
      seq: 0,
      payload: JSON.stringify({ rows: [stepsRow(D1, 1000)], workouts: [] }),
    });

    const result = await finalizeHealthImportAction(created.data.sessionId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("incomplete");
  });
});

describe("server-side revalidation", () => {
  it("recomputes fingerprints — a tampered client fingerprint is ignored", async () => {
    const row = { ...stepsRow(D1, 10000), fingerprint: "forged|fingerprint|value" };
    const sessionId = await createStagedSession([row]);
    const finalized = await finalizeHealthImportAction(sessionId);
    expect(finalized.ok).toBe(true);

    const confirmed = await confirmHealthImportAction({ token: sessionId, categories: ["steps"] });
    expect(confirmed.ok).toBe(true);

    const metric = await prisma.healthMetric.findFirstOrThrow({ where: { userId: alice.id } });
    expect(metric.fingerprint).toBe(stepsRow(D1, 10000).fingerprint);
    expect(metric.fingerprint).not.toBe("forged|fingerprint|value");
  });

  it("a CSV session cannot smuggle rows claiming apple_health provenance", async () => {
    const forged = { ...stepsRow(D1, 10000), source: "apple_health" };
    const sessionId = await createStagedSession([forged, stepsRow(D2, 500)]);

    const finalized = await finalizeHealthImportAction(sessionId);
    expect(finalized.ok).toBe(true);
    if (!finalized.ok) return;
    // The forged row was rejected server-side and reported.
    expect(finalized.data.totalRows).toBe(1);
    expect(finalized.data.warnings.join(" ")).toContain("failed server-side validation");
  });
});

describe("preview, confirm, cancel, expiry", () => {
  it("preview writes no health records; confirm writes exactly the selection", async () => {
    const sessionId = await createStagedSession();
    const finalized = await finalizeHealthImportAction(sessionId);
    expect(finalized.ok).toBe(true);
    expect(await prisma.healthMetric.count()).toBe(0);
    expect(await prisma.healthImportBatch.count()).toBe(0);

    const confirmed = await confirmHealthImportAction({ token: sessionId, categories: ["steps"] });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.data.imported).toBe(2);
    expect(await prisma.healthMetric.count({ where: { userId: alice.id, type: "steps" } })).toBe(2);

    // The session is gone after confirm; summaries were rebuilt.
    expect(await prisma.healthImportSession.count()).toBe(0);
    const summary = await prisma.calendarDaySummary.findFirst({
      where: { userId: alice.id, date: D1 },
    });
    expect(summary?.steps).toBe(10000);
  });

  it("re-importing the same rows reports duplicates and writes nothing new", async () => {
    const first = await createStagedSession();
    await finalizeHealthImportAction(first);
    await confirmHealthImportAction({ token: first, categories: ["steps"] });

    const second = await createStagedSession();
    const finalized = await finalizeHealthImportAction(second);
    expect(finalized.ok).toBe(true);
    if (finalized.ok) {
      const steps = finalized.data.categories.find((c) => c.key === "steps");
      expect(steps?.newRows).toBe(0);
      expect(steps?.unchangedRows).toBe(2);
    }

    const confirmed = await confirmHealthImportAction({ token: second, categories: ["steps"] });
    expect(confirmed.ok).toBe(true);
    if (confirmed.ok) expect(confirmed.data.imported).toBe(0);
    expect(await prisma.healthMetric.count()).toBe(2);
  });

  it("cancel removes the staged data", async () => {
    const sessionId = await createStagedSession();
    await cancelHealthImportAction(sessionId);
    expect(await prisma.healthImportSession.count()).toBe(0);
    expect(await prisma.healthImportChunk.count()).toBe(0);
  });

  it("expired sessions are swept when the next session is created", async () => {
    const sessionId = await createStagedSession();
    await prisma.healthImportSession.update({
      where: { id: sessionId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await createHealthImportSessionAction(META);
    expect(await prisma.healthImportSession.count({ where: { id: sessionId } })).toBe(0);
  });

  it("batch removal deletes the batch's rows and recomputes the touched days", async () => {
    const sessionId = await createStagedSession();
    await finalizeHealthImportAction(sessionId);
    const confirmed = await confirmHealthImportAction({ token: sessionId, categories: ["steps"] });
    if (!confirmed.ok) throw new Error("confirm failed");

    const removed = await removeImportBatchAction(confirmed.data.batchId);
    expect(removed.ok).toBe(true);
    if (removed.ok) expect(removed.data.removedMetrics).toBe(2);

    expect(await prisma.healthMetric.count()).toBe(0);
    const summary = await prisma.calendarDaySummary.findFirst({
      where: { userId: alice.id, date: D1 },
    });
    expect(summary?.steps).toBeNull();
  });
});
