import { PrismaClient } from "@prisma/client";

/**
 * One Prisma client, reused across hot reloads so `next dev` doesn't exhaust
 * database connections. Lives in its own dependency-free module so both the
 * auth layer and the data layer can import it without a cycle.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
