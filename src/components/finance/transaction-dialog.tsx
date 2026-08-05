"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowDownRight, ArrowUpRight, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { AccountView } from "@/components/finance/account-dialog";
import { FINANCE_CATEGORIES, FINANCE_CATEGORY_META, type FinanceCategory } from "@/lib/enums";
import { cn } from "@/lib/utils";
import { saveTransaction } from "@/server/actions/finance";

/** A ledger entry as the page serialises it — plain fields only. */
export interface TransactionView {
  id: string;
  date: string;
  /** Signed: positive = money in, negative = money out. */
  amount: number;
  payee: string | null;
  category: string;
  notes: string | null;
  accountId: string;
  accountName: string;
  /** The account's display currency. */
  currency: string;
  billId: string | null;
  billName: string | null;
  /** Set on both legs of a transfer — such rows are deleted as a pair, never edited. */
  transferGroupId: string | null;
}

type Direction = "spent" | "received";

interface TransactionForm {
  accountId: string;
  date: string;
  amount: string;
  direction: Direction;
  category: string;
  payee: string;
  notes: string;
}

function blankTransaction(accounts: AccountView[], today: string): TransactionForm {
  return {
    accountId: accounts[0]?.id ?? "",
    date: today,
    amount: "",
    direction: "spent",
    category: "other",
    payee: "",
    notes: "",
  };
}

function formFrom(transaction: TransactionView): TransactionForm {
  return {
    accountId: transaction.accountId,
    date: transaction.date,
    amount: String(Math.abs(transaction.amount)),
    direction: transaction.amount >= 0 ? "received" : "spent",
    category: transaction.category,
    payee: transaction.payee ?? "",
    notes: transaction.notes ?? "",
  };
}

export function TransactionDialog({
  open,
  onOpenChange,
  transaction,
  accounts,
  today,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transaction?: TransactionView | null;
  /** Unarchived accounts to pick from. */
  accounts: AccountView[];
  today: string;
}) {
  const router = useRouter();
  const isEdit = Boolean(transaction?.id);
  const [pending, startTransition] = React.useTransition();
  const [form, setForm] = React.useState<TransactionForm>(
    transaction ? formFrom(transaction) : blankTransaction(accounts, today),
  );
  const [errors, setErrors] = React.useState<Record<string, string[] | undefined>>({});

  React.useEffect(() => {
    if (!open) return;
    setForm(transaction ? formFrom(transaction) : blankTransaction(accounts, today));
    setErrors({});
  }, [open, transaction, accounts, today]);

  function set<K extends keyof TransactionForm>(key: K, value: TransactionForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  const selectedAccount = accounts.find((account) => account.id === form.accountId);
  // Bookkeeping categories are written by their own flows — "Set balance…"
  // for adjustments, "Transfer" for transfer legs. Adjustments are still
  // offered when editing one that already exists; transfers never are (their
  // legs cannot be edited here at all).
  const categories = FINANCE_CATEGORIES.filter(
    (value) =>
      value !== "transfer" && (value !== "adjustment" || form.category === "adjustment"),
  );

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setErrors({});

    if (!form.accountId) {
      setErrors({ accountId: ["Pick an account"] });
      return;
    }
    const amount = Number(form.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setErrors({ amount: ["Enter an amount above zero"] });
      return;
    }

    startTransition(async () => {
      const result = await saveTransaction({
        id: transaction?.id,
        accountId: form.accountId,
        date: form.date,
        amount: form.direction === "spent" ? -amount : amount,
        category: form.category,
        payee: form.payee.trim() || null,
        notes: form.notes.trim() || null,
        billId: transaction?.billId ?? null,
      });

      if (result.ok) {
        toast.success(isEdit ? "Transaction updated" : "Transaction recorded");
        onOpenChange(false);
        router.refresh();
      } else {
        setErrors(result.fieldErrors ?? {});
        toast.error(result.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{isEdit ? "Edit transaction" : "Add transaction"}</DialogTitle>
            <DialogDescription>
              {transaction?.billName
                ? `Payment linked to ${transaction.billName}.`
                : "One ledger entry — the account balance follows from these."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-1 rounded-lg border bg-muted/40 p-1">
              <Button
                type="button"
                size="sm"
                variant={form.direction === "spent" ? "default" : "ghost"}
                onClick={() => set("direction", "spent")}
              >
                <ArrowDownRight /> Spent
              </Button>
              <Button
                type="button"
                size="sm"
                variant={form.direction === "received" ? "default" : "ghost"}
                onClick={() => set("direction", "received")}
              >
                <ArrowUpRight /> Received
              </Button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="tx-amount">Amount</Label>
                <Input
                  id="tx-amount"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  autoFocus
                  value={form.amount}
                  aria-invalid={Boolean(errors.amount)}
                  aria-describedby={errors.amount ? "tx-amount-error" : undefined}
                  onChange={(event) => set("amount", event.target.value)}
                  placeholder="0.00"
                />
                {errors.amount && (
                  <p id="tx-amount-error" className="text-xs text-destructive">
                    {errors.amount[0]}
                  </p>
                )}
                <p className={cn("text-xs text-muted-foreground", errors.amount && "sr-only")}>
                  Recorded in {selectedAccount?.currency ?? "USD"} as{" "}
                  {form.direction === "spent" ? "money out" : "money in"}.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tx-date">Date</Label>
                <Input
                  id="tx-date"
                  type="date"
                  value={form.date}
                  aria-invalid={Boolean(errors.date)}
                  onChange={(event) => set("date", event.target.value)}
                />
                {errors.date && <p className="text-xs text-destructive">{errors.date[0]}</p>}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="tx-account">Account</Label>
                <Select value={form.accountId} onValueChange={(value) => set("accountId", value)}>
                  <SelectTrigger
                    id="tx-account"
                    aria-invalid={Boolean(errors.accountId)}
                    aria-describedby={errors.accountId ? "tx-account-error" : undefined}
                  >
                    <SelectValue placeholder="Pick an account" />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.map((account) => (
                      <SelectItem key={account.id} value={account.id}>
                        {account.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors.accountId && (
                  <p id="tx-account-error" className="text-xs text-destructive">
                    {errors.accountId[0]}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tx-category">Category</Label>
                <Select value={form.category} onValueChange={(value) => set("category", value)}>
                  <SelectTrigger id="tx-category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {categories.map((value) => (
                      <SelectItem key={value} value={value}>
                        {FINANCE_CATEGORY_META[value as FinanceCategory].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tx-payee">Payee (optional)</Label>
              <Input
                id="tx-payee"
                value={form.payee}
                onChange={(event) => set("payee", event.target.value)}
                placeholder="Corner grocery"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tx-notes">Notes (optional)</Label>
              <Textarea
                id="tx-notes"
                rows={2}
                value={form.notes}
                onChange={(event) => set("notes", event.target.value)}
              />
            </div>
          </div>

          <DialogFooter className="gap-2 sm:justify-between">
            <span />
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending && <Loader2 className="animate-spin" />}
                {isEdit ? "Save changes" : "Add transaction"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
