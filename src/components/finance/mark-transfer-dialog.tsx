"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Link2, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { TransactionView } from "@/components/finance/transaction-dialog";
import { formatDay } from "@/lib/date";
import { formatCents } from "@/lib/logic/money";
import { TRANSFER_MATCH_WINDOW_CHOICES } from "@/lib/logic/transfer-match";
import { cn } from "@/lib/utils";
import {
  createTransferCounterpart,
  getTransferLinkCandidates,
  linkTransactionsAsTransfer,
  type TransferLinkCandidates,
} from "@/server/actions/transfers";

const ANY_ACCOUNT = "__any__";

/**
 * Mark one ledger row as a transfer leg: pick (or just see) the counterpart
 * account, choose one of the offered candidate rows — same amount, opposite
 * direction, within the window — or create the missing leg when the other
 * side was never imported. Linking never rewrites the row itself.
 */
export function MarkTransferDialog({
  transaction,
  onClose,
}: {
  /** The row being linked; null keeps the dialog closed. */
  transaction: TransactionView | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [data, setData] = React.useState<TransferLinkCandidates | null>(null);
  const [windowDays, setWindowDays] = React.useState<number>(5);
  const [accountId, setAccountId] = React.useState<string>(ANY_ACCOUNT);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const transactionId = transaction?.id ?? null;

  const load = React.useCallback(
    (id: string, days: number) => {
      startTransition(async () => {
        const result = await getTransferLinkCandidates({ transactionId: id, windowDays: days });
        if (result.ok) {
          setData(result.data);
        } else {
          setData(null);
          toast.error(result.error);
        }
      });
    },
    [],
  );

  React.useEffect(() => {
    if (!transactionId) return;
    setData(null);
    setWindowDays(5);
    setAccountId(ANY_ACCOUNT);
    setSelectedId(null);
    load(transactionId, 5);
  }, [transactionId, load]);

  function changeWindow(value: string) {
    const days = Number(value);
    setWindowDays(days);
    setSelectedId(null);
    if (transactionId) load(transactionId, days);
  }

  function link() {
    if (!transactionId || !selectedId) return;
    startTransition(async () => {
      const result = await linkTransactionsAsTransfer({
        transactionId,
        counterpartId: selectedId,
      });
      if (result.ok) {
        toast.success("Linked as a transfer — both rows now stay out of income and spending");
        router.refresh();
        onClose();
      } else {
        toast.error(result.error);
      }
    });
  }

  function createLeg() {
    if (!transactionId || accountId === ANY_ACCOUNT) return;
    startTransition(async () => {
      const result = await createTransferCounterpart({ transactionId, accountId });
      if (result.ok) {
        toast.success("Missing leg created and linked");
        router.refresh();
        onClose();
      } else {
        toast.error(result.error);
      }
    });
  }

  const visibleCandidates = (data?.candidates ?? []).filter(
    (candidate) => accountId === ANY_ACCOUNT || candidate.accountId === accountId,
  );
  const direction = transaction && transaction.amount < 0 ? "into" : "from";

  return (
    <Dialog open={transaction !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Mark as transfer</DialogTitle>
          <DialogDescription>
            Link this row to its other leg in another account — the pair changes balances but
            stays out of income and spending. Unlink any time from the row menu.
          </DialogDescription>
        </DialogHeader>

        {transaction && (
          <div className="space-y-4 py-2">
            <div className="rounded-lg border px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 truncate font-medium">
                  {transaction.payee ?? "(no description)"}
                </span>
                <span className="tabular shrink-0 font-semibold">
                  {transaction.amount > 0 ? "+" : ""}
                  {formatCents(transaction.amount, transaction.currency)}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {formatDay(transaction.date)} · {transaction.accountName}
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="mark-transfer-account">Counterpart account</Label>
                <Select value={accountId} onValueChange={setAccountId}>
                  <SelectTrigger id="mark-transfer-account">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY_ACCOUNT}>Any account</SelectItem>
                    {(data?.accounts ?? []).map((account) => (
                      <SelectItem key={account.id} value={account.id}>
                        {account.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mark-transfer-window">Match within</Label>
                <Select value={String(windowDays)} onValueChange={changeWindow}>
                  <SelectTrigger id="mark-transfer-window">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TRANSFER_MATCH_WINDOW_CHOICES.map((days) => (
                      <SelectItem key={days} value={String(days)}>
                        {days} days
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {pending && !data ? (
              <p className="py-2 text-sm text-muted-foreground">Looking for matches…</p>
            ) : visibleCandidates.length > 0 ? (
              <div className="space-y-1.5" role="radiogroup" aria-label="Candidate matches">
                {visibleCandidates.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    role="radio"
                    aria-checked={selectedId === candidate.id}
                    onClick={() => setSelectedId(candidate.id)}
                    className={cn(
                      "w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                      selectedId === candidate.id
                        ? "border-domain-finance bg-domain-finance/5"
                        : "hover:bg-muted/50",
                    )}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0 truncate font-medium">
                        {candidate.payee ?? "(no description)"}
                      </span>
                      <span className="tabular shrink-0 font-semibold">
                        {candidate.amount > 0 ? "+" : ""}
                        {formatCents(candidate.amount, transaction.currency)}
                      </span>
                    </div>
                    <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      {formatDay(candidate.date)} · {candidate.accountName}
                      {candidate.confident && (
                        <Badge variant="success" className="text-[10px]">
                          likely match
                        </Badge>
                      )}
                    </p>
                  </button>
                ))}
              </div>
            ) : (
              <p className="rounded-lg border border-dashed px-3 py-3 text-sm text-muted-foreground">
                No matching row {direction === "into" ? "receiving" : "sending"} this amount
                within {windowDays} days
                {accountId !== ANY_ACCOUNT ? " in that account" : ""}. If the other side was
                never imported, create the missing leg below.
              </p>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            type="button"
            variant="outline"
            disabled={pending || accountId === ANY_ACCOUNT}
            title={
              accountId === ANY_ACCOUNT
                ? "Pick the counterpart account first"
                : undefined
            }
            onClick={createLeg}
          >
            <Plus /> Create missing leg
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" disabled={pending || !selectedId} onClick={link}>
              {pending ? <Loader2 className="animate-spin" /> : <Link2 />}
              Link selected
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
