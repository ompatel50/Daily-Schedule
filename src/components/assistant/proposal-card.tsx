"use client";

import * as React from "react";
import { AlertTriangle, Check, Loader2, X } from "lucide-react";
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
import {
  ASSISTANT_ACTION_META,
  type AssistantMode,
  type AssistantProposalView,
} from "@/lib/logic/assistant";
import {
  confirmAssistantProposal,
  rejectAssistantProposal,
} from "@/server/actions/assistant";

/**
 * One proposed change, exactly as it would execute, waiting for a decision.
 *
 * Normal actions execute on one Confirm click. Sensitive and destructive
 * actions open a second dialog that restates the action — per the safety
 * model, finance/reminder/schedule changes and every delete get the harder
 * path. Draft mode shows the preview but withholds Confirm entirely; the
 * server refuses execution in draft mode regardless of what the UI shows.
 */
export function ProposalCard(props: {
  proposal: AssistantProposalView;
  mode: AssistantMode;
  onDecided: (proposal: AssistantProposalView) => void;
}) {
  const { proposal, mode } = props;
  const [busy, setBusy] = React.useState<"confirm" | "reject" | null>(null);
  const [guardOpen, setGuardOpen] = React.useState(false);

  const kindLabel = ASSISTANT_ACTION_META[proposal.kind]?.label ?? proposal.kind;
  const needsGuard = proposal.risk !== "normal";

  async function execute() {
    setBusy("confirm");
    try {
      const result = await confirmAssistantProposal(proposal.id);
      if (result.ok) {
        toast.success("Done", { description: result.data.proposal.resultSummary ?? undefined });
        props.onDecided(result.data.proposal);
      } else {
        toast.error(result.error);
        // The row may have moved to failed/expired — reflect what we know.
        props.onDecided({ ...proposal, status: "failed", resultSummary: result.error });
      }
    } finally {
      setBusy(null);
      setGuardOpen(false);
    }
  }

  async function reject() {
    setBusy("reject");
    try {
      const result = await rejectAssistantProposal(proposal.id);
      if (result.ok) {
        toast.success("Cancelled — nothing was changed");
        props.onDecided(result.data.proposal);
      } else {
        toast.error(result.error);
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className="space-y-2 rounded-lg border bg-muted/40 px-3 py-2.5"
      data-testid="assistant-proposal"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{kindLabel}</Badge>
        {proposal.risk === "destructive" ? (
          <Badge variant="danger">
            <AlertTriangle className="mr-1 h-3 w-3" /> Destructive
          </Badge>
        ) : proposal.risk === "sensitive" ? (
          <Badge variant="warning">Sensitive</Badge>
        ) : null}
      </div>
      <p className="text-sm">{proposal.summary}</p>
      <div className="flex flex-wrap items-center gap-2">
        {mode === "confirm" ? (
          needsGuard ? (
            <Button
              size="sm"
              variant={proposal.risk === "destructive" ? "destructive" : "default"}
              onClick={() => setGuardOpen(true)}
              disabled={busy !== null}
              data-testid="assistant-proposal-confirm"
            >
              <Check /> Confirm…
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => void execute()}
              disabled={busy !== null}
              data-testid="assistant-proposal-confirm"
            >
              {busy === "confirm" ? <Loader2 className="animate-spin" /> : <Check />} Confirm
            </Button>
          )
        ) : (
          <span className="text-xs text-muted-foreground">
            Draft only — switch the assistant to Confirm mode in Settings to execute this.
          </span>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => void reject()}
          disabled={busy !== null}
          data-testid="assistant-proposal-cancel"
        >
          {busy === "reject" ? <Loader2 className="animate-spin" /> : <X />} Cancel
        </Button>
      </div>

      <Dialog open={guardOpen} onOpenChange={(open) => !busy && setGuardOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {proposal.risk === "destructive" ? "Confirm this deletion?" : "Confirm this change?"}
            </DialogTitle>
            <DialogDescription>
              This is exactly what will happen — nothing more:
            </DialogDescription>
          </DialogHeader>
          <p className="rounded-lg border bg-muted/40 px-3 py-2.5 text-sm">{proposal.summary}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGuardOpen(false)} disabled={busy !== null}>
              Keep everything as it is
            </Button>
            <Button
              variant={proposal.risk === "destructive" ? "destructive" : "default"}
              onClick={() => void execute()}
              disabled={busy !== null}
              data-testid="assistant-proposal-guard-confirm"
            >
              {busy === "confirm" ? <Loader2 className="animate-spin" /> : <Check />}
              {proposal.risk === "destructive" ? "Delete it" : "Make the change"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
