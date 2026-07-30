/**
 * Recovery-code primitives: generation, normalization, hashing. Pure
 * node:crypto — no database, no server-only guard — so the unit tests can
 * pin the format and entropy without a running PostgreSQL. The stateful
 * flow (storing, redeeming) lives in ./recovery.ts.
 */
import { createHash, randomInt } from "node:crypto";

export const RECOVERY_CODE_COUNT = 8;

/**
 * Crockford-flavoured alphabet: no 0/O, 1/l/I ambiguity, lowercase for easy
 * typing. 31 symbols × 16 characters ≈ 79 bits of randomness per code —
 * far beyond online guessing, strong enough that a fast hash is safe.
 */
export const CODE_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
export const CODE_LENGTH = 16;

/** One code, displayed as four dash-separated groups: "k3n9-p2qw-...". */
export function generateRecoveryCode(): string {
  let raw = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return raw.replace(/(.{4})(?=.)/g, "$1-");
}

/** Typing tolerance: case, spaces and dashes never matter. */
export function normalizeRecoveryCode(raw: string): string {
  return raw.toLowerCase().replace(/[\s-]/g, "");
}

/** SHA-256 hex over the normalized code — what the database stores. */
export function hashRecoveryCode(raw: string): string {
  return createHash("sha256").update(normalizeRecoveryCode(raw)).digest("hex");
}
