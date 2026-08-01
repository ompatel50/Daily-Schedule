/**
 * The assistant's shared vocabulary and pure helpers — importable from client
 * and server alike (no Prisma, no fetch, no server-only).
 *
 * The safety model lives here as data: which modes exist, which actions the
 * assistant may propose, and how much confirmation each one demands. The
 * server enforces all of it; the client merely renders it. Nothing in this
 * file talks to a model or a database.
 */

/**
 * How much the assistant may do. Read-only is the default on purpose:
 * answering questions must never be one setting away from writing data.
 *
 *  - readonly: answer questions from tools; proposing changes is refused.
 *  - draft:    may also propose actions, shown as previews; nothing executes.
 *  - confirm:  proposed actions gain a Confirm button; execution happens only
 *              after that explicit click (plus a second, harder confirmation
 *              for sensitive and destructive actions).
 */
export const ASSISTANT_MODES = ["readonly", "draft", "confirm"] as const;
export type AssistantMode = (typeof ASSISTANT_MODES)[number];

export const ASSISTANT_MODE_META: Record<AssistantMode, { label: string; description: string }> = {
  readonly: {
    label: "Read-only",
    description: "Answers questions and summarizes. Never proposes or changes anything.",
  },
  draft: {
    label: "Draft",
    description: "May propose changes as previews. Nothing is ever saved.",
  },
  confirm: {
    label: "Confirm",
    description: "Proposed changes can be executed — only after you explicitly confirm each one.",
  },
};

/**
 * Every write the assistant can propose. Each kind maps to exactly one
 * existing server action (src/server/ai/proposals.ts) — the assistant has no
 * write path of its own. Adding a kind means adding it here, a payload schema,
 * and a dispatch arm; the exhaustiveness checks keep the three in step.
 */
export const ASSISTANT_ACTION_KINDS = [
  "create_task",
  "complete_task",
  "create_reminder",
  "create_inbox_item",
  "create_transaction",
  "create_planner_block",
  "log_habit",
  "complete_inbox_item",
  "delete_task",
  "delete_reminder",
] as const;
export type AssistantActionKind = (typeof ASSISTANT_ACTION_KINDS)[number];

/**
 * How much confirmation an action demands.
 *
 *  - normal:      one explicit Confirm click.
 *  - sensitive:   Confirm opens a second dialog restating the exact action
 *                 (finance records, reminders and schedule changes, per the
 *                 safety model).
 *  - destructive: same second dialog, styled as destructive — deletes always
 *                 land here, whatever the record type.
 */
export type AssistantRisk = "normal" | "sensitive" | "destructive";

const ACTION_RISK: Record<AssistantActionKind, AssistantRisk> = {
  create_task: "normal",
  complete_task: "normal",
  create_inbox_item: "normal",
  complete_inbox_item: "normal",
  // A habit log writes one day's outcome and is undone by clicking the same
  // checkbox — the same weight as completing a task, not a finance record.
  log_habit: "normal",
  create_reminder: "sensitive",
  create_transaction: "sensitive",
  create_planner_block: "sensitive",
  delete_task: "destructive",
  delete_reminder: "destructive",
};

export function riskOf(kind: AssistantActionKind): AssistantRisk {
  return ACTION_RISK[kind];
}

export const ASSISTANT_ACTION_META: Record<AssistantActionKind, { label: string }> = {
  create_task: { label: "Create task" },
  complete_task: { label: "Complete task" },
  create_reminder: { label: "Create reminder" },
  create_inbox_item: { label: "Add inbox note" },
  create_transaction: { label: "Record transaction" },
  create_planner_block: { label: "Add planner block" },
  log_habit: { label: "Log habit" },
  complete_inbox_item: { label: "Complete inbox note" },
  delete_task: { label: "Delete task" },
  delete_reminder: { label: "Delete reminder" },
};

/**
 * What each tool is called while it runs, in the transcript's activity chips.
 *
 * Lives here rather than in the chat component so the registry and the label
 * map can be pinned against each other by a test — a tool the UI has no name
 * for would otherwise silently show its raw identifier to the user.
 */
export const ASSISTANT_TOOL_LABELS: Record<string, string> = {
  search_records: "Searching your records",
  get_needs_attention: "Checking what needs attention",
  get_day_overview: "Reading the day",
  get_week_review: "Reviewing the week",
  get_schedule: "Reading the planner",
  list_tasks: "Reading tasks",
  list_inbox: "Reading the inbox",
  get_habit_status: "Checking your habits",
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

export const PROPOSAL_STATUSES = [
  "proposed",
  "confirmed",
  "rejected",
  "expired",
  "failed",
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/**
 * Plain words for the raw status strings stored on audit rows and proposals.
 * The database keeps machine values; the activity panel should not read like
 * a database dump.
 */
const STATUS_LABELS: Record<string, string> = {
  ok: "Done",
  error: "Failed",
  refused: "Refused",
  cancelled: "Cancelled",
  proposed: "Waiting",
  confirmed: "Confirmed",
  rejected: "Cancelled",
  expired: "Expired",
  failed: "Failed",
};

export function assistantStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

/** How long a proposal stays executable before the sweep expires it. */
export const PROPOSAL_TTL_MS = 60 * 60 * 1000;

/** Bounds shared by the engine, the audit log and the UI. */
export const ASSISTANT_LIMITS = {
  /** Longest user message the chat endpoint accepts. */
  maxMessageChars: 4_000,
  /** How many prior turns travel back to the model. */
  maxHistoryMessages: 12,
  /** Longest single history message forwarded to the model. */
  maxHistoryChars: 4_000,
  /** Model→tool rounds per exchange; past this the model must answer. */
  maxToolRounds: 4,
  /** Tool calls honoured per round; the rest are refused with a note. */
  maxToolCallsPerRound: 5,
  /** Longest serialized tool result handed back to the model. */
  maxToolResultChars: 8_000,
  /** Longest argument summary stored per tool call in the audit log. */
  maxAuditArgChars: 200,
  /** Longest request preview stored in proposals and audit entries. */
  maxRequestPreviewChars: 200,
} as const;

/** Truncate for storage/prompting, marking the cut so nobody mistakes it. */
export function truncateText(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** The bounded first-line preview stored for audit rows and proposals. */
export function requestPreviewOf(message: string): string {
  return truncateText(message, ASSISTANT_LIMITS.maxRequestPreviewChars);
}

export interface AuditToolCall {
  tool: string;
  args: string;
}

/** Parse the audit row's toolCalls JSON defensively — bad JSON is just []. */
export function parseAuditToolCalls(raw: string): AuditToolCall[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const tool = (entry as { tool?: unknown }).tool;
      const args = (entry as { args?: unknown }).args;
      if (typeof tool !== "string") return [];
      return [{ tool, args: typeof args === "string" ? args : "" }];
    });
  } catch {
    return [];
  }
}

/**
 * The serializable views that cross the server → client boundary. Defined
 * here (the client-safe half) so components can import the types without
 * touching the server-only modules that produce them.
 */
export interface AssistantProposalView {
  id: string;
  kind: AssistantActionKind;
  summary: string;
  risk: AssistantRisk;
  status: string;
  payload: Record<string, unknown>;
  resultSummary: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface AssistantAuditView {
  id: string;
  kind: string;
  status: string;
  summary: string;
  requestPreview: string;
  toolCalls: AuditToolCall[];
  model: string | null;
  durationMs: number | null;
  createdAt: string;
}

/** One NDJSON line of the /api/assistant/chat stream. */
export type AssistantStreamEvent =
  | { type: "status"; state: "thinking" | "tools" }
  | { type: "token"; text: string }
  | { type: "tool_start"; tool: string; args: string }
  | { type: "tool_end"; tool: string; ok: boolean }
  | { type: "proposal"; proposal: AssistantProposalView }
  | { type: "done"; content: string; durationMs: number }
  | { type: "error"; message: string };

export function isAssistantMode(value: unknown): value is AssistantMode {
  return typeof value === "string" && (ASSISTANT_MODES as readonly string[]).includes(value);
}

export function isAssistantActionKind(value: unknown): value is AssistantActionKind {
  return (
    typeof value === "string" && (ASSISTANT_ACTION_KINDS as readonly string[]).includes(value)
  );
}
