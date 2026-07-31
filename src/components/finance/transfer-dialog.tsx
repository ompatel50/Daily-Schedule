"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2 } from "lucide-react";
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
import { formatMoney } from "@/lib/logic/finance";
import { transferBetweenAccounts } from "@/server/actions/finance";

interface TransferForm {
  fromAccountId: string;
  toAccountId: string;
  amount: string;
  date: string;
  notes: string;
}

/**
 * Move money between two accounts: one action, two linked ledger rows. The
 * legs never count as income or spending, so summaries and budgets are
 * untouched — only the two balances move.
 */
export function TransferDialog({
  open,
  onOpenChange,
  accounts,
  today,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Unarchived accounts to pick from. */
  accounts: AccountView[];
  today: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [form, setForm] = React.useState<TransferForm>({
    fromAccountId: "",
    toAccountId: "",
    amount: "",
    date: today,
    notes: "",
  });
  const [errors, setErrors] = React.useState<Record<string, string[] | undefined>>({});

  React.useEffect(() => {
    if (!open) return;
    setForm({
      fromAccountId: accounts[0]?.id ?? "",
      toAccountId: accounts[1]?.id ?? "",
      amount: "",
      date: today,
      notes: "",
    });
    setErrors({});
  }, [open, accounts, today]);

  function set<K extends keyof TransferForm>(key: K, value: TransferForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  const from = accounts.find((account) => account.id === form.fromAccountId);
  const to = accounts.find((account) => account.id === form.toAccountId);
  const currencyMismatch = Boolean(from && to && from.currency !== to.currency);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setErrors({});

    if (!form.fromAccountId || !form.toAccountId) {
      setErrors({ toAccountId: ["Pick both accounts"] });
      return;
    }
    if (form.fromAccountId === form.toAccountId) {
      setErrors({ toAccountId: ["Pick two different accounts"] });
      return;
    }
    const amount = Number(form.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setErrors({ amount: ["Enter an amount above zero"] });
      return;
    }

    startTransition(async () => {
      const result = await transferBetweenAccounts({
        fromAccountId: form.fromAccountId,
        toAccountId: form.toAccountId,
        amount,
        date: form.date,
        notes: form.notes.trim() || null,
      });

      if (result.ok) {
        toast.success(
          `Moved ${formatMoney(result.data.amount, from?.currency)} to ${to?.name ?? "the other account"}`,
        );
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
      <DialogContent className="max-h-[92vh] max-w-lg overflow-y-auto">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Transfer between accounts</DialogTitle>
            <DialogDescription>
              Two linked ledger entries, written together. Transfers never count as income or
              spending — only the balances move.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
              <div className="space-y-1.5">
                <Label htmlFor="transfer-from">From</Label>
                <Select
                  value={form.fromAccountId}
                  onValueChange={(value) => set("fromAccountId", value)}
                >
                  <SelectTrigger id="transfer-from">
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
                {from && (
                  <p className="text-xs text-muted-foreground">
                    {formatMoney(from.balance, from.currency)} available
                  </p>
                )}
              </div>
              <ArrowRight
                className="hidden h-4 w-4 text-muted-foreground sm:mb-7 sm:block"
                aria-hidden="true"
              />
              <div className="space-y-1.5">
                <Label htmlFor="transfer-to">To</Label>
                <Select
                  value={form.toAccountId}
                  onValueChange={(value) => set("toAccountId", value)}
                >
                  <SelectTrigger
                    id="transfer-to"
                    aria-invalid={Boolean(errors.toAccountId)}
                    aria-describedby={errors.toAccountId ? "transfer-to-error" : undefined}
                  >
                    <SelectValue placeholder="Pick an account" />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts
                      .filter((account) => account.id !== form.fromAccountId)
                      .map((account) => (
                        <SelectItem key={account.id} value={account.id}>
                          {account.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                {errors.toAccountId ? (
                  <p id="transfer-to-error" className="text-xs text-destructive">
                    {errors.toAccountId[0]}
                  </p>
                ) : (
                  to && (
                    <p className="text-xs text-muted-foreground">
                      {formatMoney(to.balance, to.currency)} now
                    </p>
                  )
                )}
              </div>
            </div>

            {currencyMismatch && (
              <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-400">
                These accounts use different currencies ({from?.currency} and {to?.currency}).
                Cross-currency transfers aren&apos;t supported yet — record two manual
                transactions instead.
              </p>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="transfer-amount">Amount</Label>
                <Input
                  id="transfer-amount"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  autoFocus
                  value={form.amount}
                  aria-invalid={Boolean(errors.amount)}
                  aria-describedby={errors.amount ? "transfer-amount-error" : undefined}
                  onChange={(event) => set("amount", event.target.value)}
                  placeholder="0.00"
                />
                {errors.amount && (
                  <p id="transfer-amount-error" className="text-xs text-destructive">
                    {errors.amount[0]}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="transfer-date">Date</Label>
                <Input
                  id="transfer-date"
                  type="date"
                  value={form.date}
                  onChange={(event) => set("date", event.target.value)}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="transfer-notes">Notes (optional)</Label>
              <Textarea
                id="transfer-notes"
                rows={2}
                value={form.notes}
                onChange={(event) => set("notes", event.target.value)}
                placeholder="Monthly savings move"
              />
            </div>
          </div>

          <DialogFooter className="gap-2 sm:justify-between">
            <span />
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending || currencyMismatch}>
                {pending && <Loader2 className="animate-spin" />}
                Move money
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
