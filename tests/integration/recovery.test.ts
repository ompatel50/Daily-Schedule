/**
 * Password recovery by one-time code, against a real user table: the whole
 * "forgot password" path — redeem a code, set a new password, kill every
 * session — plus the regeneration flow behind Settings.
 *
 * The invariants that must never regress:
 *   - a valid (email, code) pair sets the new password, bumps tokenVersion
 *     (every session dies), clears any lockout and burns the code,
 *   - a burned code never works again,
 *   - unknown email, wrong code, and someone ELSE's valid code all return
 *     the same bare "rejected" (enumeration resistance across accounts),
 *   - the new password must still pass the password policy,
 *   - regeneration invalidates every previous code,
 *   - the per-account and per-client rate limits close the flow before
 *     unlimited guessing.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { verifyCredentials } from "@/server/auth/credentials";
import { hashPassword } from "@/server/auth/password";
import {
  countRemainingRecoveryCodes,
  redeemRecoveryCode,
  replaceRecoveryCodes,
} from "@/server/auth/recovery";
import { RECOVERY_CODE_COUNT } from "@/server/auth/recovery-codes";
import { resetDatabase } from "./helpers";

const EMAIL = "alice@test.local";
const OLD_PASSWORD = "the-old-passphrase-2026";
const NEW_PASSWORD = "a-brand-new-passphrase";

let oldPasswordHash: string;
let userId: string;
let codes: string[];

beforeAll(async () => {
  oldPasswordHash = await hashPassword(OLD_PASSWORD);
});

beforeEach(async () => {
  await resetDatabase();
  const user = await prisma.user.create({
    data: { email: EMAIL, name: "Alice", passwordHash: oldPasswordHash },
  });
  userId = user.id;
  codes = await prisma.$transaction((tx) => replaceRecoveryCodes(tx, userId));
});

function redeem(overrides: Partial<{ email: string; code: string; newPassword: string }> = {}) {
  return redeemRecoveryCode({
    email: EMAIL,
    code: codes[0],
    newPassword: NEW_PASSWORD,
    ...overrides,
  });
}

describe("redeemRecoveryCode — success", () => {
  it("sets the new password, signs every device out, clears any lockout and burns the code", async () => {
    // A locked, failure-ridden account: recovery must reopen it.
    await prisma.user.update({
      where: { id: userId },
      data: { failedLoginCount: 5, lockedUntil: new Date(Date.now() + 10 * 60_000), tokenVersion: 3 },
    });

    const result = await redeem();
    expect(result).toEqual({ ok: true });

    const row = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(row.tokenVersion).toBe(4); // every pre-reset session token is dead
    expect(row.failedLoginCount).toBe(0);
    expect(row.lockedUntil).toBeNull();
    expect(row.passwordUpdatedAt).not.toBeNull();

    // The new password signs in; the old one no longer does.
    expect(await verifyCredentials(EMAIL, NEW_PASSWORD)).not.toBeNull();
    expect(await verifyCredentials(EMAIL, OLD_PASSWORD)).toBeNull();

    expect(await countRemainingRecoveryCodes(userId)).toBe(RECOVERY_CODE_COUNT - 1);
  });

  it("tolerates case, spaces and missing dashes in the typed code", async () => {
    const sloppy = codes[0].toUpperCase().replace(/-/g, " ");
    expect(await redeem({ code: sloppy })).toEqual({ ok: true });
  });

  it("a burned code never works again", async () => {
    expect(await redeem()).toEqual({ ok: true });
    expect(await redeem({ newPassword: "yet-another-passphrase" })).toEqual({
      ok: false,
      error: "rejected",
    });
  });
});

describe("redeemRecoveryCode — enumeration resistance", () => {
  it("returns the same rejection for unknown email, wrong code, and someone else's code", async () => {
    const mallory = await prisma.user.create({
      data: { email: "mallory@test.local", name: "Mallory", passwordHash: oldPasswordHash },
    });
    const malloryCodes = await prisma.$transaction((tx) => replaceRecoveryCodes(tx, mallory.id));

    // Unknown account.
    expect(await redeem({ email: "nobody@test.local" })).toEqual({ ok: false, error: "rejected" });
    // Known account, made-up code.
    expect(await redeem({ code: "aaaa-aaaa-aaaa-aaaa" })).toEqual({ ok: false, error: "rejected" });
    // Known account, VALID code — for a different account. Must not work and
    // must not read any differently.
    expect(await redeem({ code: malloryCodes[0] })).toEqual({ ok: false, error: "rejected" });

    // Nothing changed anywhere: old password still signs in, codes unburned.
    expect(await verifyCredentials(EMAIL, OLD_PASSWORD)).not.toBeNull();
    expect(await countRemainingRecoveryCodes(userId)).toBe(RECOVERY_CODE_COUNT);
    expect(await countRemainingRecoveryCodes(mallory.id)).toBe(RECOVERY_CODE_COUNT);
  });

  it("still enforces the password policy once the code is proven", async () => {
    expect(await redeem({ newPassword: "short" })).toEqual({ ok: false, error: "password" });
    expect(await redeem({ newPassword: "alice-forever-2026" })).toEqual({
      ok: false,
      error: "password",
    });
    // The failed attempts did not burn the code.
    expect(await countRemainingRecoveryCodes(userId)).toBe(RECOVERY_CODE_COUNT);
  });
});

describe("redeemRecoveryCode — rate limits", () => {
  it("closes the per-account window after 5 attempts", async () => {
    for (let i = 0; i < 5; i += 1) {
      expect(await redeem({ code: "aaaa-aaaa-aaaa-aaaa" })).toEqual({
        ok: false,
        error: "rejected",
      });
    }
    // Even the CORRECT code is refused now — the window closed.
    expect(await redeem()).toEqual({ ok: false, error: "rate-limited" });

    // Expire the buckets: the correct code works again.
    await prisma.rateLimitBucket.updateMany({ data: { resetAt: new Date(Date.now() - 1000) } });
    expect(await redeem()).toEqual({ ok: true });
  });
});

describe("replaceRecoveryCodes — regeneration", () => {
  it("invalidates every previous code and returns a fresh full batch", async () => {
    const fresh = await prisma.$transaction((tx) => replaceRecoveryCodes(tx, userId));
    expect(fresh).toHaveLength(RECOVERY_CODE_COUNT);
    expect(fresh.some((code) => codes.includes(code))).toBe(false);

    // An old code is gone for good…
    expect(await redeem()).toEqual({ ok: false, error: "rejected" });
    // …and a fresh one works.
    expect(await redeem({ code: fresh[0] })).toEqual({ ok: true });
  });
});
