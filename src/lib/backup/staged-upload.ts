import type { BackupCompatibility } from "@/lib/backup-format";

/**
 * The browser half of the staged backup import — the health importer's
 * transport (src/lib/health/staged-upload.ts), reused for backup JSON.
 *
 *   open    → the server sizes the upload (part size, part count)
 *   parts   → one PUT each, retried individually over a flaky connection
 *   preview → the server assembles, inspects, and hands the parts back
 *   import  → the server assembles again and runs the ordinary restore
 *
 * Transport-only: no React, no DOM beyond `File`. A small file never comes
 * here — the panel keeps the one-request server-action path below the
 * platform's body cap, and stages only what that path cannot carry.
 */

export interface BackupUploadProgress {
  /** Bytes confirmed stored by the server. */
  sent: number;
  total: number;
}

export interface StagedBackupPreview {
  uploadId: string;
  inspection: BackupCompatibility;
  fileName: string;
}

export type StagedBackupResult =
  | { ok: true; preview: StagedBackupPreview }
  | { ok: false; error: string };

const OPEN_URL = "/api/backup/import";
const PART_URL = "/api/backup/import/part";
const FINALIZE_URL = "/api/backup/import/finalize";

const PART_ATTEMPTS = 4;
const RETRY_BASE_MS = 400;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Upload the file and return the server's inspection of it. Nothing written. */
export async function stageBackupFile(
  file: File,
  onProgress?: (progress: BackupUploadProgress) => void,
): Promise<StagedBackupResult> {
  const opened = await readJson(
    await fetch(OPEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fileName: file.name, fileSize: file.size }),
    }),
  );
  if (opened.ok !== true) {
    return { ok: false, error: String(opened.error ?? "The upload could not be started.") };
  }
  const uploadId = String(opened.uploadId);
  const partBytes = Number(opened.partBytes);
  const totalParts = Number(opened.totalParts);

  let sent = 0;
  for (let seq = 0; seq < totalParts; seq += 1) {
    const slice = file.slice(seq * partBytes, Math.min(file.size, (seq + 1) * partBytes));
    let stored = false;
    for (let attempt = 0; attempt < PART_ATTEMPTS && !stored; attempt += 1) {
      if (attempt > 0) await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
      try {
        const response = await fetch(`${PART_URL}?upload=${uploadId}&seq=${seq}`, {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: slice,
        });
        if (response.ok) stored = true;
        else if (response.status < 500) {
          const body = await readJson(response);
          await abandonStagedBackup(uploadId);
          return { ok: false, error: String(body.error ?? "That part was refused.") };
        }
      } catch {
        // Network hiccup — the retry loop covers it.
      }
    }
    if (!stored) {
      await abandonStagedBackup(uploadId);
      return { ok: false, error: "The connection kept dropping. Try again." };
    }
    sent += slice.size;
    onProgress?.({ sent, total: file.size });
  }

  const finalized = await readJson(
    await fetch(FINALIZE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uploadId, action: "preview" }),
    }),
  );
  if (finalized.ok !== true) {
    return { ok: false, error: String(finalized.error ?? "The backup could not be read.") };
  }
  return {
    ok: true,
    preview: {
      uploadId,
      inspection: finalized.inspection as BackupCompatibility,
      fileName: String(finalized.fileName ?? file.name),
    },
  };
}

/** Run the import against a previously previewed staged upload. */
export async function importStagedBackup(
  uploadId: string,
  mode: "merge" | "replace",
): Promise<{ ok: true; report: unknown } | { ok: false; error: string }> {
  const finalized = await readJson(
    await fetch(FINALIZE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uploadId, action: "import", mode }),
    }),
  );
  if (finalized.ok !== true) {
    return { ok: false, error: String(finalized.error ?? "The import failed.") };
  }
  return { ok: true, report: finalized.report };
}

/** Delete a staged upload the user walked away from. Best-effort. */
export async function abandonStagedBackup(uploadId: string): Promise<void> {
  await fetch(`${OPEN_URL}?upload=${uploadId}`, { method: "DELETE" }).catch(() => {});
}
