/**
 * Password hashing — Node's built-in scrypt, no external dependency.
 *
 * The implementation lives in scripts/lib/password-hash.mjs (one source of
 * truth shared with the recovery CLI and the seeds); this module is the
 * app-facing wrapper that adds the `server-only` guard — client code and the
 * Edge middleware can never pull hashing (or a hash) into their bundles —
 * plus the dummy-hash used for enumeration-resistant failures.
 */
import "server-only";

import { randomBytes } from "node:crypto";

import { hashPassword, needsRehash, verifyPassword } from "../../../scripts/lib/password-hash.mjs";

export { hashPassword, needsRehash, verifyPassword };

/**
 * A real hash of an unguessable value, verified against for sign-in attempts
 * naming an unknown email — so "no such account" costs the same wall-clock
 * time as "wrong password" and reveals nothing by timing.
 */
let dummyHashPromise: Promise<string> | null = null;
export function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomBytes(32).toString("hex"));
  return dummyHashPromise;
}
