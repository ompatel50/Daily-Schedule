/**
 * Public self-serve account creation.
 *
 * Anyone can visit /signup and create an account — there is no allowlist,
 * no setup token and no owner bootstrap. What keeps that safe:
 *
 *  - every account only ever sees its own rows (every query and action goes
 *    through requireCurrentUser + per-user filters — creating an account
 *    grants exactly one empty, isolated space, nothing else),
 *  - the password policy and scrypt hashing are the same code sign-in
 *    verifies against,
 *  - creation is rate limited per client address (database-backed, so the
 *    fence holds across serverless instances),
 *  - a hidden honeypot field in the form catches the dumbest bots for free.
 *
 * Duplicate emails are refused with a message that points at sign-in and
 * recovery. That necessarily confirms the address is taken — unavoidable
 * for any sign-up form that rejects duplicates without sending email — so
 * the rate limit above is also the enumeration fence.
 */
import "server-only";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { normalizeEmail } from "./credentials";
import { hashPassword } from "./password";
import { checkPasswordPolicy, type PasswordPolicyError } from "./policy";
import { replaceRecoveryCodes } from "./recovery";
import { clientRateLimitKey, consumeRateLimit } from "./rate-limit";

export const MAX_EMAIL_LENGTH = 254;
export const MAX_NAME_LENGTH = 80;

/** Sign-up attempts allowed per client address per window. */
export const SIGNUP_RATE_LIMIT = 8;
export const SIGNUP_RATE_WINDOW_MS = 60 * 60_000;

export type SignUpError =
  | "invalid-email"
  | "mismatch"
  | PasswordPolicyError
  | "exists"
  | "rate-limited"
  | "disabled";

/**
 * The optional admin kill switch: set SIGNUPS_DISABLED=1 and redeploy to
 * stop NEW registrations (during an abuse incident, or to run a private
 * instance) without touching existing accounts, which sign in as normal.
 * Normal operation needs nothing — unset means sign-up is open.
 */
export function signupsDisabled(): boolean {
  const raw = process.env.SIGNUPS_DISABLED?.trim().toLowerCase() ?? "";
  return raw === "1" || raw === "true" || raw === "yes";
}

export type SignUpResult =
  | { ok: true; email: string; recoveryCodes: string[] }
  | { ok: false; error: SignUpError };

/** Good enough for a sign-in identifier: something@something.tld, sane length. */
export function isPlausibleEmail(email: string): boolean {
  if (email.length < 3 || email.length > MAX_EMAIL_LENGTH) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Create an account. On success the account exists with a password and a
 * fresh batch of recovery codes — returned in plaintext exactly once, for
 * the sign-up page to display. The caller signs the browser in afterwards.
 */
export async function createAccount(input: {
  email: string;
  name?: string;
  password: string;
  confirm: string;
  /** Honeypot: a hidden form field no human ever fills. Enforced HERE, on
   *  the server — a bot POSTing the action directly bypasses the client
   *  component's check, so the real fence has to live where the request
   *  lands. Any value is a bot; the refusal reads like a generic failure. */
  honeypot?: string;
}): Promise<SignUpResult> {
  if (signupsDisabled()) return { ok: false, error: "disabled" };
  if ((input.honeypot ?? "") !== "") return { ok: false, error: "invalid-email" };

  const email = normalizeEmail(input.email);
  const name = (input.name ?? "").trim().slice(0, MAX_NAME_LENGTH) || email.split("@")[0] || "You";

  if (!isPlausibleEmail(email)) return { ok: false, error: "invalid-email" };
  if (input.password !== input.confirm) return { ok: false, error: "mismatch" };
  const policyError = checkPasswordPolicy(input.password, email);
  if (policyError) return { ok: false, error: policyError };

  // The fence against scripted account floods. Checked after the free local
  // validations so typos don't burn attempts, before any database identity
  // work so the fence really is in front.
  const allowed = await consumeRateLimit(
    await clientRateLimitKey("signup"),
    SIGNUP_RATE_LIMIT,
    SIGNUP_RATE_WINDOW_MS,
  );
  if (!allowed) return { ok: false, error: "rate-limited" };

  const passwordHash = await hashPassword(input.password);

  try {
    const recoveryCodes = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email, name, passwordHash, passwordUpdatedAt: new Date() },
        select: { id: true },
      });
      return replaceRecoveryCodes(tx, user.id);
    });
    return { ok: true, email, recoveryCodes };
  } catch (error) {
    // The email unique constraint is the duplicate check — racing sign-ups
    // included. Never attaches a password to an existing row: that would
    // let a stranger take over a legacy account that predates sign-up.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { ok: false, error: "exists" };
    }
    throw error;
  }
}
