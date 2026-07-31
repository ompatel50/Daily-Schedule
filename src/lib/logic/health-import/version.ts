/**
 * Which version of the import pipeline wrote a batch.
 *
 *   1 — the original. A re-import overwrote any row whose fingerprint matched,
 *       whoever had last touched it.
 *   2 — server-streamed parsing plus smart merge: a row the user has edited, or
 *       that no import wrote, is protected and reported rather than overwritten
 *       (see `merge.ts`).
 *
 * Stamped on every batch (`HealthImportBatch.formatVersion`) so the history can
 * say what a run's counts meant, and so a future change has something to
 * migrate *from* rather than having to infer an old batch's semantics from its
 * dates.
 *
 * Lives here — a plain module, neither `server-only` nor `"use client"` —
 * because the server writes it and the history component reads it, and one
 * constant two files agree on beats two constants a test has to keep in step.
 */
export const IMPORT_FORMAT_VERSION = 2;
