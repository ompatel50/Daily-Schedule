import { describe, expect, it } from "vitest";

import { summarizeTransactions } from "@/lib/logic/finance";
import {
  buildImportKey,
  classifyImportUndoRow,
  detectDateOrder,
  detectFinanceCsvColumns,
  FINANCE_IMPORT_MAX_ROWS,
  importedRowIsUnchanged,
  mapCsvCategory,
  moneyHasExplicitSign,
  parseCsvDate,
  parseFinanceCsv,
  parseMoneyValue,
  planImportUndo,
  resolveCsvCategory,
  type ImportUndoCandidate,
} from "@/lib/logic/finance-import";

const OPTS = { accountId: "acc1", accountCurrency: "USD" };

function csv(lines: string[]): string {
  return lines.join("\n");
}

describe("column detection", () => {
  it("maps common bank header names onto known fields", () => {
    const mapping = detectFinanceCsvColumns([
      "Posted Date",
      "Description",
      "Amount",
      "Category",
      "Memo",
    ]);
    expect(mapping.columns.date).toBe(0);
    expect(mapping.columns.payee).toBe(1);
    expect(mapping.columns.amount).toBe(2);
    expect(mapping.columns.category).toBe(3);
    expect(mapping.columns.notes).toBe(4);
    expect(mapping.unmapped).toEqual([]);
  });

  it("maps debit/credit split columns and reports unknown headers", () => {
    const mapping = detectFinanceCsvColumns(["Date", "Withdrawal", "Deposit", "Branch Code"]);
    expect(mapping.columns.debit).toBe(1);
    expect(mapping.columns.credit).toBe(2);
    expect(mapping.unmapped).toEqual(["Branch Code"]);
  });

  it("first match wins when a field appears twice", () => {
    const mapping = detectFinanceCsvColumns(["Date", "Transaction Date"]);
    expect(mapping.columns.date).toBe(0);
    expect(mapping.unmapped).toEqual(["Transaction Date"]);
  });
});

describe("money parsing", () => {
  it("reads plain, symbol, thousands and parenthesised values", () => {
    expect(parseMoneyValue("42.50")).toBe(42.5);
    expect(parseMoneyValue("-42.50")).toBe(-42.5);
    expect(parseMoneyValue("$1,234.56")).toBe(1234.56);
    expect(parseMoneyValue("(45.00)")).toBe(-45);
    expect(parseMoneyValue("−12.00")).toBe(-12); // unicode minus
    expect(parseMoneyValue("+7")).toBe(7);
    expect(parseMoneyValue("USD 99.10")).toBe(99.1);
  });

  it("refuses non-numbers instead of guessing", () => {
    expect(parseMoneyValue("")).toBeNull();
    expect(parseMoneyValue("abc")).toBeNull();
    expect(parseMoneyValue("1,23")).toBeNull(); // malformed thousands group
    expect(parseMoneyValue("12.34.56")).toBeNull();
  });
});

describe("date parsing", () => {
  it("reads ISO under every order", () => {
    expect(parseCsvDate("2026-07-04", "iso")).toBe("2026-07-04");
    expect(parseCsvDate("2026/7/4", "mdy")).toBe("2026-07-04");
    expect(parseCsvDate("2026-07-04T13:00:00", "dmy")).toBe("2026-07-04");
  });

  it("reads slash dates under the given day/month order", () => {
    expect(parseCsvDate("7/4/2026", "mdy")).toBe("2026-07-04");
    expect(parseCsvDate("7/4/2026", "dmy")).toBe("2026-04-07");
    expect(parseCsvDate("31/12/2026", "dmy")).toBe("2026-12-31");
  });

  it("refuses impossible dates and 2-digit years", () => {
    expect(parseCsvDate("13/13/2026", "mdy")).toBeNull();
    expect(parseCsvDate("31/12/26", "dmy")).toBeNull();
    expect(parseCsvDate("2026-02-30", "iso")).toBeNull();
    expect(parseCsvDate("7/4/2026", "iso")).toBeNull();
  });

  it("detects the order from unambiguous rows and flags ambiguity", () => {
    expect(detectDateOrder(["2026-07-04"])).toEqual({ order: "iso", ambiguous: false });
    expect(detectDateOrder(["7/13/2026"])).toEqual({ order: "mdy", ambiguous: false });
    expect(detectDateOrder(["13/7/2026"])).toEqual({ order: "dmy", ambiguous: false });
    expect(detectDateOrder(["7/4/2026", "1/2/2026"])).toEqual({ order: "mdy", ambiguous: true });
  });
});

describe("category mapping", () => {
  it("matches keys and labels case-insensitively, falls back to other", () => {
    expect(mapCsvCategory("groceries")).toBe("groceries");
    expect(mapCsvCategory("Dining")).toBe("dining");
    expect(mapCsvCategory("Debt payment")).toBe("debt");
    expect(mapCsvCategory("weird custom thing")).toBe("other");
    expect(mapCsvCategory("")).toBe("other");
  });

  it("maps explicit bookkeeping values — a file that says transfer means it", () => {
    // The old behaviour sent these to "other", where a positive card payment
    // counted as income. An explicit key or label is the file saying so.
    expect(mapCsvCategory("transfer")).toBe("transfer");
    expect(mapCsvCategory("Transfer")).toBe("transfer");
    expect(mapCsvCategory("adjustment")).toBe("adjustment");
    expect(mapCsvCategory("Balance adjustment")).toBe("adjustment");
  });

  it("applies persisted user rules after built-ins, case-insensitively", () => {
    const rules = { "food & drink": "dining", payment: "transfer" } as const;
    expect(mapCsvCategory("Food & Drink", rules)).toBe("dining");
    expect(mapCsvCategory("PAYMENT", rules)).toBe("transfer");
    expect(mapCsvCategory("unmapped thing", rules)).toBe("other");
  });

  it("a built-in match beats a rule, and an invalid rule target is ignored", () => {
    // A rule can only exist for values the built-ins missed, but a database
    // is forever — neither a stale rule shadowing a real category nor a
    // corrupted target may decide anything.
    expect(mapCsvCategory("groceries", { groceries: "dining" } as never)).toBe("groceries");
    expect(mapCsvCategory("weird", { weird: "not-a-category" } as never)).toBe("other");
  });

  it("resolveCsvCategory reports what fell through and what a rule decided", () => {
    expect(resolveCsvCategory("Food & Drink")).toEqual({
      category: "other",
      unmatched: "Food & Drink",
      viaRule: false,
    });
    expect(resolveCsvCategory("Food & Drink", { "food & drink": "dining" })).toEqual({
      category: "dining",
      unmatched: null,
      viaRule: true,
    });
    expect(resolveCsvCategory("Dining")).toEqual({
      category: "dining",
      unmatched: null,
      viaRule: false,
    });
    expect(resolveCsvCategory("")).toEqual({ category: "other", unmatched: null, viaRule: false });
    // A rule to "other" is "stop offering to map this" — applied, not unmatched.
    expect(resolveCsvCategory("Misc", { misc: "other" })).toEqual({
      category: "other",
      unmatched: null,
      viaRule: true,
    });
  });
});

describe("explicit sign detection", () => {
  it("sees minus, plus, parentheses and unicode minus through symbols", () => {
    expect(moneyHasExplicitSign("-42.50")).toBe(true);
    expect(moneyHasExplicitSign("+7")).toBe(true);
    expect(moneyHasExplicitSign("(45.00)")).toBe(true);
    expect(moneyHasExplicitSign("−12.00")).toBe(true);
    expect(moneyHasExplicitSign("$-1,234.56")).toBe(true);
    expect(moneyHasExplicitSign("USD -99.10")).toBe(true);
  });

  it("bare magnitudes carry no sign", () => {
    expect(moneyHasExplicitSign("42.50")).toBe(false);
    expect(moneyHasExplicitSign("$1,234.56")).toBe(false);
    expect(moneyHasExplicitSign("")).toBe(false);
    expect(moneyHasExplicitSign("abc")).toBe(false);
  });
});

describe("parseFinanceCsv", () => {
  it("parses a plain signed-amount file", () => {
    const result = parseFinanceCsv(
      csv([
        "date,amount,description,category,notes",
        "2026-07-01,-42.50,Corner grocery,groceries,weekly",
        "2026-07-02,2500,Payroll,income,",
      ]),
      OPTS,
    );
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      date: "2026-07-01",
      amount: -4250, // integer cents
      payee: "Corner grocery",
      category: "groceries",
      notes: "weekly",
    });
    expect(result.rows[1]).toMatchObject({ amount: 250000, category: "income", notes: null });
  });

  it("reads debit/credit split files with positive magnitudes", () => {
    const result = parseFinanceCsv(
      csv(["date,withdrawal,deposit", "2026-07-01,42.50,", "2026-07-02,,100.00"]),
      OPTS,
    );
    expect(result.rows.map((row) => row.amount)).toEqual([-4250, 10000]);
  });

  it("rejects NEGATIVE debit/credit magnitudes instead of sign-flipping them", () => {
    // A negative deposit (how some exports encode reversals) must never be
    // absorbed into positive income by Math.abs — that would invent money.
    const result = parseFinanceCsv(
      csv([
        "date,withdrawal,deposit",
        "2026-07-01,,-100.00",
        "2026-07-02,-42.50,",
        "2026-07-03,,50.00",
      ]),
      OPTS,
    );
    expect(result.rows.map((row) => row.amount)).toEqual([5000]);
    expect(result.invalid).toHaveLength(2);
    expect(result.invalid[0].message).toContain("must be positive");
  });

  it("applies a type column's direction to unsigned magnitudes", () => {
    const result = parseFinanceCsv(
      csv([
        "date,amount,type",
        "2026-07-01,42.50,debit",
        "2026-07-02,100.00,credit",
        "2026-07-03,10.00,unknownness",
      ]),
      OPTS,
    );
    expect(result.amountsSigned).toBe(false);
    expect(result.rows.map((row) => row.amount)).toEqual([-4250, 10000]);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0].message).toContain("debit/credit marker");
  });

  describe("signed amounts vs the type column", () => {
    it("trusts the sign — a typed payment stays money in on a credit card", () => {
      // The defining case: a card export types its payments "Payment" while
      // the signed amount says +300 (money in). Forcing the type's bank-file
      // direction turned every card payment into invented spending — and its
      // mirror image inflated income.
      const result = parseFinanceCsv(
        csv([
          "date,amount,type,description",
          "2026-07-01,-42.50,Sale,AMAZON MKTPL",
          "2026-07-03,300.00,Payment,Payment Thank You - Web",
        ]),
        OPTS,
      );
      expect(result.amountsSigned).toBe(true);
      expect(result.rows.map((row) => row.amount)).toEqual([-4250, 30000]);
      expect(result.rows.every((row) => row.signConflict === undefined)).toBe(true);
      expect(result.invalid).toEqual([]);
    });

    it("flags a genuine contradiction instead of rewriting or rejecting", () => {
      const result = parseFinanceCsv(
        csv([
          "date,amount,type",
          "2026-07-01,-42.50,Sale", // consistent
          "2026-07-02,10.00,Sale", // a Sale that claims money in — flagged
          "2026-07-03,-20.00,Refund", // a Refund that claims money out — flagged
        ]),
        OPTS,
      );
      expect(result.rows.map((row) => row.amount)).toEqual([-4250, 1000, -2000]);
      expect(result.rows.map((row) => row.signConflict)).toEqual([undefined, "Sale", "Refund"]);
      expect(result.invalid).toEqual([]);
    });

    it("never flags account-relative types — payment and adjustment go either way", () => {
      const result = parseFinanceCsv(
        csv([
          "date,amount,type",
          "2026-07-01,300.00,Payment", // money IN to a card — correct
          "2026-07-02,-300.00,Payment", // money OUT of a bank — also correct
          "2026-07-03,5.00,Adjustment",
          "2026-07-04,-5.00,Adjustment",
        ]),
        OPTS,
      );
      expect(result.rows).toHaveLength(4);
      expect(result.rows.every((row) => row.signConflict === undefined)).toBe(true);
    });

    it("accepts unknown type values when the sign already fixes the direction", () => {
      const result = parseFinanceCsv(
        csv(["date,amount,type", "2026-07-01,-42.50,Whatever", "2026-07-02,10.00,ACH_HOLD"]),
        OPTS,
      );
      expect(result.rows.map((row) => row.amount)).toEqual([-4250, 1000]);
      expect(result.invalid).toEqual([]);
    });
  });

  describe("card-issuer type values on unsigned magnitudes", () => {
    it("sale, fee and charge are money out; return and reversal money in", () => {
      const result = parseFinanceCsv(
        csv([
          "date,amount,type",
          "2026-07-01,42.50,Sale",
          "2026-07-02,95.00,Fee",
          "2026-07-03,12.00,Charge",
          "2026-07-04,15.00,Return",
          "2026-07-05,20.00,Reversal",
        ]),
        OPTS,
      );
      expect(result.amountsSigned).toBe(false);
      expect(result.rows.map((row) => row.amount)).toEqual([-4250, -9500, -1200, 1500, 2000]);
      expect(result.invalid).toEqual([]);
    });

    it("payment on unsigned magnitudes keeps the bank-file convention: money out", () => {
      const result = parseFinanceCsv(
        csv(["date,amount,type", "2026-07-01,120.00,Payment"]),
        OPTS,
      );
      expect(result.rows.map((row) => row.amount)).toEqual([-12000]);
    });

    it("rejects an unsigned adjustment — its direction is unknowable", () => {
      const result = parseFinanceCsv(
        csv(["date,amount,type", "2026-07-01,5.00,Adjustment"]),
        OPTS,
      );
      expect(result.rows).toHaveLength(0);
      expect(result.invalid[0].message).toContain("signed amount");
    });

    it("still rejects genuinely unknown values, naming the accepted ones", () => {
      const result = parseFinanceCsv(
        csv(["date,amount,type", "2026-07-01,5.00,Mystery"]),
        OPTS,
      );
      expect(result.rows).toHaveLength(0);
      expect(result.invalid[0].message).toContain('type "Mystery"');
      expect(result.invalid[0].message).toContain("sale");
      expect(result.invalid[0].message).toContain("reversal");
      expect(result.invalid[0].message).toContain("money out");
      expect(result.invalid[0].message).toContain("money in");
    });
  });

  it("rejects invalid rows individually with line numbers, keeping the rest", () => {
    const result = parseFinanceCsv(
      csv([
        "date,amount,description",
        "2026-07-01,-42.50,Fine",
        "not-a-date,-10,Bad date",
        "2026-07-03,zero?,Bad amount",
        "2026-07-04,0,Zero amount",
        "2026-07-05,-5.00,Also fine",
      ]),
      OPTS,
    );
    expect(result.rows).toHaveLength(2);
    expect(result.invalid.map((problem) => problem.line)).toEqual([3, 4, 5]);
  });

  it("rejects rows whose currency differs from the target account", () => {
    const result = parseFinanceCsv(
      csv(["date,amount,currency", "2026-07-01,-10,USD", "2026-07-02,-10,EUR"]),
      OPTS,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.invalid[0].message).toContain("never converted");
  });

  it("fails the whole file when required columns are missing", () => {
    expect(parseFinanceCsv(csv(["amount,description", "-1,x"]), OPTS).errors[0]).toContain(
      "date column",
    );
    expect(parseFinanceCsv(csv(["date,description", "2026-07-01,x"]), OPTS).errors[0]).toContain(
      "amount column",
    );
    expect(parseFinanceCsv("", OPTS).errors[0]).toContain("empty");
  });

  it("bounds the number of rows", () => {
    const lines = ["date,amount"];
    for (let index = 0; index <= FINANCE_IMPORT_MAX_ROWS; index += 1) {
      lines.push(`2026-07-01,-1`);
    }
    const result = parseFinanceCsv(csv(lines), OPTS);
    expect(result.errors[0]).toContain("Split it");
  });

  describe("import identity", () => {
    it("keys rows by account, date, amount, payee and occurrence", () => {
      const result = parseFinanceCsv(
        csv(["date,amount,description", "2026-07-01,-4.50,Coffee"]),
        OPTS,
      );
      expect(result.rows[0].importKey).toBe("v1|acc1|2026-07-01|-4.5|coffee|0");
    });

    it("two identical rows in one file get distinct occurrence numbers", () => {
      const result = parseFinanceCsv(
        csv([
          "date,amount,description",
          "2026-07-01,-4.50,Coffee",
          "2026-07-01,-4.50,Coffee",
        ]),
        OPTS,
      );
      expect(result.rows[0].importKey).toBe("v1|acc1|2026-07-01|-4.5|coffee|0");
      expect(result.rows[1].importKey).toBe("v1|acc1|2026-07-01|-4.5|coffee|1");
    });

    it("re-parsing the same file yields identical keys — the dedup identity", () => {
      const content = csv([
        "date,amount,description",
        "2026-07-01,-4.50,Coffee",
        "2026-07-01,-4.50,Coffee",
        "2026-07-02,100,Refund",
      ]);
      const first = parseFinanceCsv(content, OPTS);
      const second = parseFinanceCsv(content, OPTS);
      expect(second.rows.map((row) => row.importKey)).toEqual(
        first.rows.map((row) => row.importKey),
      );
    });

    it("category and notes stay OUT of the key — recategorising must not duplicate", () => {
      const before = parseFinanceCsv(
        csv(["date,amount,description,category", "2026-07-01,-4.50,Coffee,dining"]),
        OPTS,
      );
      const after = parseFinanceCsv(
        csv(["date,amount,description,category", "2026-07-01,-4.50,Coffee,groceries"]),
        OPTS,
      );
      expect(after.rows[0].importKey).toBe(before.rows[0].importKey);
    });

    it("the same row imported into a different account is a different transaction", () => {
      const content = csv(["date,amount,description", "2026-07-01,-4.50,Coffee"]);
      const one = parseFinanceCsv(content, OPTS);
      const two = parseFinanceCsv(content, { ...OPTS, accountId: "acc2" });
      expect(one.rows[0].importKey).not.toBe(two.rows[0].importKey);
    });
  });

  describe("a Chase-shaped card export", () => {
    // The real column set and Type vocabulary of a Chase credit-card CSV:
    // signed amounts, Sale/Payment/Fee/Adjustment/Return types, and both a
    // Transaction Date and a Post Date.
    const CHASE = csv([
      "Transaction Date,Post Date,Description,Category,Type,Amount,Memo",
      "07/01/2026,07/02/2026,AMAZON MKTPL*XY123,Shopping,Sale,-42.50,",
      "07/03/2026,07/03/2026,Payment Thank You-Mobile,,Payment,300.00,",
      "07/05/2026,07/06/2026,ANNUAL MEMBERSHIP FEE,Fees,Fee,-95.00,",
      "07/07/2026,07/08/2026,STATEMENT CREDIT,,Adjustment,5.00,",
      "07/09/2026,07/10/2026,AMAZON MKTPL REFUND,Shopping,Return,15.00,card credit",
    ]);

    it("imports every row with its sign intact — nothing rejected, nothing flipped", () => {
      const result = parseFinanceCsv(CHASE, OPTS);
      expect(result.errors).toEqual([]);
      expect(result.invalid).toEqual([]);
      expect(result.amountsSigned).toBe(true);
      expect(result.rows.map((row) => row.amount)).toEqual([-4250, 30000, -9500, 500, 1500]);
      expect(result.rows.every((row) => row.signConflict === undefined)).toBe(true);
      // The payment arrives as money IN — the inversion this fixture guards.
      expect(result.rows[1].amount).toBeGreaterThan(0);
    });

    it("maps the Chase columns: Transaction Date wins, Post Date is reported", () => {
      const result = parseFinanceCsv(CHASE, OPTS);
      expect(result.mapping.columns.date).toBe(0);
      expect(result.mapping.unmapped).toEqual(["Post Date"]);
      expect(result.mapping.columns.payee).toBe(2);
      expect(result.mapping.columns.category).toBe(3);
      expect(result.mapping.columns.type).toBe(4);
      expect(result.mapping.columns.amount).toBe(5);
      expect(result.mapping.columns.notes).toBe(6);
      expect(result.rows[0].date).toBe("2026-07-01");
      expect(result.rows[4].notes).toBe("card credit");
    });

    it("a file that is only a Post Date still has a date column", () => {
      const result = parseFinanceCsv(
        csv(["Post Date,Amount", "2026-07-01,-1.00"]),
        OPTS,
      );
      expect(result.errors).toEqual([]);
      expect(result.rows[0].date).toBe("2026-07-01");
    });
  });

  describe("the credit-card payment round trip", () => {
    // A statement with one purchase and the payment that settled it — the
    // Category cell says "Payment", as several issuers write it.
    const STATEMENT = csv([
      "Transaction Date,Post Date,Description,Category,Type,Amount,Memo",
      "07/01/2026,07/02/2026,GROCERY STORE,Groceries,Sale,-120.00,",
      "07/03/2026,07/03/2026,Payment Thank You-Mobile,Payment,Payment,300.00,",
    ]);

    it("without a mapping, the payment's category is offered for mapping", () => {
      const result = parseFinanceCsv(STATEMENT, OPTS);
      expect(result.rows[1]).toMatchObject({ amount: 30000, category: "other" });
      expect(result.unmappedCategories).toEqual([{ value: "Payment", count: 1 }]);
      expect(result.appliedRules).toEqual([]);
    });

    it("with the mapping, it lands money-in, category transfer, out of income", () => {
      const result = parseFinanceCsv(STATEMENT, {
        ...OPTS,
        categoryRules: { payment: "transfer" },
      });
      expect(result.invalid).toEqual([]);
      expect(result.unmappedCategories).toEqual([]);
      expect(result.appliedRules).toEqual([{ value: "Payment", category: "transfer", count: 1 }]);

      const payment = result.rows[1];
      expect(payment.amount).toBe(30000); // money in (cents) — the sign was trusted
      expect(payment.category).toBe("transfer"); // bookkeeping, by the rule
      expect(payment.categoryViaRule).toBe(true);

      // And the summary maths agree: the payment moves balances, not income.
      const summary = summarizeTransactions(
        result.rows.map((row) => ({ amount: row.amount, category: row.category })),
      );
      expect(summary.income).toBe(0);
      expect(summary.spending).toBe(12000);
      expect(summary.count).toBe(1);
    });
  });

  describe("unmapped category collection", () => {
    it("collects distinct values with counts; first-seen casing displays", () => {
      const result = parseFinanceCsv(
        csv([
          "date,amount,category",
          "2026-07-01,-1,Food & Drink",
          "2026-07-02,-2,FOOD & DRINK",
          "2026-07-03,-3,Bills & Utilities",
          "2026-07-04,-4,groceries", // built-in — not unmapped
          "2026-07-05,-5,", // empty — not a value to map
        ]),
        OPTS,
      );
      expect(result.unmappedCategories).toEqual([
        { value: "Food & Drink", count: 2 },
        { value: "Bills & Utilities", count: 1 },
      ]);
      expect(result.rows.map((row) => row.category)).toEqual([
        "other",
        "other",
        "other",
        "groceries",
        "other",
      ]);
    });

    it("a rule to other applies silently instead of re-offering the value", () => {
      const result = parseFinanceCsv(
        csv(["date,amount,category", "2026-07-01,-1,Misc"]),
        { ...OPTS, categoryRules: { misc: "other" } },
      );
      expect(result.unmappedCategories).toEqual([]);
      expect(result.appliedRules).toEqual([{ value: "Misc", category: "other", count: 1 }]);
    });

    it("explicit bookkeeping categories from the file survive the parse", () => {
      const result = parseFinanceCsv(
        csv([
          "date,amount,category,description",
          "2026-07-01,300.00,Transfer,Card payment",
          "2026-07-02,-12.34,Balance adjustment,Correction",
        ]),
        OPTS,
      );
      expect(result.rows.map((row) => row.category)).toEqual(["transfer", "adjustment"]);
      expect(result.unmappedCategories).toEqual([]);
    });
  });

  it("handles quoted fields with commas and escaped quotes", () => {
    const result = parseFinanceCsv(
      csv([
        "date,amount,description",
        '2026-07-01,-42.50,"Store, the one with ""quotes"""',
      ]),
      OPTS,
    );
    expect(result.rows[0].payee).toBe('Store, the one with "quotes"');
  });

  it("honours an explicit date-order override", () => {
    const content = csv(["date,amount", "3/4/2026,-1"]);
    expect(parseFinanceCsv(content, OPTS).rows[0].date).toBe("2026-03-04");
    expect(parseFinanceCsv(content, { ...OPTS, dateOrder: "dmy" }).rows[0].date).toBe(
      "2026-04-03",
    );
  });
});

// --- undo --------------------------------------------------------------------

describe("import undo classification", () => {
  /** A row exactly as the import wrote it. */
  function imported(partial: Partial<ImportUndoCandidate> = {}): ImportUndoCandidate {
    const base = {
      id: "t1",
      accountId: "acc1",
      date: "2026-07-15",
      amount: -4250, // integer cents
      payee: "Corner Market",
    };
    return {
      ...base,
      importKey: buildImportKey(base, 0),
      billId: null,
      transferGroupId: null,
      ...partial,
    };
  }

  it("the key the parser writes is the key the undo check rebuilds", () => {
    const [row] = parseFinanceCsv(
      csv(["date,amount,description", "2026-07-15,-42.50,Corner Market"]),
      OPTS,
    ).rows;
    expect(
      importedRowIsUnchanged({
        accountId: "acc1",
        date: row.date,
        amount: row.amount,
        payee: row.payee,
        importKey: row.importKey,
      }),
    ).toBe(true);
  });

  it("an untouched row is removed", () => {
    expect(classifyImportUndoRow(imported())).toBe("remove");
  });

  it("recategorising or annotating a row does NOT protect it", () => {
    // Category and notes are outside the import identity by design, so they
    // are outside the undo decision too.
    expect(classifyImportUndoRow(imported())).toBe("remove");
  });

  it("editing the amount, date, payee or account keeps the row", () => {
    expect(classifyImportUndoRow(imported({ amount: -4350 }))).toBe("keep_edited");
    expect(classifyImportUndoRow(imported({ date: "2026-07-16" }))).toBe("keep_edited");
    expect(classifyImportUndoRow(imported({ payee: "Corner Market #2" }))).toBe("keep_edited");
    expect(classifyImportUndoRow(imported({ accountId: "acc2" }))).toBe("keep_edited");
  });

  it("payee comparison is case-insensitive, exactly like the import identity", () => {
    expect(classifyImportUndoRow(imported({ payee: "CORNER MARKET" }))).toBe("remove");
  });

  it("a row that now settles a bill or belongs to a transfer is kept", () => {
    expect(classifyImportUndoRow(imported({ billId: "bill1" }))).toBe("keep_linked");
    expect(classifyImportUndoRow(imported({ transferGroupId: "grp1" }))).toBe("keep_linked");
  });

  it("a row with no key, or an unrecognised key, is kept — never guessed at", () => {
    expect(classifyImportUndoRow(imported({ importKey: null }))).toBe("keep_edited");
    expect(classifyImportUndoRow(imported({ importKey: "v2|whatever" }))).toBe("keep_edited");
    expect(classifyImportUndoRow(imported({ importKey: "v1|acc1|2026-07-15|-42.5|x" }))).toBe(
      "keep_edited",
    );
  });

  it("a payee containing pipes still round-trips", () => {
    const base = {
      id: "t9",
      accountId: "acc1",
      date: "2026-07-15",
      amount: -1200, // integer cents
      payee: "A|B|3",
    };
    const row = { ...base, importKey: buildImportKey(base, 2), billId: null, transferGroupId: null };
    expect(classifyImportUndoRow(row)).toBe("remove");
    expect(classifyImportUndoRow({ ...row, amount: -1300 })).toBe("keep_edited");
  });

  it("duplicate rows in one file undo independently by occurrence", () => {
    const base = { accountId: "acc1", date: "2026-07-15", amount: -900, payee: "Coffee" };
    const first = { ...base, id: "a", importKey: buildImportKey(base, 0), billId: null, transferGroupId: null };
    const second = { ...base, id: "b", importKey: buildImportKey(base, 1), billId: null, transferGroupId: null };
    const plan = planImportUndo([first, second]);
    expect(plan.removeIds).toEqual(["a", "b"]);
  });

  it("the plan counts what it removes and what it keeps, and why", () => {
    const plan = planImportUndo([
      imported({ id: "a" }),
      imported({ id: "b" }),
      imported({ id: "c", amount: -100 }),
      imported({ id: "d", billId: "bill1" }),
    ]);
    expect(plan.removeIds).toEqual(["a", "b"]);
    expect(plan.removeCount).toBe(2);
    expect(plan.keptEdited).toBe(1);
    expect(plan.keptLinked).toBe(1);
    expect(plan.keptCount).toBe(2);
  });

  it("an empty batch plans an empty, harmless undo", () => {
    const plan = planImportUndo([]);
    expect(plan.removeIds).toEqual([]);
    expect(plan.keptCount).toBe(0);
  });
});
