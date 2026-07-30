/**
 * The account-resolution invariant behind every query and action, against a
 * real user table: getCurrentUser returns a row only for a session that
 * names an existing user AND carries that user's current tokenVersion.
 * There is no allowlist and no per-email gate — ANY account resolves; what
 * revokes access is the tokenVersion bump (password change, "sign out
 * everywhere"), pinned in depth by session-invalidation.test.ts.
 *
 * Auth.js itself (cookie/JWT machinery) is stubbed out by
 * vitest.integration.config.ts, so no real sign-in happens here — the
 * password verification path has its own suite (password-auth.test.ts);
 * what this file proves is the DB-level invariant every request depends on
 * after sign-in.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { getCurrentUser, requireCurrentUser } from "@/server/auth/current-user";
import { actAs, createUser, resetDatabase, twoUsers } from "./helpers";

import type { User } from "./helpers";

let alice: User;

beforeEach(async () => {
  await resetDatabase();
  ({ alice } = await twoUsers());
});

describe("getCurrentUser", () => {
  it("returns null with no session at all", async () => {
    actAs(null);
    expect(await getCurrentUser()).toBeNull();
  });

  it("returns the database row for a session user", async () => {
    actAs(alice);
    const user = await getCurrentUser();
    expect(user).not.toBeNull();
    expect(user?.id).toBe(alice.id);
    expect(user?.email).toBe("alice@test.local");
  });

  it("returns null for a session whose user row is missing", async () => {
    actAs(alice);
    // The session cookie outlives the account: the row is gone, so the
    // otherwise-valid session must resolve to nobody.
    await prisma.user.delete({ where: { id: alice.id } });
    expect(await getCurrentUser()).toBeNull();
    await expect(requireCurrentUser()).rejects.toThrowError(/NEXT_REDIRECT/);
  });

  it("resolves ANY existing account — there is no allowlist and no per-email gate", async () => {
    // A brand-new self-serve account nobody "approved": it simply works.
    const newcomer = await createUser("newcomer@test.local", "Newcomer");
    actAs(newcomer);
    expect((await getCurrentUser())?.id).toBe(newcomer.id);
  });

  it("returns null for a session whose tokenVersion predates the row's — revocation is the version bump", async () => {
    actAs(alice); // captures tokenVersion as it is right now
    await prisma.user.update({
      where: { id: alice.id },
      data: { tokenVersion: { increment: 1 } },
    });
    expect(await getCurrentUser()).toBeNull();
  });
});
