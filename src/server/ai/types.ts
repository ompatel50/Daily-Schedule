import "server-only";

/**
 * Outcome types for the assistant's one external dependency: the user's own
 * Ollama server. Deliberately a sibling of src/server/providers/types.ts
 * rather than a reuse — those types are food-search-typed, and the assistant
 * must not drag food vocabulary into AI code — but the shape and the
 * discipline are identical: failures are returned, never thrown; messages
 * are app-authored prose that never echoes a URL, a key or a response body.
 */

export type AiFailureReason =
  | "not_configured"
  | "unavailable"
  | "timeout"
  | "bad_response";

export interface AiFailure {
  reason: AiFailureReason;
  /** Safe to show a user. Never contains the base URL or a response body. */
  message: string;
}

export type AiOutcome<T> = { ok: true; data: T } | { ok: false; failure: AiFailure };

export function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

export function failure(reason: AiFailureReason, message: string): { ok: false; failure: AiFailure } {
  return { ok: false, failure: { reason, message } };
}

export function classifyThrown(error: unknown): AiFailure {
  if (error instanceof Error && error.name === "AbortError") {
    return { reason: "timeout", message: "The Ollama server did not respond in time." };
  }
  return {
    reason: "unavailable",
    message: "Could not reach the Ollama server. Is it running?",
  };
}
