import "server-only";

import { z } from "zod";

import { formatMinute } from "@/lib/date";
import { prisma } from "@/lib/prisma";
import {
  ASSISTANT_ACTION_META,
  PROPOSAL_TTL_MS,
  isAssistantActionKind,
  riskOf,
  truncateText,
  type AssistantActionKind,
  type AssistantProposalView,
  type AssistantRisk,
} from "@/lib/logic/assistant";
import {
  inboxItemSchema,
  financeTransactionSchema,
  reminderSchema,
  scheduleItemSchema,
  taskSchema,
} from "@/lib/validation";
import type { CurrentUser } from "@/server/auth/current-user";

/**
 * Proposals — the assistant's draft-before-write staging layer.
 *
 * A proposal is born here when the model calls `propose_action`, and it is
 * validated twice with the SAME zod schema the target server action uses:
 * once now, so the preview the user reads is exactly what would run, and
 * again at execution (both here and inside the action itself), so nothing
 * can drift between the click and the write. Execution lives in
 * src/server/actions/assistant.ts and routes through the existing server
 * actions — this module never writes domain records.
 *
 * Rows are stamped, never deleted, so the activity feed keeps its history;
 * an undecided proposal expires after PROPOSAL_TTL_MS and stops being
 * executable.
 */

/** At most this many undecided proposals per account — a bound, not a queue. */
const MAX_PENDING_PROPOSALS = 10;

export type ProposalPreview = AssistantProposalView;

/** The create-only variants: an assistant proposal must never smuggle an id
 *  into a save action and turn "create" into "overwrite". */
const createTaskSchema = z
  .object({})
  .passthrough()
  .transform((value) => ({ ...value, id: undefined }))
  .pipe(taskSchema);
const createReminderSchema = z
  .object({})
  .passthrough()
  .transform((value) => ({ ...value, id: undefined }))
  .pipe(reminderSchema);
const createInboxItemSchema = z
  .object({})
  .passthrough()
  .transform((value) => ({ ...value, id: undefined }))
  .pipe(inboxItemSchema);
const createTransactionSchema = z
  .object({})
  .passthrough()
  .transform((value) => ({ ...value, id: undefined }))
  .pipe(financeTransactionSchema);
const createPlannerBlockSchema = z
  .object({})
  .passthrough()
  .transform((value) => ({ ...value, id: undefined }))
  .pipe(scheduleItemSchema);

const byIdSchema = z.object({ id: z.string().min(1) });

type PreviewOutcome =
  | { ok: true; proposal: ProposalPreview }
  | { ok: false; error: string };

/**
 * Validate a proposed action, phrase it, and stage it for the user to decide.
 * Referenced records are ownership-checked NOW so the preview can name them —
 * and checked again at execution by the action itself.
 */
export async function buildProposalPreview(
  user: CurrentUser,
  kind: string,
  payload: Record<string, unknown>,
): Promise<PreviewOutcome> {
  if (!isAssistantActionKind(kind)) {
    return { ok: false, error: `Unknown action kind "${truncateText(kind, 40)}".` };
  }

  const prepared = await prepareProposal(user, kind, payload);
  if (!prepared.ok) return prepared;

  await sweepExpiredProposals(user.id);
  const pending = await prisma.assistantProposal.count({
    where: { userId: user.id, status: "proposed" },
  });
  if (pending >= MAX_PENDING_PROPOSALS) {
    return {
      ok: false,
      error:
        "There are already several undecided proposals. Ask the user to confirm or cancel those first.",
    };
  }

  const row = await prisma.assistantProposal.create({
    data: {
      userId: user.id,
      kind,
      payload: JSON.stringify(prepared.payload),
      summary: prepared.summary,
      risk: riskOf(kind),
      status: "proposed",
      expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
    },
  });
  return { ok: true, proposal: toPreview(row) };
}

interface PreparedProposal {
  ok: true;
  /** Normalized payload — schema defaults applied, ids resolved. */
  payload: Record<string, unknown>;
  summary: string;
}

type PrepareOutcome = PreparedProposal | { ok: false; error: string };

async function prepareProposal(
  user: CurrentUser,
  kind: AssistantActionKind,
  payload: Record<string, unknown>,
): Promise<PrepareOutcome> {
  const invalid = (error: z.ZodError): PrepareOutcome => {
    const first = error.issues[0];
    return {
      ok: false,
      error: `Invalid ${ASSISTANT_ACTION_META[kind].label.toLowerCase()} payload: ${
        first ? `${first.path.join(".") || "input"} — ${first.message}` : "could not be read"
      }.`,
    };
  };

  switch (kind) {
    case "create_task": {
      const parsed = createTaskSchema.safeParse(payload);
      if (!parsed.success) return invalid(parsed.error);
      const data = parsed.data;
      const detail = [
        data.dueDate ? `due ${data.dueDate}` : null,
        data.priority !== "medium" ? `${data.priority} priority` : null,
      ].filter(Boolean);
      return {
        ok: true,
        payload: data,
        summary: `Create task “${data.title}”${detail.length ? ` (${detail.join(", ")})` : ""}`,
      };
    }
    case "complete_task": {
      const parsed = byIdSchema.safeParse(payload);
      if (!parsed.success) return invalid(parsed.error);
      const task = await prisma.task.findFirst({
        where: { id: parsed.data.id, userId: user.id },
        select: { id: true, title: true, status: true },
      });
      if (!task) return { ok: false, error: "Task not found." };
      if (task.status !== "open") return { ok: false, error: "That task is not open." };
      return {
        ok: true,
        payload: { id: task.id, title: task.title },
        summary: `Mark task “${task.title}” as done`,
      };
    }
    case "create_reminder": {
      const parsed = createReminderSchema.safeParse(payload);
      if (!parsed.success) return invalid(parsed.error);
      const data = parsed.data;
      const when = new Date(data.remindAt);
      if (Number.isNaN(when.getTime())) {
        return { ok: false, error: "Invalid reminder time — use YYYY-MM-DDTHH:mm." };
      }
      return {
        ok: true,
        payload: data,
        summary: `Create reminder “${data.title}” for ${data.remindAt.replace("T", " ")}${
          data.repeat !== "none" ? ` (repeats ${data.repeat})` : ""
        }`,
      };
    }
    case "create_inbox_item": {
      const parsed = createInboxItemSchema.safeParse(payload);
      if (!parsed.success) return invalid(parsed.error);
      return {
        ok: true,
        payload: parsed.data,
        summary: `Add inbox note “${parsed.data.title}”`,
      };
    }
    case "create_transaction": {
      const parsed = createTransactionSchema.safeParse(payload);
      if (!parsed.success) return invalid(parsed.error);
      const data = parsed.data;
      const account = await prisma.financeAccount.findFirst({
        where: { id: data.accountId, userId: user.id },
        select: { name: true, currency: true },
      });
      if (!account) return { ok: false, error: "Account not found." };
      const direction = data.amount < 0 ? "out" : "in";
      return {
        ok: true,
        payload: data,
        summary: `Record ${Math.abs(data.amount).toFixed(2)} ${account.currency} ${direction} at “${data.payee}” on ${data.date} (${account.name})`,
      };
    }
    case "create_planner_block": {
      const parsed = createPlannerBlockSchema.safeParse(payload);
      if (!parsed.success) return invalid(parsed.error);
      const data = parsed.data;
      const time =
        !data.allDay && data.startMinute !== null && data.startMinute !== undefined
          ? ` at ${formatMinute(data.startMinute)}`
          : "";
      return {
        ok: true,
        payload: data,
        summary: `Add “${data.title}” to the planner on ${data.date}${time}`,
      };
    }
    case "delete_task": {
      const parsed = byIdSchema.safeParse(payload);
      if (!parsed.success) return invalid(parsed.error);
      const task = await prisma.task.findFirst({
        where: { id: parsed.data.id, userId: user.id },
        select: { id: true, title: true, subtasks: { select: { id: true } } },
      });
      if (!task) return { ok: false, error: "Task not found." };
      const subtasks = task.subtasks.length;
      return {
        ok: true,
        payload: { id: task.id, title: task.title },
        summary: `Delete task “${task.title}”${
          subtasks > 0 ? ` and its ${subtasks} subtask${subtasks === 1 ? "" : "s"}` : ""
        } — permanent`,
      };
    }
    case "delete_reminder": {
      const parsed = byIdSchema.safeParse(payload);
      if (!parsed.success) return invalid(parsed.error);
      const reminder = await prisma.reminder.findFirst({
        where: { id: parsed.data.id, userId: user.id },
        select: { id: true, title: true },
      });
      if (!reminder) return { ok: false, error: "Reminder not found." };
      return {
        ok: true,
        payload: { id: reminder.id, title: reminder.title },
        summary: `Delete reminder “${reminder.title}” — permanent`,
      };
    }
  }
}

/** Stamp undecided proposals whose window has passed. Cheap, indexed. */
export async function sweepExpiredProposals(userId: string): Promise<number> {
  const swept = await prisma.assistantProposal.updateMany({
    where: { userId, status: "proposed", expiresAt: { lt: new Date() } },
    data: { status: "expired", decidedAt: new Date() },
  });
  return swept.count;
}

/** Recent proposals for the activity panel — every status, newest first. */
export async function listRecentProposals(userId: string, limit = 20): Promise<ProposalPreview[]> {
  await sweepExpiredProposals(userId);
  const rows = await prisma.assistantProposal.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 50),
  });
  return rows.map(toPreview);
}

export function toPreview(row: {
  id: string;
  kind: string;
  summary: string;
  risk: string;
  status: string;
  payload: string;
  resultSummary: string | null;
  createdAt: Date;
  expiresAt: Date;
}): ProposalPreview {
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.payload);
    if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
  } catch {
    // A payload that cannot be parsed renders as an empty preview; execution
    // re-parses and refuses it properly.
  }
  return {
    id: row.id,
    kind: row.kind as AssistantActionKind,
    summary: row.summary,
    risk: row.risk as AssistantRisk,
    status: row.status,
    payload,
    resultSummary: row.resultSummary,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

/** Re-parse a stored payload with the kind's schema before execution. */
export function reparsePayload(
  kind: AssistantActionKind,
  raw: string,
): { ok: true; payload: unknown } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "The stored proposal could not be read." };
  }
  const schema =
    kind === "create_task"
      ? createTaskSchema
      : kind === "create_reminder"
        ? createReminderSchema
        : kind === "create_inbox_item"
          ? createInboxItemSchema
          : kind === "create_transaction"
            ? createTransactionSchema
            : kind === "create_planner_block"
              ? createPlannerBlockSchema
              : byIdSchema;
  const checked = schema.safeParse(parsed);
  if (!checked.success) return { ok: false, error: "The stored proposal is no longer valid." };
  return { ok: true, payload: checked.data };
}
