import { describe, expect, it } from "vitest";

import {
  detectDateOrder,
  detectFinanceCsvColumns,
  FINANCE_IMPORT_MAX_ROWS,
  mapCsvCategory,
  parseCsvDate,
  parseFinanceCsv,
  parseMoneyValue,
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

  it("never maps into bookkeeping categories — imports record real movement", () => {
    expect(mapCsvCategory("adjustment")).toBe("other");
    expect(mapCsvCategory("transfer")).toBe("other");
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
      amount: -42.5,
      payee: "Corner grocery",
      category: "groceries",
      notes: "weekly",
    });
    expect(result.rows[1]).toMatchObject({ amount: 2500, category: "income", notes: null });
  });

  it("reads debit/credit split files with positive magnitudes", () => {
    const result = parseFinanceCsv(
      csv(["date,withdrawal,deposit", "2026-07-01,42.50,", "2026-07-02,,100.00"]),
      OPTS,
    );
    expect(result.rows.map((row) => row.amount)).toEqual([-42.5, 100]);
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
    expect(result.rows.map((row) => row.amount)).toEqual([50]);
    expect(result.invalid).toHaveLength(2);
    expect(result.invalid[0].message).toContain("must be positive");
  });

  it("applies a type column's direction to the amount", () => {
    const result = parseFinanceCsv(
      csv([
        "date,amount,type",
        "2026-07-01,42.50,debit",
        "2026-07-02,100.00,credit",
        "2026-07-03,10.00,unknownness",
      ]),
      OPTS,
    );
    expect(result.rows.map((row) => row.amount)).toEqual([-42.5, 100]);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0].message).toContain("debit/credit marker");
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
