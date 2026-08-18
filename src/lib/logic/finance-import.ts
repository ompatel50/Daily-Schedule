import { isDayKey, type DayKey } from "@/lib/date";
import {
  FINANCE_CATEGORIES,
  FINANCE_CATEGORY_META,
  type FinanceCategory,
} from "@/lib/enums";
import { centsToAmount, toCents } from "@/lib/logic/money";
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
 *                          column (`debit|credit|sale|payment|…`). When any
 *                          amount in the file carries an explicit sign the
 *                          signs ARE the directions, and the type column is
 *                          only a cross-check: a contradiction is flagged in
 *                          the preview, never rewritten. (A credit-card export
 *                          types its payments "Payment" while the signed
 *                          amount says money in — the sign is right, and the
 *                          old behaviour of letting the type force it negative
 *                          inverted every card payment.) Only when every
 *                          amount is an unsigned magnitude does the type
 *                          column decide the direction.
 *   description optional   payee / merchant free text (`payee`, `merchant`…)
 *   category    optional   matched case-insensitively against the app's
 *                          category keys and labels, then against the user's
 *                          own persisted mappings; anything else lands in
 *                          `other` and the preview offers to map it. A file
 *                          that explicitly says `transfer` or `adjustment` —
 *                          or a persisted mapping that targets them — imports
 *                          as that bookkeeping category, surfaced clearly in
 *                          the preview: such rows change the account balance
 *                          but stay out of income and spending.
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
  "post date": "date",
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

/**
 * `type` column values that decide the direction when the file's amounts are
 * unsigned magnitudes. When the amounts are signed, these only cross-check.
 */
const DEBIT_TYPES = new Set([
  "debit",
  "dr",
  "d",
  "expense",
  "withdrawal",
  "out",
  "payment",
  "purchase",
  "sale",
  "fee",
  "charge",
]);
const CREDIT_TYPES = new Set([
  "credit",
  "cr",
  "c",
  "income",
  "deposit",
  "in",
  "refund",
  "return",
  "reversal",
]);

/**
 * Values whose real direction depends on the account rather than the word: a
 * "payment" is money OUT of a bank account but money IN to a credit card, and
 * an "adjustment" can correct either way. Against a signed amount these never
 * contradict the sign. Against unsigned magnitudes, "payment" falls back to
 * the bank-file convention above (money out — the one direction unsigned bank
 * exports actually use it for) and "adjustment" is rejected, because its
 * direction is unknowable without a sign.
 */
const ACCOUNT_RELATIVE_TYPES = new Set(["payment", "adjustment"]);

/** The accepted `type` values, spelled from the sets so this never drifts. */
const TYPE_VALUES_HELP = `accepted values — money out: ${[...DEBIT_TYPES].join(", ")}; money in: ${[...CREDIT_TYPES].join(", ")}.`;

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

/**
 * Does this amount cell carry an explicit sign — a minus, a plus, or
 * accounting parentheses? Mirrors `parseMoneyValue`'s normalisation, because
 * the two must agree on what "signed" means. This is how the parser decides,
 * per file, whether amounts are signed values (the signs are the directions)
 * or unsigned magnitudes (a `type` column decides). The honest limit: a file
 * whose window happens to contain only money-in rows looks unsigned — no
 * heuristic can tell "all positive" from "all magnitudes".
 */
export function moneyHasExplicitSign(raw: string): boolean {
  let text = raw.trim().replace(/−/g, "-"); // unicode minus
  if (text === "") return false;
  if (/^\(.*\)$/.test(text)) return true;
  text = text.replace(/[$€£¥]|[A-Za-z]{3}/g, "").trim();
  return text.startsWith("-") || text.startsWith("+");
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

/**
 * Persisted per-user category mappings, keyed by the trimmed, lowercased cell
 * value. Written from the import preview's quick-map selectors; a mapping may
 * target any category — mapping a card issuer's "Payment" onto `transfer` is
 * the point — including `other`, which means "stop offering to map this".
 */
export type CsvCategoryRules = Readonly<Record<string, FinanceCategory>>;

export interface CsvCategoryResolution {
  category: FinanceCategory;
  /** The trimmed cell value when it matched nothing and fell back to `other`. */
  unmatched: string | null;
  /** True when a persisted user mapping decided the category. */
  viaRule: boolean;
}

/**
 * Case-insensitive category match against the app's keys and labels, then the
 * user's own persisted mappings; anything else falls back to `other` and is
 * reported as unmatched so the preview can offer to map it. Bookkeeping
 * categories (`transfer`, `adjustment`) resolve like any other when the file
 * names them explicitly — a card payment IS a transfer, and refusing to say so
 * was what let positive card payments masquerade as income. The preview
 * surfaces such rows; summaries exclude them by category.
 */
export function resolveCsvCategory(raw: string, rules?: CsvCategoryRules): CsvCategoryResolution {
  const text = raw.trim().toLowerCase();
  if (!text) return { category: "other", unmatched: null, viaRule: false };
  for (const category of FINANCE_CATEGORIES) {
    if (category === text || FINANCE_CATEGORY_META[category].label.toLowerCase() === text) {
      return { category, unmatched: null, viaRule: false };
    }
  }
  const rule = rules?.[text];
  if (rule && (FINANCE_CATEGORIES as readonly string[]).includes(rule)) {
    return { category: rule, unmatched: null, viaRule: true };
  }
  return { category: "other", unmatched: raw.trim(), viaRule: false };
}

/** `resolveCsvCategory` reduced to the category alone. */
export function mapCsvCategory(raw: string, rules?: CsvCategoryRules): FinanceCategory {
  return resolveCsvCategory(raw, rules).category;
}

export interface FinanceImportRow {
  /** 1-based line number in the file, for error messages and preview. */
  line: number;
  date: DayKey;
  /** Signed INTEGER CENTS — like every amount in the app. */
  amount: number;
  payee: string | null;
  category: FinanceCategory;
  notes: string | null;
  /** The deterministic dedup identity — see the module docs. */
  importKey: string;
  /**
   * Set when the row's `type` value contradicts its signed amount (the type
   * cell's own text, for display). The sign wins — this is a preview flag,
   * never a rewrite and never a rejection.
   */
  signConflict?: string;
  /** True when a persisted user category mapping decided this row's category. */
  categoryViaRule?: boolean;
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
  /**
   * True when the amount column's values carry explicit signs (so the signs
   * are the directions and any `type` column only cross-checks); false when
   * they are unsigned magnitudes (the `type` column decides). Meaningless —
   * and false — for files with split debit/credit columns or no amount column.
   */
  amountsSigned: boolean;
  rows: FinanceImportRow[];
  invalid: Array<{ line: number; message: string }>;
  /** Capped copy of `invalid` for display. */
  invalidShown: Array<{ line: number; message: string }>;
  /**
   * Distinct category cell values that matched nothing — no key, no label, no
   * persisted mapping — and fell back to `other`, in file order with row
   * counts. The preview offers a quick-map selector for each.
   */
  unmappedCategories: Array<{ value: string; count: number }>;
  /** Persisted mappings that decided at least one row, with row counts. */
  appliedRules: Array<{ value: string; category: FinanceCategory; count: number }>;
}

function emptyResult(mapping: FinanceCsvMapping): FinanceCsvParseResult {
  return {
    errors: [],
    mapping,
    dateOrder: "iso",
    dateOrderAmbiguous: false,
    examined: 0,
    amountsSigned: false,
    rows: [],
    invalid: [],
    invalidShown: [],
    unmappedCategories: [],
    appliedRules: [],
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
    /** The user's persisted category mappings — see `CsvCategoryRules`. */
    categoryRules?: CsvCategoryRules;
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

  // Signed amounts or unsigned magnitudes? Decided once, over the whole file:
  // one explicit sign anywhere means this export writes signed values, and a
  // row-by-row guess would let "42.50, Payment" flip while "-42.50, Sale"
  // held — the exact inconsistency this decision exists to prevent.
  result.amountsSigned =
    columns.amount !== undefined &&
    rows.slice(1).some((cells) => moneyHasExplicitSign(cell(cells, "amount")));

  const rowError = (line: number, message: string): void => {
    result.invalid.push({ line, message });
  };

  // Distinct-value accumulators for the preview, keyed case-insensitively;
  // the first-seen original casing is what gets displayed.
  const unmapped = new Map<string, { value: string; count: number }>();
  const ruleHits = new Map<string, { value: string; category: FinanceCategory; count: number }>();

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
    let signConflict: string | undefined;
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
      if (typeRaw && result.amountsSigned) {
        // The file writes signed amounts, so the sign is the direction and the
        // type column only cross-checks. A contradiction is flagged for the
        // preview, never rewritten: rewriting is exactly what turned every
        // credit-card payment (type "Payment", signed money-in) into money
        // out. Account-relative values and unknown values have no fixed
        // direction to contradict.
        if (!ACCOUNT_RELATIVE_TYPES.has(typeRaw)) {
          if (
            (DEBIT_TYPES.has(typeRaw) && amount > 0) ||
            (CREDIT_TYPES.has(typeRaw) && amount < 0)
          ) {
            signConflict = cell(cells, "type");
          }
        }
      } else if (typeRaw) {
        // Unsigned magnitudes: the type column is the only direction there is.
        if (DEBIT_TYPES.has(typeRaw)) amount = -Math.abs(amount);
        else if (CREDIT_TYPES.has(typeRaw)) amount = Math.abs(amount);
        else if (typeRaw === "adjustment") {
          rowError(
            line,
            `type "${cell(cells, "type")}" does not say which way the money moved — with unsigned amounts an adjustment's direction is unknowable. Use a signed amount column.`,
          );
          continue;
        } else {
          rowError(
            line,
            `type "${cell(cells, "type")}" is not a recognised debit/credit marker; ${TYPE_VALUES_HELP}`,
          );
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

    // The single dollars→cents conversion point: the CSV text carries dollar
    // values; everything downstream of this line is integer cents.
    amount = toCents(amount);
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
    const resolved = resolveCsvCategory(cell(cells, "category"), options.categoryRules);
    if (resolved.unmatched !== null) {
      const key = resolved.unmatched.toLowerCase();
      const entry = unmapped.get(key) ?? { value: resolved.unmatched, count: 0 };
      entry.count += 1;
      unmapped.set(key, entry);
    }
    if (resolved.viaRule) {
      const key = cell(cells, "category").trim().toLowerCase();
      const entry = ruleHits.get(key) ?? {
        value: cell(cells, "category").trim(),
        category: resolved.category,
        count: 0,
      };
      entry.count += 1;
      ruleHits.set(key, entry);
    }

    const identity = `${date}|${amount}|${(payee ?? "").toLowerCase()}`;
    const occurrence = seen.get(identity) ?? 0;
    seen.set(identity, occurrence + 1);

    result.rows.push({
      line,
      date,
      amount,
      payee,
      category: resolved.category,
      notes,
      importKey: buildImportKey({ accountId: options.accountId, date, amount, payee }, occurrence),
      ...(signConflict !== undefined ? { signConflict } : {}),
      ...(resolved.viaRule ? { categoryViaRule: true } : {}),
    });
  }

  if (result.examined > 0 && result.rows.length === 0) {
    result.errors.push("No row in the file passed validation.");
  }
  result.invalidShown = result.invalid.slice(0, MAX_ROW_ERRORS);
  result.unmappedCategories = [...unmapped.values()];
  result.appliedRules = [...ruleHits.values()];
  return result;
}

// --- import identity & undo --------------------------------------------------

/** The row fields the import identity is built from. `amount` is integer cents. */
export interface ImportIdentityFields {
  accountId: string;
  date: DayKey;
  /** Signed integer cents. */
  amount: number;
  payee: string | null;
}

/**
 * The one place the dedup key is spelled. `occurrence` distinguishes rows that
 * are identical within a single file (n = 0, 1, …).
 *
 * The amount segment keeps the HISTORICAL dollar spelling ("-4.5", "2500") —
 * every stored key was written that way, and changing the spelling would stop
 * every existing ledger from deduplicating its own re-imports. `centsToAmount`
 * of an integer produces exactly the number `moneyRound` used to produce.
 */
export function buildImportKey(fields: ImportIdentityFields, occurrence: number): string {
  return `v1|${fields.accountId}|${fields.date}|${centsToAmount(fields.amount)}|${(fields.payee ?? "").toLowerCase()}|${occurrence}`;
}

/**
 * Does this ledger row still say exactly what the import wrote?
 *
 * The check rebuilds the key from the row's CURRENT account, date, amount and
 * payee (reusing the occurrence the stored key ends with) and compares. So:
 *
 *   · re-categorising or annotating an imported row leaves it matching —
 *     category and notes are deliberately outside the identity, exactly as
 *     they are for duplicate detection;
 *   · changing its date, amount, payee or account makes it stop matching,
 *     because the row no longer describes the transaction the file did.
 *
 * A row with no key, or one whose key is not in the current format, is treated
 * as not matching — undo keeps what it cannot positively identify.
 */
export function importedRowIsUnchanged(
  row: ImportIdentityFields & { importKey: string | null },
): boolean {
  if (!row.importKey) return false;
  const occurrence = /\|(\d+)$/.exec(row.importKey)?.[1];
  if (occurrence === undefined) return false;
  return buildImportKey(row, Number(occurrence)) === row.importKey;
}

/**
 * What an undo does with one row the batch created.
 *
 *   remove       — untouched since the import; the undo deletes it
 *   keep_edited  — edited since (date/amount/payee/account changed); kept,
 *                  because deleting it would throw away the user's own work
 *   keep_linked  — since given a meaning beyond the import (it settles a bill,
 *                  or it is one leg of a transfer); kept, because removing it
 *                  would corrupt the record it is now part of
 */
export type ImportUndoDecision = "remove" | "keep_edited" | "keep_linked";

export interface ImportUndoCandidate extends ImportIdentityFields {
  id: string;
  importKey: string | null;
  billId: string | null;
  transferGroupId: string | null;
}

export function classifyImportUndoRow(row: ImportUndoCandidate): ImportUndoDecision {
  if (row.billId !== null || row.transferGroupId !== null) return "keep_linked";
  return importedRowIsUnchanged(row) ? "remove" : "keep_edited";
}

export interface ImportUndoPlan {
  /** Ids the undo will delete. */
  removeIds: string[];
  removeCount: number;
  keptEdited: number;
  keptLinked: number;
  get keptCount(): number;
}

/** Split a batch's rows into "undo removes this" and "undo keeps this". */
export function planImportUndo(rows: ImportUndoCandidate[]): ImportUndoPlan {
  const removeIds: string[] = [];
  let keptEdited = 0;
  let keptLinked = 0;
  for (const row of rows) {
    const decision = classifyImportUndoRow(row);
    if (decision === "remove") removeIds.push(row.id);
    else if (decision === "keep_edited") keptEdited += 1;
    else keptLinked += 1;
  }
  return {
    removeIds,
    removeCount: removeIds.length,
    keptEdited,
    keptLinked,
    get keptCount() {
      return this.keptEdited + this.keptLinked;
    },
  };
}
