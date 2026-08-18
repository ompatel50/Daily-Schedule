import { describe, expect, it } from "vitest";

import {
  detectRecurringCosts,
  type RecurringCandidateRow,
} from "@/lib/logic/recurring-detect";

const TODAY = "2026-08-18";

function row(
  partial: Partial<RecurringCandidateRow> & Pick<RecurringCandidateRow, "date" | "amount">,
): RecurringCandidateRow {
  return {
    accountId: "checking",
    payee: "Netflix",
    category: "subscriptions",
    billId: null,
    transferGroupId: null,
    ...partial,
  };
}

describe("detectRecurringCosts", () => {
  it("finds a monthly pattern and pre-fills the bill", () => {
    const suggestions = detectRecurringCosts(
      [
        row({ date: "2026-05-15", amount: -15.49 }),
        row({ date: "2026-06-15", amount: -15.49 }),
        row({ date: "2026-07-15", amount: -15.49 }),
      ],
      TODAY,
    );
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      payeeKey: "netflix",
      payee: "Netflix",
      cadence: "monthly",
      amount: 15.49,
      count: 3,
      lastDate: "2026-07-15",
      // Aug 15 already passed (today is Aug 18) — the suggested first due
      // date is always in the future, never born overdue.
      nextDueDate: "2026-09-15",
      category: "subscriptions",
      accountId: "checking",
    });
  });

  it("a stale history still suggests a future first due date", () => {
    const suggestions = detectRecurringCosts(
      [
        row({ date: "2026-01-10", amount: -12 }),
        row({ date: "2026-02-10", amount: -12 }),
        row({ date: "2026-03-10", amount: -12 }),
      ],
      TODAY,
    );
    expect(suggestions[0].nextDueDate >= TODAY).toBe(true);
    expect(suggestions[0].nextDueDate).toBe("2026-09-10");
  });

  it("tolerates a few days of drift and small amount variance", () => {
    const suggestions = detectRecurringCosts(
      [
        row({ date: "2026-05-14", amount: -14.99 }),
        row({ date: "2026-06-16", amount: -15.49 }), // price bump, 33-day gap
        row({ date: "2026-07-15", amount: -15.49 }),
      ],
      TODAY,
    );
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].cadence).toBe("monthly");
  });

  it("weekly needs three occurrences; yearly settles for two", () => {
    const weekly = detectRecurringCosts(
      [
        row({ payee: "Gym", date: "2026-07-06", amount: -20 }),
        row({ payee: "Gym", date: "2026-07-13", amount: -20 }),
        row({ payee: "Gym", date: "2026-07-20", amount: -20 }),
      ],
      TODAY,
    );
    expect(weekly[0]).toMatchObject({ cadence: "weekly", nextDueDate: "2026-08-24" });

    const yearlyTooFew = detectRecurringCosts(
      [row({ payee: "Gym", date: "2026-07-06", amount: -20 }),
       row({ payee: "Gym", date: "2026-07-13", amount: -20 })],
      TODAY,
    );
    expect(yearlyTooFew).toEqual([]); // two weekly-looking rows are not enough

    const yearly = detectRecurringCosts(
      [
        row({ payee: "Insurance Co", date: "2025-03-01", amount: -820, category: "insurance" }),
        row({ payee: "Insurance Co", date: "2026-03-02", amount: -845, category: "insurance" }),
      ],
      TODAY,
    );
    expect(yearly[0]).toMatchObject({ cadence: "yearly", category: "insurance" });
  });

  it("irregular gaps and one-offs never qualify", () => {
    expect(
      detectRecurringCosts(
        [
          row({ date: "2026-05-01", amount: -30 }),
          row({ date: "2026-05-20", amount: -30 }),
          row({ date: "2026-07-15", amount: -30 }),
        ],
        TODAY,
      ),
    ).toEqual([]);
    expect(detectRecurringCosts([row({ date: "2026-07-15", amount: -30 })], TODAY)).toEqual([]);
  });

  it("dissimilar amounts under one payee break the pattern", () => {
    expect(
      detectRecurringCosts(
        [
          row({ payee: "Amazon", date: "2026-05-15", amount: -12 }),
          row({ payee: "Amazon", date: "2026-06-15", amount: -180 }),
          row({ payee: "Amazon", date: "2026-07-15", amount: -47 }),
        ],
        TODAY,
      ),
    ).toEqual([]);
  });

  it("skips rows that are already accounted for", () => {
    expect(
      detectRecurringCosts(
        [
          row({ date: "2026-05-15", amount: -15.49, billId: "bill1" }),
          row({ date: "2026-06-15", amount: -15.49, billId: "bill1" }),
          row({ date: "2026-07-15", amount: -15.49, billId: "bill1" }),
        ],
        TODAY,
      ),
    ).toEqual([]);
    expect(
      detectRecurringCosts(
        [
          row({ date: "2026-05-15", amount: -500, transferGroupId: "grp", category: "transfer" }),
          row({ date: "2026-06-15", amount: -500, transferGroupId: "grp", category: "transfer" }),
          row({ date: "2026-07-15", amount: -500, transferGroupId: "grp", category: "transfer" }),
        ],
        TODAY,
      ),
    ).toEqual([]);
    // Money in and payee-less rows never form a pattern either.
    expect(
      detectRecurringCosts(
        [
          row({ date: "2026-05-15", amount: 15 }),
          row({ date: "2026-06-15", amount: 15 }),
          row({ date: "2026-07-15", amount: 15 }),
        ],
        TODAY,
      ),
    ).toEqual([]);
  });

  it("a same-day double charge counts once", () => {
    const suggestions = detectRecurringCosts(
      [
        row({ date: "2026-05-15", amount: -15.49 }),
        row({ date: "2026-06-15", amount: -15.49 }),
        row({ date: "2026-06-15", amount: -15.49 }),
        row({ date: "2026-07-15", amount: -15.49 }),
      ],
      TODAY,
    );
    expect(suggestions[0].count).toBe(3);
  });

  it("payee matching is case-insensitive; the display name is the latest", () => {
    const suggestions = detectRecurringCosts(
      [
        row({ payee: "NETFLIX.COM", date: "2026-05-15", amount: -15.49 }),
        row({ payee: "netflix.com", date: "2026-06-15", amount: -15.49 }),
        row({ payee: "Netflix.com", date: "2026-07-15", amount: -15.49 }),
      ],
      TODAY,
    );
    expect(suggestions[0].payeeKey).toBe("netflix.com");
    expect(suggestions[0].payee).toBe("Netflix.com");
  });

  it("stronger patterns sort first", () => {
    const suggestions = detectRecurringCosts(
      [
        row({ payee: "Gym", date: "2026-07-06", amount: -20 }),
        row({ payee: "Gym", date: "2026-07-13", amount: -20 }),
        row({ payee: "Gym", date: "2026-07-20", amount: -20 }),
        row({ payee: "Gym", date: "2026-07-27", amount: -20 }),
        row({ date: "2026-05-15", amount: -15.49 }),
        row({ date: "2026-06-15", amount: -15.49 }),
        row({ date: "2026-07-15", amount: -15.49 }),
      ],
      TODAY,
    );
    expect(suggestions.map((suggestion) => suggestion.payeeKey)).toEqual(["gym", "netflix"]);
  });
});
