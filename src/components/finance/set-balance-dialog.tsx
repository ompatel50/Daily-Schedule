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
import type { AccountView } from "@/components/finance/account-dialog";
import { formatMoney } from "@/lib/logic/finance";
import { setAccountBalance } from "@/server/actions/finance";

/**
 * "The bank says X" — records the difference as an adjustment transaction so
 * the ledger stays the single source the balance derives from.
 */
export function SetBalanceDialog({
  account,
  today,
  onClose,
}: {
  account: AccountView | null;
  today: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [balance, setBalance] = React.useState("");
  const [date, setDate] = React.useState(today);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (!account) return;
    setBalance(String(account.balance));
    setDate(today);
    setError(null);
  }, [account, today]);

  if (!account) return null;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!account) return;
    setError(null);

    const next = Number(balance);
    if (!Number.isFinite(next)) {
      setError("Enter a number");
      return;
    }

    startTransition(async () => {
      const result = await setAccountBalance({ accountId: account.id, balance: next, date });
      if (result.ok) {
        toast.success(
          result.data.adjustment === 0
            ? "Balance already matched — nothing recorded"
            : `Balance set — ${formatMoney(result.data.adjustment, account.currency)} adjustment recorded`,
        );
        onClose();
        router.refresh();
      } else {
        setError(result.error);
        toast.error(result.error);
      }
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Set balance</DialogTitle>
            <DialogDescription>
              {account.name} currently shows{" "}
              <span className="tabular font-medium text-foreground">
                {formatMoney(account.balance, account.currency)}
              </span>
              .
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="set-balance-amount">New balance ({account.currency})</Label>
              <Input
                id="set-balance-amount"
                type="number"
                inputMode="decimal"
                step="0.01"
                autoFocus
                value={balance}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? "set-balance-error" : undefined}
                onChange={(event) => setBalance(event.target.value)}
              />
              {error && (
                <p id="set-balance-error" className="text-xs text-destructive">
                  {error}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="set-balance-date">As of</Label>
              <Input
                id="set-balance-date"
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
            </div>

            <p className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
              The difference is recorded as a balance-adjustment transaction, so the ledger stays
              the source the balance derives from. Adjustments never count as income or spending.
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />}
              Set balance
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
