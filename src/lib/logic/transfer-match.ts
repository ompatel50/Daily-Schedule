import { daysBetween, type DayKey } from "@/lib/date";
import { moneyRound } from "@/lib/logic/finance";

/**
 * Transfer reconciliation — pure. Imported bank rows arrive one-sided: the
 * card export says "Payment Thank You", the checking export says "PAYMENT TO
 * CHASE CARD", and nothing in either file links them. This module finds the
 * pairs.
 *
 * A candidate pair is always: same absolute amount (to the cent), opposite
 * signs, two different accounts in the same currency, both rows not already
 * transfer legs, dates within a window (default 5 days). On top of that,
 * `scoreTransferPair` grades how confident the pairing is:
 *
 *   raise — zero/small date gap; a transfer-ish payee word (payment,
 *           transfer, autopay, deposit, …) on either leg; money moving
 *           asset → debt (a card or loan payment);
 *   lower — a recurring round amount (rent and a savings sweep are both
 *           "$1,500 on the 1st"); more than one plausible counterpart for
 *           either leg (ambiguity — the strongest reason NOT to guess).
 *
 * `detectTransferPairs` splits results into `autoLinks` — a single,
 * unambiguous, high-confidence counterpart on both sides — and
 * `suggestions`, which a person confirms or dismisses. The caller owns
 * persistence, user scoping and dismissal filtering; everything here is
 * arithmetic over the rows it was handed.
 */

export interface TransferMatchRow {
  id: string;
  accountId: string;
  date: DayKey;
  /** Signed, rounded to cents. */
  amount: number;
  payee: string | null;
  category: string;
  transferGroupId: string | null;
}

export interface TransferMatchAccount {
  id: string;
  currency: string;
  /** True for credit cards and loans — balances normally owed. */
  debt: boolean;
}

export const TRANSFER_MATCH_DEFAULT_WINDOW_DAYS = 5;
/** The window choices the UI offers — bounded so a "candidate" stays plausible. */
export const TRANSFER_MATCH_WINDOW_CHOICES = [3, 5, 7, 14] as const;
export const TRANSFER_AUTO_LINK_THRESHOLD = 0.75;

/** Payee words that make a row read as a transfer/payment leg. */
const TRANSFER_KEYWORDS = [
  "payment",
  "transfer",
  "autopay",
  "auto-pay",
  "auto pay",
  "xfer",
  "deposit",
  "withdrawal",
];

function hasTransferKeyword(payee: string | null): boolean {
  if (!payee) return false;
  const text = payee.toLowerCase();
  return TRANSFER_KEYWORDS.some((word) => text.includes(word));
}

/** "$1,500" reads as a standing order; "$1,483.62" reads like a real bill. */
function isRoundAmount(amount: number): boolean {
  const magnitude = Math.abs(amount);
  return Number.isInteger(magnitude) && magnitude % 10 === 0;
}

/**
 * Can these two rows be the two legs of one transfer at all? The hard
 * requirements — everything scoring later grades is on top of this.
 */
export function isCounterpartPair(
  a: TransferMatchRow,
  b: TransferMatchRow,
  accountById: ReadonlyMap<string, TransferMatchAccount>,
  windowDays: number,
): boolean {
  if (a.id === b.id) return false;
  if (a.accountId === b.accountId) return false;
  if (a.transferGroupId !== null || b.transferGroupId !== null) return false;
  if (moneyRound(a.amount + b.amount) !== 0) return false; // equal magnitude, opposite sign
  if (a.amount === 0) return false;
  const accountA = accountById.get(a.accountId);
  const accountB = accountById.get(b.accountId);
  if (!accountA || !accountB) return false;
  if (accountA.currency !== accountB.currency) return false;
  return Math.abs(daysBetween(a.date, b.date)) <= windowDays;
}

export interface TransferPairScore {
  /** The money-out leg (negative amount) … */
  out: TransferMatchRow;
  /** … and the money-in leg (positive amount). */
  into: TransferMatchRow;
  /** 0–1. */
  score: number;
  /** Human-readable, for the suggestion UI ("same day", "payment wording"…). */
  reasons: string[];
  confident: boolean;
}

export interface TransferScoreContext {
  accountById: ReadonlyMap<string, TransferMatchAccount>;
  /** Rows in the scan sharing this pair's absolute amount (recurring detector). */
  sameAmountRowCount?: number;
  /** Counterpart candidates each leg has, this pair included (ambiguity). */
  outCandidateCount?: number;
  intoCandidateCount?: number;
}

/** Grade one candidate pair. Orientation is derived from the signs. */
export function scoreTransferPair(
  a: TransferMatchRow,
  b: TransferMatchRow,
  context: TransferScoreContext,
): TransferPairScore {
  const [out, into] = a.amount < 0 ? [a, b] : [b, a];
  const reasons: string[] = [];
  let score = 0.4; // exact amount, opposite signs — the entry ticket

  const gap = Math.abs(daysBetween(out.date, into.date));
  if (gap === 0) {
    score += 0.2;
    reasons.push("same day");
  } else if (gap <= 2) {
    score += 0.15;
    reasons.push(`${gap} day${gap === 1 ? "" : "s"} apart`);
  } else if (gap <= 4) {
    score += 0.05;
    reasons.push(`${gap} days apart`);
  } else {
    reasons.push(`${gap} days apart`);
  }

  if (hasTransferKeyword(out.payee) || hasTransferKeyword(into.payee)) {
    score += 0.2;
    reasons.push("payment/transfer wording");
  }

  const outDebt = context.accountById.get(out.accountId)?.debt ?? false;
  const intoDebt = context.accountById.get(into.accountId)?.debt ?? false;
  if (!outDebt && intoDebt) {
    score += 0.15;
    reasons.push("pays down a card or loan");
  }

  const sameAmountRows = context.sameAmountRowCount ?? 2;
  if (isRoundAmount(out.amount) && sameAmountRows >= 4) {
    score -= 0.15;
    reasons.push("recurring round amount");
  }

  const outCandidates = context.outCandidateCount ?? 1;
  const intoCandidates = context.intoCandidateCount ?? 1;
  const ambiguous = outCandidates > 1 || intoCandidates > 1;
  if (ambiguous) {
    score -= 0.25;
    reasons.push("several possible matches");
  }

  score = Math.min(1, Math.max(0, moneyRound(score)));
  return {
    out,
    into,
    score,
    reasons,
    // "Confident" alone never auto-links — ambiguity is checked by the caller
    // too, via detectTransferPairs' unique-counterpart requirement.
    confident: score >= TRANSFER_AUTO_LINK_THRESHOLD && !ambiguous,
  };
}

/**
 * All counterpart candidates for one row, scored, best first. What the
 * "Mark as transfer" dialog lists. `accountId` narrows to one counterpart
 * account when the user has picked one.
 */
export function findCounterpartCandidates(
  row: TransferMatchRow,
  rows: TransferMatchRow[],
  accountById: ReadonlyMap<string, TransferMatchAccount>,
  options: { windowDays?: number; accountId?: string } = {},
): TransferPairScore[] {
  const windowDays = options.windowDays ?? TRANSFER_MATCH_DEFAULT_WINDOW_DAYS;
  if (row.transferGroupId !== null) return [];
  const candidates = rows.filter(
    (other) =>
      isCounterpartPair(row, other, accountById, windowDays) &&
      (options.accountId === undefined || other.accountId === options.accountId),
  );
  return candidates
    .map((other) =>
      scoreTransferPair(row, other, {
        accountById,
        sameAmountRowCount: rows.filter(
          (r) => Math.abs(r.amount) === Math.abs(row.amount) && r.transferGroupId === null,
        ).length,
        outCandidateCount: row.amount < 0 ? candidates.length : 1,
        intoCandidateCount: row.amount < 0 ? 1 : candidates.length,
      }),
    )
    .sort((a, b) => b.score - a.score || a.out.id.localeCompare(b.out.id));
}

export interface TransferDetection {
  /** Single unambiguous high-confidence matches — safe to link unattended. */
  autoLinks: TransferPairScore[];
  /** Everything else plausible — a person accepts or dismisses each. */
  suggestions: TransferPairScore[];
}

/**
 * One detection pass over a user's unlinked rows. Deterministic and
 * idempotent: linked rows are excluded by the pair predicate, so feeding the
 * result of a pass back in finds nothing new. `dismissedPairs` (canonical
 * "lowId|highId" keys) never resurface — not even as auto-links.
 */
export function detectTransferPairs(
  rows: TransferMatchRow[],
  accounts: TransferMatchAccount[],
  options: { windowDays?: number; dismissedPairs?: ReadonlySet<string> } = {},
): TransferDetection {
  const windowDays = options.windowDays ?? TRANSFER_MATCH_DEFAULT_WINDOW_DAYS;
  const dismissed = options.dismissedPairs ?? new Set<string>();
  const accountById = new Map(accounts.map((account) => [account.id, account]));

  // Group by absolute amount so pairing is linear-ish, not all-pairs.
  const byMagnitude = new Map<number, TransferMatchRow[]>();
  for (const row of rows) {
    if (row.transferGroupId !== null || row.amount === 0) continue;
    const key = Math.abs(row.amount);
    const bucket = byMagnitude.get(key);
    if (bucket) bucket.push(row);
    else byMagnitude.set(key, [row]);
  }

  const pairs: TransferPairScore[] = [];
  const candidateCounts = new Map<string, number>();

  for (const bucket of byMagnitude.values()) {
    const outs = bucket.filter((row) => row.amount < 0);
    const ins = bucket.filter((row) => row.amount > 0);
    for (const out of outs) {
      for (const into of ins) {
        if (!isCounterpartPair(out, into, accountById, windowDays)) continue;
        candidateCounts.set(out.id, (candidateCounts.get(out.id) ?? 0) + 1);
        candidateCounts.set(into.id, (candidateCounts.get(into.id) ?? 0) + 1);
      }
    }
    for (const out of outs) {
      for (const into of ins) {
        if (!isCounterpartPair(out, into, accountById, windowDays)) continue;
        if (dismissed.has(transferPairKey(out.id, into.id))) continue;
        pairs.push(
          scoreTransferPair(out, into, {
            accountById,
            sameAmountRowCount: bucket.length,
            outCandidateCount: candidateCounts.get(out.id) ?? 1,
            intoCandidateCount: candidateCounts.get(into.id) ?? 1,
          }),
        );
      }
    }
  }

  pairs.sort(
    (a, b) => b.score - a.score || a.out.id.localeCompare(b.out.id) || a.into.id.localeCompare(b.into.id),
  );

  // Auto-link greedily by score, one link per row — and only pairs that were
  // unambiguous to begin with (candidate count 1 on both sides).
  const taken = new Set<string>();
  const autoLinks: TransferPairScore[] = [];
  const suggestions: TransferPairScore[] = [];
  for (const pair of pairs) {
    if (taken.has(pair.out.id) || taken.has(pair.into.id)) continue;
    if (pair.confident) {
      taken.add(pair.out.id);
      taken.add(pair.into.id);
      autoLinks.push(pair);
    } else {
      suggestions.push(pair);
    }
  }

  return { autoLinks, suggestions };
}

/** Canonical, orderless identity of a candidate pair — the dismissal key. */
export function transferPairKey(idA: string, idB: string): string {
  return idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
}
