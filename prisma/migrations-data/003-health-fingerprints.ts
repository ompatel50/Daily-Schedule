import type { DbClient } from "../db-client";

/**
 * Give pre-Phase-11 health rows the deduplication fingerprint the new unique
 * constraint keys on.
 *
 * Before Phase 11 the table was unique on `(userId, date, type, source)` — one
 * row per day per type per source — so `source|type|date` is guaranteed
 * collision-free for existing rows, and for `manual` rows it is byte-identical
 * to the fingerprint the manual-entry upsert now uses. Without this backfill,
 * logging a value for a day the seed (or an old import) already covered would
 * stack a second manual row instead of replacing the first.
 *
 * Idempotent: only rows whose fingerprint is still null are touched. A
 * collision (impossible for legacy data, conceivable if the migration is run
 * against a half-upgraded database) skips the row rather than failing the run.
 */
export const id = "003-health-fingerprints";
export const description = "Backfill dedup fingerprints on pre-upgrade health rows";

export async function run(prisma: DbClient): Promise<string[]> {
  const notes: string[] = [];

  const rows = await prisma.healthMetric.findMany({
    where: { fingerprint: null },
    select: { id: true, source: true, type: true, date: true },
  });

  if (rows.length === 0) {
    notes.push("health: nothing to do — every metric row already has a fingerprint");
    return notes;
  }

  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    try {
      await prisma.healthMetric.update({
        where: { id: row.id },
        data: { fingerprint: `${row.source}|${row.type}|${row.date}` },
      });
      updated += 1;
    } catch {
      skipped += 1;
    }
  }

  notes.push(`health: fingerprinted ${updated} pre-upgrade metric rows`);
  if (skipped > 0) {
    notes.push(`health: skipped ${skipped} rows whose fingerprint already existed`);
  }
  return notes;
}
