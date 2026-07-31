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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { AccountView } from "@/components/finance/account-dialog";
import {
  BILL_KINDS,
  BILL_RECURRENCE_META,
  BILL_RECURRENCES,
  FINANCE_CATEGORIES,
  FINANCE_CATEGORY_META,
  isBookkeepingCategory,
  type BillRecurrence,
  type FinanceCategory,
} from "@/lib/enums";
import type { DueBucket } from "@/lib/logic/due";
import { titleCase } from "@/lib/utils";
import { saveBill } from "@/server/actions/finance";

/** A bill row as the page serialises it — plain fields only. */
export interface BillRowView {
  id: string;
  name: string;
  amount: number;
  kind: string;
  category: string;
  accountId: string | null;
  accountName: string | null;
  /** The linked account's currency, or the page's primary currency. */
  currency: string;
  recurrence: string;
  nextDueDate: string;
  autoPay: boolean;
  reminderEnabled: boolean;
  reminderDaysBefore: number;
  notes: string | null;
  bucket: DueBucket;
  /** Signed days to the due date: negative = overdue. */
  daysUntilDue: number;
}

/** Radix Select cannot hold an empty value, so "no account" is a sentinel. */
const NO_ACCOUNT = "none";

interface BillForm {
  name: string;
  amount: string;
  kind: string;
  category: string;
  recurrence: string;
  dueDate: string;
  accountId: string;
  autoPay: boolean;
  reminderEnabled: boolean;
  reminderDaysBefore: string;
  notes: string;
}

function blankBill(today: string): BillForm {
  return {
    name: "",
    amount: "",
    kind: "bill",
    category: "utilities",
    recurrence: "monthly",
    dueDate: today,
    accountId: NO_ACCOUNT,
    autoPay: false,
    reminderEnabled: true,
    reminderDaysBefore: "3",
    notes: "",
  };
}

function formFrom(bill: BillRowView): BillForm {
  return {
    name: bill.name,
    amount: String(bill.amount),
    kind: bill.kind,
    category: bill.category,
    recurrence: bill.recurrence,
    dueDate: bill.nextDueDate,
    accountId: bill.accountId ?? NO_ACCOUNT,
    autoPay: bill.autoPay,
    reminderEnabled: bill.reminderEnabled,
    reminderDaysBefore: String(bill.reminderDaysBefore),
    notes: bill.notes ?? "",
  };
}

export function BillDialog({
  open,
  onOpenChange,
  bill,
  accounts,
  today,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bill?: BillRowView | null;
  /** Unarchived accounts the bill can default to being paid from. */
  accounts: AccountView[];
  today: string;
}) {
  const router = useRouter();
  const isEdit = Boolean(bill?.id);
  const [pending, startTransition] = React.useTransition();
  const [form, setForm] = React.useState<BillForm>(bill ? formFrom(bill) : blankBill(today));
  const [errors, setErrors] = React.useState<Record<string, string[] | undefined>>({});

  React.useEffect(() => {
    if (!open) return;
    setForm(bill ? formFrom(bill) : blankBill(today));
    setErrors({});
  }, [open, bill, today]);

  function set<K extends keyof BillForm>(key: K, value: BillForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  // A bill is money out; income and bookkeeping categories make no sense here
  // (the server refuses them too — a "transfer" bill payment would hide real
  // spending from every summary).
  const categories = FINANCE_CATEGORIES.filter(
    (value) => !isBookkeepingCategory(value) && value !== "income",
  );

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setErrors({});

    if (!form.name.trim()) {
      setErrors({ name: ["Give it a name"] });
      return;
    }
    const amount = Number(form.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setErrors({ amount: ["The amount must be above zero"] });
      return;
    }
    const reminderDaysBefore = Math.min(60, Math.max(0, Math.round(Number(form.reminderDaysBefore) || 0)));

    startTransition(async () => {
      const result = await saveBill({
        id: bill?.id,
        name: form.name.trim(),
        amount,
        kind: form.kind,
        category: form.category,
        recurrence: form.recurrence,
        dueDate: form.dueDate,
        accountId: form.accountId === NO_ACCOUNT ? null : form.accountId,
        autoPay: form.autoPay,
        reminderEnabled: form.reminderEnabled,
        reminderDaysBefore,
        notes: form.notes.trim() || null,
      });

      if (result.ok) {
        toast.success(isEdit ? "Bill updated" : "Bill created");
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
            <DialogTitle>{isEdit ? "Edit bill" : "New bill"}</DialogTitle>
            <DialogDescription>
              Bills and subscriptions behave identically — the kind only changes how the row is
              labelled.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="bill-name">Name</Label>
              <Input
                id="bill-name"
                autoFocus
                value={form.name}
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? "bill-name-error" : undefined}
                onChange={(event) => set("name", event.target.value)}
                placeholder="Rent"
              />
              {errors.name && (
                <p id="bill-name-error" className="text-xs text-destructive">
                  {errors.name[0]}
                </p>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="bill-amount">Amount</Label>
                <Input
                  id="bill-amount"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  value={form.amount}
                  aria-invalid={Boolean(errors.amount)}
                  aria-describedby={errors.amount ? "bill-amount-error" : undefined}
                  onChange={(event) => set("amount", event.target.value)}
                  placeholder="0.00"
                />
                {errors.amount && (
                  <p id="bill-amount-error" className="text-xs text-destructive">
                    {errors.amount[0]}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bill-kind">Kind</Label>
                <Select value={form.kind} onValueChange={(value) => set("kind", value)}>
                  <SelectTrigger id="bill-kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BILL_KINDS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {titleCase(value)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="bill-recurrence">Repeats</Label>
                <Select value={form.recurrence} onValueChange={(value) => set("recurrence", value)}>
                  <SelectTrigger id="bill-recurrence">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BILL_RECURRENCES.map((value) => (
                      <SelectItem key={value} value={value}>
                        {BILL_RECURRENCE_META[value as BillRecurrence].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bill-due">Due date</Label>
                <Input
                  id="bill-due"
                  type="date"
                  value={form.dueDate}
                  aria-invalid={Boolean(errors.dueDate)}
                  onChange={(event) => set("dueDate", event.target.value)}
                />
                {errors.dueDate && <p className="text-xs text-destructive">{errors.dueDate[0]}</p>}
                {isEdit && (
                  <p className="text-xs text-muted-foreground">
                    Changing the due date re-anchors the recurrence from the new day.
                  </p>
                )}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="bill-category">Category</Label>
                <Select value={form.category} onValueChange={(value) => set("category", value)}>
                  <SelectTrigger id="bill-category">
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
              <div className="space-y-1.5">
                <Label htmlFor="bill-account">Paid from (optional)</Label>
                <Select value={form.accountId} onValueChange={(value) => set("accountId", value)}>
                  <SelectTrigger id="bill-account">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_ACCOUNT}>No account</SelectItem>
                    {accounts.map((account) => (
                      <SelectItem key={account.id} value={account.id}>
                        {account.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <div>
                <Label htmlFor="bill-autopay">Auto-pay</Label>
                <p className="text-xs text-muted-foreground">
                  Paid automatically — flagged on the row so you know not to chase it.
                </p>
              </div>
              <Switch
                id="bill-autopay"
                checked={form.autoPay}
                onCheckedChange={(checked) => set("autoPay", checked)}
              />
            </div>

            <div className="space-y-3 rounded-lg border p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <Label htmlFor="bill-reminder">Reminder</Label>
                  <p className="text-xs text-muted-foreground">
                    Surface this bill before it falls due.
                  </p>
                </div>
                <Switch
                  id="bill-reminder"
                  checked={form.reminderEnabled}
                  onCheckedChange={(checked) => set("reminderEnabled", checked)}
                />
              </div>
              {form.reminderEnabled && (
                <div className="space-y-1.5">
                  <Label htmlFor="bill-reminder-days">Days before (0–60)</Label>
                  <Input
                    id="bill-reminder-days"
                    type="number"
                    min={0}
                    max={60}
                    step={1}
                    className="max-w-24"
                    value={form.reminderDaysBefore}
                    onChange={(event) => set("reminderDaysBefore", event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">0 reminds only on the day itself.</p>
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="bill-notes">Notes (optional)</Label>
              <Textarea
                id="bill-notes"
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
                {isEdit ? "Save changes" : "Create bill"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
