"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser, prisma } from "@/lib/db";
import { FINANCE_CATEGORIES, isBookkeepingCategory, type FinanceCategory } from "@/lib/enums";
import {
  parseFinanceCsv,
  planImportUndo,
  type CsvCategoryRules,
  type CsvDateOrder,
  type FinanceCsvMapping,
  type FinanceImportRow,
} from "@/lib/logic/finance-import";
import {
  fail,
  financeCategoryRuleSchema,
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

/**
 * The user's persisted category mappings, in the shape the parser takes.
 * A stored category no longer in FINANCE_CATEGORIES (it cannot happen through
 * the validated action, but a database is forever) is skipped, not applied.
 */
async function loadCategoryRules(userId: string): Promise<CsvCategoryRules> {
  const rows = await prisma.financeCategoryRule.findMany({
    where: { userId },
    select: { value: true, category: true },
  });
  const rules: Record<string, FinanceCategory> = {};
  for (const row of rows) {
    if ((FINANCE_CATEGORIES as readonly string[]).includes(row.category)) {
      rules[row.value] = row.category as FinanceCategory;
    }
  }
  return rules;
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
    categoryRules: await loadCategoryRules(userId),
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
  /** True for transfer/adjustment rows — they change balances, not income/spending. */
  bookkeeping: boolean;
  /** The type cell's text when it contradicts the signed amount (the sign wins). */
  signConflict: string | null;
}

export interface FinanceImportPreview {
  accountName: string;
  accountCurrency: string;
  mapping: FinanceCsvMapping;
  dateOrder: CsvDateOrder;
  dateOrderAmbiguous: boolean;
  /** True when the file's amounts carry signs (type column cross-checks only). */
  amountsSigned: boolean;
  rowCount: number;
  newCount: number;
  duplicateCount: number;
  invalidCount: number;
  /** The first rows, annotated — enough to sanity-check the column mapping. */
  sample: ImportPreviewRow[];
  invalidShown: Array<{ line: number; message: string }>;
  /** Rows (among those to be imported) mapped to transfer/adjustment … */
  bookkeepingCount: number;
  /** … and the first few of them, so the scope is visible beyond the sample. */
  bookkeepingShown: Array<{
    line: number;
    date: string;
    amount: number;
    payee: string | null;
    category: string;
  }>;
  /** Rows whose type column contradicts their signed amount (flag, not rewrite) … */
  signConflictCount: number;
  /** … and the first few, with what disagreed. */
  signConflictShown: Array<{ line: number; type: string; amount: number }>;
  /** Category values that matched nothing and fell back to "other". */
  unmappedCategories: Array<{ value: string; count: number }>;
  /** The user's persisted mappings that decided rows in this file. */
  appliedRules: Array<{ value: string; category: string; count: number }>;
}

const PREVIEW_SAMPLE_SIZE = 8;
const PREVIEW_DETAIL_SIZE = 6;

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
  // Bookkeeping and sign-conflict visibility covers what will actually be
  // written — duplicate rows are skipped at commit, so they are not counted.
  const bookkeepingRows = newRows.filter((row) => isBookkeepingCategory(row.category));
  const signConflictRows = newRows.filter((row) => row.signConflict !== undefined);
  return succeed({
    accountName,
    accountCurrency,
    mapping: parse.mapping,
    dateOrder: parse.dateOrder,
    dateOrderAmbiguous: parse.dateOrderAmbiguous,
    amountsSigned: parse.amountsSigned,
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
      bookkeeping: isBookkeepingCategory(row.category),
      signConflict: row.signConflict ?? null,
    })),
    invalidShown: parse.invalidShown,
    bookkeepingCount: bookkeepingRows.length,
    bookkeepingShown: bookkeepingRows.slice(0, PREVIEW_DETAIL_SIZE).map((row) => ({
      line: row.line,
      date: row.date,
      amount: row.amount,
      payee: row.payee,
      category: row.category,
    })),
    signConflictCount: signConflictRows.length,
    signConflictShown: signConflictRows.slice(0, PREVIEW_DETAIL_SIZE).map((row) => ({
      line: row.line,
      type: row.signConflict ?? "",
      amount: row.amount,
    })),
    unmappedCategories: parse.unmappedCategories,
    appliedRules: parse.appliedRules,
  });
}

// --- persisted category mappings --------------------------------------------

/**
 * Save (or change) one category mapping. Upsert on `(userId, value)` — the
 * preview's quick-map selector calls this, then re-previews, so what the user
 * sees is always the parse the persisted rules produce. No revalidate: the
 * rules surface only inside the import dialog's own preview round-trip.
 */
export async function saveFinanceCategoryRule(
  input: unknown,
): Promise<ActionResult<{ value: string; category: string }>> {
  const parsed = financeCategoryRuleSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const user = await getCurrentUser();

  const value = parsed.data.value.toLowerCase();
  const rule = await prisma.financeCategoryRule.upsert({
    where: { userId_value: { userId: user.id, value } },
    create: { userId: user.id, value, category: parsed.data.category },
    update: { category: parsed.data.category },
  });
  return succeed({ value: rule.value, category: rule.category });
}

/** Remove one mapping — its value goes back to "other" (and to being offered). */
export async function deleteFinanceCategoryRule(
  input: unknown,
): Promise<ActionResult<{ removed: boolean }>> {
  if (typeof input !== "string" || input.trim() === "" || input.length > 120) {
    return fail("Nothing to remove");
  }
  const user = await getCurrentUser();
  const result = await prisma.financeCategoryRule.deleteMany({
    where: { userId: user.id, value: input.trim().toLowerCase() },
  });
  return succeed({ removed: result.count > 0 });
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

// --- undo --------------------------------------------------------------------

/**
 * Undo removes exactly the ledger rows THIS batch created and still owns.
 *
 * "Still owns" is decided per row by `classifyImportUndoRow`: a row whose
 * account, date, amount or payee has been edited since the import, and a row
 * that has since been linked to a bill payment or a transfer, are KEPT — the
 * undo would otherwise throw away work the user did after importing. Changing
 * a row's category or notes is not an edit for this purpose (those fields are
 * outside the import identity, exactly as they are for duplicate detection).
 *
 * The batch row itself is never deleted: it stays as the audit record, stamped
 * `undoneAt` with what was removed and what was kept. That stamp is also what
 * makes a second undo a no-op instead of a way to reach rows a later import
 * created.
 *
 * Undoing restores importability: the removed rows take their `importKey` with
 * them, so re-importing the same file creates them again rather than skipping
 * them as duplicates. Kept rows keep their keys, so they are never duplicated.
 */
export interface ImportUndoPreview {
  batchId: string;
  fileName: string;
  accountName: string | null;
  importedAt: string;
  createdCount: number;
  /** Rows still linked to the batch right now. */
  remainingCount: number;
  /** Of those, how many the undo would delete … */
  removableCount: number;
  /** … and how many it would keep, split by why. */
  keptEditedCount: number;
  keptLinkedCount: number;
  undoneAt: string | null;
  /** A few of the rows that would be removed, to sanity-check the scope. */
  sample: Array<{ id: string; date: string; amount: number; payee: string | null }>;
}

const UNDO_SAMPLE_SIZE = 6;
/** A single import is capped at 5 000 rows, so this can never truncate one. */
const UNDO_ROW_CAP = 5000;

async function loadUndoCandidates(userId: string, batchId: string) {
  return prisma.financeTransaction.findMany({
    where: { userId, importBatchId: batchId },
    select: {
      id: true,
      accountId: true,
      date: true,
      amount: true,
      payee: true,
      importKey: true,
      billId: true,
      transferGroupId: true,
    },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
    take: UNDO_ROW_CAP,
  });
}

/** What an undo would do — reads only, writes nothing. */
export async function previewFinanceImportUndo(
  batchId: string,
): Promise<ActionResult<ImportUndoPreview>> {
  const user = await getCurrentUser();
  const batch = await prisma.financeImportBatch.findFirst({
    where: { id: batchId, userId: user.id },
    include: { account: { select: { name: true } } },
  });
  if (!batch) return fail("Import not found");

  const rows = await loadUndoCandidates(user.id, batch.id);
  const plan = planImportUndo(rows);
  const removable = new Set(plan.removeIds);

  return succeed({
    batchId: batch.id,
    fileName: batch.fileName,
    accountName: batch.account?.name ?? null,
    importedAt: batch.createdAt.toISOString(),
    createdCount: batch.createdCount,
    remainingCount: rows.length,
    removableCount: plan.removeCount,
    keptEditedCount: plan.keptEdited,
    keptLinkedCount: plan.keptLinked,
    undoneAt: batch.undoneAt?.toISOString() ?? null,
    sample: rows
      .filter((row) => removable.has(row.id))
      .slice(0, UNDO_SAMPLE_SIZE)
      .map((row) => ({ id: row.id, date: row.date, amount: row.amount, payee: row.payee })),
  });
}

export interface ImportUndoReport {
  batchId: string;
  removedCount: number;
  keptEditedCount: number;
  keptLinkedCount: number;
}

/**
 * Roll the batch back. One transaction: re-read the rows under the user's own
 * id, delete only the ids the plan approved (bounded by `importBatchId` AND
 * `userId`, so no other account's rows are reachable even with a guessed batch
 * id), then stamp the batch.
 */
export async function undoFinanceImport(batchId: string): Promise<ActionResult<ImportUndoReport>> {
  const user = await getCurrentUser();
  const batch = await prisma.financeImportBatch.findFirst({
    where: { id: batchId, userId: user.id },
  });
  if (!batch) return fail("Import not found");
  if (batch.undoneAt) return fail("This import has already been undone");

  const report = await prisma.$transaction(async (db) => {
    // Re-read inside the transaction: the preview the user saw may be seconds
    // stale, and the delete must be planned from what is true now.
    const rows = await db.financeTransaction.findMany({
      where: { userId: user.id, importBatchId: batch.id },
      select: {
        id: true,
        accountId: true,
        date: true,
        amount: true,
        payee: true,
        importKey: true,
        billId: true,
        transferGroupId: true,
      },
      take: UNDO_ROW_CAP,
    });
    const plan = planImportUndo(rows);

    let removed = 0;
    for (let index = 0; index < plan.removeIds.length; index += KEY_LOOKUP_CHUNK) {
      const chunk = plan.removeIds.slice(index, index + KEY_LOOKUP_CHUNK);
      const result = await db.financeTransaction.deleteMany({
        where: { id: { in: chunk }, userId: user.id, importBatchId: batch.id },
      });
      removed += result.count;
    }

    await db.financeImportBatch.update({
      where: { id: batch.id },
      data: { undoneAt: new Date(), undoneCount: removed, keptCount: plan.keptCount },
    });

    return {
      batchId: batch.id,
      removedCount: removed,
      keptEditedCount: plan.keptEdited,
      keptLinkedCount: plan.keptLinked,
    };
  });

  revalidateAll();
  return succeed(report);
}
