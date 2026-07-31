import { describe, expect, it } from "vitest";

import {
  EMPTY_MERGE_COUNTS,
  MERGE_GRACE_MS,
  countMerge,
  decideMerge,
  protectedSummary,
  totalProtected,
  type BatchBoundaries,
  type MergeCounts,
  type StoredRow,
} from "@/lib/logic/health-import/merge";

/**
 * The smart-merge rule: what a re-import does with a reading it has seen
 * before. The property that matters most is the negative one — an import must
 * never write over a value the user made their own — so most of this file is
 * about the cases where nothing happens.
 */

const IMPORT_FINISHED = new Date("2026-07-01T10:00:00.000Z");
const BATCH = "batch-1";
const boundaries: BatchBoundaries = new Map([[BATCH, IMPORT_FINISHED]]);

function stored(overrides: Partial<StoredRow> = {}): StoredRow {
  return {
    id: "row-1",
    value: 8000,
    source: "apple_health",
    batchId: BATCH,
    updatedAt: IMPORT_FINISHED,
    ...overrides,
  };
}

describe("decideMerge", () => {
  it("creates when nothing exists on the fingerprint", () => {
    expect(decideMerge({ fingerprint: "f", value: 8000 }, undefined, boundaries)).toEqual({
      decision: "create",
      reason: null,
    });
  });

  it("reports an identical value as unchanged, without deciding ownership", () => {
    // Deliberately a row the rule would otherwise protect: when the values
    // already agree there is nothing to protect it from.
    const row = stored({ source: "manual", batchId: null });
    expect(decideMerge({ fingerprint: "f", value: 8000 }, row, boundaries).decision).toBe(
      "unchanged",
    );
  });

  it("treats values inside the float epsilon as the same reading", () => {
    const row = stored({ value: 72.30000000000001 });
    expect(decideMerge({ fingerprint: "f", value: 72.3 }, row, boundaries).decision).toBe(
      "unchanged",
    );
  });

  it("merges a row the import itself wrote and has not been touched since", () => {
    // A later export carries the rest of the day, so the fuller value wins.
    const row = stored({ value: 8000 });
    expect(decideMerge({ fingerprint: "f", value: 11_500 }, row, boundaries)).toEqual({
      decision: "merge",
      reason: null,
    });
  });

  it("protects a row the user edited after the import finished", () => {
    const row = stored({
      value: 8000,
      updatedAt: new Date(IMPORT_FINISHED.getTime() + 60_000),
    });
    expect(decideMerge({ fingerprint: "f", value: 11_500 }, row, boundaries)).toEqual({
      decision: "protected",
      reason: "user_edited",
    });
  });

  it("does not mistake the import's own writes for an edit", () => {
    // `finishedAt` and the row's `updatedAt` are set microseconds apart inside
    // the same transaction. Without the grace, an import would protect every
    // row it had just written from the next import.
    const row = stored({
      value: 8000,
      updatedAt: new Date(IMPORT_FINISHED.getTime() + MERGE_GRACE_MS),
    });
    expect(decideMerge({ fingerprint: "f", value: 11_500 }, row, boundaries).decision).toBe(
      "merge",
    );
  });

  it("uses the same grace as undo, so the two rules cannot disagree", async () => {
    const { UNDO_GRACE_MS } = await import("@/lib/logic/health-import/undo");
    // A row protected from re-import but removable by undo (or vice versa)
    // would be a contradiction the user could observe.
    expect(MERGE_GRACE_MS).toBe(UNDO_GRACE_MS);
  });

  it("protects a hand-entered reading", () => {
    const row = stored({ source: "manual", batchId: null, value: 8000 });
    expect(decideMerge({ fingerprint: "f", value: 11_500 }, row, boundaries)).toEqual({
      decision: "protected",
      reason: "not_imported",
    });
  });

  it("protects a row with a source of its own but no batch — a restored backup", () => {
    const row = stored({ source: "apple_health", batchId: null, value: 8000 });
    expect(decideMerge({ fingerprint: "f", value: 11_500 }, row, boundaries).decision).toBe(
      "protected",
    );
  });

  it("protects a row whose batch does not resolve — ambiguous ownership is hands off", () => {
    // The boundaries map is built from batches scoped to THIS user, so an id
    // that does not resolve is either another account's or a deleted batch.
    // Either way the import has no claim on the row.
    const row = stored({ batchId: "someone-elses-batch", value: 8000 });
    expect(decideMerge({ fingerprint: "f", value: 11_500 }, row, boundaries)).toEqual({
      decision: "protected",
      reason: "not_imported",
    });
  });

  it("falls back to a batch's createdAt boundary when it never recorded finishedAt", () => {
    // Batches written before `finishedAt` existed; the server passes createdAt.
    const legacy: BatchBoundaries = new Map([["legacy", new Date("2026-01-01T00:00:00.000Z")]]);
    const untouched = stored({
      batchId: "legacy",
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(decideMerge({ fingerprint: "f", value: 1 }, untouched, legacy).decision).toBe("merge");

    const edited = stored({
      batchId: "legacy",
      updatedAt: new Date("2026-03-01T00:00:00.000Z"),
    });
    expect(decideMerge({ fingerprint: "f", value: 1 }, edited, legacy).decision).toBe("protected");
  });
});

describe("counting and reporting", () => {
  function counts(): MergeCounts {
    return { ...EMPTY_MERGE_COUNTS };
  }

  it("tallies every decision into its own bucket", () => {
    const tally = counts();
    countMerge({ decision: "create", reason: null }, tally);
    countMerge({ decision: "create", reason: null }, tally);
    countMerge({ decision: "merge", reason: null }, tally);
    countMerge({ decision: "unchanged", reason: null }, tally);
    countMerge({ decision: "protected", reason: "user_edited" }, tally);
    countMerge({ decision: "protected", reason: "not_imported" }, tally);
    countMerge({ decision: "protected", reason: "not_imported" }, tally);

    expect(tally).toEqual({
      create: 2,
      merge: 1,
      unchanged: 1,
      protectedEdited: 1,
      protectedForeign: 2,
    });
    expect(totalProtected(tally)).toBe(3);
  });

  it("says nothing when nothing was protected", () => {
    expect(protectedSummary(counts())).toBeNull();
  });

  it("names both reasons, so a skip is never silent", () => {
    const tally = { ...counts(), protectedEdited: 2, protectedForeign: 1 };
    const summary = protectedSummary(tally) ?? "";
    expect(summary).toContain("3 readings");
    expect(summary).toContain("2 you edited after importing");
    expect(summary).toContain("1 entered outside an import");
    expect(summary).toContain("not written");
  });

  it("reads correctly for a single row", () => {
    const summary = protectedSummary({ ...counts(), protectedEdited: 1 }) ?? "";
    expect(summary).toContain("1 reading will be left exactly as it is");
  });
});
