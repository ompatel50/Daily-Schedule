import { describe, expect, it } from "vitest";

import {
  accountBalances,
  advanceBillAfterPayment,
  billCadence,
  billIsActive,
  billsByUrgency,
  budgetProgress,
  formatMoney,
  moneyRound,
  netBalance,
  savingsProgress,
  spendingByCategory,
  summarizeTransactions,
  transferLegs,
  upcomingBillsTotal,
  type AccountBalanceInput,
  type BillLike,
  type TransactionLike,
} from "@/lib/logic/finance";

const TODAY = "2026-07-31";

function account(partial: Partial<AccountBalanceInput> = {}): AccountBalanceInput {
  return { id: "acct", type: "checking", openingBalance: 0, archivedAt: null, ...partial };
}

function tx(amount: number, category = "other"): TransactionLike {
  return { amount, category };
}

function bill(partial: Partial<BillLike> = {}): BillLike {
  return {
    id: "bill",
    name: "Bill",
    amount: 10,
    recurrence: "monthly",
    anchorDate: TODAY,
    nextDueDate: TODAY,
    settledAt: null,
    archivedAt: null,
    ...partial,
  };
}

describe("moneyRound", () => {
  it("normalises to cents", () => {
    expect(moneyRound(3.14159)).toBe(3.14);
    expect(moneyRound(19.998)).toBe(20);
    expect(moneyRound(-2.006)).toBe(-2.01);
  });

  it("cleans up float-arithmetic residue", () => {
    expect(moneyRound(0.1 + 0.2)).toBe(0.3);
    expect(moneyRound(1240.5)).toBe(1240.5);
  });
});

describe("formatMoney", () => {
  it("renders cents with a thousands separator", () => {
    expect(formatMoney(1240.5)).toBe("$1,240.50");
  });

  it("renders negatives with a leading sign", () => {
    expect(formatMoney(-86.2)).toBe("-$86.20");
  });

  it("drops the cents on whole amounts", () => {
    expect(formatMoney(1200)).toBe("$1,200");
    expect(formatMoney(0)).toBe("$0");
  });

  it("falls back instead of crashing on an unknown currency code", () => {
    expect(formatMoney(12.5, "BOGUS")).toBe("BOGUS 12.50");
    expect(formatMoney(-3, "BOGUS")).toBe("-BOGUS 3.00");
  });
});

describe("accountBalances", () => {
  it("adds the transaction total to the opening balance", () => {
    const checking = account({ id: "c", openingBalance: 100 });
    const [view] = accountBalances([checking], new Map([["c", 250.25]]));
    expect(view.balance).toBe(350.25);
    expect(view.debt).toBe(false);
    expect(view.account).toBe(checking);
  });

  it("uses the opening balance alone when the account has no transactions", () => {
    const [view] = accountBalances([account({ id: "s", type: "savings", openingBalance: 42.5 })], new Map());
    expect(view.balance).toBe(42.5);
  });

  it("flags debt from the account type", () => {
    const views = accountBalances(
      [
        account({ id: "cc", type: "credit_card" }),
        account({ id: "ln", type: "loan" }),
        account({ id: "ch", type: "checking" }),
        account({ id: "??", type: "not-a-type" }),
      ],
      new Map(),
    );
    expect(views.map((v) => v.debt)).toEqual([true, true, false, false]);
  });
});

describe("netBalance", () => {
  it("nets unarchived accounts, debt balances subtracting as negatives", () => {
    const views = accountBalances(
      [
        account({ id: "checking", openingBalance: 1000 }),
        account({ id: "savings", type: "savings", openingBalance: 2000 }),
        account({ id: "card", type: "credit_card", openingBalance: 0 }),
      ],
      new Map([["card", -500]]),
    );
    expect(netBalance(views)).toBe(2500);
  });

  it("excludes archived accounts entirely", () => {
    const views = accountBalances(
      [
        account({ id: "live", openingBalance: 100 }),
        account({ id: "old", openingBalance: 9999, archivedAt: "2026-01-01" }),
      ],
      new Map(),
    );
    expect(netBalance(views)).toBe(100);
  });
});

describe("summarizeTransactions", () => {
  it("splits income and spending, both reported positive", () => {
    const summary = summarizeTransactions([
      tx(100, "income"),
      tx(-40.25, "groceries"),
      tx(-9.75, "dining"),
    ]);
    expect(summary).toEqual({ income: 100, spending: 50, net: 50, count: 3 });
  });

  it("goes negative on net when the window overspent", () => {
    expect(summarizeTransactions([tx(-30, "shopping")])).toEqual({
      income: 0,
      spending: 30,
      net: -30,
      count: 1,
    });
  });

  it("keeps transfer legs out of both sides — moving money between accounts is not income", () => {
    const summary = summarizeTransactions([
      tx(1000, "income"),
      tx(-200, "transfer"),
      tx(200, "transfer"),
      tx(-50, "groceries"),
    ]);
    expect(summary.income).toBe(1000);
    expect(summary.spending).toBe(50);
    expect(summary.net).toBe(950);
    expect(summary.count).toBe(2);
  });

  it("keeps balance adjustments out of both sides and the count", () => {
    const summary = summarizeTransactions([
      tx(500, "adjustment"),
      tx(-20, "adjustment"),
      tx(10, "income"),
    ]);
    expect(summary).toEqual({ income: 10, spending: 0, net: 10, count: 1 });
  });

  it("summarises an empty window to zeroes", () => {
    expect(summarizeTransactions([])).toEqual({ income: 0, spending: 0, net: 0, count: 0 });
  });
});

describe("spendingByCategory", () => {
  const transactions = [
    tx(-50, "groceries"),
    tx(-25, "groceries"),
    tx(-30, "dining"),
    tx(100, "income"), // money in — not spending
    tx(-999, "adjustment"), // bookkeeping — excluded
    tx(-10, "travel"),
  ];

  it("totals only negative amounts per category, largest first, with labels", () => {
    expect(spendingByCategory(transactions)).toEqual([
      { category: "groceries", label: "Groceries", total: 75 },
      { category: "dining", label: "Dining", total: 30 },
      { category: "travel", label: "Travel", total: 10 },
    ]);
  });

  it("bounds the list by the limit", () => {
    const top = spendingByCategory(transactions, 2);
    expect(top.map((entry) => entry.category)).toEqual(["groceries", "dining"]);
  });

  it("keeps transfer legs out of category spending", () => {
    const totals = spendingByCategory([tx(-500, "transfer"), tx(-30, "dining")]);
    expect(totals).toHaveLength(1);
    expect(totals[0].category).toBe("dining");
  });

  it("falls back to the raw category as the label for unknown categories", () => {
    const [entry] = spendingByCategory([tx(-5, "llama-rental")]);
    expect(entry).toEqual({ category: "llama-rental", label: "llama-rental", total: 5 });
  });
});

describe("billCadence", () => {
  it("maps each recurrence to a unit cadence", () => {
    expect(billCadence("weekly")).toEqual({ unit: "weekly", every: 1 });
    expect(billCadence("monthly")).toEqual({ unit: "monthly", every: 1 });
    expect(billCadence("quarterly")).toEqual({ unit: "quarterly", every: 1 });
    expect(billCadence("yearly")).toEqual({ unit: "yearly", every: 1 });
  });

  it("returns null for one-time and unknown recurrences", () => {
    expect(billCadence("once")).toBeNull();
    expect(billCadence("sometimes")).toBeNull();
  });
});

describe("advanceBillAfterPayment", () => {
  it("walks a monthly bill anchored on the 31st through short months without drift", () => {
    let pointer = bill({ recurrence: "monthly", anchorDate: "2026-01-31", nextDueDate: "2026-01-31" });
    const seen: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const advanced = advanceBillAfterPayment(pointer);
      expect(advanced.settled).toBe(false);
      seen.push(advanced.nextDueDate);
      pointer = { ...pointer, nextDueDate: advanced.nextDueDate };
    }
    expect(seen).toEqual(["2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("advances a weekly bill by a week", () => {
    const advanced = advanceBillAfterPayment(
      bill({ recurrence: "weekly", anchorDate: "2026-07-06", nextDueDate: "2026-07-06" }),
    );
    expect(advanced).toEqual({ nextDueDate: "2026-07-13", settled: false });
  });

  it("settles a one-time bill without moving the due date", () => {
    const advanced = advanceBillAfterPayment(
      bill({ recurrence: "once", anchorDate: "2026-08-15", nextDueDate: "2026-08-15" }),
    );
    expect(advanced).toEqual({ nextDueDate: "2026-08-15", settled: true });
  });
});

describe("billIsActive", () => {
  it("is active only while neither settled nor archived", () => {
    expect(billIsActive(bill())).toBe(true);
    expect(billIsActive(bill({ settledAt: "2026-07-01" }))).toBe(false);
    expect(billIsActive(bill({ archivedAt: "2026-07-01" }))).toBe(false);
    expect(billIsActive(bill({ settledAt: "2026-07-01", archivedAt: "2026-07-01" }))).toBe(false);
  });
});

describe("billsByUrgency", () => {
  const bills = [
    bill({ id: "rent", name: "Rent", amount: 1200, nextDueDate: "2026-08-01" }), // +1
    bill({ id: "beta", name: "Beta", amount: 25, nextDueDate: "2026-07-31" }), // 0
    bill({ id: "electric", name: "Electric", amount: 60, nextDueDate: "2026-07-29" }), // -2
    bill({ id: "alpha", name: "Alpha", amount: 25, nextDueDate: "2026-07-31" }), // 0
    bill({ id: "cable", name: "Cable", amount: 45, nextDueDate: "2026-08-10" }), // +10
    bill({ id: "paid", name: "Paid off", settledAt: "2026-07-01" }),
    bill({ id: "gone", name: "Old gym", archivedAt: "2026-06-01" }),
  ];

  it("excludes settled and archived bills and sorts most urgent first, ties by name", () => {
    const views = billsByUrgency(bills, TODAY);
    expect(views.map((view) => view.bill.id)).toEqual(["electric", "alpha", "beta", "rent", "cable"]);
    expect(views.map((view) => view.daysUntilDue)).toEqual([-2, 0, 0, 1, 10]);
  });

  it("buckets against the default 7-day window", () => {
    const views = billsByUrgency(bills, TODAY);
    expect(views.map((view) => view.bucket)).toEqual(["overdue", "today", "today", "soon", "later"]);
  });

  it("widens the soon bucket with a custom soonDays", () => {
    const views = billsByUrgency(bills, TODAY, 14);
    const cable = views.find((view) => view.bill.id === "cable");
    expect(cable?.bucket).toBe("soon");
  });
});

describe("upcomingBillsTotal", () => {
  const views = billsByUrgency(
    [
      bill({ id: "electric", name: "Electric", amount: 60, nextDueDate: "2026-07-29" }), // -2
      bill({ id: "rent", name: "Rent", amount: 1200, nextDueDate: "2026-08-01" }), // +1
      bill({ id: "cable", name: "Cable", amount: 45, nextDueDate: "2026-08-10" }), // +10
      bill({ id: "insurance", name: "Insurance", amount: 300, nextDueDate: "2026-08-20" }), // +20
    ],
    TODAY,
  );

  it("sums bills due within the window, overdue included", () => {
    // Default 14-day window: everything but the +20 insurance bill.
    expect(upcomingBillsTotal(views)).toBe(1305);
  });

  it("respects a wider window", () => {
    expect(upcomingBillsTotal(views, 30)).toBe(1605);
  });

  it("is zero when nothing falls inside the window", () => {
    expect(upcomingBillsTotal(views, -10)).toBe(0);
  });
});

describe("savingsProgress", () => {
  it("reports percent, remaining and completeness", () => {
    expect(savingsProgress({ targetAmount: 1000, currentAmount: 250 })).toEqual({
      percent: 25,
      remaining: 750,
      complete: false,
    });
  });

  it("rounds the percent", () => {
    expect(savingsProgress({ targetAmount: 300, currentAmount: 100 }).percent).toBe(33);
  });

  it("caps an overfunded goal at 100% and marks it complete", () => {
    expect(savingsProgress({ targetAmount: 1000, currentAmount: 1300 })).toEqual({
      percent: 100,
      remaining: 0,
      complete: true,
    });
  });

  it("completes exactly at the target", () => {
    expect(savingsProgress({ targetAmount: 500, currentAmount: 500 })).toEqual({
      percent: 100,
      remaining: 0,
      complete: true,
    });
  });

  it("treats a zero or negative target as fully funded but never complete", () => {
    expect(savingsProgress({ targetAmount: 0, currentAmount: 50 })).toEqual({
      percent: 100,
      remaining: 0,
      complete: false,
    });
    expect(savingsProgress({ targetAmount: -100, currentAmount: 0 })).toEqual({
      percent: 100,
      remaining: 0,
      complete: false,
    });
  });

  it("clamps a negative current amount to zero", () => {
    expect(savingsProgress({ targetAmount: 1000, currentAmount: -50 })).toEqual({
      percent: 0,
      remaining: 1000,
      complete: false,
    });
  });
});

describe("budgetProgress", () => {
  const budget = (category: string, amount: number, id = category) => ({ id, category, amount });

  it("counts only spending in the budget's category", () => {
    const [view] = budgetProgress(
      [budget("dining", 200)],
      [tx(-50, "dining"), tx(-30, "groceries"), tx(20, "dining")],
    );
    expect(view.spent).toBe(50);
    expect(view.remaining).toBe(150);
    expect(view.percent).toBe(25);
    expect(view.over).toBe(false);
    expect(view.label).toBe("Dining");
  });

  it("income never offsets a budget, and bookkeeping rows never count", () => {
    const [view] = budgetProgress(
      [budget("dining", 100)],
      [tx(-80, "dining"), tx(500, "dining"), tx(-40, "transfer"), tx(-40, "adjustment")],
    );
    expect(view.spent).toBe(80);
  });

  it("flags over-budget with the uncapped percentage", () => {
    const [view] = budgetProgress([budget("dining", 100)], [tx(-130, "dining")]);
    expect(view.over).toBe(true);
    expect(view.percent).toBe(130);
    expect(view.remaining).toBe(0);
  });

  it("a budget with no spending reads as untouched", () => {
    const [view] = budgetProgress([budget("travel", 300)], []);
    expect(view).toMatchObject({ spent: 0, remaining: 300, percent: 0, over: false });
  });

  it("sorts over-budget first, then by percentage", () => {
    const views = budgetProgress(
      [budget("dining", 100), budget("groceries", 100), budget("travel", 100)],
      [tx(-150, "groceries"), tx(-90, "travel"), tx(-10, "dining")],
    );
    expect(views.map((view) => view.budget.category)).toEqual([
      "groceries",
      "travel",
      "dining",
    ]);
  });

  it("exact-target spending is not over budget", () => {
    const [view] = budgetProgress([budget("dining", 100)], [tx(-100, "dining")]);
    expect(view.over).toBe(false);
    expect(view.percent).toBe(100);
    expect(view.remaining).toBe(0);
  });
});

describe("transferLegs", () => {
  const input = {
    fromAccountId: "a1",
    toAccountId: "a2",
    fromAccountName: "Checking",
    toAccountName: "Savings",
    amount: 250,
    date: "2026-07-31",
    notes: "monthly move",
    transferGroupId: "grp",
  };

  it("shapes one out leg and one in leg sharing the group id", () => {
    const [out, into] = transferLegs(input);
    expect(out).toMatchObject({
      accountId: "a1",
      amount: -250,
      category: "transfer",
      payee: "Transfer to Savings",
      transferGroupId: "grp",
    });
    expect(into).toMatchObject({
      accountId: "a2",
      amount: 250,
      category: "transfer",
      payee: "Transfer from Checking",
      transferGroupId: "grp",
    });
  });

  it("the legs cancel exactly — a transfer moves money, never creates it", () => {
    const [out, into] = transferLegs({ ...input, amount: 33.335 });
    expect(out.amount + into.amount).toBe(0);
    expect(into.amount).toBe(33.34); // rounded to cents once, same on both legs
  });

  it("normalises a negative amount — direction comes from from/to, not the sign", () => {
    const [out, into] = transferLegs({ ...input, amount: -40 });
    expect(out.amount).toBe(-40);
    expect(into.amount).toBe(40);
  });
});
