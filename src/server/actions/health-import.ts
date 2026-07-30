"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/db";
import { fail, succeed, type ActionResult } from "@/lib/validation";
import {
  confirmHealthImport,
  discardStaged,
  listImportBatches,
  MAX_IMPORT_BYTES,
  previewBatchRemoval,
  previewHealthFile,
  removeImportBatch,
  type BatchRemovalPreview,
  type ImportOutcome,
  type ImportPreviewResult,
} from "@/server/health-import";

/**
 * Server actions for the staged health import. The heavy lifting (parsing,
 * staging, transactional writes, batch removal) lives in
 * `src/server/health-import.ts`; these wrappers add the user, the input
 * validation and the cache revalidation. Preview writes nothing; only confirm
 * does. The uploaded file is parsed and discarded — it never leaves this
 * machine and is never retained.
 */

function revalidateAll() {
  revalidatePath("/", "layout");
}

export async function previewHealthImportAction(
  formData: FormData,
): Promise<ActionResult<ImportPreviewResult>> {
  const user = await getCurrentUser();

  const file = formData.get("file");
  if (!(file instanceof File)) return fail("No file was uploaded.");
  if (file.size === 0) return fail("The file is empty.");
  if (file.size > MAX_IMPORT_BYTES) {
    return fail("That file is larger than 400 MB, which this importer cannot stage safely.");
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const result = await previewHealthFile(user.id, file.name, bytes);
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
  await getCurrentUser();
  if (typeof token === "string") await discardStaged(token);
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
