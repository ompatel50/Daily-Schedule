import "server-only";

import { z } from "zod";

import { formatMinute } from "@/lib/date";
import {
  FINANCE_CATEGORIES,
  PRIORITIES,
  SCHEDULE_CATEGORIES,
  isBookkeepingCategory,
} from "@/lib/enums";
import { wallClockToInstant } from "@/lib/logic/schedule";
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
 * validated three times before anything happens: by the narrow
 * assistant-facing schema below (which refuses any field the preview sentence
 * could not describe), by the domain schema at execution (`reparsePayload`),
 * and by the target server action itself. That is what makes "the preview the
 * user reads is exactly what would run" a property rather than a hope: the
 * stored payload names every field the action will see, explicitly.
 *
 * Execution lives in src/server/actions/assistant.ts and routes through the
 * existing server actions — this module never writes domain records.
 *
 * Rows are stamped, never deleted, so the activity feed keeps its history;
 * an undecided proposal expires after PROPOSAL_TTL_MS and stops being
 * executable.
 */

/** At most this many undecided proposals per account — a bound, not a queue. */
const MAX_PENDING_PROPOSALS = 10;

export type ProposalPreview = AssistantProposalView;

/**
 * Assistant-facing input schemas — deliberately NARROWER than the domain
 * schemas the actions use.
 *
 * The proposal contract is "the preview the user reads is exactly what would
 * run". That only holds if the assistant cannot supply a field the preview
 * does not describe: piping the model's payload straight through the full
 * `taskSchema`/`scheduleItemSchema` would accept `recurrenceRule`, `repeat`,
 * `reminderEnabled`, `parentId`, `tagIds`… — none of which the preview or the
 * tool contract mention, so a confirmed "add one planner block" could quietly
 * write a 120-day recurring series. These schemas accept ONLY the advertised
 * fields (`.strict()` rejects anything else, which also blocks a smuggled
 * `id` turning a create into an overwrite), and `prepareProposal` maps them
 * onto the domain action's input explicitly. The action then validates again.
 */
const createTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    notes: z.string().max(5000).nullable().optional(),
    dueDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date")
      .optional(),
    priority: z.enum(PRIORITIES).default("medium"),
  })
  .strict();

const createReminderSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    message: z.string().max(500).nullable().optional(),
    remindAt: z.string().min(1).max(40),
    repeat: z.enum(["none", "daily", "weekdays", "weekly"]).default("none"),
  })
  .strict();

const createInboxItemSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    notes: z.string().max(5000).nullable().optional(),
  })
  .strict();

const createTransactionSchema = z
  .object({
    accountId: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date"),
    // Signed and non-zero: negative is money out. Bounded like the domain schema.
    amount: z
      .number()
      .finite()
      .refine((value) => value !== 0, "Amount cannot be zero")
      .refine((value) => Math.abs(value) <= 1e12, "Amount is out of range"),
    payee: z.string().trim().min(1).max(200),
    category: z.enum(FINANCE_CATEGORIES).default("other"),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict()
  // The assistant records ordinary spend/income, never the bookkeeping legs of
  // a transfer or a balance adjustment — those have their own guarded actions.
  .refine((value) => !isBookkeepingCategory(value.category), {
    message: "Use a real spending or income category, not a transfer/adjustment.",
    path: ["category"],
  });

const createPlannerBlockSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date"),
    startMinute: z.number().int().min(0).max(1439).nullable().optional(),
    endMinute: z.number().int().min(0).max(1439).nullable().optional(),
    category: z.enum(SCHEDULE_CATEGORIES).default("personal"),
  })
  .strict()
  .refine(
    (value) =>
      value.startMinute === null ||
      value.startMinute === undefined ||
      value.endMinute === null ||
      value.endMinute === undefined ||
      value.endMinute >= value.startMinute,
    { message: "End time must be after the start time", path: ["endMinute"] },
  );

const byIdSchema = z.object({ id: z.string().min(1) }).strict();

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
        // Explicit, so the task that gets created is exactly the one the
        // sentence below describes: no repeat, no reminder, no parent, no
        // project, no tags — the assistant proposes plain tasks.
        payload: {
          title: data.title,
          notes: data.notes ?? null,
          dueDate: data.dueDate ?? null,
          priority: data.priority,
          repeat: "none",
          repeatEvery: 1,
          reminderEnabled: false,
          tags: [],
        },
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
        payload: { id: task.id },
        summary: `Mark task “${task.title}” as done`,
      };
    }
    case "create_reminder": {
      const parsed = createReminderSchema.safeParse(payload);
      if (!parsed.success) return invalid(parsed.error);
      const data = parsed.data;
      // The model writes the user's own wall clock ("2026-08-02T09:00"), so it
      // must be resolved in the USER's timezone before it becomes an instant.
      // `saveReminder` would otherwise parse it in the server's zone — UTC on
      // a hosted deployment — and a 9am reminder would fire at 5am.
      const when = wallClockToInstant(data.remindAt, user.timezone);
      if (!when) {
        return { ok: false, error: "Invalid reminder time — use YYYY-MM-DDTHH:mm." };
      }
      const shown = data.remindAt.trim().replace("T", " ").slice(0, 16);
      return {
        ok: true,
        // Stored as an absolute instant: what the user confirms is a moment,
        // not a string that could be re-interpreted differently later.
        payload: {
          title: data.title,
          message: data.message ?? null,
          remindAt: when.toISOString(),
          repeat: data.repeat,
          enabled: true,
        },
        summary: `Create reminder “${data.title}” for ${shown}${
          data.repeat !== "none" ? ` (repeats ${data.repeat})` : ""
        }`,
      };
    }
    case "create_inbox_item": {
      const parsed = createInboxItemSchema.safeParse(payload);
      if (!parsed.success) return invalid(parsed.error);
      return {
        ok: true,
        payload: { title: parsed.data.title, notes: parsed.data.notes ?? null },
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
        payload: {
          accountId: data.accountId,
          date: data.date,
          amount: data.amount,
          payee: data.payee,
          category: data.category,
          notes: data.notes ?? null,
          billId: null,
        },
        summary: `Record ${Math.abs(data.amount).toFixed(2)} ${account.currency} ${direction} at “${data.payee}” on ${data.date} (${account.name})`,
      };
    }
    case "create_planner_block": {
      const parsed = createPlannerBlockSchema.safeParse(payload);
      if (!parsed.success) return invalid(parsed.error);
      const data = parsed.data;
      const timed = data.startMinute !== null && data.startMinute !== undefined;
      const time = timed
        ? ` at ${formatMinute(data.startMinute as number)}${
            data.endMinute !== null && data.endMinute !== undefined
              ? `–${formatMinute(data.endMinute)}`
              : ""
          }`
        : " (all day)";
      return {
        ok: true,
        // Every field the action will see is set here, explicitly. A planner
        // block the assistant proposes is always a single occurrence: no
        // recurrence rule, no tags, no habit link — none of which the preview
        // could honestly describe.
        payload: {
          title: data.title,
          date: data.date,
          allDay: !timed,
          startMinute: timed ? data.startMinute : null,
          endMinute: timed ? (data.endMinute ?? null) : null,
          category: data.category,
          priority: "medium",
          status: "planned",
          recurrenceRule: null,
          tagIds: [],
        },
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
        payload: { id: task.id },
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
        payload: { id: reminder.id },
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

/**
 * Re-validate a stored payload immediately before execution.
 *
 * `prepareProposal` stored the DOMAIN action's input (every field explicit),
 * so this checks it against that same domain schema — the third and last
 * validation, after the assistant-facing schema at proposal time and the
 * action's own check at execution. A row that no longer parses is refused
 * rather than executed on a best guess.
 */
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
      ? taskSchema
      : kind === "create_reminder"
        ? reminderSchema
        : kind === "create_inbox_item"
          ? inboxItemSchema
          : kind === "create_transaction"
            ? financeTransactionSchema
            : kind === "create_planner_block"
              ? scheduleItemSchema
              : byIdSchema;
  const checked = schema.safeParse(parsed);
  if (!checked.success) return { ok: false, error: "The stored proposal is no longer valid." };
  return { ok: true, payload: checked.data };
}
