"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/db";
import { fail, succeed, type ActionResult } from "@/lib/validation";
import {
  confirmHealthImport,
  discardStaged,
  finalizeStagedPreview,
  listImportBatches,
  previewBatchRemoval,
  removeImportBatch,
  type BatchRemovalPreview,
  type ImportOutcome,
  type ImportPreviewResult,
} from "@/server/health-import";
import { appendChunk, createSession } from "@/server/health-import-session";

/**
 * Server actions for the staged health import.
 *
 * The raw export file NEVER travels through these: the browser parses it in a
 * Web Worker and uploads only normalised rows, chunk by bounded chunk, into a
 * session created here — tied to the authenticated user, impossible to point
 * at anyone else. Every row is re-validated server-side at finalize, every
 * fingerprint recomputed. Preview writes no health records; only confirm
 * does. Cancel (and expiry) removes the staged rows.
 */

function revalidateAll() {
  revalidatePath("/", "layout");
}

export async function createHealthImportSessionAction(
  meta: unknown,
): Promise<ActionResult<{ sessionId: string }>> {
  const user = await getCurrentUser();
  const result = await createSession(user.id, meta);
  if (!result.ok) return fail(result.error);
  return succeed({ sessionId: result.sessionId });
}

export async function uploadHealthImportChunkAction(input: {
  sessionId: string;
  seq: number;
  payload: string;
}): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  if (typeof input?.sessionId !== "string" || typeof input?.payload !== "string") {
    return fail("Invalid upload.");
  }
  const result = await appendChunk(user.id, input.sessionId, input.seq, input.payload);
  if (!result.ok) return fail(result.error);
  return succeed(null);
}

export async function finalizeHealthImportAction(
  sessionId: string,
): Promise<ActionResult<ImportPreviewResult>> {
  const user = await getCurrentUser();
  if (typeof sessionId !== "string") return fail("Invalid import session.");
  const result = await finalizeStagedPreview(user.id, sessionId);
  if (!result.ok) return fail(result.error);
  return succeed(result.preview);
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

export async function getImportBatchesAction(): Promise<
  ActionResult<Awaited<ReturnType<typeof listImportBatches>>>
> {
  const user = await getCurrentUser();
  return succeed(await listImportBatches(user.id));
}

export async function previewBatchRemovalAction(
  batchId: string,
): Promise<ActionResult<BatchRemovalPreview>> {
  const user = await getCurrentUser();
  const preview = await previewBatchRemoval(user.id, batchId);
  if (!preview) return fail("Import batch not found or already removed.");
  return succeed(preview);
}

export async function removeImportBatchAction(
  batchId: string,
): Promise<ActionResult<{ removedMetrics: number; removedWorkouts: number }>> {
  const user = await getCurrentUser();
  const result = await removeImportBatch(user.id, batchId);
  if (!result.ok) return fail(result.error);

  revalidateAll();
  return succeed({ removedMetrics: result.removedMetrics, removedWorkouts: result.removedWorkouts });
}
