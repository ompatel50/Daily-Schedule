"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";

import { getCurrentUser, prisma } from "@/lib/db";
import { FINANCE_CATEGORY_META, type FinanceCategory } from "@/lib/enums";
import { advanceBillAfterPayment, moneyRound, transferLegs } from "@/lib/logic/finance";
import { todayIn } from "@/lib/logic/schedule";
import {
  billSchema,
  budgetSchema,
  fail,
  financeAccountSchema,
  financeTransactionSchema,
  fromZod,
  markBillPaidSchema,
  savingsContributionSchema,
  savingsGoalSchema,
  setAccountBalanceSchema,
  succeed,
  transferSchema,
  type ActionResult,
} from "@/lib/validation";

function revalidateAll() {
  revalidatePath("/", "layout");
}

// --- accounts ----------------------------------------------------------------

export async function saveFinanceAccount(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = financeAccountSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const user = await getCurrentUser();
  const { id, ...data } = parsed.data;
  const payload = {
    ...data,
    notes: data.notes ?? null,
    // Explicitly null when absent, so clearing the field in the dialog
    // actually turns the low-balance alert off on edit.
    lowBalanceThreshold:
      data.lowBalanceThreshold === undefined || data.lowBalanceThreshold === null
        ? null
        : moneyRound(data.lowBalanceThreshold),
  };

  if (id) {
    const existing = await prisma.financeAccount.findFirst({
      where: { id, userId: user.id },
    });
    if (!existing) return fail("Account not found");
    await prisma.financeAccount.update({ where: { id }, data: payload });
    revalidateAll();
    return succeed({ id });
  }

  const created = await prisma.financeAccount.create({
    data: {
      ...payload,
      userId: user.id,
      sortOrder: await prisma.financeAccount.count({ where: { userId: user.id } }),
    },
  });
  revalidateAll();
  return succeed({ id: created.id });
}

export async function setFinanceAccountArchived(
  id: string,
  archived: boolean,
): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  const result = await prisma.financeAccount.updateMany({
    where: { id, userId: user.id },
    data: { archivedAt: archived ? new Date() : null },
  });
  if (result.count === 0) return fail("Account not found");
  revalidateAll();
  return succeed(null);
}

/**
 * Deleting an account deletes its ledger with it (bills merely lose their
 * default account). The UI confirms; archiving is the reversible path.
 */
export async function deleteFinanceAccount(id: string): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  await prisma.financeAccount.deleteMany({ where: { id, userId: user.id } });
  revalidateAll();
  return succeed(null);
}

/**
 * "Set the balance to X" — records the difference as an adjustment
 * transaction, so the ledger stays the single source the balance derives from.
 */
export async function setAccountBalance(
  input: unknown,
): Promise<ActionResult<{ adjustment: number }>> {
  const parsed = setAccountBalanceSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const user = await getCurrentUser();
  const { accountId, balance, date } = parsed.data;

  const account = await prisma.financeAccount.findFirst({
    where: { id: accountId, userId: user.id },
  });
  if (!account) return fail("Account not found");

  const total = await prisma.financeTransaction.aggregate({
    where: { userId: user.id, accountId },
    _sum: { amount: true },
  });
  const current = moneyRound(account.openingBalance + (total._sum.amount ?? 0));
  const adjustment = moneyRound(balance - current);
  if (adjustment === 0) return succeed({ adjustment: 0 });

  await prisma.financeTransaction.create({
    data: {
      userId: user.id,
      accountId,
      date,
      amount: adjustment,
      category: "adjustment",
      payee: null,
      notes: "Balance set by hand",
    },
  });
  revalidateAll();
  return succeed({ adjustment });
}

// --- transactions ------------------------------------------------------------

export async function saveTransaction(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = financeTransactionSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const user = await getCurrentUser();
  const { id, accountId, billId, ...data } = parsed.data;

  // Transfer legs only ever come in pairs, written by transferBetweenAccounts.
  // A lone hand-made "transfer" row would move a balance while hiding from
  // every summary — refuse it here rather than surprise later.
  if (data.category === "transfer") {
    return fail("Use “Transfer” to move money between accounts");
  }

  // Client-supplied references must belong to the caller.
  const account = await prisma.financeAccount.findFirst({
    where: { id: accountId, userId: user.id },
  });
  if (!account) return fail("Account not found");
  if (billId) {
    const bill = await prisma.bill.findFirst({ where: { id: billId, userId: user.id } });
    if (!bill) return fail("Bill not found");
  }

  const payload = {
    ...data,
    accountId,
    billId: billId ?? null,
    amount: moneyRound(data.amount),
    payee: data.payee ?? null,
    notes: data.notes ?? null,
  };

  if (id) {
    const existing = await prisma.financeTransaction.findFirst({
      where: { id, userId: user.id },
    });
    if (!existing) return fail("Transaction not found");
    // Editing one leg would silently unbalance the pair; the safe edit is
    // delete-and-redo, which the UI offers.
    if (existing.transferGroupId) {
      return fail("This is one leg of a transfer — delete the transfer and record it again");
    }
    await prisma.financeTransaction.update({ where: { id }, data: payload });
    revalidateAll();
    return succeed({ id });
  }

  const created = await prisma.financeTransaction.create({
    data: { ...payload, userId: user.id },
  });
  revalidateAll();
  return succeed({ id: created.id });
}

/** Deleting one leg of a transfer removes the pair — never half a transfer.
 *  Like every scoped delete here, deleting a row that is not yours (or is
 *  already gone) is a silent no-op, not an error. */
export async function deleteTransaction(id: string): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  const existing = await prisma.financeTransaction.findFirst({
    where: { id, userId: user.id },
    select: { transferGroupId: true },
  });
  if (existing) {
    await prisma.financeTransaction.deleteMany({
      where: existing.transferGroupId
        ? { userId: user.id, transferGroupId: existing.transferGroupId }
        : { id, userId: user.id },
    });
  }
  revalidateAll();
  return succeed(null);
}

// --- transfers ---------------------------------------------------------------

export interface TransferOutcome {
  transferGroupId: string;
  amount: number;
}

/**
 * Move money between two of the caller's accounts: two linked ledger rows
 * (out of one account, into the other) written atomically, category
 * `transfer` so no income/spending summary counts them. Same currency only —
 * a conversion would be a made-up number.
 */
export async function transferBetweenAccounts(
  input: unknown,
): Promise<ActionResult<TransferOutcome>> {
  const parsed = transferSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const user = await getCurrentUser();
  const { fromAccountId, toAccountId, amount, date, notes } = parsed.data;

  const accounts = await prisma.financeAccount.findMany({
    where: { id: { in: [fromAccountId, toAccountId] }, userId: user.id },
  });
  const from = accounts.find((account) => account.id === fromAccountId);
  const to = accounts.find((account) => account.id === toAccountId);
  if (!from || !to) return fail("Account not found");
  if (from.archivedAt || to.archivedAt) return fail("Restore the archived account first");
  if (from.currency !== to.currency) {
    return fail(
      `These accounts use different currencies (${from.currency} and ${to.currency}) — cross-currency transfers aren't supported yet`,
    );
  }

  const transferGroupId = randomUUID();
  const legs = transferLegs({
    fromAccountId: from.id,
    toAccountId: to.id,
    fromAccountName: from.name,
    toAccountName: to.name,
    amount,
    date,
    notes: notes ?? null,
    transferGroupId,
  });

  await prisma.financeTransaction.createMany({
    data: legs.map((leg) => ({ ...leg, userId: user.id })),
  });

  revalidateAll();
  return succeed({ transferGroupId, amount: moneyRound(amount) });
}

// --- budgets -----------------------------------------------------------------

export async function saveBudget(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = budgetSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const user = await getCurrentUser();
  const { id, ...data } = parsed.data;
  const payload = {
    ...data,
    amount: moneyRound(data.amount),
    // Explicit null rather than `undefined`: clearing the alert on an edit has
    // to write the column, not silently leave the old threshold in place.
    alertThresholdPercent: data.alertThresholdPercent ?? null,
  };
  const categoryLabel =
    FINANCE_CATEGORY_META[data.category as FinanceCategory]?.label ?? data.category;

  try {
    if (id) {
      const existing = await prisma.budget.findFirst({ where: { id, userId: user.id } });
      if (!existing) return fail("Budget not found");
      await prisma.budget.update({ where: { id }, data: payload });
      revalidateAll();
      return succeed({ id });
    }

    const created = await prisma.budget.create({ data: { ...payload, userId: user.id } });
    revalidateAll();
    return succeed({ id: created.id });
  } catch (error) {
    // The (userId, category) unique: one budget per category.
    if ((error as { code?: string }).code === "P2002") {
      return fail(`You already have a ${categoryLabel} budget — edit that one instead`);
    }
    throw error;
  }
}

export async function deleteBudget(id: string): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  await prisma.budget.deleteMany({ where: { id, userId: user.id } });
  revalidateAll();
  return succeed(null);
}

// --- bills -------------------------------------------------------------------

export async function saveBill(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = billSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const user = await getCurrentUser();
  const { id, dueDate, accountId, ...data } = parsed.data;

  if (accountId) {
    const account = await prisma.financeAccount.findFirst({
      where: { id: accountId, userId: user.id },
    });
    if (!account) return fail("Account not found");
  }

  const payload = {
    ...data,
    accountId: accountId ?? null,
    amount: moneyRound(data.amount),
    notes: data.notes ?? null,
  };

  if (id) {
    const existing = await prisma.bill.findFirst({ where: { id, userId: user.id } });
    if (!existing) return fail("Bill not found");
    // A changed due date re-anchors the recurrence: occurrences now generate
    // from the new date, and a settled one-time bill reopens.
    const reanchor = dueDate !== existing.nextDueDate;
    await prisma.bill.update({
      where: { id },
      data: {
        ...payload,
        ...(reanchor
          ? { anchorDate: dueDate, nextDueDate: dueDate, settledAt: null }
          : {}),
      },
    });
    revalidateAll();
    return succeed({ id });
  }

  const created = await prisma.bill.create({
    data: { ...payload, userId: user.id, anchorDate: dueDate, nextDueDate: dueDate },
  });
  revalidateAll();
  return succeed({ id: created.id });
}

export interface MarkBillPaidOutcome {
  nextDueDate: string | null;
  settled: boolean;
  transactionRecorded: boolean;
}

/**
 * Mark the bill's current occurrence paid: advance the due pointer (or settle
 * a one-time bill) and, when an account is known, write the payment into the
 * ledger — one action, atomically.
 */
export async function markBillPaid(input: unknown): Promise<ActionResult<MarkBillPaidOutcome>> {
  const parsed = markBillPaidSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const user = await getCurrentUser();
  const { billId, date, amount, accountId, recordTransaction } = parsed.data;

  const bill = await prisma.bill.findFirst({ where: { id: billId, userId: user.id } });
  if (!bill) return fail("Bill not found");
  if (bill.settledAt) return fail("This bill is already settled");

  const paidFromId = accountId ?? bill.accountId;
  if (paidFromId) {
    const account = await prisma.financeAccount.findFirst({
      where: { id: paidFromId, userId: user.id },
    });
    if (!account) return fail("Account not found");
  }

  const advance = advanceBillAfterPayment(bill);
  const paidAmount = moneyRound(amount ?? bill.amount);
  const writeTransaction = recordTransaction && paidFromId !== null;

  await prisma.$transaction(async (db) => {
    await db.bill.update({
      where: { id: bill.id },
      data: {
        nextDueDate: advance.nextDueDate,
        lastPaidDate: date,
        settledAt: advance.settled ? new Date() : null,
      },
    });
    if (writeTransaction) {
      await db.financeTransaction.create({
        data: {
          userId: user.id,
          accountId: paidFromId!,
          billId: bill.id,
          date,
          amount: -paidAmount,
          category: bill.category,
          payee: bill.name,
        },
      });
    }
  });

  revalidateAll();
  return succeed({
    nextDueDate: advance.settled ? null : advance.nextDueDate,
    settled: advance.settled,
    transactionRecorded: writeTransaction,
  });
}

export async function setBillArchived(id: string, archived: boolean): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  const result = await prisma.bill.updateMany({
    where: { id, userId: user.id },
    data: { archivedAt: archived ? new Date() : null },
  });
  if (result.count === 0) return fail("Bill not found");
  revalidateAll();
  return succeed(null);
}

export async function deleteBill(id: string): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  await prisma.bill.deleteMany({ where: { id, userId: user.id } });
  revalidateAll();
  return succeed(null);
}

// --- savings goals -----------------------------------------------------------

export async function saveSavingsGoal(input: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = savingsGoalSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const user = await getCurrentUser();
  const { id, ...data } = parsed.data;
  const payload = {
    ...data,
    targetAmount: moneyRound(data.targetAmount),
    currentAmount: moneyRound(data.currentAmount),
    targetDate: data.targetDate ?? null,
    notes: data.notes ?? null,
  };

  if (id) {
    const existing = await prisma.savingsGoal.findFirst({ where: { id, userId: user.id } });
    if (!existing) return fail("Savings goal not found");
    await prisma.savingsGoal.update({ where: { id }, data: payload });
    revalidateAll();
    return succeed({ id });
  }

  const created = await prisma.savingsGoal.create({
    data: {
      ...payload,
      userId: user.id,
      sortOrder: await prisma.savingsGoal.count({ where: { userId: user.id } }),
    },
  });
  revalidateAll();
  return succeed({ id: created.id });
}

/** Add to (positive) or withdraw from (negative) a goal's saved amount. */
export async function adjustSavingsGoal(
  input: unknown,
): Promise<ActionResult<{ currentAmount: number }>> {
  const parsed = savingsContributionSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);
  const user = await getCurrentUser();
  const { id, amount } = parsed.data;

  const goal = await prisma.savingsGoal.findFirst({ where: { id, userId: user.id } });
  if (!goal) return fail("Savings goal not found");

  const next = moneyRound(goal.currentAmount + amount);
  if (next < 0) return fail("That would take the goal below zero");

  await prisma.savingsGoal.update({ where: { id }, data: { currentAmount: next } });
  revalidateAll();
  return succeed({ currentAmount: next });
}

export async function setSavingsGoalArchived(
  id: string,
  archived: boolean,
): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  const result = await prisma.savingsGoal.updateMany({
    where: { id, userId: user.id },
    data: { archivedAt: archived ? new Date() : null },
  });
  if (result.count === 0) return fail("Savings goal not found");
  revalidateAll();
  return succeed(null);
}

export async function deleteSavingsGoal(id: string): Promise<ActionResult<null>> {
  const user = await getCurrentUser();
  await prisma.savingsGoal.deleteMany({ where: { id, userId: user.id } });
  revalidateAll();
  return succeed(null);
}

/** The user's today, for default transaction/payment dates in dialogs. */
export async function getFinanceToday(): Promise<ActionResult<{ today: string }>> {
  const user = await getCurrentUser();
  return succeed({ today: todayIn(user.timezone) });
}
