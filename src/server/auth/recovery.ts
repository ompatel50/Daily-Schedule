/**
 * Password recovery without email infrastructure.
 *
 * The app sends no email and depends on no paid provider, so "forgot
 * password" is proven by a recovery code instead: a batch of one-time codes
 * is generated at sign-up (and regenerable from Settings), shown exactly
 * once, and stored only as SHA-256 hashes. Redeeming a code on
 * /forgot-password sets a new password, signs every device out (tokenVersion
 * bump) and burns the code.
 *
 * Enumeration resistance mirrors sign-in: unknown email, wrong code, used
 * code and codeless account all return the same generic failure, cost a
 * comparable amount of work, and are rate limited per client and per
 * account before anything is looked up.
 *
 * Self-hosters with direct database access also keep the offline
 * scripts/reset-password.mjs as a break-glass path; this module is the
 * normal-user flow.
 */
import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { normalizeEmail } from "./credentials";
import { checkPasswordPolicy } from "./policy";
import { hashPassword } from "./password";
import { clientRateLimitKey, consumeRateLimit } from "./rate-limit";
import {
  CODE_LENGTH,
  RECOVERY_CODE_COUNT,
  generateRecoveryCode,
  hashRecoveryCode,
  normalizeRecoveryCode,
} from "./recovery-codes";

export { RECOVERY_CODE_COUNT };

/**
 * Replace every recovery code for `userId` with a fresh batch and return
 * the plaintext codes — the only moment they exist outside the caller's
 * screen. Runs inside the caller's transaction so sign-up (create user +
 * codes) and regeneration (burn old + create new) are each atomic.
 */
export async function replaceRecoveryCodes(
  tx: Pick<typeof prisma, "recoveryCode">,
  userId: string,
): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode());
  await tx.recoveryCode.deleteMany({ where: { userId } });
  await tx.recoveryCode.createMany({
    data: codes.map((code) => ({ userId, codeHash: hashRecoveryCode(code) })),
  });
  return codes;
}

/** How many unused codes the account still holds — shown in Settings. */
export async function countRemainingRecoveryCodes(userId: string): Promise<number> {
  return prisma.recoveryCode.count({ where: { userId, usedAt: null } });
}

export type RecoveryResult = { ok: true } | { ok: false; error: "rejected" | "rate-limited" | "password" };

/** Constant-time hex-digest comparison. */
function digestsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * The whole "forgot password" decision. Returns `rejected` for every
 * identity failure — unknown email, wrong or already-used code — so the
 * form confirms nothing about which accounts exist. Only the password
 * policy gets a specific error: by then the caller has already proven
 * account ownership with a valid code, so there is nothing left to leak.
 */
export async function redeemRecoveryCode(input: {
  email: string;
  code: string;
  newPassword: string;
}): Promise<RecoveryResult> {
  const email = normalizeEmail(input.email);
  const normalized = normalizeRecoveryCode(input.code);

  // Free structural validation first, so an obviously-malformed submission
  // (blank email, too-short code) never costs anyone a rate-limit slot —
  // and, crucially, never writes a per-account bucket row for an arbitrary
  // attacker-named email.
  if (!email || normalized.length < CODE_LENGTH) return { ok: false, error: "rejected" };

  // Two fences, short-circuited. Per-CLIENT first: if the caller has spent
  // their own window, refuse WITHOUT touching the per-account bucket —
  // otherwise one un-spoofed address could keep an unlimited number of
  // victims' recovery windows exhausted (a targeted DoS) and grow the
  // bucket table one row per chosen email. Only a caller still within its
  // own budget is allowed to spend against a named account.
  const perClient = await consumeRateLimit(await clientRateLimitKey("recover"), 10, 60 * 60_000);
  if (!perClient) return { ok: false, error: "rate-limited" };
  const perAccount = await consumeRateLimit(`recover-email:${email}`, 5, 60 * 60_000);
  if (!perAccount) return { ok: false, error: "rate-limited" };

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  });

  // Unknown account: burn comparable work to a real check, refuse generically.
  const candidateHash = hashRecoveryCode(normalized);
  if (!user) {
    digestsMatch(candidateHash, createHash("sha256").update(randomBytes(32)).digest("hex"));
    return { ok: false, error: "rejected" };
  }

  const codeRow = await prisma.recoveryCode.findUnique({ where: { codeHash: candidateHash } });
  if (!codeRow || codeRow.userId !== user.id || codeRow.usedAt !== null) {
    return { ok: false, error: "rejected" };
  }

  const policyError = checkPasswordPolicy(input.newPassword, user.email);
  if (policyError) return { ok: false, error: "password" };

  const passwordHash = await hashPassword(input.newPassword);

  // Burn the code and set the password atomically; the guarded updateMany
  // means two concurrent redemptions of the same code cannot both win.
  const outcome = await prisma.$transaction(async (tx) => {
    const burned = await tx.recoveryCode.updateMany({
      where: { id: codeRow.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (burned.count === 0) return "lost" as const;
    await tx.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        passwordUpdatedAt: new Date(),
        // Every session everywhere dies on its next request — whoever held
        // the old password (or a stolen session) is out.
        tokenVersion: { increment: 1 },
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });
    return "ok" as const;
  });

  if (outcome !== "ok") return { ok: false, error: "rejected" };
  return { ok: true };
}
