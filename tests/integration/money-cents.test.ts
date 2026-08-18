/**
 * Phase-5 money-as-integer-cents against real PostgreSQL: dual-write on every
 * write path, exact cents arithmetic through the overview, the read fallback
 * for legacy float-only rows, the 004 backfill module (fill + per-account
 * verification), and the required proof that a FULL BACKUP TAKEN BEFORE THE
 * MIGRATION (floats only, v10) restores correctly after it.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma, prismaIncludingTrashed } from "@/lib/prisma";
import { run as runMoneyCentsBackfill } from "../../prisma/migrations-data/004-money-cents";
import { exportBackup, importBackup } from "@/server/actions/backup";
import { saveTransaction, saveFinanceAccount } from "@/server/actions/finance";
import { commitFinanceCsvImport } from "@/server/actions/finance-import";
import { getFinanceOverview } from "@/server/finance";
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

describe("dual-write", () => {
  it("every write path fills both columns, mirrored exactly", async () => {
    const created = await saveFinanceAccount({ name: "Checking", openingBalance: 10.05 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const account = await prisma.financeAccount.findUniqueOrThrow({
      where: { id: created.data.id },
    });
    expect(account.openingBalanceCents).toBe(1005);
    expect(account.openingBalance).toBe(10.05);

    const tx = await saveTransaction({
      accountId: account.id,
      date: "2026-07-15",
      amount: -42.5,
      category: "groceries",
    });
    expect(tx.ok).toBe(true);
    if (!tx.ok) return;
    const row = await prisma.financeTransaction.findUniqueOrThrow({ where: { id: tx.data.id } });
    expect(row.amountCents).toBe(-4250);
    expect(row.amount).toBe(-42.5);

    const imported = await commitFinanceCsvImport({
      accountId: account.id,
      fileName: "b.csv",
      content: "date,amount,description\n2026-07-16,-19.99,Streaming",
    });
    expect(imported.ok).toBe(true);
    const importedRow = await prisma.financeTransaction.findFirstOrThrow({
      where: { userId: alice.id, payee: "Streaming" },
    });
    expect(importedRow.amountCents).toBe(-1999);
    expect(importedRow.amount).toBe(-19.99);
    // The dedup key keeps the historical DOLLAR spelling.
    expect(importedRow.importKey).toBe(`v1|${account.id}|2026-07-16|-19.99|streaming|0`);
  });

  it("cent arithmetic is exact where float sums drift", async () => {
    const created = await saveFinanceAccount({ name: "Exact", openingBalance: 0 });
    if (!created.ok) throw new Error("account");
    for (const amount of [0.1, 0.2, 0.3, -0.4]) {
      const saved = await saveTransaction({
        accountId: created.data.id,
        date: "2026-07-15",
        amount,
        category: "other",
        payee: `p${amount}`,
      });
      expect(saved.ok).toBe(true);
    }
    const overview = await getFinanceOverview();
    const balance = overview.balances.find((row) => row.account.id === created.data.id);
    // 10 + 20 + 30 − 40 = 20 cents, exactly — no 0.20000000000000004.
    expect(balance?.balance).toBe(20);
    expect(Number.isInteger(balance?.balance)).toBe(true);
  });
});

describe("legacy float-only rows", () => {
  it("read identically through the fallback until backfilled", async () => {
    // Simulate rows that predate the migration's SQL backfill (or arrived
    // outside it): float only, cents null.
    const account = await prisma.financeAccount.create({
      data: { userId: alice.id, name: "Legacy", openingBalance: 5.5, openingBalanceCents: null },
    });
    await prisma.financeTransaction.create({
      data: {
        userId: alice.id,
        accountId: account.id,
        date: "2026-07-10",
        amount: -1.05,
        amountCents: null,
        category: "dining",
      },
    });

    const overview = await getFinanceOverview();
    const balance = overview.balances.find((row) => row.account.id === account.id);
    expect(balance?.balance).toBe(445); // 550 − 105, in cents via the fallback
  });

  it("the 004 backfill fills them and verifies balances to the cent", async () => {
    const account = await prisma.financeAccount.create({
      data: { userId: alice.id, name: "Legacy", openingBalance: 5.5, openingBalanceCents: null },
    });
    await prisma.financeTransaction.create({
      data: {
        userId: alice.id,
        accountId: account.id,
        date: "2026-07-10",
        amount: -1.05,
        amountCents: null,
        category: "dining",
      },
    });
    await prisma.bill.create({
      data: {
        userId: alice.id,
        name: "Old bill",
        amount: 12.34,
        amountCents: null,
        anchorDate: "2026-07-01",
        nextDueDate: "2026-08-01",
      },
    });

    const notes = await runMoneyCentsBackfill(prismaIncludingTrashed);
    expect(notes.join(" ")).toContain("filled cents on 3 row(s)");
    expect(notes.join(" ")).toMatch(/verified \d+ account balance\(s\) identical to the cent/);

    const backfilled = await prisma.financeTransaction.findFirstOrThrow({
      where: { accountId: account.id },
    });
    expect(backfilled.amountCents).toBe(-105);
    expect(
      (await prisma.financeAccount.findUniqueOrThrow({ where: { id: account.id } }))
        .openingBalanceCents,
    ).toBe(550);
    expect(
      (await prisma.bill.findFirstOrThrow({ where: { userId: alice.id } })).amountCents,
    ).toBe(1234);

    // Idempotent: a second run fills nothing and still verifies.
    const again = await runMoneyCentsBackfill(prismaIncludingTrashed);
    expect(again.join(" ")).toContain("nothing to fill");
  });
});

describe("a pre-migration backup restores correctly after it", () => {
  it("restores a floats-only v10 file with cents derived on import", async () => {
    // Shaped exactly like an export the app produced BEFORE this phase:
    // finance rows with float money and no *Cents keys at all.
    const preMigrationBackup = {
      app: "personal-os" as const,
      version: 10,
      exportedAt: "2026-08-01T00:00:00.000Z",
      data: {
        financeAccounts: [
          {
            id: "old-acct",
            userId: "old-user",
            name: "Old checking",
            type: "checking",
            currency: "USD",
            openingBalance: 100.55,
            lowBalanceThreshold: 25.5,
            sortOrder: 0,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        financeTransactions: [
          {
            id: "old-tx",
            userId: "old-user",
            accountId: "old-acct",
            date: "2026-07-15",
            amount: -42.5,
            category: "groceries",
            payee: "Corner grocery",
            createdAt: "2026-07-15T00:00:00.000Z",
            updatedAt: "2026-07-15T00:00:00.000Z",
          },
        ],
        bills: [
          {
            id: "old-bill",
            userId: "old-user",
            name: "Rent",
            amount: 1800,
            accountId: "old-acct",
            anchorDate: "2026-07-01",
            nextDueDate: "2026-09-01",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        budgets: [
          {
            id: "old-budget",
            userId: "old-user",
            category: "groceries",
            amount: 400,
            period: "monthly",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        savingsGoals: [
          {
            id: "old-goal",
            userId: "old-user",
            name: "Emergency",
            targetAmount: 10000,
            currentAmount: 2500.25,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    };

    const restored = await importBackup(preMigrationBackup, "merge");
    expect(restored.ok).toBe(true);

    const account = await prisma.financeAccount.findFirstOrThrow({
      where: { userId: alice.id },
    });
    expect(account).toMatchObject({
      openingBalance: 100.55,
      openingBalanceCents: 10055,
      lowBalanceThreshold: 25.5,
      lowBalanceThresholdCents: 2550,
    });
    const tx = await prisma.financeTransaction.findFirstOrThrow({ where: { userId: alice.id } });
    expect(tx).toMatchObject({ amount: -42.5, amountCents: -4250 });
    const bill = await prisma.bill.findFirstOrThrow({ where: { userId: alice.id } });
    expect(bill).toMatchObject({ amount: 1800, amountCents: 180000 });
    const budget = await prisma.budget.findFirstOrThrow({ where: { userId: alice.id } });
    expect(budget).toMatchObject({ amount: 400, amountCents: 40000 });
    const goal = await prisma.savingsGoal.findFirstOrThrow({ where: { userId: alice.id } });
    expect(goal).toMatchObject({
      targetAmountCents: 1000000,
      currentAmountCents: 250025,
    });

    // The restored data computes correctly through the app.
    const overview = await getFinanceOverview();
    const balance = overview.balances.find((row) => row.account.id === account.id);
    expect(balance?.balance).toBe(5805); // 10055 − 4250 cents
  });

  it("a post-switch export round-trips into another account with cents intact", async () => {
    const created = await saveFinanceAccount({ name: "Mine", openingBalance: 12.34 });
    if (!created.ok) throw new Error("account");
    await saveTransaction({
      accountId: created.data.id,
      date: "2026-07-15",
      amount: -0.99,
      category: "other",
    });

    const exported = await exportBackup();
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.data.version).toBe(11);

    actAs(bob);
    const restored = await importBackup(exported.data, "merge");
    expect(restored.ok).toBe(true);
    const account = await prisma.financeAccount.findFirstOrThrow({
      where: { userId: bob.id, name: "Mine" },
    });
    expect(account.openingBalanceCents).toBe(1234);
    const tx = await prisma.financeTransaction.findFirstOrThrow({ where: { userId: bob.id } });
    expect(tx.amountCents).toBe(-99);
  });
});
