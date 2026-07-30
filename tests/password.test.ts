import { beforeAll, describe, expect, it } from "vitest";

import {
  hashPassword as hashViaModule,
  needsRehash as needsRehashViaModule,
  verifyPassword as verifyViaModule,
} from "../scripts/lib/password-hash.mjs";
import { dummyHash, hashPassword, needsRehash, verifyPassword } from "@/server/auth/password";

/**
 * Pins the scrypt password-hash module — the single implementation shared by
 * the app (via the server-only wrapper), the recovery CLI and the seeds. What
 * must never drift silently: the stored format `scrypt$16$8$1$<b64>$<b64>`
 * (existing rows must keep verifying), random per-hash salts, NFKC input
 * normalization (the same password typed via a different IME must still sign
 * in), malformed stored values failing closed instead of throwing (a corrupt
 * row must not crash sign-in), verify-time parameter caps (a tampered row
 * cannot demand unbounded memory), and `needsRehash` flagging weaker-than-
 * current parameters so old hashes upgrade on the next successful sign-in.
 * Both entry points are exercised so the wrapper can never fork behavior.
 */

const PASSWORD = "correct horse battery staple";

// Structurally valid base64 fields (16-byte salt, 64-byte hash) for building
// stored strings by hand — needsRehash and the malformed-value cases only
// parse, so the bytes themselves are arbitrary.
const SALT_B64 = Buffer.alloc(16, 1).toString("base64");
const HASH_B64 = Buffer.alloc(64, 2).toString("base64");

let stored: string; // hashed via the raw module
let storedAgain: string; // second hash of the same password
let wrapped: string; // hashed via the server wrapper

beforeAll(async () => {
  [stored, storedAgain, wrapped] = await Promise.all([
    hashViaModule(PASSWORD),
    hashViaModule(PASSWORD),
    hashPassword(PASSWORD),
  ]);
}, 30_000);

describe("hash and verify roundtrip", () => {
  it("verifies the original password against its own hash via the module entry point", async () => {
    await expect(verifyViaModule(PASSWORD, stored)).resolves.toBe(true);
  });

  it("verifies via the server wrapper, including hashes produced by the other entry point", async () => {
    await expect(verifyPassword(PASSWORD, wrapped)).resolves.toBe(true);
    await expect(verifyPassword(PASSWORD, stored)).resolves.toBe(true);
    await expect(verifyViaModule(PASSWORD, wrapped)).resolves.toBe(true);
  });

  it("rejects a wrong password", async () => {
    await expect(verifyViaModule("incorrect horse", stored)).resolves.toBe(false);
  });
});

describe("salting", () => {
  it("produces distinct hashes for the same password, both of which verify", async () => {
    expect(storedAgain).not.toBe(stored);
    await expect(verifyViaModule(PASSWORD, storedAgain)).resolves.toBe(true);
  });
});

describe("stored format", () => {
  it("serializes as scrypt$16$8$1$<salt-b64>$<hash-b64> with a 16-byte salt and 64-byte hash", () => {
    expect(stored).toMatch(/^scrypt\$16\$8\$1\$[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}$/);
    const [, , , , saltB64, hashB64] = stored.split("$");
    expect(Buffer.from(saltB64, "base64")).toHaveLength(16);
    expect(Buffer.from(hashB64, "base64")).toHaveLength(64);
  });
});

describe("malformed stored values", () => {
  const cases: Array<[label: string, value: string]> = [
    ["empty string", ""],
    ["garbage", "garbage"],
    ["wrong algorithm tag", `bcrypt$16$8$1$${SALT_B64}$${HASH_B64}`],
    ["too few parts", `scrypt$16$8$1$${SALT_B64}`],
    ["too many parts", `scrypt$16$8$1$${SALT_B64}$${HASH_B64}$extra`],
    ["non-integer logN", `scrypt$sixteen$8$1$${SALT_B64}$${HASH_B64}`],
    ["fractional logN", `scrypt$16.5$8$1$${SALT_B64}$${HASH_B64}`],
    ["logN above the verify cap", `scrypt$21$8$1$${SALT_B64}$${HASH_B64}`],
    ["r above the verify cap", `scrypt$16$17$1$${SALT_B64}$${HASH_B64}`],
    ["p above the verify cap", `scrypt$16$8$5$${SALT_B64}$${HASH_B64}`],
    ["truncated hash base64", `scrypt$16$8$1$${SALT_B64}$${HASH_B64.slice(0, 20)}`],
    ["salt shorter than 8 bytes", `scrypt$16$8$1$${Buffer.alloc(4).toString("base64")}$${HASH_B64}`],
  ];

  it.each(cases)("verifies false and never throws: %s", async (_label, value) => {
    // `resolves` doubles as the never-throws assertion — a rejection fails it.
    await expect(verifyViaModule("any password", value)).resolves.toBe(false);
    await expect(verifyPassword("any password", value)).resolves.toBe(false);
  });
});

describe("needsRehash", () => {
  it("is false for a hash produced at current parameters, via both entry points", () => {
    expect(needsRehashViaModule(stored)).toBe(false);
    expect(needsRehash(wrapped)).toBe(false);
  });

  it("is true for a hash stored with weaker-than-current parameters", () => {
    expect(needsRehashViaModule(`scrypt$15$8$1$${SALT_B64}$${HASH_B64}`)).toBe(true);
    expect(needsRehash(`scrypt$15$8$1$${SALT_B64}$${HASH_B64}`)).toBe(true);
  });

  it("is true for a malformed stored value, failing toward re-hashing", () => {
    expect(needsRehashViaModule("garbage")).toBe(true);
  });
});

describe("unicode normalization", () => {
  it("verifies a decomposed spelling against a hash of the composed one (NFKC)", async () => {
    const composed = "p\u00C5ssword"; // Å as a single code point
    const decomposed = "pA\u030Assword"; // A + combining ring above
    expect(composed).not.toBe(decomposed);
    const hash = await hashViaModule(composed);
    await expect(verifyViaModule(decomposed, hash)).resolves.toBe(true);
  });
});

describe("dummyHash", () => {
  it("returns the same cached promise on every call", async () => {
    expect(dummyHash()).toBe(dummyHash());
    await expect(dummyHash()).resolves.toBe(await dummyHash());
  });

  it("never verifies any candidate password", async () => {
    await expect(verifyPassword("anything", await dummyHash())).resolves.toBe(false);
  });
});
