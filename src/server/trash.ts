import "server-only";

import { getCurrentUser } from "@/lib/db";
import { prismaIncludingTrashed } from "@/lib/prisma";
import { formatCents } from "@/lib/logic/money";
import { centsOrLegacy } from "@/lib/logic/money";
import {
  purgeCutoff,
  SOFT_DELETE_MODEL_NAMES,
  TRASH_RETENTION_DAYS,
  type SoftDeleteModel,
} from "@/lib/soft-delete";

/**
 * The Trash read model and the retention sweep. Everything here runs on the
 * RAW client on purpose — the Trash is the one surface whose whole job is
 * seeing soft-deleted rows (src/lib/soft-delete.ts documents the contract).
 */

export interface TrashItem {
  /** Prisma model name — the restore/purge actions take it back verbatim. */
  model: SoftDeleteModel;
  id: string;
  /** Human-readable module name for the list ("Tasks", "Finance"…). */
  module: string;
  /** What the row was: its title/name/label. */
  title: string;
  /** Secondary context — a date, an amount, a category. */
  detail: string | null;
  deletedAt: string; // ISO
  /** When the daily sweep will purge it for good. */
  purgeAt: string; // ISO
}

/** At most this many rows are listed per model — the Trash is a recovery
 *  surface, not an archive browser. */
const LIST_CAP = 200;

const MODULE_LABEL: Record<SoftDeleteModel, string> = {
  ScheduleItem: "Planner",
  Task: "Tasks",
  Project: "Projects",
  Habit: "Habits",
  Meal: "Meals",
  Workout: "Workouts",
  FinanceTransaction: "Finance",
  FinanceAccount: "Finance",
  Bill: "Finance",
  SavingsGoal: "Finance",
  Budget: "Finance",
  Reminder: "Reminders",
  JournalEntry: "Journal",
  Goal: "Goals",
  InboxItem: "Inbox",
  LifeDocument: "Documents",
};

type Row = Record<string, unknown>;

const str = (row: Row, key: string): string | null =>
  typeof row[key] === "string" && (row[key] as string).length > 0 ? (row[key] as string) : null;

/** What each model's row reads as in the list. */
const DESCRIBE: Record<SoftDeleteModel, (row: Row) => { title: string; detail: string | null }> = {
  ScheduleItem: (row) => ({ title: str(row, "title") ?? "Planner block", detail: str(row, "date") }),
  Task: (row) => ({ title: str(row, "title") ?? "Task", detail: str(row, "dueDate") }),
  Project: (row) => ({ title: str(row, "name") ?? "Project", detail: null }),
  Habit: (row) => ({ title: str(row, "name") ?? "Habit", detail: null }),
  Meal: (row) => ({
    title: str(row, "label") ?? str(row, "type") ?? "Meal",
    detail: str(row, "date"),
  }),
  Workout: (row) => ({ title: str(row, "type") ?? "Workout", detail: str(row, "date") }),
  FinanceTransaction: (row) => ({
    title: str(row, "payee") ?? str(row, "category") ?? "Transaction",
    detail: [
      str(row, "date"),
      formatCents(
        centsOrLegacy(
          row.amountCents as number | null,
          typeof row.amount === "number" ? row.amount : 0,
        ),
      ),
    ]
      .filter(Boolean)
      .join(" · "),
  }),
  FinanceAccount: (row) => ({ title: str(row, "name") ?? "Account", detail: null }),
  Bill: (row) => ({ title: str(row, "name") ?? "Bill", detail: str(row, "nextDueDate") }),
  SavingsGoal: (row) => ({ title: str(row, "name") ?? "Savings goal", detail: null }),
  Budget: (row) => ({ title: str(row, "category") ?? "Budget", detail: null }),
  Reminder: (row) => ({ title: str(row, "title") ?? "Reminder", detail: null }),
  JournalEntry: (row) => ({
    title: str(row, "title") ?? "Journal entry",
    detail: str(row, "date"),
  }),
  Goal: (row) => ({ title: str(row, "label") ?? str(row, "metric") ?? "Goal", detail: null }),
  InboxItem: (row) => ({ title: str(row, "title") ?? "Inbox note", detail: null }),
  LifeDocument: (row) => ({ title: str(row, "name") ?? "Document", detail: null }),
};

/** The delegate for a model name on the raw client ("Task" → client.task). */
function delegateOf(model: SoftDeleteModel) {
  const key = (model[0].toLowerCase() + model.slice(1)) as "task";
  return prismaIncludingTrashed[key];
}

/** Everything in the current user's Trash, newest deletions first. */
export async function getTrashPage(): Promise<{
  items: TrashItem[];
  retentionDays: number;
}> {
  const user = await getCurrentUser();
  const items: TrashItem[] = [];

  for (const model of SOFT_DELETE_MODEL_NAMES) {
    const rows = (await delegateOf(model).findMany({
      where: { userId: user.id, deletedAt: { not: null } },
      orderBy: { deletedAt: "desc" },
      take: LIST_CAP,
    })) as unknown as Row[];
    for (const row of rows) {
      const deletedAt = row.deletedAt as Date;
      const { title, detail } = DESCRIBE[model](row);
      items.push({
        model,
        id: row.id as string,
        module: MODULE_LABEL[model],
        title,
        detail,
        deletedAt: deletedAt.toISOString(),
        purgeAt: new Date(
          deletedAt.getTime() + TRASH_RETENTION_DAYS * 86_400_000,
        ).toISOString(),
      });
    }
  }

  items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  return { items, retentionDays: TRASH_RETENTION_DAYS };
}

/** How many items sit in the current user's Trash — the Settings card's number. */
export async function getTrashCount(): Promise<number> {
  const user = await getCurrentUser();
  const counts = await Promise.all(
    SOFT_DELETE_MODEL_NAMES.map((model) =>
      delegateOf(model).count({ where: { userId: user.id, deletedAt: { not: null } } }),
    ),
  );
  return counts.reduce((total, count) => total + count, 0);
}

/**
 * Purge everything trashed longer than the retention window, across ALL
 * users — the daily maintenance tick calls this next to the upload sweep.
 * Parents last, so a child count is a real count and FK cascades (subtasks,
 * series occurrences, an account's transactions) clean up whatever the
 * per-model pass missed. Never throws in a way the caller must handle: the
 * route wraps it in a catch.
 */
export async function purgeExpiredTrash(now: Date = new Date()): Promise<number> {
  const cutoff = purgeCutoff(now);
  let purged = 0;
  for (const model of SOFT_DELETE_MODEL_NAMES) {
    const result = await delegateOf(model).deleteMany({
      where: { deletedAt: { lt: cutoff } },
    });
    purged += result.count;
  }
  return purged;
}
