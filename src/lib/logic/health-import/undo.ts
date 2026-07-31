/**
 * What an import undo does with each row that import created — pure, so the
 * rule is testable without a database.
 *
 * The philosophy is the one finance imports already use: **an undo removes the
 * import's own work and nothing else.** Two things stop a row being the
 * import's own work any more:
 *
 *   keep_edited  — the row changed after the import finished. Something wrote
 *                  to it since, and that something was the user (nothing else
 *                  in the app touches an imported health row: day-score and
 *                  calendar rebuilds write to summaries, never to metrics). A
 *                  row you have corrected is yours, so undo leaves it.
 *   keep_linked  — the row has become part of something else. An imported
 *                  workout you have since added sets to, or scheduled a
 *                  planner block from, is no longer just an import artefact;
 *                  deleting it would take that work with it.
 *   remove       — untouched since the import wrote it. This is the row the
 *                  undo exists to delete.
 *
 * The boundary instant is the batch's own `finishedAt` (falling back to
 * `createdAt` for a batch written before that column existed). A one-second
 * grace covers the ordinary case where the row's `updatedAt` and the batch's
 * `finishedAt` are set microseconds apart inside the same transaction — an
 * import must not classify its own writes as edits.
 */

export type HealthUndoDecision = "remove" | "keep_edited" | "keep_linked";

export interface HealthUndoCandidate {
  id: string;
  /** When the row was last written. */
  updatedAt: Date;
  /** True when something else now depends on the row. */
  linked: boolean;
}

/** Writes inside the import's own transaction may land just after `finishedAt`. */
export const UNDO_GRACE_MS = 1_000;

export function classifyHealthUndoRow(
  row: HealthUndoCandidate,
  importFinishedAt: Date,
): HealthUndoDecision {
  if (row.linked) return "keep_linked";
  return row.updatedAt.getTime() > importFinishedAt.getTime() + UNDO_GRACE_MS
    ? "keep_edited"
    : "remove";
}

export interface HealthUndoPlan {
  /** Ids the undo will delete. */
  removeIds: string[];
  removeCount: number;
  keptEdited: number;
  keptLinked: number;
  keptCount: number;
}

/** Split a batch's rows into "undo removes this" and "undo keeps this". */
export function planHealthUndo(
  rows: HealthUndoCandidate[],
  importFinishedAt: Date,
): HealthUndoPlan {
  const removeIds: string[] = [];
  let keptEdited = 0;
  let keptLinked = 0;
  for (const row of rows) {
    const decision = classifyHealthUndoRow(row, importFinishedAt);
    if (decision === "remove") removeIds.push(row.id);
    else if (decision === "keep_edited") keptEdited += 1;
    else keptLinked += 1;
  }
  return {
    removeIds,
    removeCount: removeIds.length,
    keptEdited,
    keptLinked,
    keptCount: keptEdited + keptLinked,
  };
}
