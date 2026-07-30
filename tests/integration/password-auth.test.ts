/**
 * The credential policy, end to end against a real user table: this file
 * pins what verifyCredentials (src/server/auth/credentials.ts) — the exact
 * function production sign-in runs — does with correct, wrong, unknown
 * and locked-out credentials, including the DB side effects
 * (lastLoginAt, failedLoginCount, lastFailedLoginAt, lockedUntil) that the
 * lockout and audit-trail features depend on.
 *
 * The invariants that must never regress:
 *   - ANY existing account with the right password signs in — no allowlist,
 *     no per-email approval (the public sign-up model),
 *   - every failure mode returns the same bare null (enumeration resistance),
 *   - 5 consecutive failures lock the account, and while locked even the
 *     CORRECT password is refused,
 *   - an EXPIRED lock forgives the old counter, so one wrong guess after a
 *     lockout does not immediately re-lock the owner out,
 *   - a weaker-than-current stored hash is transparently upgraded on the one
 *     moment the plaintext is available (successful sign-in).
 *
 * Lockout states are reached by writing failedLoginCount/lockedUntil rows
 * directly where clock-dependence would otherwise creep in.
 */
import { randomBytes, scrypt } from "node:crypto";

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import {
  MAX_FAILED_ATTEMPTS,
  verifyCredentials,
} from "@/server/auth/credentials";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { resetDatabase } from "./helpers";

const EMAIL = "alice@test.local";
const PASSWORD = "correct-horse-battery-staple";

// scrypt at the current cost is deliberately slow (~200 ms); hash once and
// reuse the stored string for every per-test user row.
let passwordHash: string;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

beforeEach(async () => {
  await resetDatabase();
  await prisma.user.create({ data: { email: EMAIL, name: "Alice", passwordHash } });
});

/** The user row with the globally-omitted passwordHash opted back in. */
async function authRow(email: string = EMAIL) {
  const row = await prisma.user.findUnique({
    where: { email },
    omit: { passwordHash: false },
  });
  if (!row) throw new Error(`expected a user row for ${email}`);
  return row;
}

/**
 * A hash in yesterday's cost (logN 15), built straight on node:crypto so the
 * public API — which only ever writes the current parameters — cannot get in
 * the way. Same format, same NFKC rule, weaker work factor.
 */
function legacyHash(password: string): Promise<string> {
  const salt = randomBytes(16);
  const N = 2 ** 15;
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize("NFKC"),
      salt,
      64,
      { N, r: 8, p: 1, maxmem: 256 * N * 8 },
      (error, derived) =>
        error
          ? reject(error)
          : resolve(
              ["scrypt", "15", "8", "1", salt.toString("base64"), derived.toString("base64")].join(
                "$",
              ),
            ),
    );
  });
}

describe("verifyCredentials — success path", () => {
  it("returns the user for the correct email and password, sets lastLoginAt and clears the failure counter", async () => {
    // A few stale failures on the row: success must wipe them.
    await prisma.user.update({ where: { email: EMAIL }, data: { failedLoginCount: 3 } });

    const user = await verifyCredentials(EMAIL, PASSWORD);
    expect(user).not.toBeNull();
    expect(user?.email).toBe(EMAIL);

    const row = await authRow();
    expect(row.lastLoginAt).not.toBeNull();
    expect(row.failedLoginCount).toBe(0);
    expect(row.lockedUntil).toBeNull();
  });

  it("normalizes the email — case and surrounding whitespace do not matter", async () => {
    const user = await verifyCredentials("  Alice@TEST.local ", PASSWORD);
    expect(user).not.toBeNull();
    expect(user?.email).toBe(EMAIL);
  });
});

describe("verifyCredentials — failure paths", () => {
  it("returns null for a wrong password and records the failure on the row", async () => {
    expect(await verifyCredentials(EMAIL, "not-the-password")).toBeNull();

    const row = await authRow();
    expect(row.failedLoginCount).toBe(1);
    expect(row.lastFailedLoginAt).not.toBeNull();
    expect(row.lastLoginAt).toBeNull();
  });

  it("returns null for an unknown email and never creates a user", async () => {
    const before = await prisma.user.count();
    expect(await verifyCredentials("nobody@test.local", PASSWORD)).toBeNull();
    expect(await prisma.user.count()).toBe(before);
    expect(await prisma.user.findUnique({ where: { email: "nobody@test.local" } })).toBeNull();
  });

  it("signs in ANY existing account with the right password — no allowlist, no approval step", async () => {
    // A second, freshly self-served account nobody "allowed": public
    // sign-up means the password is the whole test.
    await prisma.user.create({
      data: { email: "newcomer@test.local", name: "Newcomer", passwordHash },
    });

    const user = await verifyCredentials("newcomer@test.local", PASSWORD);
    expect(user).not.toBeNull();
    expect(user?.email).toBe("newcomer@test.local");
    expect((await authRow("newcomer@test.local")).lastLoginAt).not.toBeNull();
  });

  it("returns null for a missing password or empty email without touching the counters", async () => {
    expect(await verifyCredentials(EMAIL, "")).toBeNull();
    expect(await verifyCredentials(EMAIL, undefined)).toBeNull();
    expect(await verifyCredentials("", PASSWORD)).toBeNull();
    expect(await verifyCredentials("   ", PASSWORD)).toBeNull();

    const row = await authRow();
    expect(row.failedLoginCount).toBe(0);
    expect(row.lastFailedLoginAt).toBeNull();
  });
});

describe("verifyCredentials — lockout", () => {
  it("locks after 5 consecutive failures, and while locked the correct password is refused too", async () => {
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      expect(await verifyCredentials(EMAIL, "wrong-every-time")).toBeNull();
    }

    const locked = await authRow();
    expect(locked.failedLoginCount).toBe(MAX_FAILED_ATTEMPTS);
    expect(locked.lockedUntil).not.toBeNull();
    expect(locked.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    // The lock must not be a password oracle: the right password fails the
    // same way, and does not count as a sign-in.
    expect(await verifyCredentials(EMAIL, PASSWORD)).toBeNull();
    expect((await authRow()).lastLoginAt).toBeNull();
  });

  it("forgives an expired lock — the correct password succeeds, and one wrong attempt after does not re-lock", async () => {
    await prisma.user.update({
      where: { email: EMAIL },
      data: {
        failedLoginCount: MAX_FAILED_ATTEMPTS,
        lockedUntil: new Date(Date.now() - 60_000),
      },
    });

    const user = await verifyCredentials(EMAIL, PASSWORD);
    expect(user).not.toBeNull();

    const cleared = await authRow();
    expect(cleared.failedLoginCount).toBe(0);
    expect(cleared.lockedUntil).toBeNull();
    expect(cleared.lastLoginAt).not.toBeNull();

    // The counter restarted from zero: a single new failure is 1-of-5, not
    // an instant re-lock — otherwise one bad guess per window could keep the
    // owner out forever.
    expect(await verifyCredentials(EMAIL, "one-bad-guess")).toBeNull();
    const after = await authRow();
    expect(after.failedLoginCount).toBe(1);
    expect(after.lockedUntil).toBeNull();
  });
});

describe("verifyCredentials — transparent rehash", () => {
  it("upgrades a weaker-than-current stored hash on successful sign-in", async () => {
    await prisma.user.update({
      where: { email: EMAIL },
      data: { passwordHash: await legacyHash(PASSWORD) },
    });
    expect((await authRow()).passwordHash).toMatch(/^scrypt\$15\$/);

    expect(await verifyCredentials(EMAIL, PASSWORD)).not.toBeNull();

    const upgraded = (await authRow()).passwordHash;
    expect(upgraded).not.toBeNull();
    expect(upgraded!.startsWith("scrypt$16$")).toBe(true);
    // The upgraded hash still verifies the same password.
    expect(await verifyPassword(PASSWORD, upgraded!)).toBe(true);
  });
});
