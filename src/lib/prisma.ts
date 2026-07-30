import { PrismaClient } from "@prisma/client";

/**
 * One Prisma client, reused across hot reloads so `next dev` doesn't exhaust
 * database connections. Lives in its own dependency-free module so both the
 * auth layer and the data layer can import it without a cycle.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient(): PrismaClient {
  // PRISMA_LOG_QUERIES=1 prints each query's SQL shape and duration for
  // performance measurement. Deliberately query-text-only: parameters are
  // never logged, so no journal text, food name, health value or title can
  // end up in a server log.
  if (process.env.PRISMA_LOG_QUERIES === "1") {
    const client = new PrismaClient({
      log: [{ emit: "event", level: "query" }, "error"],
    });
    client.$on("query", (event) => {
      console.log(`prisma:query ${event.duration}ms ${event.query}`);
    });
    return client as unknown as PrismaClient;
  }
  return new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
