import "server-only";

import { getCurrentUser, prisma } from "@/lib/db";
import { BACKUP_VERSION } from "@/lib/backup-format";
import { getTrashCount } from "@/server/trash";

/**
 * The Settings data page's read model: what the account holds, per module —
 * the `get_backup_status` computation surfaced for humans, extended with the
 * bounds and recency the numbers alone don't tell. Strictly read-only.
 *
 * Counts read through the guarded client, so they describe the data the app
 * actually shows; the Trash's own count rides along as its own line.
 */

export interface DataModuleRow {
  module: string;
  count: number;
  /** Oldest/newest natural date (`YYYY-MM-DD`), where the module has one. */
  oldest: string | null;
  newest: string | null;
}

export interface DataOverview {
  modules: DataModuleRow[];
  totalRecords: number;
  trashCount: number;
  lastFinanceImport: {
    fileName: string;
    at: string; // ISO
    created: number;
    undone: boolean;
  } | null;
  lastHealthImport: {
    fileName: string | null;
    at: string; // ISO
    status: string;
  } | null;
  /** Null = this account has never exported a backup. */
  lastBackupExportAt: string | null;
  backupFormatVersion: number;
}

const dayOf = (value: Date | string | null): string | null =>
  value === null ? null : typeof value === "string" ? value : value.toISOString().slice(0, 10);

export async function getDataOverview(): Promise<DataOverview> {
  const user = await getCurrentUser();
  const userId = user.id;

  /** Count + min/max over a string day column. */
  const dated = async (
    module: string,
    delegate: {
      count: (args: { where: { userId: string } }) => Promise<number>;
      aggregate: (args: {
        where: { userId: string };
        _min: { date: true };
        _max: { date: true };
      }) => Promise<{ _min: { date: string | null }; _max: { date: string | null } }>;
    },
  ): Promise<DataModuleRow> => {
    const [count, bounds] = await Promise.all([
      delegate.count({ where: { userId } }),
      delegate.aggregate({ where: { userId }, _min: { date: true }, _max: { date: true } }),
    ]);
    return { module, count, oldest: bounds._min.date, newest: bounds._max.date };
  };

  /** Count + min/max over createdAt, for modules without a natural day. */
  const stamped = async (
    module: string,
    delegate: {
      count: (args: { where: { userId: string } }) => Promise<number>;
      aggregate: (args: {
        where: { userId: string };
        _min: { createdAt: true };
        _max: { createdAt: true };
      }) => Promise<{ _min: { createdAt: Date | null }; _max: { createdAt: Date | null } }>;
    },
  ): Promise<DataModuleRow> => {
    const [count, bounds] = await Promise.all([
      delegate.count({ where: { userId } }),
      delegate.aggregate({
        where: { userId },
        _min: { createdAt: true },
        _max: { createdAt: true },
      }),
    ]);
    return {
      module,
      count,
      oldest: dayOf(bounds._min.createdAt),
      newest: dayOf(bounds._max.createdAt),
    };
  };

  const countOnly = async (
    module: string,
    delegate: { count: (args: { where: { userId: string } }) => Promise<number> },
  ): Promise<DataModuleRow> => ({
    module,
    count: await delegate.count({ where: { userId } }),
    oldest: null,
    newest: null,
  });

  const [modules, trashCount, lastFinanceImport, lastHealthImport] = await Promise.all([
    Promise.all([
      dated("Planner blocks", prisma.scheduleItem),
      stamped("Tasks", prisma.task),
      stamped("Projects", prisma.project),
      stamped("Habits", prisma.habit),
      dated("Habit logs", prisma.habitLog),
      dated("Meals", prisma.meal),
      dated("Workouts", prisma.workout),
      dated("Health readings", prisma.healthMetric),
      countOnly("Health records", prisma.healthRecord),
      dated("Transactions", prisma.financeTransaction),
      countOnly("Accounts", prisma.financeAccount),
      countOnly("Bills", prisma.bill),
      countOnly("Budgets", prisma.budget),
      countOnly("Savings goals", prisma.savingsGoal),
      dated("Journal entries", prisma.journalEntry),
      stamped("Goals", prisma.goal),
      stamped("Inbox notes", prisma.inboxItem),
      stamped("Documents", prisma.lifeDocument),
      countOnly("Reminders", prisma.reminder),
    ]),
    getTrashCount(),
    prisma.financeImportBatch.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { fileName: true, createdAt: true, createdCount: true, undoneAt: true },
    }),
    prisma.healthImportBatch.findFirst({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { fileName: true, createdAt: true, status: true },
    }),
  ]);

  return {
    modules,
    totalRecords: modules.reduce((total, row) => total + row.count, 0),
    trashCount,
    lastFinanceImport: lastFinanceImport
      ? {
          fileName: lastFinanceImport.fileName,
          at: lastFinanceImport.createdAt.toISOString(),
          created: lastFinanceImport.createdCount,
          undone: lastFinanceImport.undoneAt !== null,
        }
      : null,
    lastHealthImport: lastHealthImport
      ? {
          fileName: lastHealthImport.fileName,
          at: lastHealthImport.createdAt.toISOString(),
          status: lastHealthImport.status,
        }
      : null,
    lastBackupExportAt: user.lastBackupExportAt?.toISOString() ?? null,
    backupFormatVersion: BACKUP_VERSION,
  };
}
