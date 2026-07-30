import "server-only";

import { randomBytes } from "node:crypto";

/**
 * Client-safe failure reporting.
 *
 * Raw error text can carry SQL fragments, file paths or provider details —
 * none of which belongs in a browser. The full error goes to the server log
 * under a short reference id; the caller sends the user only the reference,
 * so a report like "import failed, reference a1b2c3" can be correlated with
 * the log line without ever exposing internals.
 */
export function logRedactedError(context: string, error: unknown): string {
  const reference = randomBytes(4).toString("hex");
  const message = error instanceof Error ? error.message : String(error);
  // Message text only — never request payloads or record contents.
  console.error(`[${context}] ref=${reference} ${message.slice(0, 500)}`);
  return reference;
}
