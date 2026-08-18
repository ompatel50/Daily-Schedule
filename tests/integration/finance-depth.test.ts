/**
 * Phase-4 finance depth against real PostgreSQL: credit-limit / statement-day
 * persistence, budget rollover through the overview, recurring-cost bill
 * suggestions (detection, dismissal persistence, bill-name suppression,
 * cross-user isolation), the month-over-month report data, and backup
 * coverage of the new pieces.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { monthRange, shiftDay } from "@/lib/date";
import { exportBackup, importBackup } from "@/server/actions/backup";
import {
  dismissBillSuggestion,
  saveBudget,
  saveFinanceAccount,
} from "@/server/actions/finance";
import { getFinanceOverview } from "@/server/finance";
import { scheduleSettingsFor } from "@/server/schedule";
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

const aliceToday = () => scheduleSettingsFor(alice).today;

function makeAccount(userId: string, overrides: Record<string, unknown> = {}) {
  return prisma.financeAccount.create({ data: { userId, name: "Checking", ...overrides } });
}

function makeTx(userId: string, accountId: string, overrides: Record<string, unknown> = {}) {
  return prisma.financeTransaction.create({
    data: { userId, accountId, date: aliceToday(), amount: -10, category: "other", ...overrides },
  });
}

describe("credit-card depth fields", () => {
  it("creditLimit and statementDueDay persist, and clearing them nulls", async () => {
    const created = await saveFinanceAccount({
      name: "Card",
      type: "credit_card",
      creditLimit: 5000,
      statementDueDay: 25,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const row = await prisma.financeAccount.findUniqueOrThrow({
      where: { id: created.data.id },
    });
    expect(row).toMatchObject({ creditLimit: 5000, statementDueDay: 25 });

    const cleared = await saveFinanceAccount({
      id: created.data.id,
      name: "Card",
      type: "credit_card",
    });
    expect(cleared.ok).toBe(true);
    const after = await prisma.financeAccount.findUniqueOrThrow({
      where: { id: created.data.id },
    });
    expect(after).toMatchObject({ creditLimit: null, statementDueDay: null });
  });

  it("refuses a nonsensical limit or due day", async () => {
    expect((await saveFinanceAccount({ name: "C", type: "credit_card", creditLimit: 0 })).ok).toBe(
      false,
    );
    expect(
      (await saveFinanceAccount({ name: "C", type: "credit_card", statementDueDay: 32 })).ok,
    ).toBe(false);
  });
});

describe("budget rollover through the overview", () => {
  it("carries last month's unused amount, capped, opt-in only", async () => {
    const account = await makeAccount(alice.id);
    const today = aliceToday();
    const thisMonth = monthRange(today);
    const lastMonth = monthRange(shiftDay(thisMonth.start, -1));

    const saved = await saveBudget({
      category: "groceries",
      amount: 400,
      period: "monthly",
      rollover: true,
    });
    expect(saved.ok).toBe(true);

    await makeTx(alice.id, account.id, {
      date: lastMonth.start,
      amount: -150,
      category: "groceries",
    });
    await makeTx(alice.id, account.id, {
      date: thisMonth.start,
      amount: -500,
      category: "groceries",
    });

    const overview = await getFinanceOverview();
    const [view] = overview.budgets;
    expect(view.carry).toBe(250);
    expect(view.effectiveAmount).toBe(650);
    expect(view.spent).toBe(500);
    expect(view.over).toBe(false);
    expect(view.budget.rollover).toBe(true);
  });
});

describe("recurring-cost bill suggestions", () => {
  async function seedNetflix(userId: string, accountId: string) {
    const today = scheduleSettingsFor(alice).today;
    for (const monthsBack of [3, 2, 1]) {
      const window = monthRange(today);
      let date = window.start;
      for (let step = 0; step < monthsBack; step += 1) {
        date = monthRange(shiftDay(date, -1)).start;
      }
      await makeTx(userId, accountId, {
        date: shiftDay(date, 9), // the 10th of each month
        amount: -15.49,
        payee: "Netflix",
        category: "subscriptions",
      });
    }
  }

  it("suggests, per user; dismissal persists; an active bill suppresses", async () => {
    const account = await makeAccount(alice.id);
    await seedNetflix(alice.id, account.id);

    const overview = await getFinanceOverview();
    expect(overview.billSuggestions.map((suggestion) => suggestion.payeeKey)).toEqual([
      "netflix",
    ]);
    expect(overview.billSuggestions[0]).toMatchObject({
      cadence: "monthly",
      amount: 15.49,
      count: 3,
      category: "subscriptions",
    });
    expect(overview.billSuggestions[0].nextDueDate >= aliceToday()).toBe(true);

    // Bob sees nothing of alice's pattern.
    actAs(bob);
    const bobOverview = await getFinanceOverview();
    expect(bobOverview.billSuggestions).toEqual([]);

    // Dismissal persists and suppresses re-detection.
    actAs(alice);
    const dismissed = await dismissBillSuggestion("Netflix");
    expect(dismissed.ok).toBe(true);
    expect((await getFinanceOverview()).billSuggestions).toEqual([]);
    expect(
      await prisma.billSuggestionDismissal.count({
        where: { userId: alice.id, payeeKey: "netflix" },
      }),
    ).toBe(1);
  });

  it("an active bill with the payee's name suppresses without a dismissal", async () => {
    const account = await makeAccount(alice.id);
    await seedNetflix(alice.id, account.id);
    await prisma.bill.create({
      data: {
        userId: alice.id,
        name: "netflix",
        amount: 15.49,
        anchorDate: aliceToday(),
        nextDueDate: aliceToday(),
      },
    });
    expect((await getFinanceOverview()).billSuggestions).toEqual([]);
  });
});

describe("month over month report data", () => {
  it("summarises both calendar months and ranks the movers", async () => {
    const account = await makeAccount(alice.id);
    const today = aliceToday();
    const thisMonth = monthRange(today);
    const lastMonth = monthRange(shiftDay(thisMonth.start, -1));

    await makeTx(alice.id, account.id, {
      date: thisMonth.start,
      amount: -300,
      category: "groceries",
    });
    await makeTx(alice.id, account.id, {
      date: lastMonth.start,
      amount: -200,
      category: "groceries",
    });
    await makeTx(alice.id, account.id, {
      date: lastMonth.start,
      amount: -60,
      category: "transport",
    });
    await makeTx(alice.id, account.id, {
      date: thisMonth.start,
      amount: 2000,
      category: "income",
    });

    const overview = await getFinanceOverview();
    expect(overview.month).toMatchObject({ spending: 300, income: 2000 });
    expect(overview.previousMonth).toMatchObject({ spending: 260, income: 0 });
    expect(overview.previousMonth.window).toEqual(lastMonth);
    expect(overview.monthOverMonth.map((delta) => delta.category)).toEqual([
      "groceries",
      "transport",
    ]);
    expect(overview.monthOverMonth[0]).toMatchObject({ current: 300, previous: 200, delta: 100 });
  });
});

describe("backup coverage of the phase-4 pieces", () => {
  it("round-trips the new columns and the suggestion dismissals", async () => {
    await saveFinanceAccount({
      name: "Card",
      type: "credit_card",
      creditLimit: 5000,
      statementDueDay: 25,
    });
    await saveBudget({ category: "groceries", amount: 400, rollover: true });
    await dismissBillSuggestion("Netflix");

    const exported = await exportBackup();
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.data.data.billSuggestionDismissals).toHaveLength(1);

    actAs(bob);
    const restored = await importBackup(exported.data, "merge");
    expect(restored.ok).toBe(true);
    const account = await prisma.financeAccount.findFirstOrThrow({
      where: { userId: bob.id, name: "Card" },
    });
    expect(account).toMatchObject({ creditLimit: 5000, statementDueDay: 25 });
    const budget = await prisma.budget.findFirstOrThrow({ where: { userId: bob.id } });
    expect(budget.rollover).toBe(true);
    expect(
      await prisma.billSuggestionDismissal.count({
        where: { userId: bob.id, payeeKey: "netflix" },
      }),
    ).toBe(1);
  });
});
