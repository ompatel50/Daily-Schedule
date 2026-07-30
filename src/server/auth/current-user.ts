/**
 * The one place "who is making this request?" is answered.
 *
 * Every server query and every server action resolves the user through these
 * helpers — never from a client-supplied id, never from `findFirst`. The
 * session cookie names the account; the database row is fetched once per
 * request (React `cache`) and the allowlist is re-checked live, so removing
 * an email from `ALLOWED_EMAILS` locks that account out on its next request
 * rather than when its session happens to expire.
 */
import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import type { Session } from "next-auth";
import type { User } from "@prisma/client";

import { auth } from "@/server/auth";
import { isAllowedEmail } from "@/server/auth/allowlist";
import { prisma } from "@/lib/prisma";

/**
 * What the rest of the app receives as "the user": every User column except
 * the password hash, which the Prisma client omits globally (src/lib/prisma).
 */
export type CurrentUser = Omit<User, "passwordHash">;

/** The session, or null. Cached per request. */
export const getSession = cache(async (): Promise<Session | null> => {
  return auth();
});

/**
 * The signed-in, allowlisted user's database row, or null.
 * Cached per request — repeated calls across a render cost one query total.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await getSession();
  const id = session?.user?.id;
  if (!id) return null;
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) return null;
  if (!isAllowedEmail(user.email)) return null;
  // A token issued before the last password change (or "sign out everywhere")
  // carries a stale version — and a token with NO version predates password
  // auth entirely. Both are treated as signed out. Same row, no extra query.
  if (session.user.tokenVersion !== user.tokenVersion) return null;
  return user;
});

/** Session or a redirect to the sign-in page. */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session?.user?.id) redirect("/signin");
  return session;
}

/**
 * The current user, or a redirect to the sign-in page. This is what the app
 * imports as `getCurrentUser` (via src/lib/db.ts): pages, queries and server
 * actions all refuse to run without an authenticated, allowlisted account.
 */
export async function requireCurrentUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  return user;
}

/**
 * Ownership guard for a record fetched by client-supplied id.
 *
 * Returns the record only when it exists AND belongs to the given user;
 * otherwise reports the same "not found" either way, so an id-guessing
 * request cannot distinguish "exists but not yours" from "does not exist".
 */
export function requireOwnedRecord<T extends { userId: string }>(
  record: T | null,
  userId: string,
): T {
  if (!record || record.userId !== userId) {
    throw new Error("Not found");
  }
  return record;
}
