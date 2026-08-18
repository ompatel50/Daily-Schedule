"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, Link2, ScanSearch, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/shared/section-card";
import { formatDay } from "@/lib/date";
import { formatCents } from "@/lib/logic/money";
import { pluralize } from "@/lib/utils";
import {
  acceptTransferSuggestion,
  detectTransfers,
  dismissTransferSuggestion,
} from "@/server/actions/transfers";
import type { TransferSuggestionView } from "@/server/transfers";

/**
 * Pairs of one-sided rows that look like the two legs of one transfer —
 * found read-only on every page load, dismissed pairs excluded. Accept links
 * the pair; Dismiss buries it for good; "Run detection" additionally
 * auto-links the matches confident enough to link unattended.
 */
export function TransferSuggestionsSection({
  suggestions,
}: {
  suggestions: TransferSuggestionView[];
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, message: string) {
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        toast.success(message);
        router.refresh();
      } else {
        toast.error(result.error ?? "Something went wrong");
      }
    });
  }

  function detect() {
    startTransition(async () => {
      const result = await detectTransfers();
      if (result.ok) {
        const { linked, suggestions: remaining } = result.data;
        toast.success(
          linked > 0
            ? `Linked ${linked} ${pluralize(linked, "transfer")} automatically`
            : "No pair was certain enough to link automatically",
          {
            description:
              remaining > 0
                ? `${remaining} ${pluralize(remaining, "suggestion")} left for you to judge.`
                : undefined,
          },
        );
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  if (suggestions.length === 0) return null;

  return (
    <SectionCard
      title="Transfer suggestions"
      icon={Link2}
      accent="text-domain-finance"
      description="Two one-sided rows that look like one transfer — you decide"
      action={
        <Button size="sm" variant="ghost" disabled={pending} onClick={detect}>
          <ScanSearch /> Run detection
        </Button>
      }
    >
      <div className="space-y-2">
        {suggestions.map((suggestion) => (
          <div
            key={`${suggestion.outId}|${suggestion.intoId}`}
            className="rounded-lg border px-3 py-2.5"
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className="min-w-0 truncate">
                <span className="font-medium">{suggestion.outAccountName}</span>{" "}
                <span className="text-muted-foreground">
                  {formatDay(suggestion.outDate, "MMM d")}
                  {suggestion.outPayee ? ` · ${suggestion.outPayee}` : ""}
                </span>
              </span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 truncate">
                <span className="font-medium">{suggestion.intoAccountName}</span>{" "}
                <span className="text-muted-foreground">
                  {formatDay(suggestion.intoDate, "MMM d")}
                  {suggestion.intoPayee ? ` · ${suggestion.intoPayee}` : ""}
                </span>
              </span>
              <span className="tabular ml-auto shrink-0 font-semibold">
                {formatCents(suggestion.amount, suggestion.currency)}
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
              <span className="flex flex-wrap gap-1">
                {suggestion.reasons.map((reason) => (
                  <Badge key={reason} variant="muted" className="text-[10px]">
                    {reason}
                  </Badge>
                ))}
              </span>
              <span className="flex gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    run(
                      () =>
                        acceptTransferSuggestion({
                          transactionId: suggestion.outId,
                          counterpartId: suggestion.intoId,
                        }),
                      "Linked as a transfer",
                    )
                  }
                >
                  <Check /> Link
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  aria-label={`Dismiss the suggestion for ${formatCents(suggestion.amount, suggestion.currency)}`}
                  onClick={() =>
                    run(
                      () =>
                        dismissTransferSuggestion({
                          aId: suggestion.outId,
                          bId: suggestion.intoId,
                        }),
                      "Dismissed — this pair won't be suggested again",
                    )
                  }
                >
                  <X /> Dismiss
                </Button>
              </span>
            </div>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}
