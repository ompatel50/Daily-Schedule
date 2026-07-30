/**
 * Public self-serve sign-up, against a real user table: anyone can create
 * an account, duplicates are refused, the password policy holds, and every
 * new account arrives with a full batch of hashed recovery codes.
 *
 * The invariants that must never regress:
 *   - success creates the user with a verifying scrypt hash and
 *     RECOVERY_CODE_COUNT unused recovery codes, stored ONLY as hashes,
 *   - a duplicate email is refused and NEVER touches the existing row —
 *     sign-up must not become an account-takeover path for legacy rows,
 *   - two racing sign-ups for one email produce exactly one account,
 *   - the password policy (length, confirm match, no email local part) is
 *     enforced server-side, not just in the form,
 *   - the per-client rate limit closes after SIGNUP_RATE_LIMIT attempts in
 *     a window (tests share the "signup:unknown" bucket — no request scope).
 */
import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { MIN_PASSWORD_LENGTH } from "@/server/auth/policy";
import { RECOVERY_CODE_COUNT, hashRecoveryCode } from "@/server/auth/recovery-codes";
import { SIGNUP_RATE_LIMIT, createAccount } from "@/server/auth/signup";
import { resetDatabase } from "./helpers";

const EMAIL = "newcomer@test.local";
const PASSWORD = "sturdy-passphrase-2026";

/** createAccount with valid-everything defaults; override one knob per test. */
function attempt(
  overrides: Partial<{ email: string; name: string; password: string; confirm: string }> = {},
) {
  return createAccount({ email: EMAIL, password: PASSWORD, confirm: PASSWORD, ...overrides });
}

/** The user row with the globally-omitted passwordHash opted back in. */
async function authRow(email: string) {
  const row = await prisma.user.findUnique({ where: { email }, omit: { passwordHash: false } });
  if (!row) throw new Error(`expected a user row for ${email}`);
  return row;
}

beforeEach(async () => {
  await resetDatabase();
});

describe("createAccount — success", () => {
  it("creates the user with a verifying password hash and a full batch of recovery codes", async () => {
    const result = await attempt({ name: "Newcomer" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = await authRow(EMAIL);
    expect(row.name).toBe("Newcomer");
    expect(row.passwordHash).not.toBeNull();
    expect(await verifyPassword(PASSWORD, row.passwordHash!)).toBe(true);
    expect(row.passwordUpdatedAt).not.toBeNull();

    // The plaintext codes exist only in the result; the table holds hashes.
    expect(result.recoveryCodes).toHaveLength(RECOVERY_CODE_COUNT);
    const stored = await prisma.recoveryCode.findMany({ where: { userId: row.id } });
    expect(stored).toHaveLength(RECOVERY_CODE_COUNT);
    expect(stored.every((code) => code.usedAt === null)).toBe(true);
    const storedHashes = new Set(stored.map((code) => code.codeHash));
    for (const plaintext of result.recoveryCodes) {
      expect(storedHashes.has(hashRecoveryCode(plaintext))).toBe(true);
      // Never the plaintext itself.
      expect(storedHashes.has(plaintext)).toBe(false);
    }
  });

  it("normalizes the email and defaults the name from its local part", async () => {
    const result = await attempt({ email: "  Casey.Jones@TEST.local " });
    expect(result.ok).toBe(true);

    const row = await prisma.user.findUnique({ where: { email: "casey.jones@test.local" } });
    expect(row).not.toBeNull();
    expect(row?.name).toBe("casey.jones");
  });
});

describe("createAccount — duplicates", () => {
  it("refuses a duplicate email without touching the existing account", async () => {
    const originalHash = await hashPassword("the-original-password");
    const existing = await prisma.user.create({
      data: { email: EMAIL, name: "First", passwordHash: originalHash },
    });

    const result = await attempt({ password: "attacker-password-123", confirm: "attacker-password-123" });
    expect(result).toEqual({ ok: false, error: "exists" });

    // The existing row is byte-for-byte untouched: same password, no codes.
    const row = await authRow(EMAIL);
    expect(row.id).toBe(existing.id);
    expect(row.passwordHash).toBe(originalHash);
    expect(await prisma.recoveryCode.count({ where: { userId: existing.id } })).toBe(0);
    expect(await prisma.user.count()).toBe(1);
  });

  it("refuses to attach a password to a passwordless legacy row — that would be account takeover", async () => {
    await prisma.user.create({ data: { email: EMAIL, name: "Legacy" } });

    const result = await attempt();
    expect(result).toEqual({ ok: false, error: "exists" });
    expect((await authRow(EMAIL)).passwordHash).toBeNull();
  });

  it("two racing sign-ups for one email produce exactly one account", async () => {
    const [first, second] = await Promise.all([attempt(), attempt()]);
    const outcomes = [first, second].map((result) => result.ok).sort();
    expect(outcomes).toEqual([false, true]);
    expect(await prisma.user.count({ where: { email: EMAIL } })).toBe(1);
  });
});

describe("createAccount — honeypot", () => {
  it("refuses a filled honeypot server-side, without creating an account", async () => {
    // A bot that POSTs the action directly bypasses the client check; the
    // server is the real fence. The refusal is a generic error, not a tell.
    const result = await createAccount({
      email: "bot@test.local",
      password: PASSWORD,
      confirm: PASSWORD,
      honeypot: "http://spam.example",
    });
    expect(result.ok).toBe(false);
    expect(await prisma.user.count({ where: { email: "bot@test.local" } })).toBe(0);
  });
});

describe("createAccount — validation", () => {
  it("rejects an implausible email before any database work", async () => {
    for (const email of ["", "not-an-email", "a@b", "spaces in@example.com"]) {
      expect(await attempt({ email })).toEqual({ ok: false, error: "invalid-email" });
    }
    expect(await prisma.user.count()).toBe(0);
  });

  it("rejects mismatched, short and email-derived passwords", async () => {
    expect(await attempt({ confirm: "something-else-entirely" })).toEqual({
      ok: false,
      error: "mismatch",
    });
    const short = "a".repeat(MIN_PASSWORD_LENGTH - 1);
    expect(await attempt({ password: short, confirm: short })).toEqual({
      ok: false,
      error: "short",
    });
    expect(
      await attempt({ password: "newcomer-rules-2026", confirm: "newcomer-rules-2026" }),
    ).toEqual({ ok: false, error: "weak" });
    expect(await prisma.user.count()).toBe(0);
  });
});

describe("createAccount — rate limit", () => {
  it(`closes after ${SIGNUP_RATE_LIMIT} attempts in the window, counting failures too`, async () => {
    // Outside a request scope every attempt shares the "signup:unknown"
    // bucket, which is exactly what this test needs. Duplicate-email
    // attempts are the cheap way to burn it down.
    await attempt({ email: "occupied@test.local" });
    for (let i = 1; i < SIGNUP_RATE_LIMIT; i += 1) {
      const result = await attempt({ email: "occupied@test.local" });
      expect(result).toEqual({ ok: false, error: "exists" });
    }

    // The window is spent: even a perfectly valid sign-up is refused now.
    expect(await attempt({ email: "someone-else@test.local" })).toEqual({
      ok: false,
      error: "rate-limited",
    });
    expect(await prisma.user.findUnique({ where: { email: "someone-else@test.local" } })).toBeNull();

    // A fresh window (simulated by expiring the bucket) opens the door again.
    await prisma.rateLimitBucket.updateMany({
      data: { resetAt: new Date(Date.now() - 1000) },
    });
    expect((await attempt({ email: "someone-else@test.local" })).ok).toBe(true);
  });
});
