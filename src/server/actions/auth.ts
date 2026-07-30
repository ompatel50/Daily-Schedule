"use server";

import { z } from "zod";

import { getCurrentUser, prisma } from "@/lib/db";
import { fail, succeed, type ActionResult } from "@/lib/validation";
import { signIn, signOut } from "@/server/auth";
import { clearFailedAttempts, recordFailedAttempt } from "@/server/auth/credentials";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { containsEmailLocalPart, MIN_PASSWORD_LENGTH } from "@/server/auth/policy";
import { redeemRecoveryCode, replaceRecoveryCodes } from "@/server/auth/recovery";
import { createAccount } from "@/server/auth/signup";

/** Ends the session and lands on the sign-in page. */
export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/signin" });
}

const SIGNUP_ERROR_MESSAGES: Record<string, string> = {
  "invalid-email": "Enter a real email address — it's how you'll sign in.",
  mismatch: "The two passwords don't match.",
  short: `Use at least ${MIN_PASSWORD_LENGTH} characters — a long passphrase beats a short complicated password.`,
  long: "That's longer than necessary — use at most 200 characters.",
  weak: "Don't build the password around your email address — pick something unrelated.",
  exists:
    "An account with that email address already exists. Sign in instead — or use a recovery code if you've lost the password.",
  "rate-limited": "Too many sign-up attempts from your network. Try again in an hour.",
  disabled: "Sign-ups are currently disabled on this deployment.",
};

export type SignUpActionResult =
  | { ok: true; recoveryCodes: string[]; signedIn: boolean }
  | { ok: false; error: string };

/**
 * Public sign-up: create the account, sign this browser in, and hand back
 * the one-time recovery codes for the page to display. Reachable signed-out
 * by design — the rate limit and validation live in
 * src/server/auth/signup.ts.
 */
export async function signUpAction(input: {
  email: string;
  name?: string;
  password: string;
  confirm: string;
  honeypot?: string;
}): Promise<SignUpActionResult> {
  const result = await createAccount(input);
  if (!result.ok) {
    return { ok: false, error: SIGNUP_ERROR_MESSAGES[result.error] ?? "Sign-up didn't complete. Please try again." };
  }

  // Sign the fresh account in so "create account" lands on the dashboard.
  // If this somehow fails the account still exists — the page sends the
  // user to /signin instead of erroring.
  let signedIn = true;
  try {
    await signIn("password", { email: result.email, password: input.password, redirect: false });
  } catch {
    signedIn = false;
  }

  return { ok: true, recoveryCodes: result.recoveryCodes, signedIn };
}

/**
 * The /forgot-password submission: email + one unused recovery code + new
 * password. Every identity failure reads identically (and is rate limited
 * upstream); success invalidates every existing session of the account.
 */
export async function resetPasswordAction(input: {
  email: string;
  code: string;
  newPassword: string;
  confirm: string;
}): Promise<ActionResult<null>> {
  if (input.newPassword !== input.confirm) {
    return fail("The two new passwords don't match");
  }
  const result = await redeemRecoveryCode({
    email: input.email,
    code: input.code,
    newPassword: input.newPassword,
  });
  if (result.ok) return succeed(null);
  switch (result.error) {
    case "rate-limited":
      return fail("Too many attempts. Try again in an hour.");
    case "password":
      return fail(
        `Pick a different new password: at least ${MIN_PASSWORD_LENGTH} characters, at most 200, and not built around your email address.`,
      );
    default:
      return fail("That email address and recovery code combination wasn't accepted.");
  }
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
    return fail("This account has no password to change");
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
  // this the very next request would treat us as signed out too. The
  // password change is already committed, so a failure here (e.g. the
  // sign-in rate limit tripping on this client) must NOT report failure —
  // it only means this browser is signed out like the others, and the user
  // signs back in with the new password. Reporting an error would be a lie:
  // the password DID change.
  try {
    await signIn("password", {
      email: updated.email,
      password: parsed.data.newPassword,
      redirect: false,
    });
  } catch {
    // Swallowed deliberately — see above.
  }

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

/**
 * Replace every recovery code with a fresh batch and return the plaintext
 * codes for the panel to display once. Requires the current password — a
 * stolen session alone must not be able to mint itself a permanent way
 * back in — and wrong guesses count toward the same lockout as sign-in.
 */
export async function regenerateRecoveryCodesAction(input: {
  currentPassword: string;
}): Promise<ActionResult<{ recoveryCodes: string[] }>> {
  const user = await getCurrentUser();

  const secret = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { passwordHash: true, lockedUntil: true },
  });
  if (!secret.passwordHash) {
    return fail("This account has no password yet");
  }
  if (secret.lockedUntil && secret.lockedUntil.getTime() > Date.now()) {
    return fail("Too many failed attempts. Try again in a few minutes.");
  }
  const currentOk = await verifyPassword(input.currentPassword, secret.passwordHash);
  if (!currentOk) {
    await recordFailedAttempt(user.id);
    return fail("The current password wasn't right");
  }
  await clearFailedAttempts(user.id);

  const recoveryCodes = await prisma.$transaction((tx) => replaceRecoveryCodes(tx, user.id));
  return succeed({ recoveryCodes });
}
