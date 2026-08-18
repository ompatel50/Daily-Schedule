/**
 * Money as integer cents — the one module that owns the unit.
 *
 * Monetary values are STORED and COMPUTED as integer cents (the `*Cents`
 * columns; `moneyRound`'s old job). Integers add without drift, so sums,
 * balances and comparisons are exact; division only ever happens here, at
 * the display boundary (`formatCents`) and at the human boundaries where
 * dollars are typed in (`toCents`) or shown back (`centsToAmount`).
 *
 * The float columns the cents columns replaced stay behind (dual-written)
 * until the cleanup migration retires them — `centsOrLegacy` is the read
 * fallback that makes a row written before the backfill, or restored from an
 * old backup, read identically.
 *
 * `toCents` rounds exactly the way `moneyRound` rounded — half away from
 * the smaller cent via Math.round on the ×100 value — so the backfill
 * (cents = toCents(float)) reproduces every balance to the cent.
 */

/** Dollars (a human-entered or legacy float) → integer cents. */
export function toCents(amount: number): number {
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100);
}

/** Integer cents → the exact 2-decimal dollar value (display/input only). */
export function centsToAmount(cents: number): number {
  return cents / 100;
}

/**
 * The transition read: the cents column when the row has one, else the legacy
 * float converted. Every server read of a money column goes through this.
 */
export function centsOrLegacy(cents: number | null | undefined, legacyAmount: number): number {
  return typeof cents === "number" ? cents : toCents(legacyAmount);
}

/** Same, for nullable money columns (thresholds, limits). */
export function centsOrLegacyNullable(
  cents: number | null | undefined,
  legacyAmount: number | null | undefined,
): number | null {
  if (typeof cents === "number") return cents;
  if (typeof legacyAmount === "number") return toCents(legacyAmount);
  return null;
}

/**
 * "$1,240.50" / "−$86.20" from integer cents. Locale pinned so tests are
 * deterministic and the app renders identically everywhere; `currency` is
 * display-only — nothing in the app ever converts between currencies.
 */
export function formatCents(cents: number, currency = "USD"): string {
  const amount = centsToAmount(Math.round(cents));
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    // An unknown currency code must never crash a page over a display detail.
    return `${amount < 0 ? "-" : ""}${currency} ${Math.abs(amount).toFixed(2)}`;
  }
}
