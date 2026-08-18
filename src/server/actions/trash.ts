"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/db";
import { prismaIncludingTrashed } from "@/lib/prisma";
import { SOFT_DELETE_MODELS, type SoftDeleteModel } from "@/lib/soft-delete";
import { operationalDayOfRecord } from "@/lib/logic/operational-day";
import { parseSkipDates, serializeSkipDates } from "@/lib/logic/recurrence";
import { resetMinuteOf } from "@/lib/logic/schedule";
import { fail, succeed, type ActionResult } from "@/lib/validation";
import { scheduleSettingsFor, setScheduleEnabled } from "@/server/schedule";
import { recomputeDay } from "@/server/summaries";

/**
 * Restore and purge, the Trash's two verbs. Both run on the RAW client (the
 * whole point is reaching soft-deleted rows — src/lib/soft-delete.ts), both
 * are strictly user-scoped, and restore is LINK-AWARE: it brings back the
 * exact group one delete removed (same trash stamp) and repairs what a purge
 * broke in the meantime rather than resurrecting half a structure.
 */

const raw = prismaIncludingTrashed;

function revalidateAll() {
  revalidatePath("/", "layout");
}

function asModel(value: string): SoftDeleteModel | null {
  return SOFT_DELETE_MODELS.has(value) ? (value as SoftDeleteModel) : null;
}

/** The delegate for a model name on the raw client ("Task" → raw.task). */
function delegateOf(model: SoftDeleteModel) {
  const key = (model[0].toLowerCase() + model.slice(1)) as "task";
  return raw[key];
}

interface TrashedRow {
  id: string;
  deletedAt: Date;
}

async function loadTrashed(
  model: SoftDeleteModel,
  id: string,
  userId: string,
): Promise<TrashedRow | null> {
  const row = (await delegateOf(model).findFirst({
    where: { id, userId, deletedAt: { not: null } },
  })) as unknown as ({ deletedAt: Date } & Record<string, unknown>) | null;
  return row ? (row as unknown as TrashedRow) : null;
}

export async function purgeTrashItem(
  modelName: string,
  id: string,
): Promise<ActionResult<null>> {
  const model = asModel(modelName);
  if (!model) return fail("Unknown trash item");
  const user = await getCurrentUser();
  // Only rows already in the Trash can be purged from here — a live row must
  // go through its own delete first. FK cascades take dependents (subtasks,
  // series occurrences, an account's transactions) with the purged row.
  const result = await delegateOf(model).deleteMany({
    where: { id, userId: user.id, deletedAt: { not: null } },
  });
  if (result.count === 0) return fail("Not in the trash");
  revalidateAll();
  return succeed(null);
}

export async function restoreTrashItem(
  modelName: string,
  id: string,
): Promise<ActionResult<{ restored: number }>> {
  const model = asModel(modelName);
  if (!model) return fail("Unknown trash item");
  const user = await getCurrentUser();
  const row = await loadTrashed(model, id, user.id);
  if (!row) return fail("Not in the trash");

  const stamp = row.deletedAt;
  let restored = 0;

  switch (model) {
    case "Task": {
      // The task plus the subtasks its delete took along (same stamp). A
      // subtask restored on its own also brings back its trashed parent —
      // an orphaned subtask would be invisible on the board.
      const task = (await raw.task.findFirst({
        where: { id, userId: user.id },
        select: { parentId: true },
      }))!;
      const result = await raw.task.updateMany({
        where: {
          userId: user.id,
          OR: [{ id }, { parentId: id, deletedAt: stamp }],
        },
        data: { deletedAt: null },
      });
      restored = result.count;
      if (task.parentId) {
        restored += (
          await raw.task.updateMany({
            where: { id: task.parentId, userId: user.id, deletedAt: { not: null } },
            data: { deletedAt: null },
          })
        ).count;
      }
      break;
    }

    case "ScheduleItem": {
      // The rows this delete stamped: the row itself plus any series rows
      // sharing the stamp (a "future"/"all" delete), and the reminders that
      // followed them. A "one"-deleted occurrence also gives its slot back —
      // the skip tombstone exists to stop regeneration, not restoration.
      const item = (await raw.scheduleItem.findFirst({
        where: { id, userId: user.id },
      }))!;
      const seriesId = item.seriesId ?? item.id;
      const group = await raw.scheduleItem.findMany({
        where: {
          userId: user.id,
          deletedAt: stamp,
          OR: [{ id }, { seriesId }, { id: seriesId }],
        },
        select: { id: true, date: true, startMinute: true, originalDate: true },
      });
      const ids = group.map((entry) => entry.id);
      const result = await raw.scheduleItem.updateMany({
        where: { id: { in: ids }, userId: user.id },
        data: { deletedAt: null },
      });
      restored = result.count;
      await raw.reminder.updateMany({
        where: { scheduleItemId: { in: ids }, userId: user.id, deletedAt: stamp },
        data: { deletedAt: null },
      });

      const reset = resetMinuteOf(scheduleSettingsFor(user));
      if (item.seriesId) {
        const parent = await raw.scheduleItem.findFirst({
          where: { id: item.seriesId, userId: user.id },
          select: { id: true, skipDates: true },
        });
        if (parent) {
          const slots = new Set(
            group.map((entry) => entry.originalDate ?? operationalDayOfRecord(entry, reset)),
          );
          await raw.scheduleItem.update({
            where: { id: parent.id },
            data: {
              skipDates: serializeSkipDates(
                parseSkipDates(parent.skipDates).filter((day) => !slots.has(day)),
              ),
            },
          });
        }
      }
      for (const entry of group) {
        await recomputeDay(user.id, operationalDayOfRecord(entry, reset));
      }
      break;
    }

    case "FinanceTransaction": {
      // A transfer restores as a pair. If the counterpart was purged (or its
      // account's purge cascaded it away), restore this leg DETACHED — half
      // a transfer must not come back wearing the transfer category.
      const tx = (await raw.financeTransaction.findFirst({
        where: { id, userId: user.id },
      }))!;
      if (tx.transferGroupId) {
        const legs = await raw.financeTransaction.findMany({
          where: { userId: user.id, transferGroupId: tx.transferGroupId },
          select: { id: true, accountId: true },
        });
        const accounts = await raw.financeAccount.findMany({
          where: { id: { in: [...new Set(legs.map((leg) => leg.accountId))] } },
          select: { id: true, deletedAt: true },
        });
        const liveAccounts = new Set(
          accounts.filter((account) => !account.deletedAt).map((account) => account.id),
        );
        const restorable = legs.filter((leg) => liveAccounts.has(leg.accountId));
        if (restorable.length >= 2) {
          const result = await raw.financeTransaction.updateMany({
            where: { id: { in: restorable.map((leg) => leg.id) }, userId: user.id },
            data: { deletedAt: null },
          });
          restored = result.count;
        } else {
          await raw.financeTransaction.update({
            where: { id },
            data: {
              deletedAt: null,
              transferGroupId: null,
              category: tx.preTransferCategory ?? "other",
              preTransferCategory: null,
            },
          });
          restored = 1;
        }
      } else {
        await raw.financeTransaction.update({ where: { id }, data: { deletedAt: null } });
        restored = 1;
      }
      // A transaction needs its account back to be visible at all.
      await raw.financeAccount.updateMany({
        where: { id: tx.accountId, userId: user.id, deletedAt: { not: null } },
        data: { deletedAt: null },
      });
      break;
    }

    case "FinanceAccount": {
      // The account plus the transactions its delete took along (same stamp).
      const result = await raw.financeAccount.updateMany({
        where: { id, userId: user.id },
        data: { deletedAt: null },
      });
      restored = result.count;
      restored += (
        await raw.financeTransaction.updateMany({
          where: { accountId: id, userId: user.id, deletedAt: stamp },
          data: { deletedAt: null },
        })
      ).count;
      break;
    }

    case "Workout": {
      // The workout and its mirrored planner block travel together.
      const result = await raw.workout.updateMany({
        where: { id, userId: user.id },
        data: { deletedAt: null },
      });
      restored = result.count;
      restored += (
        await raw.scheduleItem.updateMany({
          where: { workoutId: id, userId: user.id, deletedAt: stamp },
          data: { deletedAt: null },
        })
      ).count;
      break;
    }

    case "Habit": {
      const habit = (await raw.habit.findFirst({ where: { id, userId: user.id } }))!;
      await raw.habit.update({ where: { id }, data: { deletedAt: null } });
      restored = 1;
      // The delete disabled the polymorphic schedule instead of deleting it —
      // switch it back on unless the habit was archived anyway.
      await setScheduleEnabled(user.id, "habit", id, !habit.archived);
      break;
    }

    case "Goal": {
      const goal = (await raw.goal.findFirst({ where: { id, userId: user.id } }))!;
      await raw.goal.update({ where: { id }, data: { deletedAt: null } });
      restored = 1;
      await setScheduleEnabled(user.id, "goal", id, !goal.archivedAt && goal.active);
      break;
    }

    default: {
      const result = await delegateOf(model).updateMany({
        where: { id, userId: user.id },
        data: { deletedAt: null },
      });
      restored = result.count;
    }
  }

  revalidateAll();
  return succeed({ restored });
}

/** Purge the current user's entire Trash at once. */
export async function emptyTrash(): Promise<ActionResult<{ purged: number }>> {
  const user = await getCurrentUser();
  let purged = 0;
  for (const model of SOFT_DELETE_MODELS) {
    const result = await delegateOf(model as SoftDeleteModel).deleteMany({
      where: { userId: user.id, deletedAt: { not: null } },
    });
    purged += result.count;
  }
  revalidateAll();
  return succeed({ purged });
}
