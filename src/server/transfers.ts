import "server-only";

import { randomUUID } from "node:crypto";

import { prisma } from "@/lib/db";
import { ACCOUNT_TYPE_META, type AccountType } from "@/lib/enums";
import {
  detectTransferPairs,
  transferPairKey,
  type TransferMatchAccount,
  type TransferMatchRow,
  type TransferPairScore,
} from "@/lib/logic/transfer-match";

/**
 * Transfer reconciliation — the data-access half. The matching itself is pure
 * (src/lib/logic/transfer-match.ts); this module loads one user's rows,
 * accounts and dismissals, runs the pass, and — only in
 * `runTransferDetection` — writes the links. Everything is scoped to the one
 * user id it was handed; nothing here can see across accounts.
 */

/**
 * Newest rows considered by a detection pass. A bound, not a page: a personal
 * ledger sits far below it, and a pass over the newest 5,000 rows still spans
 * years. Rows beyond the cap are simply not scanned (they can always be
 * linked by hand from the row menu).
 */
const DETECTION_ROW_CAP = 5000;

/** Suggestions surfaced at once — the best-scored few, not a backlog. */
export const TRANSFER_SUGGESTION_CAP = 8;

interface TransferMatchData {
  rows: TransferMatchRow[];
  accounts: TransferMatchAccount[];
  accountNames: Map<string, string>;
  accountCurrencies: Map<string, string>;
  dismissedPairs: Set<string>;
}

/** Unarchived accounts + their unlinked rows + the user's dismissals. */
export async function loadTransferMatchData(userId: string): Promise<TransferMatchData> {
  const [accounts, rows, dismissals] = await Promise.all([
    prisma.financeAccount.findMany({
      where: { userId, archivedAt: null },
      select: { id: true, name: true, currency: true, type: true },
    }),
    prisma.financeTransaction.findMany({
      where: { userId, transferGroupId: null },
      select: {
        id: true,
        accountId: true,
        date: true,
        amount: true,
        payee: true,
        category: true,
        transferGroupId: true,
      },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      take: DETECTION_ROW_CAP,
    }),
    prisma.transferDismissal.findMany({
      where: { userId },
      select: { aId: true, bId: true },
    }),
  ]);

  const accountIds = new Set(accounts.map((account) => account.id));
  return {
    // Rows of archived accounts stay out — detection mirrors what the
    // Transfer flow itself allows.
    rows: rows.filter((row) => accountIds.has(row.accountId)),
    accounts: accounts.map((account) => ({
      id: account.id,
      currency: account.currency,
      debt: ACCOUNT_TYPE_META[account.type as AccountType]?.debt ?? false,
    })),
    accountNames: new Map(accounts.map((account) => [account.id, account.name])),
    accountCurrencies: new Map(accounts.map((account) => [account.id, account.currency])),
    dismissedPairs: new Set(dismissals.map((row) => transferPairKey(row.aId, row.bId))),
  };
}

/** One suggested pair, shaped for the finance page. */
export interface TransferSuggestionView {
  outId: string;
  intoId: string;
  amount: number;
  currency: string;
  outDate: string;
  intoDate: string;
  outPayee: string | null;
  intoPayee: string | null;
  outAccountName: string;
  intoAccountName: string;
  score: number;
  reasons: string[];
}

function toSuggestionView(pair: TransferPairScore, data: TransferMatchData): TransferSuggestionView {
  return {
    outId: pair.out.id,
    intoId: pair.into.id,
    amount: Math.abs(pair.into.amount),
    currency: data.accountCurrencies.get(pair.into.accountId) ?? "USD",
    outDate: pair.out.date,
    intoDate: pair.into.date,
    outPayee: pair.out.payee,
    intoPayee: pair.into.payee,
    outAccountName: data.accountNames.get(pair.out.accountId) ?? "?",
    intoAccountName: data.accountNames.get(pair.into.accountId) ?? "?",
    score: pair.score,
    reasons: pair.reasons,
  };
}

/**
 * Read-only pass for the finance page: every plausible pair (would-be
 * auto-links included — a page load must not write), dismissals excluded,
 * best first, capped.
 */
export async function computeTransferSuggestions(
  userId: string,
): Promise<TransferSuggestionView[]> {
  const data = await loadTransferMatchData(userId);
  if (data.accounts.length < 2 || data.rows.length === 0) return [];
  const detection = detectTransferPairs(data.rows, data.accounts, {
    dismissedPairs: data.dismissedPairs,
  });
  return [...detection.autoLinks, ...detection.suggestions]
    .slice(0, TRANSFER_SUGGESTION_CAP)
    .map((pair) => toSuggestionView(pair, data));
}

export interface TransferDetectionOutcome {
  /** Pairs actually linked by this pass. */
  linked: number;
  /** Plausible pairs left for the user to judge. */
  suggestions: number;
}

/**
 * The writing pass: link every single-unambiguous-high-confidence pair, count
 * what remains as suggestions. Runs after each CSV import commits, and on
 * demand from the finance page. Idempotent — linked rows leave the candidate
 * pool, so a second pass finds nothing new. Each pair links in its own small
 * transaction guarded by `transferGroupId: null`, so a concurrent pass (two
 * tabs importing at once) links a pair exactly once and never half-links.
 */
export async function runTransferDetection(userId: string): Promise<TransferDetectionOutcome> {
  const data = await loadTransferMatchData(userId);
  if (data.accounts.length < 2 || data.rows.length === 0) {
    return { linked: 0, suggestions: 0 };
  }
  const detection = detectTransferPairs(data.rows, data.accounts, {
    dismissedPairs: data.dismissedPairs,
  });

  let linked = 0;
  for (const pair of detection.autoLinks) {
    const transferGroupId = randomUUID();
    const outcome = await prisma
      .$transaction(async (db) => {
        const out = await db.financeTransaction.updateMany({
          where: { id: pair.out.id, userId, transferGroupId: null },
          data: {
            transferGroupId,
            category: "transfer",
            preTransferCategory: pair.out.category,
          },
        });
        if (out.count === 0) return 0;
        const into = await db.financeTransaction.updateMany({
          where: { id: pair.into.id, userId, transferGroupId: null },
          data: {
            transferGroupId,
            category: "transfer",
            preTransferCategory: pair.into.category,
          },
        });
        // Counterpart raced away — throwing rolls the first leg back.
        if (into.count === 0) throw new Error("transfer-link-raced");
        return 1;
      })
      .catch(() => 0);
    linked += outcome;
  }

  return { linked, suggestions: detection.suggestions.length };
}
