import { PrismaClient } from "@prisma/client";

/**
 * Single-user, local-first app: one Prisma client, reused across hot reloads so
 * `next dev` doesn't exhaust SQLite connections.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/**
 * The app is deliberately single-user (it runs on your machine, there is no
 * auth). `getCurrentUser` is the one seam where multi-user support would slot
 * in later — everything else already takes a userId.
 */
export async function getCurrentUser() {
  const existing = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
  if (existing) return existing;

  return prisma.user.create({
    data: { name: "You", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
  });
}

export async function getCurrentUserId(): Promise<string> {
  const user = await getCurrentUser();
  return user.id;
}
