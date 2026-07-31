"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/db";
import { fail, succeed, type ActionResult } from "@/lib/validation";
import {
  confirmHealthImport,
  discardStaged,
  getStagedPreview,
  listImportBatches,
  previewBatchRemoval,
  removeImportBatch,
  type BatchRemovalPreview,
  type BatchRemovalReport,
  type ImportBatchSummary,
  type ImportOutcome,
  type ImportPreviewResult,
} from "@/server/health-import";

/**
 * Server actions for the staged health import.
 *
 * The file itself never travels through an action — it is streamed to
 * `/api/health/import`, parsed there on the server, and staged. These actions
 * cover everything after that: fetching a staged preview, confirming it,
 * cancelling it, listing the history, and undoing an import.
 *
 * Every one of them resolves the user from the session and passes that id
 * down; no action accepts a user id, so a token or batch id belonging to
 * another account simply does not resolve.
 */

function revalidateAll() {
  revalidatePath("/", "layout");
}

export async function getHealthImportPreviewAction(
  token: string,
): Promise<ActionResult<ImportPreviewResult>> {
  const user = await getCurrentUser();
  if (typeof token !== "string") return fail("Invalid import session.");
  const preview = await getStagedPreview(user.id, token);
  if (!preview) return fail("This import session has expired. Upload the file again.");
  return succeed(preview);
}

export async function confirmHealthImportAction(input: {
  token: string;
  categories: string[];
}): Promise<ActionResult<ImportOutcome>> {
  const user = await getCurrentUser();
  if (typeof input?.token !== "string" || !Array.isArray(input?.categories)) {
    return fail("Invalid import confirmation.");
  }
  const categories = input.categories.filter((value): value is string => typeof value === "string");

  const result = await confirmHealthImport(user.id, input.token, categories);
  if (!result.ok) return fail(result.error);

  revalidateAll();
  return succeed(result.outcome);
}

export async function cancelHealthImportAction(token: string): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  if (typeof token === "string") await discardStaged(user.id, token);
  return succeed(null);
}

export async function getImportBatchesAction(): Promise<ActionResult<ImportBatchSummary[]>> {
  const user = await getCurrentUser();
  return succeed(await listImportBatches(user.id));
}

export async function previewBatchRemovalAction(
  batchId: string,
): Promise<ActionResult<BatchRemovalPreview>> {
  const user = await getCurrentUser();
  if (typeof batchId !== "string") return fail("Invalid import batch.");
  const preview = await previewBatchRemoval(user.id, batchId);
  if (!preview) return fail("Import batch not found or already undone.");
  return succeed(preview);
}

export async function removeImportBatchAction(
  batchId: string,
): Promise<ActionResult<BatchRemovalReport>> {
  const user = await getCurrentUser();
  if (typeof batchId !== "string") return fail("Invalid import batch.");
  const result = await removeImportBatch(user.id, batchId);
  if (!result.ok) return fail(result.error);

  revalidateAll();
  return succeed(result.report);
}
