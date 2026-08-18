import { Prisma } from "@prisma/client";

/**
 * Soft delete, centralised. This module is THE single place that builds the
 * `deletedAt: null` filter — no query call site anywhere spells the condition
 * itself. The exported Prisma client extension rewrites every query against a
 * soft-deletable model so trashed rows are invisible:
 *
 *  * top-level `findMany` / `findFirst(+OrThrow)` / `count` / `aggregate` /
 *    `groupBy` / `updateMany` / `deleteMany` get `deletedAt: null` AND-merged
 *    into their `where`;
 *  * nested reads are walked recursively: a to-MANY relation include/select
 *    that targets a soft-deletable model gets the same filter injected
 *    (filtered relation `_count` selects included), so a live parent never
 *    lists trashed children.
 *
 * What the guard deliberately does NOT touch, and why that is safe:
 *
 *  * Unique-key operations (`findUnique(+OrThrow)`, `update`, `delete`,
 *    `upsert`) — Prisma cannot add non-unique conditions to a unique lookup.
 *    The action layer's universal pattern is a guarded, user-scoped
 *    `findFirst` FIRST, so a trashed id never reaches these; the trash
 *    tooling and tests reach trashed rows through them on purpose.
 *  * To-ONE relation includes (`scheduleItem.task`, `task.project`, …) —
 *    Prisma cannot filter them. The read models that render such links
 *    select `deletedAt` and null the link at the serialisation boundary
 *    (each site points back here).
 *
 * The raw, unguarded client (`prismaIncludingTrashed` in src/lib/prisma.ts)
 * exists for the documented paths that MUST see trashed rows: the Trash page
 * itself (list / restore / purge), the 30-day purge sweep, backup-restore's
 * replace-mode wipe, account deletion, demo-data removal, import-undo's
 * "remove", and identity/dedup reads (import keys, template stamps) where a
 * trashed row must keep occupying its unique key until purged.
 */

/** Prisma model names that soft-delete (the Trash's exact scope). */
export const SOFT_DELETE_MODEL_NAMES = [
  "ScheduleItem",
  "Task",
  "Project",
  "Habit",
  "Meal",
  "Workout",
  "FinanceTransaction",
  "FinanceAccount",
  "Bill",
  "SavingsGoal",
  "Budget",
  "Reminder",
  "JournalEntry",
  "Goal",
  "InboxItem",
  "LifeDocument",
] as const;

export type SoftDeleteModel = (typeof SOFT_DELETE_MODEL_NAMES)[number];

export const SOFT_DELETE_MODELS: ReadonlySet<string> = new Set(SOFT_DELETE_MODEL_NAMES);

/** How long a trashed row lives before the daily sweep purges it. */
export const TRASH_RETENTION_DAYS = 30;

// --- the relation graph, from the DMMF ---------------------------------------

interface RelationInfo {
  /** Target model name. */
  target: string;
  isList: boolean;
}

/** modelName → relation field name → where it points. Built once. */
const RELATIONS: ReadonlyMap<string, ReadonlyMap<string, RelationInfo>> = (() => {
  const map = new Map<string, Map<string, RelationInfo>>();
  for (const model of Prisma.dmmf.datamodel.models) {
    const fields = new Map<string, RelationInfo>();
    for (const field of model.fields) {
      if (field.kind !== "object") continue;
      fields.set(field.name, { target: field.type, isList: field.isList });
    }
    map.set(model.name, fields);
  }
  return map;
})();

// --- filter construction -----------------------------------------------------

type Where = Record<string, unknown>;

/** `deletedAt: null` AND-merged with whatever the caller asked for. */
function mergeWhere(where: Where | undefined): Where {
  if (!where || Object.keys(where).length === 0) return { deletedAt: null };
  return { AND: [{ deletedAt: null }, where] };
}

/**
 * Walk an include/select tree, injecting the filter into every to-many
 * relation that targets a soft-deletable model. Mutates a COPY.
 */
function guardNested(modelName: string, args: Record<string, unknown>): Record<string, unknown> {
  const relations = RELATIONS.get(modelName);
  if (!relations) return args;

  const out = { ...args };
  for (const key of ["include", "select"] as const) {
    const tree = out[key];
    if (!tree || typeof tree !== "object") continue;
    const nextTree: Record<string, unknown> = { ...(tree as Record<string, unknown>) };

    for (const [field, value] of Object.entries(nextTree)) {
      if (value === false || value === undefined) continue;

      // Filtered relation counts: _count: { select: { tasks: true | {...} } }
      if (field === "_count" && value && typeof value === "object") {
        const countSelect = (value as { select?: Record<string, unknown> }).select;
        if (countSelect) {
          const nextCount: Record<string, unknown> = { ...countSelect };
          for (const [countField, countValue] of Object.entries(nextCount)) {
            const rel = relations.get(countField);
            if (!rel || !rel.isList || !SOFT_DELETE_MODELS.has(rel.target)) continue;
            const prev =
              countValue && typeof countValue === "object"
                ? (countValue as { where?: Where })
                : {};
            nextCount[countField] = { ...prev, where: mergeWhere(prev.where) };
          }
          nextTree._count = { ...(value as object), select: nextCount };
        }
        continue;
      }

      const rel = relations.get(field);
      if (!rel) continue;

      const childArgs: Record<string, unknown> =
        value === true ? {} : { ...(value as Record<string, unknown>) };
      let next = guardNested(rel.target, childArgs);
      if (rel.isList && SOFT_DELETE_MODELS.has(rel.target)) {
        next = { ...next, where: mergeWhere(next.where as Where | undefined) };
      }
      nextTree[field] = Object.keys(next).length === 0 ? true : next;
    }
    out[key] = nextTree;
  }
  return out;
}

/** Operations whose top-level `where` accepts non-unique filters. */
const FILTERABLE_OPS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "updateMany",
  "deleteMany",
]);

/** Read operations that can carry include/select trees worth walking. */
const NESTED_OPS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
]);

/**
 * The client extension. Applied once in src/lib/prisma.ts; everything that
 * imports `prisma` from there is guarded automatically, transactions
 * included.
 */
export const softDeleteGuard = Prisma.defineExtension({
  name: "soft-delete-guard",
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const guarded = SOFT_DELETE_MODELS.has(model);
        let nextArgs = args as Record<string, unknown>;

        if (guarded && FILTERABLE_OPS.has(operation)) {
          nextArgs = {
            ...nextArgs,
            where: mergeWhere(nextArgs.where as Where | undefined),
          };
        }
        // Nested guarding applies from ANY model's reads — an unguarded
        // parent (e.g. FinanceImportBatch) can still include guarded children.
        if (NESTED_OPS.has(operation)) {
          nextArgs = guardNested(model, nextArgs);
        }
        return query(nextArgs as typeof args);
      },
    },
  },
});

// --- stamps ------------------------------------------------------------------

/**
 * The moment a delete happened. Cascaded children are stamped with the SAME
 * timestamp as their parent, which is what lets a restore bring back exactly
 * the rows that one delete removed — a child trashed separately (its own
 * stamp) stays in the Trash when the parent is restored.
 */
export function trashStamp(): Date {
  return new Date();
}

/** The cutoff before which trashed rows are purged for good. */
export function purgeCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - TRASH_RETENTION_DAYS * 86_400_000);
}
