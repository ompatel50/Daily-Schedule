import { describe, expect, it } from "vitest";

import {
  detectTransferPairs,
  findCounterpartCandidates,
  isCounterpartPair,
  scoreTransferPair,
  transferPairKey,
  TRANSFER_AUTO_LINK_THRESHOLD,
  type TransferMatchAccount,
  type TransferMatchRow,
} from "@/lib/logic/transfer-match";

const ACCOUNTS: TransferMatchAccount[] = [
  { id: "checking", currency: "USD", debt: false },
  { id: "savings", currency: "USD", debt: false },
  { id: "card", currency: "USD", debt: true },
  { id: "euro", currency: "EUR", debt: false },
];
const BY_ID = new Map(ACCOUNTS.map((account) => [account.id, account]));

let nextId = 0;
function row(partial: Partial<TransferMatchRow> & Pick<TransferMatchRow, "accountId" | "amount">): TransferMatchRow {
  nextId += 1;
  return {
    id: `t${String(nextId).padStart(3, "0")}`,
    date: "2026-07-10",
    payee: null,
    category: "other",
    transferGroupId: null,
    ...partial,
  };
}

describe("isCounterpartPair", () => {
  const out = row({ accountId: "checking", amount: -300 });

  it("requires equal magnitude, opposite sign, different same-currency accounts", () => {
    expect(isCounterpartPair(out, row({ accountId: "card", amount: 300 }), BY_ID, 5)).toBe(true);
    expect(isCounterpartPair(out, row({ accountId: "card", amount: 300.01 }), BY_ID, 5)).toBe(false);
    expect(isCounterpartPair(out, row({ accountId: "card", amount: -300 }), BY_ID, 5)).toBe(false);
    expect(isCounterpartPair(out, row({ accountId: "checking", amount: 300 }), BY_ID, 5)).toBe(false);
    expect(isCounterpartPair(out, row({ accountId: "euro", amount: 300 }), BY_ID, 5)).toBe(false);
  });

  it("respects the date window in both directions", () => {
    expect(
      isCounterpartPair(out, row({ accountId: "card", amount: 300, date: "2026-07-15" }), BY_ID, 5),
    ).toBe(true);
    expect(
      isCounterpartPair(out, row({ accountId: "card", amount: 300, date: "2026-07-16" }), BY_ID, 5),
    ).toBe(false);
    expect(
      isCounterpartPair(out, row({ accountId: "card", amount: 300, date: "2026-07-05" }), BY_ID, 5),
    ).toBe(true);
  });

  it("never pairs a row that is already a transfer leg", () => {
    const linked = row({ accountId: "card", amount: 300, transferGroupId: "grp" });
    expect(isCounterpartPair(out, linked, BY_ID, 5)).toBe(false);
    expect(
      isCounterpartPair({ ...out, transferGroupId: "grp" }, row({ accountId: "card", amount: 300 }), BY_ID, 5),
    ).toBe(false);
  });
});

describe("scoreTransferPair", () => {
  it("a same-day keyword card payment scores as confident", () => {
    const out = row({ accountId: "checking", amount: -300, payee: "PAYMENT TO CHASE CARD" });
    const into = row({ accountId: "card", amount: 300, payee: "Payment Thank You-Mobile" });
    const score = scoreTransferPair(out, into, { accountById: BY_ID });
    expect(score.out.id).toBe(out.id);
    expect(score.into.id).toBe(into.id);
    expect(score.score).toBeGreaterThanOrEqual(TRANSFER_AUTO_LINK_THRESHOLD);
    expect(score.confident).toBe(true);
    expect(score.reasons).toContain("same day");
    expect(score.reasons).toContain("payment/transfer wording");
    expect(score.reasons).toContain("pays down a card or loan");
  });

  it("orientation comes from the signs, whichever order the legs arrive", () => {
    const out = row({ accountId: "checking", amount: -50 });
    const into = row({ accountId: "savings", amount: 50 });
    const forward = scoreTransferPair(out, into, { accountById: BY_ID });
    const backward = scoreTransferPair(into, out, { accountById: BY_ID });
    expect(forward.out.id).toBe(out.id);
    expect(backward.out.id).toBe(out.id);
    expect(forward.score).toBe(backward.score);
  });

  it("a bare same-amount coincidence is a suggestion, not a confident match", () => {
    const out = row({ accountId: "checking", amount: -42.17, payee: "GROCERY" });
    const into = row({ accountId: "savings", amount: 42.17, payee: "REFUND", date: "2026-07-13" });
    const score = scoreTransferPair(out, into, { accountById: BY_ID });
    expect(score.confident).toBe(false);
    expect(score.score).toBeLessThan(TRANSFER_AUTO_LINK_THRESHOLD);
  });

  it("recurring round amounts lower confidence", () => {
    const out = row({ accountId: "checking", amount: -1500, payee: "TRANSFER" });
    const into = row({ accountId: "savings", amount: 1500 });
    const oneOff = scoreTransferPair(out, into, { accountById: BY_ID, sameAmountRowCount: 2 });
    const recurring = scoreTransferPair(out, into, { accountById: BY_ID, sameAmountRowCount: 6 });
    expect(recurring.score).toBeLessThan(oneOff.score);
    expect(recurring.reasons).toContain("recurring round amount");
  });

  it("multiple plausible candidates lower confidence and forbid auto-linking", () => {
    const out = row({ accountId: "checking", amount: -300, payee: "PAYMENT" });
    const into = row({ accountId: "card", amount: 300, payee: "Payment" });
    const unique = scoreTransferPair(out, into, { accountById: BY_ID });
    const contested = scoreTransferPair(out, into, {
      accountById: BY_ID,
      outCandidateCount: 2,
      intoCandidateCount: 1,
    });
    expect(unique.confident).toBe(true);
    expect(contested.confident).toBe(false);
    expect(contested.score).toBeLessThan(unique.score);
    expect(contested.reasons).toContain("several possible matches");
  });
});

describe("findCounterpartCandidates", () => {
  it("lists scored candidates, best first, optionally narrowed to one account", () => {
    const payment = row({ accountId: "card", amount: 300, payee: "Payment Thank You" });
    const sameDay = row({ accountId: "checking", amount: -300, payee: "PAYMENT TO CARD" });
    const farDay = row({ accountId: "savings", amount: -300, date: "2026-07-14" });
    const wrongAmount = row({ accountId: "checking", amount: -299 });
    const rows = [payment, sameDay, farDay, wrongAmount];

    const all = findCounterpartCandidates(payment, rows, BY_ID);
    expect(all.map((candidate) => candidate.out.id)).toEqual([sameDay.id, farDay.id]);

    const savingsOnly = findCounterpartCandidates(payment, rows, BY_ID, { accountId: "savings" });
    expect(savingsOnly.map((candidate) => candidate.out.id)).toEqual([farDay.id]);
  });

  it("an already-linked row has no candidates", () => {
    const linked = row({ accountId: "card", amount: 300, transferGroupId: "grp" });
    const other = row({ accountId: "checking", amount: -300 });
    expect(findCounterpartCandidates(linked, [linked, other], BY_ID)).toEqual([]);
  });
});

describe("detectTransferPairs", () => {
  it("auto-links only the single unambiguous high-confidence match", () => {
    const cardPayment = row({ accountId: "card", amount: 300, payee: "Payment Thank You" });
    const checkingOut = row({ accountId: "checking", amount: -300, payee: "CHASE AUTOPAY" });
    // A same-amount coincidence with no signals — plausible, never automatic.
    const groceriesA = row({ accountId: "checking", amount: -42.17, date: "2026-07-11" });
    const groceriesB = row({ accountId: "savings", amount: 42.17, date: "2026-07-12" });

    const result = detectTransferPairs(
      [cardPayment, checkingOut, groceriesA, groceriesB],
      ACCOUNTS,
    );
    expect(result.autoLinks).toHaveLength(1);
    expect(result.autoLinks[0].out.id).toBe(checkingOut.id);
    expect(result.autoLinks[0].into.id).toBe(cardPayment.id);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].out.id).toBe(groceriesA.id);
  });

  it("two plausible counterparts make every pairing a suggestion", () => {
    const payment = row({ accountId: "card", amount: 300, payee: "Payment" });
    const fromChecking = row({ accountId: "checking", amount: -300, payee: "PAYMENT" });
    const fromSavings = row({ accountId: "savings", amount: -300, payee: "PAYMENT" });

    const result = detectTransferPairs([payment, fromChecking, fromSavings], ACCOUNTS);
    expect(result.autoLinks).toEqual([]);
    expect(result.suggestions).toHaveLength(2);
    for (const suggestion of result.suggestions) {
      expect(suggestion.reasons).toContain("several possible matches");
    }
  });

  it("dismissed pairs never resurface — not even as auto-links", () => {
    const payment = row({ accountId: "card", amount: 300, payee: "Payment Thank You" });
    const checkingOut = row({ accountId: "checking", amount: -300, payee: "AUTOPAY" });
    const dismissed = new Set([transferPairKey(payment.id, checkingOut.id)]);

    const result = detectTransferPairs([payment, checkingOut], ACCOUNTS, {
      dismissedPairs: dismissed,
    });
    expect(result.autoLinks).toEqual([]);
    expect(result.suggestions).toEqual([]);
  });

  it("is idempotent: rows linked by a pass produce nothing on the next", () => {
    const payment = row({ accountId: "card", amount: 300, payee: "Payment Thank You" });
    const checkingOut = row({ accountId: "checking", amount: -300, payee: "AUTOPAY" });
    const first = detectTransferPairs([payment, checkingOut], ACCOUNTS);
    expect(first.autoLinks).toHaveLength(1);

    const linked = [
      { ...payment, transferGroupId: "grp", category: "transfer" },
      { ...checkingOut, transferGroupId: "grp", category: "transfer" },
    ];
    const second = detectTransferPairs(linked, ACCOUNTS);
    expect(second.autoLinks).toEqual([]);
    expect(second.suggestions).toEqual([]);
  });

  it("never pairs across currencies and ignores zero amounts", () => {
    const usdOut = row({ accountId: "checking", amount: -100 });
    const eurIn = row({ accountId: "euro", amount: 100 });
    const result = detectTransferPairs([usdOut, eurIn], ACCOUNTS);
    expect(result.autoLinks).toEqual([]);
    expect(result.suggestions).toEqual([]);
  });

  it("a row auto-links at most once even among several confident pairs", () => {
    // Two card payments a week apart, two checking outflows a week apart —
    // each payment has exactly one counterpart within the window.
    const paymentA = row({ accountId: "card", amount: 250, payee: "Payment", date: "2026-07-01" });
    const outA = row({ accountId: "checking", amount: -250, payee: "AUTOPAY", date: "2026-07-01" });
    const paymentB = row({ accountId: "card", amount: 250, payee: "Payment", date: "2026-07-20" });
    const outB = row({ accountId: "checking", amount: -250, payee: "AUTOPAY", date: "2026-07-20" });

    const result = detectTransferPairs([paymentA, outA, paymentB, outB], ACCOUNTS);
    expect(result.autoLinks).toHaveLength(2);
    const linkedIds = result.autoLinks.flatMap((pair) => [pair.out.id, pair.into.id]);
    expect(new Set(linkedIds).size).toBe(4);
  });

  it("transferPairKey is orderless", () => {
    expect(transferPairKey("a", "b")).toBe(transferPairKey("b", "a"));
  });
});
