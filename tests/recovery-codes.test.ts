/**
 * The pure primitives under sign-up and password recovery: the password
 * policy every "set a password" path shares, and the recovery-code
 * generate/normalize/hash trio whose format the UI, the redemption form and
 * the database all rely on.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  checkPasswordPolicy,
  containsEmailLocalPart,
} from "@/server/auth/policy";
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  RECOVERY_CODE_COUNT,
  generateRecoveryCode,
  hashRecoveryCode,
  normalizeRecoveryCode,
} from "@/server/auth/recovery-codes";

describe("checkPasswordPolicy", () => {
  it("accepts a long unrelated passphrase", () => {
    expect(checkPasswordPolicy("correct-horse-battery-staple", "jane@example.com")).toBeNull();
  });

  it("rejects short, over-long and email-derived passwords", () => {
    expect(checkPasswordPolicy("a".repeat(MIN_PASSWORD_LENGTH - 1), null)).toBe("short");
    expect(checkPasswordPolicy("a".repeat(MAX_PASSWORD_LENGTH + 1), null)).toBe("long");
    expect(checkPasswordPolicy("jane.doe-2026-secure!", "jane.doe@example.com")).toBe("weak");
  });

  it("boundary lengths are accepted", () => {
    expect(checkPasswordPolicy("a".repeat(MIN_PASSWORD_LENGTH), null)).toBeNull();
    expect(checkPasswordPolicy("a".repeat(MAX_PASSWORD_LENGTH), null)).toBeNull();
  });
});

describe("containsEmailLocalPart", () => {
  it("matches the local part case-insensitively", () => {
    expect(containsEmailLocalPart("MyJane.Doe!Rules", "jane.doe@example.com")).toBe(true);
    expect(containsEmailLocalPart("completely unrelated", "jane.doe@example.com")).toBe(false);
  });

  it("ignores local parts shorter than four characters — too common to ban", () => {
    expect(containsEmailLocalPart("bob-is-in-here", "bob@example.com")).toBe(false);
  });
});

describe("recovery codes", () => {
  it("generates the display format: four dash-separated groups from the unambiguous alphabet", () => {
    for (let i = 0; i < 50; i += 1) {
      const code = generateRecoveryCode();
      expect(code).toMatch(/^[a-z0-9]{4}(-[a-z0-9]{4}){3}$/);
      const raw = code.replace(/-/g, "");
      expect(raw).toHaveLength(CODE_LENGTH);
      for (const char of raw) expect(CODE_ALPHABET).toContain(char);
      // The lookalike characters are never used.
      expect(raw).not.toMatch(/[01loi]/);
    }
  });

  it("normalization forgives case, spaces and dashes — and hashing follows it", () => {
    const code = generateRecoveryCode();
    const sloppy = ` ${code.toUpperCase().replace(/-/g, "  ")} `;
    expect(normalizeRecoveryCode(sloppy)).toBe(code.replace(/-/g, ""));
    expect(hashRecoveryCode(sloppy)).toBe(hashRecoveryCode(code));
  });

  it("hashes are 64-char hex and never contain the code itself", () => {
    const code = generateRecoveryCode();
    const hash = hashRecoveryCode(code);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(normalizeRecoveryCode(code));
  });

  it("collisions across a generated batch are effectively impossible", () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateRecoveryCode()));
    expect(codes.size).toBe(200);
    expect(RECOVERY_CODE_COUNT).toBeGreaterThanOrEqual(8);
  });
});
