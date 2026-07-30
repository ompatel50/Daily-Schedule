/**
 * The password policy, shared by sign-up, password change and recovery.
 *
 * Deliberately a pure module — no secrets, no database, no Node-only
 * imports — so any runtime (server actions, tests, even a client component
 * that wants the length for a `minLength` attribute) can read the same
 * numbers the server enforces.
 */

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;

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

export type PasswordPolicyError = "short" | "long" | "weak";

/**
 * The single policy check every "set a password" path runs. Returns null
 * when the password is acceptable, otherwise which rule it broke — the
 * caller maps that to its own user-facing message.
 */
export function checkPasswordPolicy(
  password: string,
  email: string | null | undefined,
): PasswordPolicyError | null {
  if (password.length < MIN_PASSWORD_LENGTH) return "short";
  if (password.length > MAX_PASSWORD_LENGTH) return "long";
  if (email && containsEmailLocalPart(password, email)) return "weak";
  return null;
}
