/**
 * The scrypt password-hash implementation — THE single source of truth.
 *
 * Plain ESM JavaScript so every consumer can share it verbatim:
 *   - the app (src/server/auth/password.ts wraps it behind `server-only`),
 *   - the owner recovery CLI (scripts/reset-password.mjs),
 *   - the local/e2e seeds (prisma/demo-data.ts, scripts/seed-e2e-users.mjs),
 *   - the unit tests that pin the format.
 *
 * Stored format: `scrypt$<logN>$<r>$<p>$<salt-b64>$<hash-b64>`. Parameters
 * live inside the stored string, so they can be raised later without
 * breaking existing hashes: verification always uses the stored parameters,
 * and `needsRehash` reports when a hash predates the current cost so the
 * caller can transparently re-hash on the next successful sign-in.
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// Current cost: N=2^16, r=8 is 64 MiB and ~200 ms — comfortably above the
// OWASP scrypt floor. Affordable because sign-in is rare in a single-owner
// app and hosted functions have ≥1 GB of memory.
const LOG_N = 16;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

// Upper bounds accepted when *verifying*, so a tampered stored string cannot
// make the server allocate unbounded memory.
const MAX_LOG_N = 20;
const MAX_R = 16;
const MAX_P = 4;

function scryptAsync(password, salt, logN, r, p) {
  const N = 2 ** logN;
  return new Promise((resolve, reject) => {
    scrypt(
      // NFKC first: the "same" password typed through a different keyboard,
      // IME or platform can arrive as different Unicode code points; without
      // normalization that locks the owner out of their own account.
      password.normalize("NFKC"),
      salt,
      KEY_LENGTH,
      // maxmem must exceed 128 * N * r; double it for headroom.
      { N, r, p, maxmem: 256 * N * r },
      (error, derived) => (error ? reject(error) : resolve(derived)),
    );
  });
}

/** Hash a password with the current parameters. */
export async function hashPassword(password) {
  const salt = randomBytes(SALT_LENGTH);
  const hash = await scryptAsync(password, salt, LOG_N, R, P);
  return [
    "scrypt",
    String(LOG_N),
    String(R),
    String(P),
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
}

function parseStoredHash(stored) {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const logN = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(logN) || logN < 10 || logN > MAX_LOG_N) return null;
  if (!Number.isInteger(r) || r < 1 || r > MAX_R) return null;
  if (!Number.isInteger(p) || p < 1 || p > MAX_P) return null;
  try {
    const salt = Buffer.from(parts[4], "base64");
    const hash = Buffer.from(parts[5], "base64");
    if (salt.length < 8 || hash.length !== KEY_LENGTH) return null;
    return { logN, r, p, salt, hash };
  } catch {
    return null;
  }
}

/**
 * Constant-time verification against a stored hash. Malformed stored values
 * verify as false rather than throwing — a corrupted row must fail closed,
 * not crash sign-in for everyone.
 */
export async function verifyPassword(password, stored) {
  const parsed = parseStoredHash(stored);
  if (!parsed) return false;
  const candidate = await scryptAsync(password, parsed.salt, parsed.logN, parsed.r, parsed.p);
  return candidate.length === parsed.hash.length && timingSafeEqual(candidate, parsed.hash);
}

/** True when the stored hash uses weaker-than-current parameters. */
export function needsRehash(stored) {
  const parsed = parseStoredHash(stored);
  if (!parsed) return true;
  return parsed.logN < LOG_N || parsed.r < R || parsed.p < P;
}
