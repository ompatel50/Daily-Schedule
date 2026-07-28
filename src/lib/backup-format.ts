/**
 * Backup format v1.
 *
 * The whole database belongs to one user, so a backup is simply every table
 * serialised as JSON. IDs are preserved: restoring into an empty database
 * reproduces the original graph exactly, and re-importing the same file is a
 * no-op rather than a duplicate (import is upsert-by-id).
 *
 * Lives outside the `"use server"` module because a server-actions file may
 * only export async functions.
 */
export const BACKUP_VERSION = 1;

export interface BackupFile {
  version: number;
  exportedAt: string;
  app: "personal-os";
  data: Record<string, unknown[]>;
}

export type CsvTable = "schedule" | "habits" | "nutrition" | "workouts" | "health";
