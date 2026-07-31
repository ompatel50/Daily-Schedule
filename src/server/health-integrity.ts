import "server-only";

import { prisma } from "@/lib/db";
import type { DayKey } from "@/lib/date";
import {
  buildIntegrityReport,
  checkFailedImports,
  checkFutureDated,
  checkImplausibleValues,
  checkMissingFingerprints,
  checkOrphanedBatchLinks,
  checkUnknownTypes,
  checkUnreadableUnits,
  type IntegrityReport,
  type MetricExtent,
  type UnitUsage,
} from "@/lib/logic/health-import/integrity";

/**
 * Run the health-data integrity checks for one account.
 *
 * ## Bounded by construction
 *
 * Every check is an **aggregate**: six queries that the database answers from
 * its own counters and the `(userId, type, date)` index, and not one of them
 * materialises a row. That matters because this runs on a page an account with
 * a decade of imported data will open — the checks have to cost the same for
 * 400 rows and 4,000,000.
 *
 * The trade is that a min/max tells you a metric holds an impossible reading
 * without telling you how many, which is why `checkImplausibleValues` counts
 * *metrics* rather than claiming a row count it did not measure. Finding the
 * exact day is one click away on the metric's own page, and it is a rare
 * enough situation that paying for a scan up front would be the wrong bargain.
 *
 * ## Privacy
 *
 * Every query is scoped by `userId` and returns counts, units and extremes —
 * never a note, a title or an identifiable reading. Nothing is written, and
 * nothing leaves the request.
 */
export async function getHealthIntegrityReport(
  userId: string,
  today: DayKey,
): Promise<IntegrityReport> {
  const [byType, byUnit, futureDated, missingFingerprints, orphanedLinks, failedImports] =
    await Promise.all([
      prisma.healthMetric.groupBy({
        by: ["type"],
        where: { userId },
        _min: { value: true },
        _max: { value: true },
        _count: { _all: true },
      }),
      prisma.healthMetric.groupBy({
        by: ["type", "unit"],
        where: { userId },
        _count: { _all: true },
      }),
      prisma.healthMetric.count({ where: { userId, date: { gt: today } } }),
      prisma.healthMetric.count({ where: { userId, fingerprint: null } }),
      // A row whose batch was undone but which survived the undo — the
      // "you edited it, so it is yours now" case. Worth surfacing once.
      prisma.healthMetric.count({
        where: { userId, batchId: { not: null }, batch: { status: "removed" } },
      }),
      prisma.healthImportBatch.count({ where: { userId, status: "failed" } }),
    ]);

  const extents: MetricExtent[] = byType.map((group) => ({
    type: group.type,
    min: group._min.value,
    max: group._max.value,
    count: group._count._all,
  }));

  const usage: UnitUsage[] = byUnit.map((group) => ({
    type: group.type,
    unit: group.unit,
    count: group._count._all,
  }));

  return buildIntegrityReport([
    checkUnknownTypes(extents),
    checkUnreadableUnits(usage),
    checkImplausibleValues(extents),
    checkFutureDated(futureDated, today),
    checkMissingFingerprints(missingFingerprints),
    checkOrphanedBatchLinks(orphanedLinks),
    checkFailedImports(failedImports),
  ]);
}

export type { IntegrityFinding, IntegrityReport } from "@/lib/logic/health-import/integrity";
