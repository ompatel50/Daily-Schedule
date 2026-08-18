import "server-only";

import { readFile, rm } from "node:fs/promises";

import { inspectBackup, type BackupCompatibility } from "@/lib/backup-format";
import { importBackup } from "@/server/actions/backup";

export type ImportMode = "merge" | "replace";
import { resolveUploadLimit, type UploadLimit } from "@/server/apple-health/limits";
import {
  assembleUpload,
  discardUpload,
  openUpload,
  receivePart,
  releaseUpload,
  type OpenedUpload,
  type UploadProgress,
  type UploadResult,
} from "@/server/health-upload/session";

/**
 * The staged BACKUP import — the health importer's transport, reused verbatim
 * for backup JSON. A backup used to travel as one server-action body, which a
 * hosted platform caps far below a real archive of one's life; now it is
 * sliced into the same bounded, owner-checked, idempotent parts, with the
 * same sweep-on-abandon behaviour, under `kind: "backup"` so neither
 * consumer can ever be fed the other's bytes.
 *
 * Two-phase, preserving the panel's preview-then-confirm contract:
 *
 *   preview → assemble the parts, JSON.parse, `inspectBackup`, then RELEASE
 *             the session — nothing written, parts intact for the confirm.
 *   import  → assemble again, parse again, run the ordinary `importBackup`
 *             (safety and remapping identical to the small-file path), then
 *             discard the session for good.
 */

/**
 * The backup-specific ceiling. Tighter than the health archive's, because the
 * finalize must hold the DECODED JSON in memory to restore it — an archive
 * streams, a backup does not. 64 MB of backup JSON is hundreds of thousands
 * of records; the previous one-request path capped out around 4 MB hosted.
 */
export const BACKUP_MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

export function backupUploadLimit(): UploadLimit {
  const base = resolveUploadLimit();
  return base.bytes <= BACKUP_MAX_UPLOAD_BYTES
    ? base
    : { bytes: BACKUP_MAX_UPLOAD_BYTES, reason: "app", platformBound: false };
}

export function openBackupUpload(
  userId: string,
  input: { fileName: unknown; fileSize: unknown },
): Promise<UploadResult<OpenedUpload>> {
  return openUpload(userId, input, backupUploadLimit(), "backup");
}

export function receiveBackupPart(
  userId: string,
  input: { uploadId: unknown; seq: unknown; body: ReadableStream<Uint8Array> | null },
): Promise<UploadResult<UploadProgress>> {
  return receivePart(userId, input, backupUploadLimit());
}

export type FinalizeBackupResult =
  | { action: "preview"; inspection: BackupCompatibility; fileName: string }
  | { action: "import"; report: Awaited<ReturnType<typeof importBackup>> };

/**
 * Assemble the staged parts and either inspect or restore them. `userId` is
 * the authenticated caller's — the session resolves by (id, owner, kind), so
 * another account's id simply does not exist here.
 */
export async function finalizeBackupUpload(
  userId: string,
  uploadId: unknown,
  request: { action: "preview" } | { action: "import"; mode: ImportMode },
): Promise<UploadResult<FinalizeBackupResult>> {
  const assembled = await assembleUpload(userId, uploadId, backupUploadLimit(), "backup");
  if (!assembled.ok) return assembled;
  const { path, directory, fileName } = assembled.data;

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    // Deterministic — retrying would fail identically, so the parts go too.
    await discardUpload(userId, uploadId);
    return { ok: false, error: "That file isn't valid JSON.", status: 400 };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }

  if (request.action === "preview") {
    const inspection = inspectBackup(parsed);
    if (!inspection.ok) {
      // An incompatible file will stay incompatible; free the staged bytes.
      await discardUpload(userId, uploadId);
    } else {
      await releaseUpload(userId, uploadId);
    }
    return { ok: true, data: { action: "preview", inspection, fileName } };
  }

  const report = await importBackup(parsed, request.mode);
  await discardUpload(userId, uploadId);
  return { ok: true, data: { action: "import", report } };
}
