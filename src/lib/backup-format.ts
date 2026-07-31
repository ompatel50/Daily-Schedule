/**
 * Backup format.
 *
 * A backup is one account's records, every table serialised as JSON, in the
 * ids the exporting app used. On import those ids are never trusted: the
 * hosted restore (src/server/backup-restore.ts) deterministically remaps
 * every id into the authenticated account, which preserves all internal
 * relationships, keeps re-importing the same file a no-op rather than a
 * duplicate, and makes it structurally impossible for a file to address
 * another account's rows.
 *
 * Lives outside the `"use server"` module because a server-actions file may
 * only export async functions.
 *
 * ## Versions
 *
 * v1 — the original tables.
 * v2 — adds the shared scheduling tables (`scheduleRules`, `scheduleRuleDays`,
 *      `scheduleOverrides`), manual goal outcomes (`goalEntries`) and demo-data
 *      identification (`seedBatches`, `seedRecords`), plus richer metadata.
 * v3 — adds health import batches (`healthImportBatches`) and the reminder
 *      delivery ledger (`reminderDeliveries`); health metric rows now carry
 *      fingerprints, intervals, sleep stages and batch links.
 * v4 — adds the universal-OS foundation tables: tasks & projects (`projects`,
 *      `tasks`), finance (`financeAccounts`, `bills`, `financeTransactions`,
 *      `savingsGoals`) and the life-admin inbox (`inboxItems`).
 *
 * A v1–v3 file restores into a v4 app unchanged: the missing tables simply
 * have no rows, `npm run db:migrate` backfills an every-day schedule for
 * anything that arrives without one, and metric rows that arrive without a
 * fingerprint get one from the same migration — which is exactly how those
 * records behaved when the older backup was taken.
 */
export const BACKUP_VERSION = 4;

export interface BackupMetadata {
  /** Schema version of the backup format itself. */
  version: number;
  /** The app version that produced the file. */
  appVersion: string;
  exportedAt: string;
  /** The user's timezone at export time — day keys are meaningless without it. */
  timezone: string;
  /** Row count per table, so an import can show a summary before writing. */
  recordCounts: Record<string, number>;
  /** Cheap integrity check over the serialised payload. */
  checksum: string;
}

export interface BackupFile {
  version: number;
  exportedAt: string;
  app: "personal-os";
  meta?: BackupMetadata;
  data: Record<string, unknown[]>;
}

/**
 * Every table a full backup carries, in restore order — parents before the rows
 * that reference them. Export and import both read this list, so adding a table
 * in one place cannot leave the other behind.
 */
export const BACKUP_TABLES = [
  "tags",
  "foodItems",
  "scheduleTemplates",
  "habits",
  "workoutTemplates",
  "workouts",
  "workoutSets",
  "scheduleItems",
  "scheduleItemTags",
  "habitLogs",
  "meals",
  "mealEntries",
  "mealTemplates",
  "mealTemplateItems",
  "healthImportBatches",
  "healthMetrics",
  "goals",
  "goalEntries",
  "scheduleRules",
  "scheduleRuleDays",
  "scheduleOverrides",
  "journalEntries",
  "reminders",
  "reminderDeliveries",
  "favorites",
  "projects",
  "tasks",
  "financeAccounts",
  "bills",
  "financeTransactions",
  "savingsGoals",
  "inboxItems",
  "seedBatches",
  "seedRecords",
] as const;

export type BackupTable = (typeof BACKUP_TABLES)[number];

/**
 * A non-cryptographic checksum. It exists to catch truncated or mangled files,
 * not to resist tampering — this is a local backup of your own data.
 */
export function checksumOf(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export interface BackupCompatibility {
  ok: boolean;
  /** Blocking problem, if any. */
  error: string | null;
  /** Non-blocking notes the user should see before importing. */
  warnings: string[];
  counts: Record<string, number>;
  total: number;
}

/**
 * Validate a candidate backup before anything is written.
 *
 * Deliberately strict about shape and lenient about age: an older file is
 * importable and says so, a newer one is refused because this app cannot know
 * what its tables mean.
 */
export function inspectBackup(payload: unknown): BackupCompatibility {
  const empty = { counts: {}, total: 0, warnings: [] as string[] };

  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "That file is not valid JSON.", ...empty };
  }
  const file = payload as Partial<BackupFile>;
  if (file.app !== "personal-os") {
    return { ok: false, error: "That doesn't look like a Personal OS backup file.", ...empty };
  }
  if (typeof file.version !== "number") {
    return { ok: false, error: "The backup file has no version.", ...empty };
  }
  if (file.version > BACKUP_VERSION) {
    return {
      ok: false,
      error: `This backup was written by a newer version of the app (format ${file.version}, this app reads up to ${BACKUP_VERSION}). Update the app first — importing it could drop data it does not understand.`,
      ...empty,
    };
  }
  if (!file.data || typeof file.data !== "object") {
    return { ok: false, error: "The backup file has no data.", ...empty };
  }

  const warnings: string[] = [];
  const counts: Record<string, number> = {};
  let total = 0;

  for (const table of BACKUP_TABLES) {
    const rows = file.data[table];
    const count = Array.isArray(rows) ? rows.length : 0;
    counts[table] = count;
    total += count;
  }

  const unknown = Object.keys(file.data).filter(
    (key) => !(BACKUP_TABLES as readonly string[]).includes(key) && key !== "users",
  );
  if (unknown.length > 0) {
    warnings.push(`${unknown.length} unrecognised table(s) will be ignored: ${unknown.join(", ")}.`);
  }

  if (file.version < BACKUP_VERSION) {
    warnings.push(
      `This backup uses format v${file.version}; the app now writes v${BACKUP_VERSION}. It will import, and anything without a schedule will be given an every-day schedule — which is how it behaved when the backup was taken.`,
    );
  }

  if (file.meta?.checksum) {
    const recomputed = checksumOf(JSON.stringify(file.data));
    if (recomputed !== file.meta.checksum) {
      warnings.push("The checksum does not match — the file may have been edited or truncated.");
    }
  }

  if (total === 0) {
    warnings.push("The backup contains no records.");
  }

  return { ok: true, error: null, warnings, counts, total };
}

export type CsvTable =
  | "schedule"
  | "habits"
  | "nutrition"
  | "workouts"
  | "health"
  | "goals";
