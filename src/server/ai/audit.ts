import "server-only";

import { prisma } from "@/lib/prisma";
import {
  ASSISTANT_LIMITS,
  parseAuditToolCalls,
  truncateText,
  type AssistantAuditView,
  type AuditToolCall,
} from "@/lib/logic/assistant";

/**
 * The assistant's audit trail — append-only, bounded, app-authored.
 *
 * One row per assistant exchange, per decided proposal and per connection
 * test. What gets stored is deliberately a summary, not a transcript: a
 * truncated first line of the request, tool names with truncated argument
 * previews, and an outcome. Enough to answer "what did the assistant do and
 * when", never a copy of the user's data or the model's prose.
 */

export interface AuditEntryInput {
  userId: string;
  kind: "chat" | "action" | "connection";
  status: "ok" | "error" | "refused" | "cancelled";
  summary: string;
  requestPreview?: string;
  toolCalls?: Array<{ tool: string; args: unknown }>;
  proposalId?: string | null;
  model?: string | null;
  durationMs?: number | null;
}

export async function writeAuditEntry(input: AuditEntryInput): Promise<void> {
  const toolCalls: AuditToolCall[] = (input.toolCalls ?? []).map((call) => ({
    tool: truncateText(call.tool, 60),
    args: truncateText(safeStringify(call.args), ASSISTANT_LIMITS.maxAuditArgChars),
  }));

  await prisma.assistantAuditEntry.create({
    data: {
      userId: input.userId,
      kind: input.kind,
      status: input.status,
      summary: truncateText(input.summary, 300),
      requestPreview: truncateText(
        input.requestPreview ?? "",
        ASSISTANT_LIMITS.maxRequestPreviewChars,
      ),
      toolCalls: JSON.stringify(toolCalls),
      proposalId: input.proposalId ?? null,
      model: input.model ?? null,
      durationMs: input.durationMs ?? null,
    },
  });
}

export type AuditEntryView = AssistantAuditView;

/** Recent audit rows for the assistant page, newest first. */
export async function listAuditEntries(userId: string, limit = 20): Promise<AuditEntryView[]> {
  const rows = await prisma.assistantAuditEntry.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 50),
  });
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    summary: row.summary,
    requestPreview: row.requestPreview,
    toolCalls: parseAuditToolCalls(row.toolCalls),
    model: row.model,
    durationMs: row.durationMs,
    createdAt: row.createdAt.toISOString(),
  }));
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
