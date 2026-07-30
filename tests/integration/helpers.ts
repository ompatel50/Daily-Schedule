import { prisma } from "@/lib/prisma";
import type { User } from "@prisma/client";

/** Sign the stubbed session in as this user (or out with null). */
export function actAs(user: User | null): void {
  (globalThis as { __TEST_SESSION__?: unknown }).__TEST_SESSION__ = user
    ? { user: { id: user.id, email: user.email, name: user.name } }
    : null;
}

/** Wipe every table (children first) so each suite starts from nothing. */
export async function resetDatabase(): Promise<void> {
  // TRUNCATE ... CASCADE clears the whole graph regardless of FK order.
  const tables: Array<{ tablename: string }> = await prisma.$queryRawUnsafe(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%'`,
  );
  if (tables.length === 0) return;
  const names = tables.map((t) => `"${t.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
}

export async function createUser(email: string, name = email.split("@")[0]): Promise<User> {
  return prisma.user.create({ data: { email, name, emailVerified: new Date() } });
}

/** Two users with a little data each — the standard isolation fixture. */
export async function twoUsers(): Promise<{ alice: User; bob: User }> {
  const alice = await createUser("alice@test.local", "Alice");
  const bob = await createUser("bob@test.local", "Bob");
  return { alice, bob };
}
