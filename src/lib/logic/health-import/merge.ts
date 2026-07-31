/**
 * What a re-import does with a reading it has seen before — pure, so the rule
 * is testable without a database, and shared by the preview and the write so
 * the two can never disagree about what is about to happen.
 *
 * ## The problem this solves
 *
 * A fingerprint is a stable identity, not a claim of ownership. Import the same
 * export twice and the second run finds rows it wrote itself — fine, refresh
 * them. But a row can also have become *yours* since: you corrected a weight
 * the scale got wrong, or fixed a step count from a day the watch double
 * counted. Overwriting that silently is the one unrecoverable thing an import
 * can do, because the file is the authority and your correction is not in it.
 *
 * Undo already draws exactly this line (`undo.ts`): a row written to after the
 * import finished belongs to the user, so undo keeps it. A re-import has to
 * honour the same line, or undo protects an edit that the next import quietly
 * destroys.
 *
 * ## The rules, in order
 *
 *   create     — nothing exists on this fingerprint. Write it.
 *   unchanged  — the stored value already equals the incoming one. Nothing to
 *                do; counted so the history can say "already present".
 *   protected  — the stored row is not the import's to change:
 *                  * it was entered by hand or by another source, or
 *                  * an import wrote it but the user has edited it since.
 *                Left exactly as it is, and *reported* — a skip the user is
 *                never told about is indistinguishable from data loss.
 *   merge      — the import owns the row and the file has a different value.
 *                Take the file's, which is the fuller one: a later export
 *                contains the rest of a day the earlier one caught mid-way.
 *
 * Conservative on purpose. Where ownership is ambiguous the answer is
 * `protected`: refusing to write is always recoverable (import again after
 * deleting the row), and overwriting is not.
 */

/** Values within this of each other are the same reading, not a change. */
export const VALUE_EPSILON = 1e-6;

/**
 * Writes inside an import's own transaction can land microseconds after the
 * batch's `finishedAt`. The same grace `undo.ts` uses, for the same reason and
 * deliberately the same number: the two rules must agree on where an import's
 * own work ends, or a row could be protected from re-import yet removed by undo.
 */
export { UNDO_GRACE_MS as MERGE_GRACE_MS } from "./undo";
import { UNDO_GRACE_MS } from "./undo";

export type MergeDecision = "create" | "merge" | "unchanged" | "protected";

/** Why a row was protected — shown to the user, never just a count. */
export type ProtectReason = "user_edited" | "not_imported";

export interface IncomingRow {
  fingerprint: string;
  value: number;
}

export interface StoredRow {
  id: string;
  value: number;
  /** manual | apple_health | csv | workout | calculated | estimated. */
  source: string;
  /** The import that last wrote this row, if any. */
  batchId: string | null;
  updatedAt: Date;
}

export interface MergeOutcome {
  decision: MergeDecision;
  reason: ProtectReason | null;
}

/**
 * When each past import finished, so "edited since" can be answered per row.
 * Keyed by batch id; a batch this account does not own is simply absent, which
 * makes its rows unreachable rather than merge-able.
 */
export type BatchBoundaries = ReadonlyMap<string, Date>;

export function decideMerge(
  incoming: IncomingRow,
  stored: StoredRow | undefined,
  boundaries: BatchBoundaries,
): MergeOutcome {
  if (!stored) return { decision: "create", reason: null };

  if (Math.abs(stored.value - incoming.value) < VALUE_EPSILON) {
    // Identical either way — no need to decide who owns it.
    return { decision: "unchanged", reason: null };
  }

  // A row no import wrote is not an import's to overwrite. `source` alone is
  // not enough: a restored backup carries the original source but may have lost
  // its batch link, and a row with no batch has no import that can claim it.
  if (stored.batchId === null || stored.source === "manual") {
    return { decision: "protected", reason: "not_imported" };
  }

  const finishedAt = boundaries.get(stored.batchId);
  if (!finishedAt) {
    // The batch that wrote this row is unknown here — another account's id, or
    // a batch deleted out from under it. Ambiguous ownership means hands off.
    return { decision: "protected", reason: "not_imported" };
  }

  if (stored.updatedAt.getTime() > finishedAt.getTime() + UNDO_GRACE_MS) {
    return { decision: "protected", reason: "user_edited" };
  }

  return { decision: "merge", reason: null };
}

export interface MergeCounts {
  create: number;
  merge: number;
  unchanged: number;
  protectedEdited: number;
  protectedForeign: number;
}

export const EMPTY_MERGE_COUNTS: MergeCounts = {
  create: 0,
  merge: 0,
  unchanged: 0,
  protectedEdited: 0,
  protectedForeign: 0,
};

export function countMerge(outcome: MergeOutcome, into: MergeCounts): void {
  switch (outcome.decision) {
    case "create":
      into.create += 1;
      break;
    case "merge":
      into.merge += 1;
      break;
    case "unchanged":
      into.unchanged += 1;
      break;
    case "protected":
      if (outcome.reason === "user_edited") into.protectedEdited += 1;
      else into.protectedForeign += 1;
      break;
  }
}

export function totalProtected(counts: MergeCounts): number {
  return counts.protectedEdited + counts.protectedForeign;
}

/**
 * One sentence for the preview and the history, or null when there is nothing
 * to say. Written for someone who has not read any of the above.
 */
export function protectedSummary(counts: MergeCounts): string | null {
  const total = totalProtected(counts);
  if (total === 0) return null;
  const parts: string[] = [];
  if (counts.protectedEdited > 0) {
    parts.push(`${counts.protectedEdited} you edited after importing`);
  }
  if (counts.protectedForeign > 0) {
    parts.push(`${counts.protectedForeign} entered outside an import`);
  }
  return (
    `${total} reading${total === 1 ? "" : "s"} will be left exactly as ${total === 1 ? "it is" : "they are"} ` +
    `(${parts.join(", ")}). The file's values for ${total === 1 ? "it" : "them"} are not written.`
  );
}
