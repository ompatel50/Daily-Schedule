"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
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
import { ACCOUNT_TYPE_META, ACCOUNT_TYPES, type AccountType } from "@/lib/enums";
import { saveFinanceAccount } from "@/server/actions/finance";

/** A finance account as the page serialises it — plain fields only. */
export interface AccountView {
  id: string;
  name: string;
  type: string;
  currency: string;
  openingBalance: number;
  /** Remind when the balance drops below this; null = no alert. */
  lowBalanceThreshold: number | null;
  notes: string | null;
  archived: boolean;
  /** openingBalance + every transaction — computed on the server. */
  balance: number;
  /** True for credit_card / loan accounts, whose balance is normally owed. */
  debt: boolean;
}

interface AccountForm {
  name: string;
  type: string;
  currency: string;
  openingBalance: string;
  /** Empty string = no low-balance alert. */
  lowBalanceThreshold: string;
  notes: string;
}

function blankAccount(): AccountForm {
  return {
    name: "",
    type: "checking",
    currency: "USD",
    openingBalance: "0",
    lowBalanceThreshold: "",
    notes: "",
  };
}

function formFrom(account: AccountView): AccountForm {
  return {
    name: account.name,
    type: account.type,
    currency: account.currency,
    openingBalance: String(account.openingBalance),
    lowBalanceThreshold:
      account.lowBalanceThreshold === null ? "" : String(account.lowBalanceThreshold),
    notes: account.notes ?? "",
  };
}

export function AccountDialog({
  open,
  onOpenChange,
  account,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account?: AccountView | null;
}) {
  const router = useRouter();
  const isEdit = Boolean(account?.id);
  const [pending, startTransition] = React.useTransition();
  const [form, setForm] = React.useState<AccountForm>(account ? formFrom(account) : blankAccount());
  const [errors, setErrors] = React.useState<Record<string, string[] | undefined>>({});

  React.useEffect(() => {
    if (!open) return;
    setForm(account ? formFrom(account) : blankAccount());
    setErrors({});
  }, [open, account]);

  function set<K extends keyof AccountForm>(key: K, value: AccountForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setErrors({});

    if (!form.name.trim()) {
      setErrors({ name: ["Give the account a name"] });
      return;
    }
    const openingBalance = Number(form.openingBalance);
    if (!Number.isFinite(openingBalance)) {
      setErrors({ openingBalance: ["Enter a number"] });
      return;
    }
    const thresholdRaw = form.lowBalanceThreshold.trim();
    const lowBalanceThreshold = thresholdRaw === "" ? null : Number(thresholdRaw);
    if (lowBalanceThreshold !== null && !Number.isFinite(lowBalanceThreshold)) {
      setErrors({ lowBalanceThreshold: ["Enter a number, or leave it empty"] });
      return;
    }

    startTransition(async () => {
      const result = await saveFinanceAccount({
        id: account?.id,
        name: form.name.trim(),
        type: form.type,
        currency: form.currency.trim() || "USD",
        openingBalance,
        lowBalanceThreshold,
        notes: form.notes.trim() || null,
      });

      if (result.ok) {
        toast.success(isEdit ? "Account updated" : "Account created");
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
            <DialogTitle>{isEdit ? "Edit account" : "New account"}</DialogTitle>
            <DialogDescription>
              The balance is always the opening balance plus every recorded transaction — it is
              computed, never stored.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="account-name">Name</Label>
              <Input
                id="account-name"
                autoFocus
                value={form.name}
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? "account-name-error" : undefined}
                onChange={(event) => set("name", event.target.value)}
                placeholder="Everyday checking"
              />
              {errors.name && (
                <p id="account-name-error" className="text-xs text-destructive">
                  {errors.name[0]}
                </p>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="account-type">Type</Label>
                <Select value={form.type} onValueChange={(value) => set("type", value)}>
                  <SelectTrigger id="account-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ACCOUNT_TYPES.map((value) => (
                      <SelectItem key={value} value={value}>
                        {ACCOUNT_TYPE_META[value as AccountType].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="account-currency">Currency</Label>
                <Input
                  id="account-currency"
                  value={form.currency}
                  maxLength={3}
                  aria-invalid={Boolean(errors.currency)}
                  aria-describedby={errors.currency ? "account-currency-error" : undefined}
                  onChange={(event) => set("currency", event.target.value.toUpperCase())}
                  placeholder="USD"
                />
                {errors.currency && (
                  <p id="account-currency-error" className="text-xs text-destructive">
                    {errors.currency[0]}
                  </p>
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="account-opening">Opening balance</Label>
              <Input
                id="account-opening"
                type="number"
                inputMode="decimal"
                step="0.01"
                value={form.openingBalance}
                aria-invalid={Boolean(errors.openingBalance)}
                aria-describedby={errors.openingBalance ? "account-opening-error" : undefined}
                onChange={(event) => set("openingBalance", event.target.value)}
              />
              {errors.openingBalance && (
                <p id="account-opening-error" className="text-xs text-destructive">
                  {errors.openingBalance[0]}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                {isEdit
                  ? "Changing this shifts the computed balance — prefer “Set balance…” for corrections."
                  : "What the account held before the first transaction you record. Negative for money owed."}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="account-threshold">Low-balance alert (optional)</Label>
              <Input
                id="account-threshold"
                type="number"
                inputMode="decimal"
                step="0.01"
                value={form.lowBalanceThreshold}
                aria-invalid={Boolean(errors.lowBalanceThreshold)}
                aria-describedby={
                  errors.lowBalanceThreshold ? "account-threshold-error" : undefined
                }
                onChange={(event) => set("lowBalanceThreshold", event.target.value)}
                placeholder="No alert"
              />
              {errors.lowBalanceThreshold ? (
                <p id="account-threshold-error" className="text-xs text-destructive">
                  {errors.lowBalanceThreshold[0]}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Remind me when the balance drops below this — at most once a week. Leave empty
                  for no alert.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="account-notes">Notes (optional)</Label>
              <Textarea
                id="account-notes"
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
                {isEdit ? "Save changes" : "Create account"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
