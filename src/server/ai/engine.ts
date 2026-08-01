import "server-only";

import {
  ASSISTANT_LIMITS,
  truncateText,
  type AssistantMode,
  type AssistantStreamEvent,
} from "@/lib/logic/assistant";
import type { ScheduleSettings } from "@/lib/logic/schedule";
import type { CurrentUser } from "@/server/auth/current-user";
import type { ProposalPreview } from "@/server/ai/proposals";
import {
  runTool,
  serializeToolResult,
  toolsForMode,
  type ToolContext,
} from "@/server/ai/tools";
import {
  chatOllama,
  streamOllamaChat,
  type OllamaChatMessage,
  type OllamaToolCall,
  type OllamaToolSchema,
} from "@/server/ai/ollama";

/**
 * The exchange engine: one user message in, a bounded tool loop, a streamed
 * answer out. The model proposes tool calls; this module runs them through
 * the registry (which validates and scopes them) and feeds the results back,
 * for at most ASSISTANT_LIMITS.maxToolRounds rounds. On the last round the
 * tools are withheld, so the model must answer with what it has.
 *
 * The engine never touches Prisma and never sees a userId argument — the
 * ToolContext carries the authenticated user, resolved once at the API
 * boundary. Everything the caller needs for the audit log comes back in the
 * result: which tools ran, what was proposed, how long it took.
 */

export type EngineEvent = AssistantStreamEvent;

export interface EngineResult {
  status: "ok" | "error";
  content: string;
  error?: string;
  toolCalls: Array<{ tool: string; args: unknown }>;
  proposals: ProposalPreview[];
  durationMs: number;
}

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

function systemPrompt(user: CurrentUser, settings: ScheduleSettings, mode: AssistantMode): string {
  const modeRule =
    mode === "readonly"
      ? "You are in READ-ONLY mode: you may answer and summarize, but you cannot propose or make changes. If asked to change something, explain that read-only mode is on and where to change it (assistant settings)."
      : mode === "draft"
        ? "You are in DRAFT mode: you may propose changes with the propose_action tool. Proposals are previews only — nothing executes in draft mode, and you must say so."
        : "You are in CONFIRM mode: you may propose changes with the propose_action tool. A proposal executes ONLY after the user clicks Confirm on the preview card. Never claim a change happened — the user decides.";

  return [
    "You are the private assistant inside Personal OS, the user's personal planner, finance, tasks, health and life-admin app. You run entirely on the user's own Ollama server; nothing leaves their machines.",
    `Today is ${settings.today} in the user's timezone (${user.timezone}). The week starts on ${settings.weekStartsOn === 0 ? "Sunday" : "Monday"}. Units: ${user.unitSystem}.`,
    "Use the tools to look at the user's real data before answering questions about it. Never invent records, numbers or ids — if a tool fails or returns nothing, say so plainly. Cite what you looked at in passing (\"among your open tasks…\"), not as a list of tool names.",
    modeRule,
    "Be factual and non-judgemental: report what the data says, do not praise, scold, diagnose or give medical advice. Be concise — short paragraphs or short lists, plain text, no markdown tables or headers.",
    "Dates are YYYY-MM-DD strings. Money amounts are signed: negative means money out.",
  ].join("\n\n");
}

function toOllamaTools(ctx: ToolContext): OllamaToolSchema[] {
  return toolsForMode(ctx.mode).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function boundedHistory(history: HistoryMessage[]): OllamaChatMessage[] {
  return history.slice(-ASSISTANT_LIMITS.maxHistoryMessages).map((message) => ({
    role: message.role,
    content:
      message.content.length > ASSISTANT_LIMITS.maxHistoryChars
        ? `${message.content.slice(0, ASSISTANT_LIMITS.maxHistoryChars)}…`
        : message.content,
  }));
}

export async function runAssistantExchange(options: {
  user: CurrentUser;
  settings: ScheduleSettings;
  mode: AssistantMode;
  baseUrl: string;
  model: string;
  message: string;
  history: HistoryMessage[];
  signal?: AbortSignal;
  emit: (event: EngineEvent) => void | Promise<void>;
}): Promise<EngineResult> {
  const started = Date.now();
  const ctx: ToolContext = { user: options.user, settings: options.settings, mode: options.mode };
  const auditCalls: Array<{ tool: string; args: unknown }> = [];
  const proposals: ProposalPreview[] = [];

  const messages: OllamaChatMessage[] = [
    { role: "system", content: systemPrompt(options.user, options.settings, options.mode) },
    ...boundedHistory(options.history),
    { role: "user", content: options.message },
  ];
  const tools = toOllamaTools(ctx);

  const fail = async (message: string): Promise<EngineResult> => {
    await options.emit({ type: "error", message });
    return {
      status: "error",
      content: "",
      error: message,
      toolCalls: auditCalls,
      proposals,
      durationMs: Date.now() - started,
    };
  };

  for (let round = 0; round <= ASSISTANT_LIMITS.maxToolRounds; round += 1) {
    const lastRound = round === ASSISTANT_LIMITS.maxToolRounds;
    await options.emit({ type: "status", state: "thinking" });

    // Streaming for every round: prose reaches the user as it is produced,
    // and a round that turns out to be tool calls simply streamed nothing.
    const turn = await streamOllamaChat({
      baseUrl: options.baseUrl,
      model: options.model,
      messages,
      tools: lastRound ? undefined : tools,
      signal: options.signal,
      onToken: (token) => options.emit({ type: "token", text: token }),
    });
    if (!turn.ok) return fail(turn.failure.message);

    const { content, toolCalls } = turn.data;
    if (toolCalls.length === 0) {
      const durationMs = Date.now() - started;
      await options.emit({ type: "done", content, durationMs });
      return { status: "ok", content, toolCalls: auditCalls, proposals, durationMs };
    }

    await options.emit({ type: "status", state: "tools" });
    messages.push({ role: "assistant", content, tool_calls: toolCalls });

    const honoured = toolCalls.slice(0, ASSISTANT_LIMITS.maxToolCallsPerRound);
    for (const call of honoured) {
      const name = call.function?.name ?? "";
      const args = (call.function?.arguments ?? {}) as Record<string, unknown>;
      auditCalls.push({ tool: name, args });
      await options.emit({
        type: "tool_start",
        tool: name,
        args: truncateText(JSON.stringify(args) ?? "", 120),
      });

      const outcome = await runTool(ctx, name, args);
      if (outcome.proposal) {
        proposals.push(outcome.proposal);
        await options.emit({ type: "proposal", proposal: outcome.proposal });
      }
      await options.emit({ type: "tool_end", tool: name, ok: outcome.ok });
      messages.push({
        role: "tool",
        tool_name: name,
        content: serializeToolResult(outcome),
      });
    }
    for (const ignored of toolCalls.slice(ASSISTANT_LIMITS.maxToolCallsPerRound)) {
      messages.push({
        role: "tool",
        tool_name: ignored.function?.name ?? "unknown",
        content: JSON.stringify({
          error: "Too many tool calls in one round; this one was not run.",
        }),
      });
    }
  }

  // Unreachable: the last round carries no tools, so it cannot request more.
  return fail("The assistant could not finish answering.");
}

/**
 * A non-streaming single question — used by tests and anywhere a full
 * round-trip without an event stream is enough.
 */
export async function runAssistantOnce(options: {
  user: CurrentUser;
  settings: ScheduleSettings;
  mode: AssistantMode;
  baseUrl: string;
  model: string;
  message: string;
  history?: HistoryMessage[];
}): Promise<EngineResult> {
  return runAssistantExchange({ ...options, history: options.history ?? [], emit: () => {} });
}

/** Exported for tests: the exact prompt/context assembly. */
export const internals = { systemPrompt, boundedHistory, toOllamaTools };
export type { OllamaToolCall };
export { chatOllama };
