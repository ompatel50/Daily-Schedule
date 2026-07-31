import { isDayKey, type DayKey } from "@/lib/date";
import {
  FINANCE_CATEGORIES,
  FINANCE_CATEGORY_META,
  isBookkeepingCategory,
  type FinanceCategory,
} from "@/lib/enums";
import { moneyRound } from "@/lib/logic/finance";
import { parseCsvRows } from "@/lib/logic/health-import/csv";

/**
 * Finance CSV import — pure. The server action feeds file text in; this module
 * turns it into validated candidate rows with per-row rejection reasons, and
 * computes the deterministic import identity that makes re-importing the same
 * file a no-op. No bank sync, no format guessing beyond what the header names
 * and an explicit day/month-order option can justify.
 *
 * ## The format
 *
 * Header row required. One row per transaction. Recognised columns (aliases in
 * COLUMN_ALIASES; order free; unknown columns are ignored and reported):
 *
 *   date        required   `YYYY-MM-DD`, or `MM/DD/YYYY` / `DD/MM/YYYY` with a
 *                          4-digit year — which order is auto-detected from the
 *                          file when possible and always shown (and overridable)
 *                          in the preview, because `03/04/2026` alone means two
 *                          dates.
 *   amount      required*  signed: positive in, negative out. `$1,234.56`,
 *                          `(45.00)` and `−45.00` all parse. *Alternatively the
 *                          file may carry `debit` / `credit` columns (positive
 *                          magnitudes, one per row), or `amount` plus a `type`
 *                          column (`debit|credit|…`) that fixes the direction.
 *   description optional   payee / merchant free text (`payee`, `merchant`…)
 *   category    optional   matched case-insensitively against the app's
 *                          category keys and labels; anything else lands in
 *                          `other`. Bookkeeping categories are refused —
 *                          imports record real money movement.
 *   notes       optional   free text
 *   currency    optional   ISO code; a row whose currency differs from the
 *                          target account's is rejected, not converted.
 *   account     optional   ignored (shown in the preview): an import targets
 *                          ONE account you pick — split multi-account files.
 *
 * ## Import identity (dedup)
 *
 * Every valid row gets `v1|<accountId>|<date>|<amount>|<payee>|<n>` where `n`
 * counts identical rows within the file. The `(userId, importKey)` unique
 * index turns a re-import of the same file — or an overlapping export window —
 * into skips instead of duplicates, while two genuinely identical purchases in
 * one file (n = 0, 1) both import. Category and notes stay out of the key on
 * purpose: recategorising a file must not duplicate its rows.
 */

/** Hard bounds — a personal ledger import, not an ETL pipeline. */
export const FINANCE_IMPORT_MAX_ROWS = 5000;
export const FINANCE_IMPORT_MAX_CHARS = 1_000_000;

export type CsvDateOrder = "iso" | "mdy" | "dmy";

export const CSV_DATE_ORDERS: Record<CsvDateOrder, { label: string }> = {
  iso: { label: "Year first (YYYY-MM-DD)" },
  mdy: { label: "Month first (MM/DD/YYYY)" },
  dmy: { label: "Day first (DD/MM/YYYY)" },
};

/** The columns the importer can map, in display order. */
export const FINANCE_CSV_FIELDS = [
  "date",
  "amount",
  "debit",
  "credit",
  "type",
  "payee",
  "category",
  "notes",
  "currency",
  "account",
] as const;
export type FinanceCsvField = (typeof FINANCE_CSV_FIELDS)[number];

const COLUMN_ALIASES: Record<string, FinanceCsvField> = {
  // date
  date: "date",
  "transaction date": "date",
  "posted date": "date",
  "posting date": "date",
  "date posted": "date",
  "trans date": "date",
  // signed amount
  amount: "amount",
  "transaction amount": "amount",
  value: "amount",
  // split debit / credit magnitudes
  debit: "debit",
  withdrawal: "debit",
  withdrawals: "debit",
  "money out": "debit",
  "paid out": "debit",
  outflow: "debit",
  credit: "credit",
  deposit: "credit",
  deposits: "credit",
  "money in": "credit",
  "paid in": "credit",
  inflow: "credit",
  // direction column
  type: "type",
  "transaction type": "type",
  direction: "type",
  "cr/dr": "type",
  "dr/cr": "type",
  // payee / description
  description: "payee",
  payee: "payee",
  merchant: "payee",
  name: "payee",
  narrative: "payee",
  details: "payee",
  // category
  category: "category",
  // notes
  notes: "notes",
  note: "notes",
  memo: "notes",
  // currency
  currency: "currency",
  "currency code": "currency",
  // account (informational only)
  account: "account",
  "account name": "account",
  "account number": "account",
};

/** `type` column values that mean money out / money in. Anything else rejects. */
const DEBIT_TYPES = new Set(["debit", "dr", "d", "expense", "withdrawal", "out", "payment", "purchase"]);
const CREDIT_TYPES = new Set(["credit", "cr", "c", "income", "deposit", "in", "refund"]);

const MAX_ROW_ERRORS = 12;

export interface FinanceCsvMapping {
  /** field → 0-based column index in the header row. */
  columns: Partial<Record<FinanceCsvField, number>>;
  /** field → the header cell it matched, for display. */
  headers: Partial<Record<FinanceCsvField, string>>;
  /** Header cells that matched nothing and will be ignored. */
  unmapped: string[];
}

/** Map the header row onto known fields. First match wins per field. */
export function detectFinanceCsvColumns(headerRow: string[]): FinanceCsvMapping {
  const columns: Partial<Record<FinanceCsvField, number>> = {};
  const headers: Partial<Record<FinanceCsvField, string>> = {};
  const unmapped: string[] = [];
  headerRow.forEach((cell, index) => {
    const field = COLUMN_ALIASES[cell.trim().toLowerCase()];
    if (field && columns[field] === undefined) {
      columns[field] = index;
      headers[field] = cell.trim();
    } else if (cell.trim() !== "") {
      unmapped.push(cell.trim());
    }
  });
  return { columns, headers, unmapped };
}

/**
 * `$1,234.56`, `(45.00)`, `−45.00`, `1 234,56`? No — decimal commas are out of
 * scope; thousands commas, currency symbols, parentheses-negative and unicode
 * minus are in. Null when it isn't a finite number.
 */
export function parseMoneyValue(raw: string): number | null {
  let text = raw.trim().replace(/−/g, "-"); // unicode minus
  if (text === "") return null;
  let negative = false;
  const parens = /^\((.*)\)$/.exec(text);
  if (parens) {
    negative = true;
    text = parens[1];
  }
  text = text.replace(/[$€£¥]|[A-Za-z]{3}/g, "").trim();
  if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1);
  } else if (text.startsWith("+")) {
    text = text.slice(1);
  }
  // Thousands separators: only well-formed groups, so "1,23" stays invalid.
  text = text.replace(/,(?=\d{3}(\D|$))/g, "");
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

/** A date cell under an explicit day/month order. Null when unparsable. */
export function parseCsvDate(raw: string, order: CsvDateOrder): DayKey | null {
  const text = raw.trim();
  // ISO (optionally with a time suffix) is unambiguous under every order.
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})([T ].*)?$/.exec(text);
  if (iso) {
    const key = `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
    return isDayKey(key) ? key : null;
  }
  if (order === "iso") return null;
  const parts = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text);
  if (!parts) return null;
  const [first, second] = [Number(parts[1]), Number(parts[2])];
  const [month, day] = order === "mdy" ? [first, second] : [second, first];
  const key = `${parts[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isDayKey(key) ? key : null;
}

/**
 * Which day/month orders the file's non-ISO dates are consistent with. A file
 * with a 13+ in one position rules the corresponding order out; a file of
 * all-ISO dates (or none) is consistent with everything and `iso` is enough.
 */
export function detectDateOrder(
  dateCells: string[],
): { order: CsvDateOrder; ambiguous: boolean } {
  let sawSlashDates = false;
  let mdyPossible = true;
  let dmyPossible = true;
  for (const raw of dateCells) {
    const text = raw.trim();
    if (/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})([T ].*)?$/.test(text)) continue;
    const parts = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text);
    if (!parts) continue; // unparsable rows report per-row, not here
    sawSlashDates = true;
    if (Number(parts[1]) > 12) mdyPossible = false;
    if (Number(parts[2]) > 12) dmyPossible = false;
  }
  if (!sawSlashDates) return { order: "iso", ambiguous: false };
  if (mdyPossible && !dmyPossible) return { order: "mdy", ambiguous: false };
  if (dmyPossible && !mdyPossible) return { order: "dmy", ambiguous: false };
  // Every date fits both readings — default to month-first, but say so.
  return { order: "mdy", ambiguous: mdyPossible && dmyPossible };
}

/** Case-insensitive category match against keys and labels; unknown → other. */
export function mapCsvCategory(raw: string): FinanceCategory {
  const text = raw.trim().toLowerCase();
  if (!text) return "other";
  for (const category of FINANCE_CATEGORIES) {
    if (isBookkeepingCategory(category)) continue;
    if (category === text || FINANCE_CATEGORY_META[category].label.toLowerCase() === text) {
      return category;
    }
  }
  return "other";
}

export interface FinanceImportRow {
  /** 1-based line number in the file, for error messages and preview. */
  line: number;
  date: DayKey;
  /** Signed, rounded to cents. */
  amount: number;
  payee: string | null;
  category: FinanceCategory;
  notes: string | null;
  /** The deterministic dedup identity — see the module docs. */
  importKey: string;
}

export interface FinanceCsvParseResult {
  /** File-level problems that stop the whole import. */
  errors: string[];
  mapping: FinanceCsvMapping;
  dateOrder: CsvDateOrder;
  /** True when non-ISO dates fit both month-first and day-first readings. */
  dateOrderAmbiguous: boolean;
  /** Data rows examined (header excluded). */
  examined: number;
  rows: FinanceImportRow[];
  invalid: Array<{ line: number; message: string }>;
  /** Capped copy of `invalid` for display. */
  invalidShown: Array<{ line: number; message: string }>;
}

function emptyResult(mapping: FinanceCsvMapping): FinanceCsvParseResult {
  return {
    errors: [],
    mapping,
    dateOrder: "iso",
    dateOrderAmbiguous: false,
    examined: 0,
    rows: [],
    invalid: [],
    invalidShown: [],
  };
}

/**
 * Parse a finance CSV against a target account. Never throws on bad input —
 * file-level problems land in `errors`, row-level ones in `invalid`. The
 * import identity needs the account id (the same row imported into two
 * accounts is two different transactions) and the account currency backs the
 * per-row currency check.
 */
export function parseFinanceCsv(
  text: string,
  options: {
    accountId: string;
    accountCurrency: string;
    /** Override the auto-detected day/month order (the preview offers this). */
    dateOrder?: CsvDateOrder;
  },
): FinanceCsvParseResult {
  const result = emptyResult({ columns: {}, headers: {}, unmapped: [] });

  if (text.length > FINANCE_IMPORT_MAX_CHARS) {
    result.errors.push(
      `The file is too large (over ${Math.round(FINANCE_IMPORT_MAX_CHARS / 1000)}k characters). Split it and import the parts.`,
    );
    return result;
  }

  const rows = parseCsvRows(text);
  if (rows.length === 0) {
    result.errors.push("The file is empty.");
    return result;
  }
  if (rows.length - 1 > FINANCE_IMPORT_MAX_ROWS) {
    result.errors.push(
      `The file has ${rows.length - 1} rows; the importer takes up to ${FINANCE_IMPORT_MAX_ROWS} at a time. Split it and import the parts.`,
    );
    return result;
  }

  const mapping = detectFinanceCsvColumns(rows[0]);
  result.mapping = mapping;
  const columns = mapping.columns;

  if (columns.date === undefined) {
    result.errors.push(
      "No date column found. The header row must name a date column (e.g. \"Date\" or \"Posted Date\").",
    );
  }
  if (
    columns.amount === undefined &&
    columns.debit === undefined &&
    columns.credit === undefined
  ) {
    result.errors.push(
      "No amount column found. The header row must name an \"Amount\" column, or \"Debit\"/\"Credit\" columns.",
    );
  }
  if (result.errors.length > 0) return result;

  const cell = (cells: string[], field: FinanceCsvField): string => {
    const index = columns[field];
    return index === undefined ? "" : (cells[index] ?? "").trim();
  };

  const detected = detectDateOrder(rows.slice(1).map((cells) => cell(cells, "date")));
  const dateOrder = options.dateOrder ?? detected.order;
  result.dateOrder = dateOrder;
  result.dateOrderAmbiguous = detected.ambiguous;

  const rowError = (line: number, message: string): void => {
    result.invalid.push({ line, message });
  };

  // Occurrence counter per identity, so two identical rows in one file both
  // import while a re-imported file collides row for row.
  const seen = new Map<string, number>();

  for (let index = 1; index < rows.length; index += 1) {
    const cells = rows[index];
    const line = index + 1;
    result.examined += 1;

    const dateRaw = cell(cells, "date");
    const date = dateRaw ? parseCsvDate(dateRaw, dateOrder) : null;
    if (!date) {
      rowError(
        line,
        dateRaw
          ? `date "${dateRaw}" could not be read${dateOrder === "iso" ? " — expected YYYY-MM-DD" : ""}.`
          : "date is empty.",
      );
      continue;
    }

    // --- amount: signed column, debit/credit split, or amount + type --------
    let amount: number | null = null;
    const amountRaw = cell(cells, "amount");
    const debitRaw = cell(cells, "debit");
    const creditRaw = cell(cells, "credit");

    if (columns.amount !== undefined && amountRaw !== "") {
      amount = parseMoneyValue(amountRaw);
      if (amount === null) {
        rowError(line, `amount "${amountRaw}" is not a number.`);
        continue;
      }
      const typeRaw = cell(cells, "type").toLowerCase();
      if (typeRaw) {
        if (DEBIT_TYPES.has(typeRaw)) amount = -Math.abs(amount);
        else if (CREDIT_TYPES.has(typeRaw)) amount = Math.abs(amount);
        else {
          rowError(line, `type "${cell(cells, "type")}" is not a recognised debit/credit marker.`);
          continue;
        }
      }
    } else if (debitRaw !== "" || creditRaw !== "") {
      const debit = debitRaw === "" ? 0 : parseMoneyValue(debitRaw);
      const credit = creditRaw === "" ? 0 : parseMoneyValue(creditRaw);
      if (debit === null || credit === null) {
        rowError(line, `debit/credit value could not be read.`);
        continue;
      }
      if (debit !== 0 && credit !== 0) {
        rowError(line, "both debit and credit are set — one per row.");
        continue;
      }
      // These columns carry positive magnitudes by contract; a negative here
      // (some exports encode reversals that way) is ambiguous — flipping the
      // sign silently would turn a reversed credit into invented income.
      if (debit < 0 || credit < 0) {
        rowError(
          line,
          `debit/credit values must be positive — "${debit < 0 ? debitRaw : creditRaw}" is ambiguous here; use a signed amount column instead.`,
        );
        continue;
      }
      amount = credit !== 0 ? credit : -debit;
    } else {
      rowError(line, "no amount on this row.");
      continue;
    }

    amount = moneyRound(amount);
    if (amount === 0) {
      rowError(line, "an amount of zero records nothing.");
      continue;
    }

    const currencyRaw = cell(cells, "currency").toUpperCase();
    if (currencyRaw && currencyRaw !== options.accountCurrency.toUpperCase()) {
      rowError(
        line,
        `currency "${currencyRaw}" does not match the account's ${options.accountCurrency} — rows are never converted.`,
      );
      continue;
    }

    const payee = cell(cells, "payee").slice(0, 200) || null;
    const notes = cell(cells, "notes").slice(0, 2000) || null;
    const category = mapCsvCategory(cell(cells, "category"));

    const identity = `${date}|${amount}|${(payee ?? "").toLowerCase()}`;
    const occurrence = seen.get(identity) ?? 0;
    seen.set(identity, occurrence + 1);

    result.rows.push({
      line,
      date,
      amount,
      payee,
      category,
      notes,
      importKey: `v1|${options.accountId}|${identity}|${occurrence}`,
    });
  }

  if (result.examined > 0 && result.rows.length === 0) {
    result.errors.push("No row in the file passed validation.");
  }
  result.invalidShown = result.invalid.slice(0, MAX_ROW_ERRORS);
  return result;
}
