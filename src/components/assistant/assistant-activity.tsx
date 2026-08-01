"use client";

import * as React from "react";
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
  assistantStatusLabel,
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
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                <p className="line-clamp-2 min-w-[10rem] flex-1 break-words">{proposal.summary}</p>
                <StatusBadge
                  status={
                    proposal.status === "confirmed"
                      ? "ok"
                      : proposal.status === "rejected"
                        ? "cancelled"
                        : "error"
                  }
                  label={assistantStatusLabel(proposal.status)}
                />
              </div>
              {proposal.resultSummary && (
                <p className="text-xs text-muted-foreground">{proposal.resultSummary}</p>
              )}
            </div>
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
            <div className="min-w-0 flex-1 space-y-0.5">
              {/*
                The status and time wrap onto their own line when the row is
                narrow. Pinned beside the text with `shrink-0` they took ~150px
                of a phone's width, which left the request itself truncated to
                a few characters — an audit log nobody could read. The floor on
                the text is what makes them wrap rather than squeeze: without
                it the column gets narrow enough to break "Cancelled:" in two.
              */}
              <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                <p
                  className="line-clamp-2 min-w-[10rem] flex-1 break-words"
                  data-testid="assistant-audit-request"
                >
                  {entry.requestPreview ? `“${entry.requestPreview}”` : entry.summary}
                </p>
                <span className="flex shrink-0 items-center gap-2">
                  <StatusBadge status={entry.status} label={assistantStatusLabel(entry.status)} />
                  <time className="text-xs tabular text-muted-foreground" dateTime={entry.createdAt}>
                    <LocalTime iso={entry.createdAt} />
                  </time>
                </span>
              </div>
              {entry.requestPreview && (
                <p className="line-clamp-2 break-words text-xs text-muted-foreground">
                  {entry.summary}
                </p>
              )}
              {entry.toolCalls.length > 0 && (
                <p className="truncate text-xs text-muted-foreground">
                  Tools: {entry.toolCalls.map((call) => call.tool).join(", ")}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

/**
 * Audit rows carry UTC instants; showing them raw would tell a user in
 * Chicago that they asked something "at 06:12" when they asked at midnight.
 * Formatting happens after mount because the server and the first client
 * render must agree — the browser's clock is not knowable during SSR.
 */
function LocalTime({ iso }: { iso: string }) {
  const [text, setText] = React.useState<string | null>(null);

  React.useEffect(() => {
    const when = new Date(iso);
    if (Number.isNaN(when.getTime())) return;
    setText(
      when.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
    );
  }, [iso]);

  // Before hydration: the calendar day only, which is the same in the vast
  // majority of zones and never claims a wrong wall-clock time.
  return <>{text ?? iso.slice(0, 10)}</>;
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
