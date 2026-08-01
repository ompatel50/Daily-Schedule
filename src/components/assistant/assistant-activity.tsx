"use client";

import {
  Activity,
  CheckCircle2,
  CircleSlash,
  MessageSquare,
  PlugZap,
  XCircle,
  Zap,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { SectionCard } from "@/components/shared/section-card";
import {
  type AssistantAuditView,
  type AssistantProposalView,
} from "@/lib/logic/assistant";

/**
 * The audit trail, rendered: what the assistant was asked, which tools it
 * used, what was proposed, and how each decision went. Everything shown here
 * comes from the append-only audit table plus stamped proposal rows — it is
 * the page's memory, since transcripts are deliberately not persisted.
 */
export function AssistantActivity(props: {
  entries: AssistantAuditView[];
  decidedProposals?: AssistantProposalView[];
}) {
  const decided = (props.decidedProposals ?? []).filter(
    (proposal) => proposal.status !== "proposed",
  );

  if (props.entries.length === 0 && decided.length === 0) return null;

  return (
    <SectionCard
      title="Recent assistant activity"
      icon={Activity}
      accent="text-violet-500"
      description="The audit log — requests, tool use and decided actions. Summaries only, never transcripts."
    >
      <ul className="space-y-1.5" data-testid="assistant-audit-list">
        {decided.slice(0, 6).map((proposal) => (
          <li
            key={`p-${proposal.id}`}
            className="flex items-start gap-3 rounded-lg border px-3 py-2 text-sm"
          >
            <Zap className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate">{proposal.summary}</p>
              {proposal.resultSummary && (
                <p className="text-xs text-muted-foreground">{proposal.resultSummary}</p>
              )}
            </div>
            <StatusBadge
              status={
                proposal.status === "confirmed"
                  ? "ok"
                  : proposal.status === "rejected"
                    ? "cancelled"
                    : "error"
              }
              label={proposal.status}
            />
          </li>
        ))}
        {props.entries.map((entry) => (
          <li
            key={entry.id}
            className="flex items-start gap-3 rounded-lg border px-3 py-2 text-sm"
          >
            {entry.kind === "chat" ? (
              <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            ) : entry.kind === "connection" ? (
              <PlugZap className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            ) : (
              <Zap className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate">
                {entry.requestPreview ? `“${entry.requestPreview}”` : entry.summary}
              </p>
              {entry.requestPreview && (
                <p className="truncate text-xs text-muted-foreground">{entry.summary}</p>
              )}
              {entry.toolCalls.length > 0 && (
                <p className="truncate text-xs text-muted-foreground">
                  Tools: {entry.toolCalls.map((call) => call.tool).join(", ")}
                </p>
              )}
            </div>
            <span className="flex shrink-0 items-center gap-2">
              <StatusBadge status={entry.status} label={entry.status} />
              <time className="text-xs tabular text-muted-foreground" dateTime={entry.createdAt}>
                {entry.createdAt.slice(0, 16).replace("T", " ")}
              </time>
            </span>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

function StatusBadge({ status, label }: { status: string; label: string }) {
  if (status === "ok") {
    return (
      <Badge variant="success">
        <CheckCircle2 className="mr-1 h-3 w-3" /> {label}
      </Badge>
    );
  }
  if (status === "cancelled" || status === "refused") {
    return (
      <Badge variant="muted">
        <CircleSlash className="mr-1 h-3 w-3" /> {label}
      </Badge>
    );
  }
  return (
    <Badge variant="danger">
      <XCircle className="mr-1 h-3 w-3" /> {label}
    </Badge>
  );
}
