/**
 * One-time owner setup — how the first (and normally only) password account
 * comes to exist without any external identity provider.
 *
 * The /setup page is live only while BOTH hold:
 *   1. `AUTH_SETUP_TOKEN` is set in the environment — a high-entropy secret
 *      only the deployer knows (docs say to generate it with
 *      `openssl rand -base64 33` and to remove it after setup), and
 *   2. no account has a password yet.
 *
 * The moment setup completes, condition 2 turns it off everywhere — the page
 * redirects to /signin and the action refuses. Re-running setup to overwrite
 * an existing password is deliberately impossible; recovery for a lost
 * password is the offline script (scripts/reset-password.mjs), which needs
 * direct database access.
 *
 * If an account row for the email already exists (a deployment migrated from
 * the Google-era build, or an import created it), setup ATTACHES the password
 * to that row rather than creating a duplicate — existing data stays owned.
 */
import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { allowlistConfigured, isAllowedEmail } from "./allowlist";
import { hashPassword } from "./password";
import { normalizeEmail } from "./credentials";

export const MIN_PASSWORD_LENGTH = 12;

/**
 * The setup token is the only thing standing between the internet and the
 * owner account while setup is open, so a weak one must not count as
 * configured at all: below this length the page simply does not exist.
 * (Docs: `openssl rand -base64 33` → 44 characters.)
 */
export const MIN_SETUP_TOKEN_LENGTH = 32;

function configuredToken(): string {
  const token = process.env.AUTH_SETUP_TOKEN?.trim() ?? "";
  return token.length >= MIN_SETUP_TOKEN_LENGTH ? token : "";
}

/** Constant-time equality over digests, safe for unequal lengths. */
function tokenMatches(candidate: string): boolean {
  const expected = configuredToken();
  if (!expected) return false;
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

async function credentialAccountExists(): Promise<boolean> {
  const existing = await prisma.user.findFirst({
    where: { passwordHash: { not: null } },
    select: { id: true },
  });
  return existing !== null;
}

/** Whether the /setup page should exist right now. */
export async function setupAvailable(): Promise<boolean> {
  if (!configuredToken()) return false;
  if (!allowlistConfigured()) return false;
  return !(await credentialAccountExists());
}

export type SetupError = "disabled" | "done" | "mismatch" | "short" | "weak" | "rejected";
export type SetupResult = { ok: true } | { ok: false; error: SetupError };

/**
 * Create (or complete) the owner account. Error codes stay generic — this
 * page is reachable signed-out, so it must not confirm which emails exist or
 * whether the token was the failing part.
 */
export async function completeSetup(input: {
  token: string;
  email: string;
  password: string;
  confirm: string;
}): Promise<SetupResult> {
  const email = normalizeEmail(input.email);

  if (!configuredToken() || !allowlistConfigured()) {
    return { ok: false, error: "disabled" };
  }
  if (await credentialAccountExists()) {
    return { ok: false, error: "done" };
  }
  if (input.password !== input.confirm) {
    return { ok: false, error: "mismatch" };
  }
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: "short" };
  }
  // One combined check for the two secrets. Deciding them separately would
  // tell a visitor which one they got right. The flat delay keeps guessing
  // slow even though the token's entropy already makes it hopeless.
  if (!tokenMatches(input.token) || !email || !isAllowedEmail(email)) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return { ok: false, error: "rejected" };
  }
  if (containsEmailLocalPart(input.password, email)) {
    return { ok: false, error: "weak" };
  }

  const passwordHash = await hashPassword(input.password);
  const name = email.split("@")[0] || "You";

  // Transactional re-check: two concurrent setup submissions must not both
  // "win" — the second one finds a credential account and refuses, exactly
  // as a sequential second attempt would.
  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.user.findFirst({
      where: { passwordHash: { not: null } },
      select: { id: true },
    });
    if (existing) return "done" as const;
    await tx.user.upsert({
      where: { email },
      create: { email, name, passwordHash, passwordUpdatedAt: new Date() },
      update: { passwordHash, passwordUpdatedAt: new Date() },
    });
    return "ok" as const;
  });
  if (result === "done") return { ok: false, error: "done" };

  return { ok: true };
}

/**
 * A password built around the email's local part ("jane.doe2024!") is the
 * first thing anyone tries. Only the local part is checked — full-email
 * substrings are covered by it, and domain words alone are too common to ban.
 */
export function containsEmailLocalPart(password: string, email: string): boolean {
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  if (local.length < 4) return false;
  return password.toLowerCase().includes(local);
}
