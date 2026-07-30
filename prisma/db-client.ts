import { PrismaClient, type Prisma } from "@prisma/client";

/**
 * The one way a Prisma client is constructed anywhere in this repo.
 *
 * The global `omit` keeps `User.passwordHash` out of every query result —
 * runtime AND types — unless a call site opts back in explicitly. Sharing the
 * factory means the app client (src/lib/prisma.ts), the seed CLI and the
 * data backfills all have the identical client type, so helpers like
 * `seedDemoData(prisma, …)` accept any of them.
 */
export function createDbClient(log?: Prisma.PrismaClientOptions["log"]) {
  return new PrismaClient({ omit: { user: { passwordHash: true } }, log });
}

export type DbClient = ReturnType<typeof createDbClient>;
