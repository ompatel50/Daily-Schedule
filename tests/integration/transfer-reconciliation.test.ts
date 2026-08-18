/**
 * Phase-3 transfer reconciliation against real PostgreSQL: mark-as-transfer
 * linking (with candidates), the missing-leg flow, unlinking, the post-import
 * auto-detection pass, persistent dismissals, import-undo keep_linked
 * behaviour for auto-linked rows, cross-user isolation, and the backup round
 * trip of dismissals.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { exportBackup, importBackup } from "@/server/actions/backup";
import {
  commitFinanceCsvImport,
} from "@/server/actions/finance-import";
import { transferBetweenAccounts } from "@/server/actions/finance";
import {
  createTransferCounterpart,
  detectTransfers,
  dismissTransferSuggestion,
  getTransferLinkCandidates,
  linkTransactionsAsTransfer,
  unlinkTransfer,
} from "@/server/actions/transfers";
import { previewFinanceImportUndo, undoFinanceImport } from "@/server/actions/finance-import";
import { computeTransferSuggestions } from "@/server/transfers";
import { actAs, resetDatabase, twoUsers } from "./helpers";

import type { User } from "./helpers";

let alice: User;
let bob: User;

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  ({ alice, bob } = await twoUsers());
  actAs(alice);
});

function makeAccount(userId: string, name: string, overrides: Record<string, unknown> = {}) {
  return prisma.financeAccount.create({ data: { userId, name, ...overrides } });
}

function makeTx(
  userId: string,
  accountId: string,
  overrides: Record<string, unknown> = {},
) {
  return prisma.financeTransaction.create({
    data: {
      userId,
      accountId,
      date: "2026-07-03",
      amount: -300,
      category: "other",
      ...overrides,
    },
  });
}

describe("mark as transfer", () => {
  it("offers candidates, links the pair, and a summary-shaped read agrees", async () => {
    const checking = await makeAccount(alice.id, "Checking");
    const card = await makeAccount(alice.id, "Card", { type: "credit_card" });
    const out = await makeTx(alice.id, checking.id, { payee: "PAYMENT TO CARD" });
    const into = await makeTx(alice.id, card.id, {
      amount: 300,
      payee: "Payment Thank You",
      category: "other",
    });
    // Noise that must NOT be offered: same account, wrong amount, linked.
    await makeTx(alice.id, checking.id, { amount: 300 });
    await makeTx(alice.id, card.id, { amount: 299 });

    const candidates = await getTransferLinkCandidates({ transactionId: out.id });
    expect(candidates.ok).toBe(true);
    if (!candidates.ok) return;
    expect(candidates.data.candidates.map((candidate) => candidate.id)).toEqual([into.id]);
    expect(candidates.data.candidates[0].confident).toBe(true);
    expect(candidates.data.accounts.map((account) => account.id)).toEqual([card.id]);

    const linked = await linkTransactionsAsTransfer({
      transactionId: out.id,
      counterpartId: into.id,
    });
    expect(linked.ok).toBe(true);

    const rows = await prisma.financeTransaction.findMany({
      where: { id: { in: [out.id, into.id] } },
    });
    expect(rows).toHaveLength(2);
    const [a, b] = rows;
    expect(a.transferGroupId).toBe(b.transferGroupId);
    expect(a.transferGroupId).not.toBeNull();
    for (const row of rows) {
      expect(row.category).toBe("transfer");
      expect(row.preTransferCategory).toBe("other");
    }
    // Source fields untouched — the import identity convention.
    const outAfter = rows.find((row) => row.id === out.id)!;
    expect(outAfter.amount).toBe(-300);
    expect(outAfter.payee).toBe("PAYMENT TO CARD");
    expect(outAfter.date).toBe("2026-07-03");
  });

  it("refuses the pairs that cannot be transfers", async () => {
    const checking = await makeAccount(alice.id, "Checking");
    const card = await makeAccount(alice.id, "Card");
    const euro = await makeAccount(alice.id, "Euro", { currency: "EUR" });
    const out = await makeTx(alice.id, checking.id);

    const sameAccount = await makeTx(alice.id, checking.id, { amount: 300 });
    expect(
      await linkTransactionsAsTransfer({ transactionId: out.id, counterpartId: sameAccount.id }),
    ).toMatchObject({ ok: false });

    const wrongAmount = await makeTx(alice.id, card.id, { amount: 250 });
    expect(
      await linkTransactionsAsTransfer({ transactionId: out.id, counterpartId: wrongAmount.id }),
    ).toMatchObject({ ok: false });

    const sameDirection = await makeTx(alice.id, card.id, { amount: -300 });
    expect(
      await linkTransactionsAsTransfer({ transactionId: out.id, counterpartId: sameDirection.id }),
    ).toMatchObject({ ok: false });

    const crossCurrency = await makeTx(alice.id, euro.id, { amount: 300 });
    expect(
      await linkTransactionsAsTransfer({ transactionId: out.id, counterpartId: crossCurrency.id }),
    ).toMatchObject({ ok: false });

    // Cross-user: bob's row is invisible to alice's link.
    const bobAccount = await makeAccount(bob.id, "Bob checking");
    const bobRow = await makeTx(bob.id, bobAccount.id, { amount: 300 });
    expect(
      await linkTransactionsAsTransfer({ transactionId: out.id, counterpartId: bobRow.id }),
    ).toMatchObject({ ok: false, error: "Transaction not found" });
    const bobRowAfter = await prisma.financeTransaction.findUniqueOrThrow({
      where: { id: bobRow.id },
    });
    expect(bobRowAfter.transferGroupId).toBeNull();
  });

  it("creates the missing leg when the other side was never imported", async () => {
    const checking = await makeAccount(alice.id, "Checking");
    const savings = await makeAccount(alice.id, "Savings");
    const out = await makeTx(alice.id, checking.id, {
      amount: -500,
      payee: "MONTHLY SWEEP",
      category: "savings",
    });

    const created = await createTransferCounterpart({
      transactionId: out.id,
      accountId: savings.id,
    });
    expect(created.ok).toBe(true);

    const legs = await prisma.financeTransaction.findMany({
      where: { userId: alice.id, transferGroupId: { not: null } },
      orderBy: { amount: "asc" },
    });
    expect(legs).toHaveLength(2);
    const [outLeg, inLeg] = legs;
    expect(outLeg.id).toBe(out.id);
    expect(outLeg.preTransferCategory).toBe("savings");
    expect(inLeg.accountId).toBe(savings.id);
    expect(inLeg.amount).toBe(500);
    expect(inLeg.date).toBe(out.date);
    expect(inLeg.payee).toBe("Transfer from Checking");
    expect(inLeg.category).toBe("transfer");
    expect(inLeg.preTransferCategory).toBeNull();
  });

  it("unlink restores pre-link categories; born legs restore to other", async () => {
    const checking = await makeAccount(alice.id, "Checking");
    const card = await makeAccount(alice.id, "Card");
    const out = await makeTx(alice.id, checking.id, { category: "debt" });
    const into = await makeTx(alice.id, card.id, { amount: 300, category: "income" });
    await linkTransactionsAsTransfer({ transactionId: out.id, counterpartId: into.id });

    const unlinked = await unlinkTransfer(out.id);
    expect(unlinked.ok).toBe(true);
    const restoredOut = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: out.id } });
    const restoredInto = await prisma.financeTransaction.findUniqueOrThrow({
      where: { id: into.id },
    });
    expect(restoredOut).toMatchObject({
      category: "debt",
      transferGroupId: null,
      preTransferCategory: null,
    });
    expect(restoredInto).toMatchObject({ category: "income", transferGroupId: null });

    // A pair the Transfer flow wrote never had other categories — "other".
    const transferred = await transferBetweenAccounts({
      fromAccountId: checking.id,
      toAccountId: card.id,
      amount: 75,
      date: "2026-07-10",
    });
    expect(transferred.ok).toBe(true);
    if (!transferred.ok) return;
    const leg = await prisma.financeTransaction.findFirstOrThrow({
      where: { transferGroupId: transferred.data.transferGroupId },
    });
    const unlinkedClassic = await unlinkTransfer(leg.id);
    expect(unlinkedClassic.ok).toBe(true);
    const classicRows = await prisma.financeTransaction.findMany({
      where: { userId: alice.id, amount: { in: [75, -75] } },
    });
    for (const row of classicRows) {
      expect(row.category).toBe("other");
      expect(row.transferGroupId).toBeNull();
    }
  });
});

// A Chase-shaped card statement whose payment has a matching outflow already
// sitting in the checking account.
const CARD_CSV = [
  "Transaction Date,Post Date,Description,Category,Type,Amount,Memo",
  "07/01/2026,07/02/2026,GROCERY STORE,Groceries,Sale,-120.00,",
  "07/03/2026,07/03/2026,Payment Thank You-Mobile,,Payment,300.00,",
].join("\n");

describe("auto-detection after import", () => {
  it("links the unambiguous payment, reports it, and undo keeps both legs", async () => {
    const checking = await makeAccount(alice.id, "Checking");
    const card = await makeAccount(alice.id, "Card", { type: "credit_card" });
    const outflow = await makeTx(alice.id, checking.id, {
      payee: "CHASE AUTOPAY",
      category: "debt",
    });

    const committed = await commitFinanceCsvImport({
      accountId: card.id,
      fileName: "card.csv",
      content: CARD_CSV,
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(committed.data.createdCount).toBe(2);
    expect(committed.data.transfersLinked).toBe(1);
    expect(committed.data.transferSuggestions).toBe(0);

    const payment = await prisma.financeTransaction.findFirstOrThrow({
      where: { userId: alice.id, payee: "Payment Thank You-Mobile" },
    });
    const linkedOutflow = await prisma.financeTransaction.findUniqueOrThrow({
      where: { id: outflow.id },
    });
    expect(payment.transferGroupId).not.toBeNull();
    expect(payment.transferGroupId).toBe(linkedOutflow.transferGroupId);
    expect(payment.category).toBe("transfer");
    expect(payment.preTransferCategory).toBe("other");
    expect(linkedOutflow.preTransferCategory).toBe("debt");
    // Imported source fields untouched.
    expect(payment.amount).toBe(300);
    expect(payment.importKey).toContain("payment thank you-mobile");

    // 3c — the auto-linked row is keep_linked on undo, exactly like a
    // hand-made transfer leg.
    const preview = await previewFinanceImportUndo(committed.data.batchId);
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      expect(preview.data.removableCount).toBe(1); // the grocery row
      expect(preview.data.keptLinkedCount).toBe(1); // the linked payment
    }
    const undone = await undoFinanceImport(committed.data.batchId);
    expect(undone.ok).toBe(true);
    if (undone.ok) {
      expect(undone.data.removedCount).toBe(1);
      expect(undone.data.keptLinkedCount).toBe(1);
    }
    expect(
      await prisma.financeTransaction.count({ where: { id: payment.id } }),
    ).toBe(1);
    expect(
      await prisma.financeTransaction.count({
        where: { userId: alice.id, payee: "GROCERY STORE" },
      }),
    ).toBe(0);
  });

  it("an ambiguous match becomes a suggestion, never an auto-link", async () => {
    const checking = await makeAccount(alice.id, "Checking");
    const savings = await makeAccount(alice.id, "Savings");
    const card = await makeAccount(alice.id, "Card", { type: "credit_card" });
    await makeTx(alice.id, checking.id, { payee: "PAYMENT" });
    await makeTx(alice.id, savings.id, { payee: "PAYMENT" });

    const committed = await commitFinanceCsvImport({
      accountId: card.id,
      fileName: "card.csv",
      content: CARD_CSV,
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(committed.data.transfersLinked).toBe(0);
    expect(committed.data.transferSuggestions).toBeGreaterThan(0);
    expect(
      await prisma.financeTransaction.count({
        where: { userId: alice.id, transferGroupId: { not: null } },
      }),
    ).toBe(0);
  });

  it("never pairs across users", async () => {
    const card = await makeAccount(alice.id, "Card", { type: "credit_card" });
    // Only bob holds a matching outflow — alice's import must find nothing.
    const bobAccount = await makeAccount(bob.id, "Bob checking");
    await makeTx(bob.id, bobAccount.id, { payee: "CHASE AUTOPAY" });

    const committed = await commitFinanceCsvImport({
      accountId: card.id,
      fileName: "card.csv",
      content: CARD_CSV,
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(committed.data.transfersLinked).toBe(0);
    expect(committed.data.transferSuggestions).toBe(0);
    expect(
      await prisma.financeTransaction.count({ where: { transferGroupId: { not: null } } }),
    ).toBe(0);
  });
});

describe("suggestions and dismissals", () => {
  it("a dismissed pair never resurfaces — not in suggestions, not by detection", async () => {
    const checking = await makeAccount(alice.id, "Checking");
    const savings = await makeAccount(alice.id, "Savings");
    // A same-amount pair with no strong signals: suggestion territory.
    const out = await makeTx(alice.id, checking.id, { amount: -42.17, date: "2026-07-11" });
    const into = await makeTx(alice.id, savings.id, { amount: 42.17, date: "2026-07-12" });

    const before = await computeTransferSuggestions(alice.id);
    expect(before.map((suggestion) => [suggestion.outId, suggestion.intoId])).toEqual([
      [out.id, into.id],
    ]);

    const dismissed = await dismissTransferSuggestion({ aId: into.id, bId: out.id });
    expect(dismissed.ok).toBe(true);

    expect(await computeTransferSuggestions(alice.id)).toEqual([]);
    const detection = await detectTransfers();
    expect(detection).toMatchObject({ ok: true, data: { linked: 0, suggestions: 0 } });

    // Dismissing is not forbidding: an explicit link still works.
    const linked = await linkTransactionsAsTransfer({
      transactionId: out.id,
      counterpartId: into.id,
    });
    expect(linked.ok).toBe(true);
  });

  it("dismissal refuses rows that are not yours", async () => {
    const checking = await makeAccount(alice.id, "Checking");
    const mine = await makeTx(alice.id, checking.id);
    const bobAccount = await makeAccount(bob.id, "Bob checking");
    const theirs = await makeTx(bob.id, bobAccount.id, { amount: 300 });

    const refused = await dismissTransferSuggestion({ aId: mine.id, bId: theirs.id });
    expect(refused).toMatchObject({ ok: false });
    expect(await prisma.transferDismissal.count()).toBe(0);
  });

  it("dismissals survive a backup round trip and stay suppressive", async () => {
    const checking = await makeAccount(alice.id, "Checking");
    const savings = await makeAccount(alice.id, "Savings");
    const out = await makeTx(alice.id, checking.id, { amount: -42.17 });
    const into = await makeTx(alice.id, savings.id, { amount: 42.17 });
    await dismissTransferSuggestion({ aId: out.id, bId: into.id });

    const exported = await exportBackup();
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.data.data.transferDismissals).toHaveLength(1);

    // Restored into BOB's account: remapped ids, canonical order, still
    // suppressing the pair for him.
    actAs(bob);
    const restored = await importBackup(exported.data, "merge");
    expect(restored.ok).toBe(true);
    const dismissal = await prisma.transferDismissal.findFirstOrThrow({
      where: { userId: bob.id },
    });
    expect(dismissal.aId < dismissal.bId).toBe(true);
    expect(await computeTransferSuggestions(bob.id)).toEqual([]);
  });
});
