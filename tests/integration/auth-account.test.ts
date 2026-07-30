/**
 * The account-resolution invariant behind every query and action, against a
 * real user table: getCurrentUser returns a row only for a session whose user
 * exists AND is allowlisted, and the allowlist is re-read per request so a
 * change locks accounts out (or in) immediately.
 *
 * Auth.js itself (cookie/JWT machinery) is stubbed out by
 * vitest.integration.config.ts, so no real sign-in happens here — the
 * password verification path has its own suite (password-auth.test.ts);
 * what this file proves is the DB-level invariant every request depends on
 * after sign-in.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { getCurrentUser, requireCurrentUser } from "@/server/auth/current-user";
import { actAs, createUser, resetDatabase, twoUsers } from "./helpers";

import type { User } from "./helpers";

let alice: User;

// tests/integration/setup.ts sets the allowlist; every mutation restores it.
const ALLOWLIST = process.env.ALLOWED_EMAILS;

beforeEach(async () => {
  await resetDatabase();
  ({ alice } = await twoUsers());
});

afterEach(() => {
  process.env.ALLOWED_EMAILS = ALLOWLIST;
});

describe("getCurrentUser", () => {
  it("returns null with no session at all", async () => {
    actAs(null);
    expect(await getCurrentUser()).toBeNull();
  });

  it("returns the database row for an allowlisted session user", async () => {
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

  it("returns null for a user whose email is not allowlisted", async () => {
    const outsider = await createUser("outsider@test.local", "Outsider");
    actAs(outsider);
    expect(await getCurrentUser()).toBeNull();
  });

  it("re-reads the allowlist per request — adding and removing an email applies immediately", async () => {
    const outsider = await createUser("outsider@test.local", "Outsider");
    actAs(outsider);
    expect(await getCurrentUser()).toBeNull();

    // Case-insensitive: the env list is upper-cased, the row is lower-case.
    process.env.ALLOWED_EMAILS = `${ALLOWLIST},OUTSIDER@TEST.LOCAL`;
    expect((await getCurrentUser())?.id).toBe(outsider.id);

    // Removing the email locks the account out on its very next request.
    process.env.ALLOWED_EMAILS = ALLOWLIST;
    expect(await getCurrentUser()).toBeNull();
  });
});
