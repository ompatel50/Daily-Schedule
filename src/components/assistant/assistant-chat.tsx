"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Bot,
  CheckCircle2,
  CircleSlash,
  Eye,
  Loader2,
  Pencil,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Wrench,
  XCircle,
} from "lucide-react";

import { AssistantActivity } from "@/components/assistant/assistant-activity";
import { ProposalCard } from "@/components/assistant/proposal-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  ASSISTANT_LIMITS,
  ASSISTANT_MODE_META,
  type AssistantAuditView,
  type AssistantMode,
  type AssistantProposalView,
  type AssistantStreamEvent,
} from "@/lib/logic/assistant";
import { testAssistantConnection } from "@/server/actions/assistant";

/**
 * The assistant conversation. The transcript is deliberately client state —
 * closing the page ends the conversation; what persists is the audit trail
 * and any proposals, which the server owns. All model traffic flows through
 * the same-origin /api/assistant/chat stream; this component never talks to
 * Ollama itself (the CSP would refuse it anyway).
 */

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Tool activity shown inline while (and after) the assistant works. */
  tools: Array<{ tool: string; ok: boolean | null }>;
  error?: string;
}

const SUGGESTIONS = [
  "What should I focus on today?",
  "Summarize my finances this month.",
  "Find overdue bills and tasks.",
  "Summarize my sleep and heart trends.",
  "What happened this week?",
];

const TOOL_LABELS: Record<string, string> = {
  search_records: "Searching your records",
  get_needs_attention: "Checking what needs attention",
  get_day_overview: "Reading the day",
  get_week_review: "Reviewing the week",
  get_schedule: "Reading the planner",
  list_tasks: "Reading tasks",
  list_inbox: "Reading the inbox",
  get_finance_overview: "Reading finances",
  list_transactions: "Reading transactions",
  list_bills: "Reading bills",
  list_reminders: "Reading reminders",
  get_reminder_feed: "Checking today's reminders",
  get_health_trends: "Reading health trends",
  list_documents: "Reading documents",
  get_import_history: "Reading import history",
  get_backup_status: "Checking backup status",
  propose_action: "Drafting a proposal",
};

export function AssistantChat(props: {
  configured: boolean;
  model: string | null;
  mode: AssistantMode;
  initialProposals: AssistantProposalView[];
  initialAudit: AssistantAuditView[];
}) {
  const router = useRouter();
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [proposals, setProposals] = React.useState<AssistantProposalView[]>(props.initialProposals);
  const [input, setInput] = React.useState("");
  const [streaming, setStreaming] = React.useState(false);
  const [phase, setPhase] = React.useState<"thinking" | "tools" | null>(null);
  const [reachable, setReachable] = React.useState<boolean | null>(props.configured ? null : false);
  const [connectionError, setConnectionError] = React.useState<string | null>(null);
  const bottomRef = React.useRef<HTMLDivElement | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);

  // Passive status probe after mount — never during render, and not recorded
  // in the audit log (only explicit tests from Settings are).
  React.useEffect(() => {
    if (!props.configured) return;
    let cancelled = false;
    void testAssistantConnection().then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setReachable(result.data.reachable);
        setConnectionError(result.data.error);
      } else {
        setReachable(false);
        setConnectionError(result.error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [props.configured]);

  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, proposals, streaming]);

  React.useEffect(() => () => abortRef.current?.abort(), []);

  const pendingProposals = proposals.filter((proposal) => proposal.status === "proposed");

  async function send(text: string) {
    const message = text.trim();
    if (!message || streaming) return;
    setInput("");

    const history = messages
      .filter((entry) => !entry.error)
      .map((entry) => ({ role: entry.role, content: entry.content }));

    const userEntry: ChatMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      content: message,
      tools: [],
    };
    const assistantEntry: ChatMessage = {
      id: `a-${Date.now()}`,
      role: "assistant",
      content: "",
      tools: [],
    };
    setMessages((current) => [...current, userEntry, assistantEntry]);
    setStreaming(true);
    setPhase("thinking");

    const patchAssistant = (patch: (entry: ChatMessage) => ChatMessage) => {
      setMessages((current) =>
        current.map((entry) => (entry.id === assistantEntry.id ? patch(entry) : entry)),
      );
    };

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch("/api/assistant/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, history }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        patchAssistant((entry) => ({
          ...entry,
          error: body?.error ?? "The assistant could not be reached.",
        }));
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      let sawProposal = false;

      const handle = (event: AssistantStreamEvent) => {
        switch (event.type) {
          case "status":
            setPhase(event.state);
            return;
          case "token":
            patchAssistant((entry) => ({ ...entry, content: entry.content + event.text }));
            return;
          case "tool_start":
            patchAssistant((entry) => ({
              ...entry,
              tools: [...entry.tools, { tool: event.tool, ok: null }],
            }));
            return;
          case "tool_end":
            patchAssistant((entry) => {
              const tools = [...entry.tools];
              for (let index = tools.length - 1; index >= 0; index -= 1) {
                if (tools[index].tool === event.tool && tools[index].ok === null) {
                  tools[index] = { tool: event.tool, ok: event.ok };
                  break;
                }
              }
              return { ...entry, tools };
            });
            return;
          case "proposal":
            sawProposal = true;
            setProposals((current) => [event.proposal, ...current]);
            return;
          case "done":
            setPhase(null);
            return;
          case "error":
            patchAssistant((entry) => ({ ...entry, error: event.message }));
            setPhase(null);
            return;
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        for (;;) {
          const newline = buffered.indexOf("\n");
          if (newline === -1) break;
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (!line) continue;
          try {
            handle(JSON.parse(line) as AssistantStreamEvent);
          } catch {
            // A malformed line is dropped; the stream carries on.
          }
        }
      }

      // Proposals and audit entries were written server-side during the
      // exchange; refresh so a navigation elsewhere shows current state.
      if (sawProposal) router.refresh();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        patchAssistant((entry) => ({
          ...entry,
          error: "The connection to the assistant was interrupted.",
        }));
      }
    } finally {
      setStreaming(false);
      setPhase(null);
      abortRef.current = null;
    }
  }

  function onProposalDecided(updated: AssistantProposalView) {
    setProposals((current) =>
      current.map((proposal) => (proposal.id === updated.id ? updated : proposal)),
    );
    router.refresh();
  }

  if (!props.configured) {
    return (
      <div className="space-y-6">
        <EmptyState
          icon={Bot}
          title="The assistant isn't set up yet"
          description="Point it at your own Ollama server — on this machine or another on your network. No cloud AI, no API key, no card. Your data only ever goes to the server you choose."
          action={
            <Button asChild>
              <Link href="/settings#assistant">
                <Settings2 /> Set up in Settings
              </Link>
            </Button>
          }
        />
        <AssistantActivity entries={props.initialAudit} />
      </div>
    );
  }

  const modeMeta = ASSISTANT_MODE_META[props.mode];

  return (
    <div className="space-y-6">
      <div
        className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm"
        data-testid="assistant-status"
      >
        {reachable === null ? (
          <Badge variant="muted">
            <Loader2 className="mr-1 h-3 w-3 animate-spin" /> Checking Ollama…
          </Badge>
        ) : reachable ? (
          <Badge variant="success">
            <CheckCircle2 className="mr-1 h-3 w-3" /> Ollama connected
          </Badge>
        ) : (
          <Badge variant="danger">
            <XCircle className="mr-1 h-3 w-3" /> Ollama offline
          </Badge>
        )}
        <Badge variant="outline">{props.model}</Badge>
        <Badge
          variant={props.mode === "confirm" ? "warning" : "secondary"}
          data-testid="assistant-mode-badge"
        >
          {props.mode === "readonly" ? (
            <Eye className="mr-1 h-3 w-3" />
          ) : props.mode === "draft" ? (
            <Pencil className="mr-1 h-3 w-3" />
          ) : (
            <ShieldCheck className="mr-1 h-3 w-3" />
          )}
          {modeMeta.label}
        </Badge>
        <span className="text-xs text-muted-foreground">{modeMeta.description}</span>
        <Button asChild variant="ghost" size="sm" className="ml-auto">
          <Link href="/settings#assistant">
            <Settings2 /> Settings
          </Link>
        </Button>
      </div>

      {reachable === false && (
        <div className="flex items-start gap-2 rounded-lg border border-dashed px-3 py-2.5 text-sm text-muted-foreground">
          <CircleSlash className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {connectionError ?? "Could not reach the Ollama server."} Everything else in the app
            works normally; the assistant will answer again once the server is reachable.
          </span>
        </div>
      )}

      <div className="rounded-xl border bg-card shadow-sm">
        <div className="max-h-[52vh] min-h-48 space-y-4 overflow-y-auto p-4" data-testid="assistant-transcript">
          {messages.length === 0 ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Ask about your data, or ask for a change — changes are only ever previews until you
                confirm them.
              </p>
              <div className="flex flex-wrap gap-2">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => void send(suggestion)}
                    disabled={streaming}
                    className="rounded-full border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                  >
                    <Sparkles className="mr-1 inline h-3 w-3" />
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((entry) => (
              <div key={entry.id} className={cn("flex", entry.role === "user" && "justify-end")}>
                <div
                  className={cn(
                    "max-w-[85%] space-y-2 rounded-lg px-3 py-2 text-sm",
                    entry.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "border bg-muted/40",
                  )}
                >
                  {entry.tools.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {entry.tools.map((tool, index) => (
                        <span
                          key={`${tool.tool}-${index}`}
                          className="inline-flex items-center gap-1 rounded border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground"
                        >
                          {tool.ok === null ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : tool.ok ? (
                            <Wrench className="h-3 w-3" />
                          ) : (
                            <XCircle className="h-3 w-3" />
                          )}
                          {TOOL_LABELS[tool.tool] ?? tool.tool}
                        </span>
                      ))}
                    </div>
                  )}
                  {entry.content && <p className="whitespace-pre-wrap">{entry.content}</p>}
                  {entry.error && (
                    <p className="text-red-600 dark:text-red-400">{entry.error}</p>
                  )}
                  {entry.role === "assistant" &&
                    !entry.content &&
                    !entry.error &&
                    streaming && (
                      <p className="flex items-center gap-2 text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        {phase === "tools" ? "Looking things up…" : "Thinking…"}
                      </p>
                    )}
                </div>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>

        <form
          className="flex items-end gap-2 border-t p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void send(input);
          }}
        >
          <Textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send(input);
              }
            }}
            placeholder={
              reachable === false
                ? "Ollama is offline — start it, then ask away"
                : "Ask about your data… (Enter to send)"
            }
            maxLength={ASSISTANT_LIMITS.maxMessageChars}
            rows={2}
            className="min-h-0 resize-none"
            data-testid="assistant-input"
          />
          <Button
            type="submit"
            size="icon"
            disabled={streaming || input.trim() === ""}
            aria-label="Send"
            data-testid="assistant-send"
          >
            {streaming ? <Loader2 className="animate-spin" /> : <Send />}
          </Button>
        </form>
      </div>

      {pendingProposals.length > 0 && (
        <div className="space-y-3" data-testid="assistant-proposals">
          <h3 className="section-title">Waiting for your decision</h3>
          {pendingProposals.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              mode={props.mode}
              onDecided={onProposalDecided}
            />
          ))}
        </div>
      )}

      <AssistantActivity entries={props.initialAudit} decidedProposals={proposals} />
    </div>
  );
}
