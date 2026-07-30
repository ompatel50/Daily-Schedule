/**
 * The one-time owner bootstrap, against a real user table: /setup exists only
 * while AUTH_SETUP_TOKEN (>= 32 chars) is configured, the allowlist is
 * non-empty, and NO account has a password yet — and completeSetup can run
 * exactly once, after which the door is closed for good.
 *
 * The invariants that must never regress:
 *   - a missing, weak (short) token, or empty allowlist keeps setup OFF —
 *     the gate fails closed on every precondition,
 *   - the first credential account turns setup off everywhere; a second
 *     completeSetup gets "done", never an overwritten password,
 *   - setup ATTACHES the password to a pre-existing row for the same email
 *     (a migrated account keeps its id and its data) instead of duplicating,
 *   - a wrong token or non-allowlisted email gets the same generic
 *     "rejected" after a flat >= 1s delay (no oracle for which secret
 *     failed), and never creates a user,
 *   - password policy: minimum length, confirm match, and no passwords
 *     built around the email's local part.
 *
 * AUTH_SETUP_TOKEN and ALLOWED_EMAILS are process-global, so every test that
 * touches them restores the originals in afterEach.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { verifyPassword } from "@/server/auth/password";
import {
  MIN_PASSWORD_LENGTH,
  MIN_SETUP_TOKEN_LENGTH,
  completeSetup,
  containsEmailLocalPart,
  setupAvailable,
} from "@/server/auth/setup";
import { createUser, resetDatabase } from "./helpers";

const TOKEN = "integration-test-setup-token-0123456789";
const EMAIL = "owner@test.local"; // in the allowlist tests/integration/setup.ts plants
const PASSWORD = "sturdy-passphrase-2026";

// tests/integration/setup.ts sets the allowlist; the token starts unset.
const ORIGINAL_ALLOWLIST = process.env.ALLOWED_EMAILS;
const ORIGINAL_TOKEN = process.env.AUTH_SETUP_TOKEN;

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** completeSetup with valid-everything defaults; override one knob per test. */
function attempt(
  overrides: Partial<{ token: string; email: string; password: string; confirm: string }> = {},
) {
  return completeSetup({
    token: TOKEN,
    email: EMAIL,
    password: PASSWORD,
    confirm: PASSWORD,
    ...overrides,
  });
}

/** The user row with the globally-omitted passwordHash opted back in. */
async function authRow(email: string = EMAIL) {
  const row = await prisma.user.findUnique({
    where: { email },
    omit: { passwordHash: false },
  });
  if (!row) throw new Error(`expected a user row for ${email}`);
  return row;
}

beforeEach(async () => {
  await resetDatabase();
  process.env.AUTH_SETUP_TOKEN = TOKEN;
});

afterEach(() => {
  restoreEnv("AUTH_SETUP_TOKEN", ORIGINAL_TOKEN);
  restoreEnv("ALLOWED_EMAILS", ORIGINAL_ALLOWLIST);
});

describe("setupAvailable — the gate on the /setup page", () => {
  it("is true with a long token, a configured allowlist and no credential account", async () => {
    expect(TOKEN.length).toBeGreaterThanOrEqual(MIN_SETUP_TOKEN_LENGTH);
    expect(await setupAvailable()).toBe(true);

    // A password-LESS row (e.g. a migrated Google-era account) does not close
    // the gate — setup exists precisely to attach a password to it.
    await createUser(EMAIL, "Owner");
    expect(await setupAvailable()).toBe(true);
  });

  it("is false when AUTH_SETUP_TOKEN is not set at all", async () => {
    delete process.env.AUTH_SETUP_TOKEN;
    expect(await setupAvailable()).toBe(false);
  });

  it("is false when the token is under the minimum length — a weak token must not open setup", async () => {
    expect("short-token".length).toBeLessThan(MIN_SETUP_TOKEN_LENGTH);
    process.env.AUTH_SETUP_TOKEN = "short-token";
    expect(await setupAvailable()).toBe(false);
  });

  it("is false when the allowlist is empty", async () => {
    process.env.ALLOWED_EMAILS = "";
    expect(await setupAvailable()).toBe(false);
  });

  it("is false once any user has a passwordHash", async () => {
    await prisma.user.create({
      data: {
        email: "bob@test.local",
        name: "Bob",
        passwordHash: "scrypt$16$8$1$c2FsdHNhbHRzYWx0c2E=$aGFzaA==",
      },
    });
    expect(await setupAvailable()).toBe(false);
  });
});

describe("completeSetup — happy path", () => {
  it("creates the owner: normalized email, a verifying scrypt hash, passwordUpdatedAt set", async () => {
    const result = await attempt({ email: "  Owner@TEST.local  " });
    expect(result).toEqual({ ok: true });

    // Stored under the normalized address, not the raw input.
    const row = await authRow(EMAIL);
    expect(row.email).toBe(EMAIL);
    expect(row.passwordHash).not.toBeNull();
    expect(await verifyPassword(PASSWORD, row.passwordHash!)).toBe(true);
    expect(await verifyPassword("not-the-password", row.passwordHash!)).toBe(false);
    expect(row.passwordUpdatedAt).not.toBeNull();

    // The first credential account closes the gate everywhere.
    expect(await setupAvailable()).toBe(false);
  });

  it("attaches the password to an existing row — same id, data kept", async () => {
    const migrated = await createUser(EMAIL, "Owner");
    await prisma.journalEntry.create({
      data: { userId: migrated.id, date: "2026-07-29", content: "pre-setup entry" },
    });

    expect(await attempt()).toEqual({ ok: true });

    // No duplicate account: the migrated row itself gained the password.
    expect(await prisma.user.count()).toBe(1);
    const row = await authRow();
    expect(row.id).toBe(migrated.id);
    expect(await verifyPassword(PASSWORD, row.passwordHash!)).toBe(true);

    // ...and its records still belong to it.
    const entries = await prisma.journalEntry.findMany({ where: { userId: migrated.id } });
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe("pre-setup entry");
  });

  it("refuses a second completeSetup with 'done' — setup can never overwrite a password", async () => {
    expect(await attempt()).toEqual({ ok: true });
    const first = (await authRow()).passwordHash;

    // Even a fully valid second submission (correct token, allowlisted
    // email, strong password) is turned away.
    expect(await attempt({ password: "another-fine-passphrase", confirm: "another-fine-passphrase" }))
      .toEqual({ ok: false, error: "done" });

    expect(await prisma.user.count()).toBe(1);
    expect((await authRow()).passwordHash).toBe(first);
  });
});

describe("completeSetup — refusals", () => {
  it("rejects a wrong token generically, after a flat delay of at least ~1s", async () => {
    const started = Date.now();
    const result = await attempt({ token: "wrong-token-that-is-also-long-enough-000" });
    const elapsed = Date.now() - started;

    expect(result).toEqual({ ok: false, error: "rejected" });
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(await prisma.user.count()).toBe(0);
  });

  it("rejects a non-allowlisted email with the same generic 'rejected'", async () => {
    const result = await attempt({ email: "stranger@test.local" });
    expect(result).toEqual({ ok: false, error: "rejected" });
    expect(await prisma.user.count()).toBe(0);
  });

  it("refuses a password shorter than the minimum with 'short'", async () => {
    const tooShort = "a".repeat(MIN_PASSWORD_LENGTH - 1);
    expect(await attempt({ password: tooShort, confirm: tooShort })).toEqual({
      ok: false,
      error: "short",
    });
    expect(await prisma.user.count()).toBe(0);
  });

  it("refuses a confirm mismatch with 'mismatch'", async () => {
    expect(await attempt({ confirm: `${PASSWORD}-typo` })).toEqual({
      ok: false,
      error: "mismatch",
    });
    expect(await prisma.user.count()).toBe(0);
  });

  it("refuses a password built around the email's local part with 'weak'", async () => {
    expect(await attempt({ password: "the-owner-2026-secret", confirm: "the-owner-2026-secret" }))
      .toEqual({ ok: false, error: "weak" });
    expect(await prisma.user.count()).toBe(0);
  });
});

describe("containsEmailLocalPart — the 'weak' rule itself", () => {
  it("matches the local part case-insensitively, on either side", () => {
    expect(containsEmailLocalPart("MyOwnerPass123", "owner@test.local")).toBe(true);
    expect(containsEmailLocalPart("password-alice-2026", "Alice@TEST.local")).toBe(true);
    expect(containsEmailLocalPart("plain-owner", "OWNER@test.local")).toBe(true);
  });

  it("ignores local parts under 4 characters — banning tiny substrings would ban everything", () => {
    expect(containsEmailLocalPart("contains-bob-here", "bob@test.local")).toBe(false);
    expect(containsEmailLocalPart("abcabcabcabc", "abc@test.local")).toBe(false);
  });

  it("does not match when the local part is absent", () => {
    expect(containsEmailLocalPart("unrelated-passphrase", "owner@test.local")).toBe(false);
  });
});
