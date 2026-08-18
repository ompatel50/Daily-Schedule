"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";

import { getCurrentUser, prisma } from "@/lib/db";
import { moneyRound } from "@/lib/logic/finance";
import {
  findCounterpartCandidates,
  TRANSFER_MATCH_DEFAULT_WINDOW_DAYS,
  type TransferMatchRow,
} from "@/lib/logic/transfer-match";
import { loadTransferMatchData, runTransferDetection } from "@/server/transfers";
import {
  fail,
  fromZod,
  succeed,
  transferCandidatesSchema,
  transferCounterpartSchema,
  transferDismissSchema,
  transferLinkSchema,
  type ActionResult,
} from "@/lib/validation";

/**
 * Transfer reconciliation actions: turn two one-sided ledger rows (a CSV
 * import only ever sees one account) into one linked transfer, and back.
 *
 * The rules every path here enforces:
 *  * linking touches LINK METADATA plus category only — `transferGroupId`,
 *    `preTransferCategory`, `category: "transfer"`. Date, amount, payee and
 *    account are never rewritten, so an import's undo identity survives;
 *  * both rows must belong to the caller, sit in two different unarchived
 *    same-currency accounts, carry equal-and-opposite amounts, and not
 *    already be transfer legs;
 *  * unlinking restores each row's pre-link category (rows written AS legs —
 *    by the Transfer flow or "create the missing leg" — never had one and
 *    restore to "other").
 */

function revalidateAll() {
  revalidatePath("/", "layout");
}

// --- candidates for the "Mark as transfer" dialog ---------------------------

export interface TransferCandidateView {
  id: string;
  accountId: string;
  accountName: string;
  date: string;
  amount: number;
  payee: string | null;
  score: number;
  confident: boolean;
  reasons: string[];
}

export interface TransferLinkCandidates {
  transaction: {
    id: string;
    accountId: string;
    accountName: string;
    currency: string;
    date: string;
    amount: number;
    payee: string | null;
  };
  /** Unarchived same-currency accounts the counterpart could live in. */
  accounts: Array<{ id: string; name: string; currency: string }>;
  /** Scored candidates across those accounts, best first. */
  candidates: TransferCandidateView[];
  windowDays: number;
}

export async function getTransferLinkCandidates(
  input: unknown,
): Promise<ActionResult<TransferLinkCandidates>> {
  const parsed = transferCandidatesSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const user = await getCurrentUser();
  const windowDays = parsed.data.windowDays ?? TRANSFER_MATCH_DEFAULT_WINDOW_DAYS;

  const row = await prisma.financeTransaction.findFirst({
    where: { id: parsed.data.transactionId, userId: user.id },
    include: { account: { select: { name: true, currency: true, archivedAt: true } } },
  });
  if (!row) return fail("Transaction not found");
  if (row.transferGroupId) return fail("This row is already part of a transfer");

  const data = await loadTransferMatchData(user.id);
  const target: TransferMatchRow = {
    id: row.id,
    accountId: row.accountId,
    date: row.date,
    amount: row.amount,
    payee: row.payee,
    category: row.category,
    transferGroupId: row.transferGroupId,
  };
  const scored = findCounterpartCandidates(target, data.rows, new Map(
    data.accounts.map((account) => [account.id, account]),
  ), { windowDays });

  const accounts = [...data.accountNames.entries()]
    .filter(
      ([id]) => id !== row.accountId && data.accountCurrencies.get(id) === row.account.currency,
    )
    .map(([id, name]) => ({
      id,
      name,
      currency: data.accountCurrencies.get(id) ?? row.account.currency,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return succeed({
    transaction: {
      id: row.id,
      accountId: row.accountId,
      accountName: row.account.name,
      currency: row.account.currency,
      date: row.date,
      amount: row.amount,
      payee: row.payee,
    },
    accounts,
    candidates: scored.map((pair) => {
      const other = pair.out.id === row.id ? pair.into : pair.out;
      return {
        id: other.id,
        accountId: other.accountId,
        accountName: data.accountNames.get(other.accountId) ?? "?",
        date: other.date,
        amount: other.amount,
        payee: other.payee,
        score: pair.score,
        confident: pair.confident,
        reasons: pair.reasons,
      };
    }),
    windowDays,
  });
}

// --- link / create / unlink --------------------------------------------------

/** The shared write: two owned rows become the two legs of one transfer. */
async function linkPair(
  userId: string,
  aId: string,
  bId: string,
): Promise<{ ok: true; transferGroupId: string } | { ok: false; error: string }> {
  const rows = await prisma.financeTransaction.findMany({
    where: { id: { in: [aId, bId] }, userId },
    include: { account: { select: { currency: true, archivedAt: true } } },
  });
  const a = rows.find((row) => row.id === aId);
  const b = rows.find((row) => row.id === bId);
  if (!a || !b) return { ok: false, error: "Transaction not found" };
  if (a.transferGroupId || b.transferGroupId) {
    return { ok: false, error: "One of these rows is already part of a transfer" };
  }
  if (a.accountId === b.accountId) {
    return { ok: false, error: "A transfer needs two different accounts" };
  }
  if (a.account.archivedAt || b.account.archivedAt) {
    return { ok: false, error: "Restore the archived account first" };
  }
  if (a.account.currency !== b.account.currency) {
    return { ok: false, error: "These accounts use different currencies" };
  }
  if (a.amount === 0 || moneyRound(a.amount + b.amount) !== 0) {
    return { ok: false, error: "The two rows must carry the same amount in opposite directions" };
  }

  const transferGroupId = randomUUID();
  try {
    await prisma.$transaction(async (db) => {
      for (const row of [a, b]) {
        const updated = await db.financeTransaction.updateMany({
          where: { id: row.id, userId, transferGroupId: null },
          data: {
            transferGroupId,
            category: "transfer",
            preTransferCategory: row.category,
          },
        });
        if (updated.count === 0) throw new Error("transfer-link-raced");
      }
    });
  } catch {
    return { ok: false, error: "One of these rows was just linked elsewhere — reload and retry" };
  }
  return { ok: true, transferGroupId };
}

/** Mark-as-transfer with an existing counterpart the user picked. */
export async function linkTransactionsAsTransfer(
  input: unknown,
): Promise<ActionResult<{ transferGroupId: string }>> {
  const parsed = transferLinkSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const user = await getCurrentUser();

  const result = await linkPair(user.id, parsed.data.transactionId, parsed.data.counterpartId);
  if (!result.ok) return fail(result.error);
  revalidateAll();
  return succeed({ transferGroupId: result.transferGroupId });
}

/**
 * Mark-as-transfer when the other side was never imported: write the missing
 * leg into the chosen account (same date, opposite amount, transfer payee)
 * and link the pair.
 */
export async function createTransferCounterpart(
  input: unknown,
): Promise<ActionResult<{ transferGroupId: string }>> {
  const parsed = transferCounterpartSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const user = await getCurrentUser();

  const row = await prisma.financeTransaction.findFirst({
    where: { id: parsed.data.transactionId, userId: user.id },
    include: { account: { select: { name: true, currency: true, archivedAt: true } } },
  });
  if (!row) return fail("Transaction not found");
  if (row.transferGroupId) return fail("This row is already part of a transfer");
  if (row.amount === 0) return fail("A zero row cannot be a transfer leg");
  if (row.account.archivedAt) return fail("Restore the archived account first");

  const counterpartAccount = await prisma.financeAccount.findFirst({
    where: { id: parsed.data.accountId, userId: user.id },
  });
  if (!counterpartAccount) return fail("Account not found");
  if (counterpartAccount.id === row.accountId) {
    return fail("A transfer needs two different accounts");
  }
  if (counterpartAccount.archivedAt) return fail("Restore the archived account first");
  if (counterpartAccount.currency !== row.account.currency) {
    return fail("These accounts use different currencies");
  }

  const transferGroupId = randomUUID();
  try {
    await prisma.$transaction(async (db) => {
      await db.financeTransaction.create({
        data: {
          userId: user.id,
          accountId: counterpartAccount.id,
          date: row.date,
          amount: moneyRound(-row.amount),
          category: "transfer",
          // Same convention transferLegs uses — named from the leg's view.
          payee:
            row.amount < 0
              ? `Transfer from ${row.account.name}`
              : `Transfer to ${row.account.name}`,
          notes: null,
          transferGroupId,
        },
      });
      const updated = await db.financeTransaction.updateMany({
        where: { id: row.id, userId: user.id, transferGroupId: null },
        data: {
          transferGroupId,
          category: "transfer",
          preTransferCategory: row.category,
        },
      });
      if (updated.count === 0) throw new Error("transfer-link-raced");
    });
  } catch {
    return fail("This row was just linked elsewhere — reload and retry");
  }
  revalidateAll();
  return succeed({ transferGroupId });
}

/**
 * Undo a link: both legs go back to ordinary rows. Each restores the category
 * it carried before linking; rows born as transfer legs restore to "other".
 * Nothing is deleted — a leg the "create the missing leg" flow wrote stays as
 * an ordinary row (delete it separately if it was a mistake).
 */
export async function unlinkTransfer(transactionId: string): Promise<ActionResult<null>> {
  if (typeof transactionId !== "string" || transactionId === "") {
    return fail("Transaction not found");
  }
  const user = await getCurrentUser();
  const row = await prisma.financeTransaction.findFirst({
    where: { id: transactionId, userId: user.id },
    select: { transferGroupId: true },
  });
  if (!row) return fail("Transaction not found");
  if (!row.transferGroupId) return fail("This row is not part of a transfer");

  const legs = await prisma.financeTransaction.findMany({
    where: { userId: user.id, transferGroupId: row.transferGroupId },
    select: { id: true, preTransferCategory: true },
  });
  await prisma.$transaction(
    legs.map((leg) =>
      prisma.financeTransaction.update({
        where: { id: leg.id },
        data: {
          transferGroupId: null,
          category: leg.preTransferCategory ?? "other",
          preTransferCategory: null,
        },
      }),
    ),
  );
  revalidateAll();
  return succeed(null);
}

// --- suggestions -------------------------------------------------------------

/** Accept a suggestion — exactly a link, validated the same way. */
export async function acceptTransferSuggestion(
  input: unknown,
): Promise<ActionResult<{ transferGroupId: string }>> {
  return linkTransactionsAsTransfer(input);
}

/** Dismissals persist per user and never resurface — not even as auto-links. */
export async function dismissTransferSuggestion(input: unknown): Promise<ActionResult<null>> {
  const parsed = transferDismissSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const user = await getCurrentUser();

  // Canonical order, so leg order never smuggles a pair past the unique index.
  const [aId, bId] =
    parsed.data.aId < parsed.data.bId
      ? [parsed.data.aId, parsed.data.bId]
      : [parsed.data.bId, parsed.data.aId];

  const owned = await prisma.financeTransaction.count({
    where: { id: { in: [aId, bId] }, userId: user.id },
  });
  if (owned !== 2) return fail("Transaction not found");

  await prisma.transferDismissal.upsert({
    where: { userId_aId_bId: { userId: user.id, aId, bId } },
    create: { userId: user.id, aId, bId },
    update: {},
  });
  revalidateAll();
  return succeed(null);
}

/** The on-demand detection pass: auto-link what is safe, report the rest. */
export async function detectTransfers(): Promise<
  ActionResult<{ linked: number; suggestions: number }>
> {
  const user = await getCurrentUser();
  const outcome = await runTransferDetection(user.id);
  if (outcome.linked > 0) revalidateAll();
  return succeed(outcome);
}
