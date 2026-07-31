"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser, prisma } from "@/lib/db";
import {
  parseFinanceCsv,
  type CsvDateOrder,
  type FinanceCsvMapping,
  type FinanceImportRow,
} from "@/lib/logic/finance-import";
import {
  fail,
  financeCsvImportSchema,
  fromZod,
  succeed,
  type ActionResult,
} from "@/lib/validation";

/**
 * CSV transaction import — preview and commit share one parse path, so what
 * the preview showed is exactly what commits. Everything is scoped to the
 * signed-in user and the one account they picked; the commit is a single
 * transaction, so a mid-flight failure writes nothing.
 */

function revalidateAll() {
  revalidatePath("/", "layout");
}

/** Duplicate lookups run in slices so an IN() list can never grow unbounded. */
const KEY_LOOKUP_CHUNK = 500;

async function findExistingImportKeys(userId: string, keys: string[]): Promise<Set<string>> {
  const existing = new Set<string>();
  for (let index = 0; index < keys.length; index += KEY_LOOKUP_CHUNK) {
    const slice = keys.slice(index, index + KEY_LOOKUP_CHUNK);
    const rows = await prisma.financeTransaction.findMany({
      where: { userId, importKey: { in: slice } },
      select: { importKey: true },
    });
    for (const row of rows) if (row.importKey) existing.add(row.importKey);
  }
  return existing;
}

interface ParsedImport {
  accountName: string;
  accountCurrency: string;
  parse: ReturnType<typeof parseFinanceCsv>;
  newRows: FinanceImportRow[];
  duplicateCount: number;
}

/** Shared by preview and commit: verify the account, parse, split new/known. */
async function parseForUser(
  userId: string,
  input: { accountId: string; content: string; dateOrder?: CsvDateOrder },
): Promise<{ ok: true; value: ParsedImport } | { ok: false; error: string }> {
  const account = await prisma.financeAccount.findFirst({
    where: { id: input.accountId, userId },
  });
  if (!account) return { ok: false, error: "Account not found" };
  if (account.archivedAt) return { ok: false, error: "Restore the archived account first" };

  const parse = parseFinanceCsv(input.content, {
    accountId: account.id,
    accountCurrency: account.currency,
    dateOrder: input.dateOrder,
  });
  if (parse.errors.length > 0) return { ok: false, error: parse.errors[0] };

  const existing = await findExistingImportKeys(
    userId,
    parse.rows.map((row) => row.importKey),
  );
  const newRows = parse.rows.filter((row) => !existing.has(row.importKey));

  return {
    ok: true,
    value: {
      accountName: account.name,
      accountCurrency: account.currency,
      parse,
      newRows,
      duplicateCount: parse.rows.length - newRows.length,
    },
  };
}

export interface ImportPreviewRow {
  line: number;
  date: string;
  amount: number;
  payee: string | null;
  category: string;
  /** `new` imports; `duplicate` is already in the ledger and will be skipped. */
  status: "new" | "duplicate";
}

export interface FinanceImportPreview {
  accountName: string;
  accountCurrency: string;
  mapping: FinanceCsvMapping;
  dateOrder: CsvDateOrder;
  dateOrderAmbiguous: boolean;
  rowCount: number;
  newCount: number;
  duplicateCount: number;
  invalidCount: number;
  /** The first rows, annotated — enough to sanity-check the column mapping. */
  sample: ImportPreviewRow[];
  invalidShown: Array<{ line: number; message: string }>;
}

const PREVIEW_SAMPLE_SIZE = 8;

/** Parse and report — writes nothing, whatever the file contains. */
export async function previewFinanceCsvImport(
  input: unknown,
): Promise<ActionResult<FinanceImportPreview>> {
  const parsed = financeCsvImportSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const user = await getCurrentUser();

  const result = await parseForUser(user.id, parsed.data);
  if (!result.ok) return fail(result.error);
  const { accountName, accountCurrency, parse, newRows, duplicateCount } = result.value;

  const newKeys = new Set(newRows.map((row) => row.importKey));
  return succeed({
    accountName,
    accountCurrency,
    mapping: parse.mapping,
    dateOrder: parse.dateOrder,
    dateOrderAmbiguous: parse.dateOrderAmbiguous,
    rowCount: parse.examined,
    newCount: newRows.length,
    duplicateCount,
    invalidCount: parse.invalid.length,
    sample: parse.rows.slice(0, PREVIEW_SAMPLE_SIZE).map((row) => ({
      line: row.line,
      date: row.date,
      amount: row.amount,
      payee: row.payee,
      category: row.category,
      status: newKeys.has(row.importKey) ? "new" : "duplicate",
    })),
    invalidShown: parse.invalidShown,
  });
}

export interface FinanceImportReport {
  batchId: string;
  accountName: string;
  createdCount: number;
  skippedCount: number;
  rejectedCount: number;
}

/**
 * The import itself: one transaction writes the batch record and every new
 * row. `skipDuplicates` backstops the preview's dedup — two tabs committing
 * the same file race down to one set of rows, and the loser's count says so.
 */
export async function commitFinanceCsvImport(
  input: unknown,
): Promise<ActionResult<FinanceImportReport>> {
  const parsed = financeCsvImportSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const user = await getCurrentUser();

  const result = await parseForUser(user.id, parsed.data);
  if (!result.ok) return fail(result.error);
  const { accountName, parse, newRows } = result.value;

  const report = await prisma.$transaction(async (db) => {
    const batch = await db.financeImportBatch.create({
      data: {
        userId: user.id,
        accountId: parsed.data.accountId,
        fileName: parsed.data.fileName,
        rowCount: parse.examined,
        createdCount: 0,
        skippedCount: 0,
        rejectedCount: parse.invalid.length,
      },
    });

    const created = newRows.length
      ? await db.financeTransaction.createMany({
          data: newRows.map((row) => ({
            userId: user.id,
            accountId: parsed.data.accountId,
            date: row.date,
            amount: row.amount,
            payee: row.payee,
            category: row.category,
            notes: row.notes,
            importKey: row.importKey,
            importBatchId: batch.id,
          })),
          skipDuplicates: true,
        })
      : { count: 0 };

    const createdCount = created.count;
    const skippedCount = parse.rows.length - createdCount;
    await db.financeImportBatch.update({
      where: { id: batch.id },
      data: { createdCount, skippedCount },
    });

    return {
      batchId: batch.id,
      accountName,
      createdCount,
      skippedCount,
      rejectedCount: parse.invalid.length,
    };
  });

  revalidateAll();
  return succeed(report);
}
