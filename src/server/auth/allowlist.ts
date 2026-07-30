/**
 * The server-side email allowlist.
 *
 * Personal OS is a private app with no public registration: an account exists
 * only for the email addresses the owner has listed in `ALLOWED_EMAILS`
 * (comma-separated, case-insensitive). Google may authenticate anyone; this
 * list decides who is *authorized*, and it is enforced twice — at sign-in and
 * again on every authenticated request (so removing an email locks that
 * account out immediately, without waiting for its session to expire).
 *
 * Edge-safe: no database, no Node-only imports — the middleware bundles this.
 */

function parseAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email.includes("@")),
  );
}

export function isAllowedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  // Parsed per call rather than cached at module scope so a redeploy with a
  // changed ALLOWED_EMAILS takes effect everywhere without stale copies.
  return parseAllowlist(process.env.ALLOWED_EMAILS).has(email.trim().toLowerCase());
}

/** True when no allowlist is configured at all — used to fail closed. */
export function allowlistConfigured(): boolean {
  return parseAllowlist(process.env.ALLOWED_EMAILS).size > 0;
}
