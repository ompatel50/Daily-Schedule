/**
 * Email + password verification with database-backed throttling.
 *
 * This is the entire credential policy in one place, deliberately separate
 * from the Auth.js provider glue so the integration tests exercise exactly
 * what production runs.
 *
 * Enumeration resistance: every failure — unknown email, wrong password,
 * locked account — returns the same `null`, and an unknown email still pays
 * for a full scrypt verification against a dummy hash so timing reveals
 * nothing either.
 *
 * Throttling is per-account and stored on the User row (serverless instances
 * share nothing but the database): 5 consecutive failures lock the account
 * for 15 minutes. While locked, even the correct password fails with the
 * same generic result, so the lock is not an oracle. Counters use atomic
 * increments; concurrent attempts cannot lose updates.
 */
import "server-only";

import type { User } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { dummyHash, hashPassword, needsRehash, verifyPassword } from "./password";

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 15;

export function normalizeEmail(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

/** Record one failed attempt; the Nth in a row starts the lockout window. */
export async function recordFailedAttempt(userId: string): Promise<void> {
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { failedLoginCount: { increment: 1 }, lastFailedLoginAt: new Date() },
    select: { failedLoginCount: true },
  });
  if (updated.failedLoginCount >= MAX_FAILED_ATTEMPTS) {
    await prisma.user.update({
      where: { id: userId },
      data: { lockedUntil: new Date(Date.now() + LOCKOUT_MINUTES * 60_000) },
    });
  }
}

/** Success path: clear the counter and any expired lock. */
export async function clearFailedAttempts(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { failedLoginCount: 0, lockedUntil: null },
  });
}

/**
 * The one question sign-in asks: do these credentials name an account that
 * may sign in right now? Returns the user row on success, null on any
 * failure. Callers must not distinguish failure causes to the visitor.
 */
export async function verifyCredentials(
  rawEmail: unknown,
  rawPassword: unknown,
): Promise<User | null> {
  const email = normalizeEmail(rawEmail);
  const password = typeof rawPassword === "string" ? rawPassword : "";
  if (!email || !password) return null;

  const user = email.includes("@")
    ? // One of the two places allowed to read the hash (see src/lib/prisma).
      await prisma.user.findUnique({ where: { email }, omit: { passwordHash: false } })
    : null;

  // Unknown account (or a legacy row that never got a password): burn the
  // same scrypt time as a real verification, then refuse.
  if (!user?.passwordHash) {
    await verifyPassword(password, await dummyHash());
    return null;
  }

  // Locked accounts refuse even the correct password — checking the password
  // first would make the lock an oracle for password-guessing.
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    await verifyPassword(password, await dummyHash());
    return null;
  }

  // An EXPIRED lock means the window is over: forgive the old counter before
  // judging this attempt. Without this, the count would sit at the threshold
  // forever and every single failure after a lockout would re-lock — one
  // wrong guess per 15 minutes could keep the owner out indefinitely.
  if (user.lockedUntil) {
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null },
    });
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    await recordFailedAttempt(user.id);
    return null;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  });

  // Transparent cost upgrade: if the stored hash predates the current scrypt
  // parameters, replace it now — the only moment the plaintext is available.
  if (needsRehash(user.passwordHash)) {
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(password) },
    });
  }

  return user;
}
