"use server";

import { z } from "zod";

import { getCurrentUser, prisma } from "@/lib/db";
import { fail, succeed, type ActionResult } from "@/lib/validation";
import { signIn, signOut } from "@/server/auth";
import { clearFailedAttempts, recordFailedAttempt } from "@/server/auth/credentials";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { containsEmailLocalPart, MIN_PASSWORD_LENGTH } from "@/server/auth/setup";

/** Ends the session and lands on the sign-in page. */
export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/signin" });
}

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password"),
  newPassword: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters`)
    .max(200, "That's longer than necessary"),
  confirm: z.string(),
});

/**
 * Change the signed-in account's password.
 *
 * Requires the current password (a stolen session alone must not be able to
 * take the account over), and failed current-password checks count toward
 * the same lockout as failed sign-ins. On success the account's
 * `tokenVersion` is bumped — every session everywhere dies on its next
 * request — and this browser is signed back in immediately with the new
 * password, so only the other devices notice.
 */
export async function changePasswordAction(input: {
  currentPassword: string;
  newPassword: string;
  confirm: string;
}): Promise<ActionResult<null>> {
  const user = await getCurrentUser();

  const parsed = changePasswordSchema.safeParse(input);
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Check the form and try again");
  }
  if (parsed.data.newPassword !== parsed.data.confirm) {
    return fail("The two new passwords don't match");
  }
  if (user.email && containsEmailLocalPart(parsed.data.newPassword, user.email)) {
    return fail("Don't build the password around your email address");
  }
  // The hash is globally omitted from user queries (src/lib/prisma); this is
  // the second of the two call sites allowed to read it back.
  const secret = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { passwordHash: true, lockedUntil: true },
  });
  if (!secret.passwordHash) {
    return fail("This account has no password yet — complete the owner setup first");
  }
  if (secret.lockedUntil && secret.lockedUntil.getTime() > Date.now()) {
    return fail("Too many failed attempts. Try again in a few minutes.");
  }
  const currentOk = await verifyPassword(parsed.data.currentPassword, secret.passwordHash);
  if (!currentOk) {
    await recordFailedAttempt(user.id);
    return fail("The current password wasn't right");
  }
  await clearFailedAttempts(user.id);

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(parsed.data.newPassword),
      passwordUpdatedAt: new Date(),
      tokenVersion: { increment: 1 },
    },
    select: { email: true },
  });

  // Re-issue this browser's session against the new tokenVersion; without
  // this the very next request would treat us as signed out too.
  await signIn("password", {
    email: updated.email,
    password: parsed.data.newPassword,
    redirect: false,
  });

  return succeed(null);
}

/**
 * Invalidate every session of this account, including the current one, by
 * bumping `tokenVersion` — then clear this browser's cookie and land on the
 * sign-in page. The recovery move for "I signed in somewhere I shouldn't
 * have" (without needing a password change).
 */
export async function signOutEverywhereAction(): Promise<void> {
  const user = await getCurrentUser();
  await prisma.user.update({
    where: { id: user.id },
    data: { tokenVersion: { increment: 1 } },
  });
  await signOut({ redirectTo: "/signin" });
}
