import type { ImportPreviewResult } from "@/server/health-import";

/**
 * The browser half of the staged health-import upload.
 *
 * An Apple Health `export.zip` cannot be sent as one request body — a hosting
 * platform refuses anything over a few megabytes at the edge, long before the
 * app sees it. So the file is never sent as one request body. It is sliced into
 * parts the server sized, each part is its own request, and a final call
 * reassembles and parses them.
 *
 *   open   → the server agrees the part size and the part count
 *   parts  → one PUT each, a few in flight, each retried on its own
 *   finish → the server reassembles, parses, and answers with the preview
 *
 * Deliberately transport-only: no React, no DOM beyond `File`, no rendering
 * decisions. That keeps the retry and bounding rules directly testable, which
 * matters more here than anywhere else in the import — this is the layer whose
 * failure mode used to be an opaque platform 413.
 *
 * Cancellation is real, not cosmetic: the signal aborts the request in flight
 * *and* the server-side session is deleted, so an abandoned upload does not sit
 * in the account's staging area waiting to expire.
 */

/** Where the upload has got to, in the order the user sees them. */
export type UploadStage =
  | "idle"
  | "preparing"
  | "uploading"
  | "parsing"
  | "preview"
  | "importing"
  | "done";

export interface UploadProgress {
  stage: UploadStage;
  /** Bytes confirmed stored by the server. */
  sent: number;
  total: number;
  parts: number;
  totalParts: number;
}

export interface StageFileOptions {
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
  /** Injected in tests; defaults to the global. */
  fetchImpl?: typeof fetch;
  /** Injected in tests so retry backoff costs no real time. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export type StageFileResult =
  | { ok: true; preview: ImportPreviewResult }
  | { ok: false; error: string; cancelled?: boolean };

/** Parts in flight at once. Enough to fill a link, few enough to be polite. */
const CONCURRENCY = 3;
/** Attempts per part, including the first. */
const PART_ATTEMPTS = 4;
/** First backoff; doubles per attempt. */
const RETRY_BASE_MS = 400;

const OPEN_URL = "/api/health/import";
const PART_URL = "/api/health/import/part";
const FINALIZE_URL = "/api/health/import/finalize";

class UploadFailed extends Error {}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Upload a health export and return the server's preview of it.
 *
 * Resolves — it does not throw — for every outcome the user can act on, so a
 * caller never has to distinguish "the server refused this file" from "the
 * network died" by inspecting an exception.
 */
export async function stageHealthFile(
  file: File,
  options: StageFileOptions = {},
): Promise<StageFileResult> {
  const call = options.fetchImpl ?? fetch;
  const sleep = options.sleepImpl ?? defaultSleep;
  const signal = options.signal;
  let uploadId: string | null = null;

  const report = (stage: UploadStage, sent: number, total: number, parts: number, totalParts: number) =>
    options.onProgress?.({ stage, sent, total, parts, totalParts });

  try {
    report("preparing", 0, file.size, 0, 0);

    const opened = await readJson(
      await call(OPEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileName: file.name, fileSize: file.size }),
        signal,
      }),
    );
    if (!opened.ok) throw new UploadFailed(opened.error);

    const { uploadId: id, partBytes, totalParts } = opened as unknown as {
      uploadId: string;
      partBytes: number;
      totalParts: number;
    };
    uploadId = id;

    // --- the parts ---------------------------------------------------------
    report("uploading", 0, file.size, 0, totalParts);
    let done = 0;
    let sent = 0;

    let cursor = 0;
    // `Promise.all` rejects on the first failure but leaves its siblings
    // running. Without this they would keep PUTting parts into a session that
    // is about to be abandoned, which is wasted bandwidth on exactly the
    // connection that just proved it is unreliable.
    let stopped = false;

    const worker = async () => {
      while (!stopped && cursor < totalParts) {
        const seq = cursor++;
        throwIfAborted(signal);

        const start = seq * partBytes;
        const slice = file.slice(start, Math.min(start + partBytes, file.size));
        try {
          await putPart(call, sleep, signal, id, seq, slice);
        } catch (error) {
          stopped = true;
          throw error;
        }

        done += 1;
        sent += slice.size;
        report("uploading", sent, file.size, done, totalParts);
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, totalParts) }, worker));

    // --- the parse ---------------------------------------------------------
    report("parsing", file.size, file.size, totalParts, totalParts);
    const finished = await readJson(
      await call(FINALIZE_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uploadId: id }),
        signal,
      }),
    );
    if (!finished.ok) throw new UploadFailed(finished.error);

    // The parse consumed the staged parts; there is nothing left to abandon.
    uploadId = null;
    report("preview", file.size, file.size, totalParts, totalParts);
    return { ok: true, preview: (finished as unknown as { preview: ImportPreviewResult }).preview };
  } catch (error) {
    if (uploadId) void abandonUpload(call, uploadId);
    if (isAbort(error, signal)) {
      return { ok: false, error: "The upload was cancelled. Nothing was imported.", cancelled: true };
    }
    if (error instanceof UploadFailed) return { ok: false, error: error.message };
    return { ok: false, error: "The upload did not complete. Nothing was imported." };
  }
}

/**
 * One part, retried.
 *
 * A part is idempotent server-side — `(session, index)` is unique — so a retry
 * after a dropped connection is safe by construction rather than by hope. A
 * refusal the server *meant* (too large, expired, not yours) is not retried:
 * it would fail identically and only delay telling the user.
 */
async function putPart(
  call: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  signal: AbortSignal | undefined,
  uploadId: string,
  seq: number,
  slice: Blob,
): Promise<void> {
  let lastError = "That part could not be uploaded.";
  for (let attempt = 0; attempt < PART_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal);
    try {
      const response = await call(`${PART_URL}?upload=${encodeURIComponent(uploadId)}&seq=${seq}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: slice,
        signal,
      });
      if (response.ok) return;

      const payload = await readJson(response);
      lastError = payload.ok ? lastError : payload.error;
      // 4xx other than 408/429 is a decision, not a hiccup.
      if (response.status < 500 && response.status !== 408 && response.status !== 429) {
        throw new UploadFailed(lastError);
      }
    } catch (error) {
      if (error instanceof UploadFailed) throw error;
      if (isAbort(error, signal)) throw error;
    }
    if (attempt < PART_ATTEMPTS - 1) await sleep(RETRY_BASE_MS * 2 ** attempt);
  }
  throw new UploadFailed(lastError);
}

/**
 * Tell the server to drop a session we are giving up on.
 *
 * `keepalive` is what makes this work in the case that matters most: closing
 * the tab mid-upload. Without it the browser cancels the in-flight request as
 * the page goes away, the session survives until it expires, and the account
 * spends one of its two upload slots on an upload nobody is performing. With
 * it the request outlives the document. (No body, so the 64 KB keepalive
 * budget is irrelevant.)
 *
 * Still best-effort by design — the sweep removes an abandoned session anyway,
 * so a failure here must never become the error the user sees instead of the
 * real one.
 */
async function abandonUpload(call: typeof fetch, uploadId: string): Promise<void> {
  try {
    await call(`${OPEN_URL}?upload=${encodeURIComponent(uploadId)}`, {
      method: "DELETE",
      keepalive: true,
    });
  } catch {
    // Deliberately ignored — see above.
  }
}

type JsonPayload = { ok: true; [key: string]: unknown } | { ok: false; error: string };

/**
 * Read a JSON envelope, tolerating a response that is not one.
 *
 * A platform-level rejection (a proxy 413, a gateway 502) answers with HTML,
 * not JSON. The old client called `.json()` unguarded and turned every such
 * failure into "the upload did not complete" — which is exactly the message
 * that made the payload-limit bug so hard to diagnose. Anything unparseable now
 * reports the status it actually got.
 */
async function readJson(response: Response): Promise<JsonPayload> {
  try {
    const payload = (await response.json()) as JsonPayload;
    if (payload && typeof payload === "object" && "ok" in payload) return payload;
  } catch {
    // fall through to the status-based message
  }
  if (response.ok) return { ok: false, error: "The server sent an unreadable response." };
  if (response.status === 413) {
    return {
      ok: false,
      error:
        "The hosting platform refused the request as too large. This should not happen with a " +
        "staged upload — please report it.",
    };
  }
  return { ok: false, error: `The server refused the upload (${response.status}).` };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}
