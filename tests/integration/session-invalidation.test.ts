/**
 * Session revocation via tokenVersion, pinned at the exact seam production
 * uses to answer "who is making this request?" — getCurrentUser — plus the
 * actions that bump the version (changePasswordAction, signOutEverywhere)
 * and the backup export's promise that credentials never leave the database.
 *
 * The invariants that must never regress:
 *   - a session token only resolves while its tokenVersion matches the row;
 *     bumping the row kills every outstanding token, and a token carrying NO
 *     version at all (a legacy Google-era JWT) is treated as signed out,
 *   - changing the password requires the CURRENT password, and a wrong guess
 *     there feeds the same lockout counter as a failed sign-in,
 *   - a successful password change stores a new verifying hash, stamps
 *     passwordUpdatedAt and bumps tokenVersion (revoked everywhere),
 *   - an exported backup carries profile fields only — no passwordHash, no
 *     tokenVersion, no lockout state, not even the email.
 *
 * Auth.js is stubbed (vitest.integration.config.ts): actAs plants the session
 * verbatim, signIn/signOut are no-ops, and React's cache() does not memoize
 * outside a request context — which is why, as in auth-account.test.ts,
 * getCurrentUser can simply be called again after each state change.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { changePasswordAction, signOutEverywhereAction } from "@/server/actions/auth";
import { exportBackup } from "@/server/actions/backup";
import { getCurrentUser } from "@/server/auth/current-user";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { actAs, resetDatabase } from "./helpers";

import type { User } from "./helpers";

const EMAIL = "alice@test.local";
const PASSWORD = "correct-horse-battery-staple";
const NEW_PASSWORD = "brand-new-secret-phrase-1";

// scrypt at the current cost is deliberately slow; hash once, reuse per test.
let passwordHash: string;
let alice: User;

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

beforeEach(async () => {
  await resetDatabase();
  alice = await prisma.user.create({
    data: { email: EMAIL, name: "Alice", passwordHash },
  });
});

/** The row with the globally-omitted credential columns opted back in. */
async function secretRow() {
  return prisma.user.findUniqueOrThrow({
    where: { email: EMAIL },
    omit: { passwordHash: false },
  });
}

describe("getCurrentUser and tokenVersion", () => {
  it("returns the row for a session whose tokenVersion matches", async () => {
    actAs(alice);
    const user = await getCurrentUser();
    expect(user).not.toBeNull();
    expect(user?.id).toBe(alice.id);
    expect(user?.tokenVersion).toBe(alice.tokenVersion);
  });

  it("returns null for a stale session once the row's tokenVersion is bumped", async () => {
    actAs(alice);
    expect(await getCurrentUser()).not.toBeNull();

    // Bump the row (what a password change or "sign out everywhere" does).
    // The planted session still carries the OLD version — it must die on its
    // very next request, with no per-session bookkeeping anywhere.
    await prisma.user.update({
      where: { id: alice.id },
      data: { tokenVersion: { increment: 1 } },
    });
    expect(await getCurrentUser()).toBeNull();
  });

  it("returns null for a legacy session that carries no tokenVersion at all", async () => {
    // A JWT minted by the old Google-era config has no tv claim. The check is
    // a strict !==, so "no version" can never equal any row version — the
    // token is signed out rather than grandfathered in.
    actAs({ ...alice, tokenVersion: undefined } as unknown as User);
    expect(await getCurrentUser()).toBeNull();
  });
});

describe("changePasswordAction", () => {
  it("with the correct current password: stores a new verifying hash, stamps passwordUpdatedAt and bumps tokenVersion", async () => {
    actAs(alice);
    const result = await changePasswordAction({
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
      confirm: NEW_PASSWORD,
    });
    expect(result.ok).toBe(true);

    const row = await secretRow();
    expect(row.passwordHash).not.toBe(passwordHash);
    expect(await verifyPassword(NEW_PASSWORD, row.passwordHash!)).toBe(true);
    expect(await verifyPassword(PASSWORD, row.passwordHash!)).toBe(false);
    expect(row.tokenVersion).toBe(alice.tokenVersion + 1);
    expect(row.passwordUpdatedAt).not.toBeNull();

    // The session planted before the change still carries the old version:
    // every other device is now signed out. (Production re-issues THIS
    // browser's cookie via signIn, which the test stub no-ops.)
    expect(await getCurrentUser()).toBeNull();
  });

  it("with a wrong current password: fails, counts toward the sign-in lockout, leaves tokenVersion alone", async () => {
    actAs(alice);
    const result = await changePasswordAction({
      currentPassword: "not-the-password",
      newPassword: NEW_PASSWORD,
      confirm: NEW_PASSWORD,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toMatch(/current password/i);

    // A stolen session guessing at the current password marches toward the
    // same lockout as failed sign-ins — it is not a free oracle.
    const row = await secretRow();
    expect(row.failedLoginCount).toBe(1);
    expect(row.lastFailedLoginAt).not.toBeNull();
    expect(row.tokenVersion).toBe(alice.tokenVersion);
    expect(row.passwordHash).toBe(passwordHash);
    expect(row.passwordUpdatedAt).toBeNull();
  });

  it("rejects a new password built around the email local part", async () => {
    actAs(alice);
    const result = await changePasswordAction({
      currentPassword: PASSWORD,
      newPassword: "alice-needs-a-new-secret",
      confirm: "alice-needs-a-new-secret",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toMatch(/email/i);

    // Rejected before the current password is judged: nothing changed, and
    // no failure was recorded against the lockout counter.
    const row = await secretRow();
    expect(row.passwordHash).toBe(passwordHash);
    expect(row.tokenVersion).toBe(alice.tokenVersion);
    expect(row.failedLoginCount).toBe(0);
  });
});

describe("signOutEverywhereAction", () => {
  it("bumps tokenVersion so every outstanding session dies on its next request", async () => {
    actAs(alice);
    expect(await getCurrentUser()).not.toBeNull();

    await signOutEverywhereAction();

    const row = await secretRow();
    expect(row.tokenVersion).toBe(alice.tokenVersion + 1);
    // The session planted before the action carries the old version.
    expect(await getCurrentUser()).toBeNull();
  });
});

describe("exportBackup", () => {
  it("never carries credentials — profile fields only, no email, no auth state", async () => {
    actAs(alice);
    const result = await exportBackup();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    const users = result.data.data.users;
    expect(users).toHaveLength(1);
    const exported = users[0] as Record<string, unknown>;

    // Assert on the actual key set: a field that sneaks into the export
    // object shows up here even if its value happens to be null.
    const keys = Object.keys(exported);
    expect(keys).not.toContain("passwordHash");
    expect(keys).not.toContain("tokenVersion");
    expect(keys).not.toContain("failedLoginCount");
    expect(keys).not.toContain("lockedUntil");
    expect(keys).not.toContain("email");

    // The profile itself survives — the file is still a useful backup.
    expect(exported.name).toBe("Alice");
    expect(typeof exported.timezone).toBe("string");
    expect(typeof exported.dayStartHour).toBe("number");
  });
});
