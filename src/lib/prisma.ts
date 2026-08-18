import type { Prisma } from "@prisma/client";

import { createDbClient, type DbClient } from "../../prisma/db-client";
import { softDeleteGuard } from "@/lib/soft-delete";

/**
 * One Prisma client, reused across hot reloads so `next dev` doesn't exhaust
 * database connections. Lives in its own dependency-free module so both the
 * auth layer and the data layer can import it without a cycle.
 *
 * Constructed through the shared factory (prisma/db-client.ts), whose global
 * `omit.user.passwordHash` means no query returns the password hash — at
 * runtime or in types — unless it opts back in with
 * `omit: { passwordHash: false }` or an explicit `select`. Exactly two call
 * sites do (credential verification and the password-change action);
 * everything else — pages, queries, actions, exports — physically cannot
 * leak the hash into props, HTML or a backup file by accident.
 */
const globalForPrisma = globalThis as unknown as { prisma?: DbClient };

function createClient(): DbClient {
  const logQueries = process.env.PRISMA_LOG_QUERIES === "1";
  const client = createDbClient(
    logQueries
      ? [{ emit: "event", level: "query" }, "error"]
      : process.env.NODE_ENV === "development"
        ? ["error", "warn"]
        : ["error"],
  );
  if (logQueries) {
    // PRISMA_LOG_QUERIES=1 prints each query's SQL shape and duration for
    // performance measurement. Deliberately query-text-only: parameters are
    // never logged, so no journal text, food name, health value or title can
    // end up in a server log. (The cast is only for $on's event typing, which
    // needs a statically-known log config the shared factory doesn't pin.)
    (client as unknown as {
      $on: (event: "query", callback: (event: Prisma.QueryEvent) => void) => void;
    }).$on("query", (event) => {
      console.log(`prisma:query ${event.duration}ms ${event.query}`);
    });
  }
  return client;
}

const base = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = base;

/**
 * The app's client: soft-delete guarded. Every query through it excludes
 * trashed rows (deletedAt set) on the models in
 * `SOFT_DELETE_MODEL_NAMES` — see src/lib/soft-delete.ts, the single place
 * that builds the filter.
 */
export const prisma = base.$extends(softDeleteGuard);

/**
 * The SAME connection without the guard: trashed rows are visible. Only for
 * the documented paths that must see them — Trash list/restore/purge, the
 * purge sweep, backup-restore's replace wipe, demo removal, import-undo's
 * remove, and identity/dedup reads. Reach for `prisma` everywhere else.
 */
export const prismaIncludingTrashed: DbClient = base;

/**
 * The interactive-transaction client of the GUARDED client. Helper functions
 * that run inside `prisma.$transaction(async (tx) => …)` type their parameter
 * with this instead of `Prisma.TransactionClient` (which names the raw
 * client's shape and no longer matches).
 */
export type Tx = Omit<
  typeof prisma,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;
