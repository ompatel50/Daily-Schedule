import "server-only";

import { z } from "zod";

import { formatMinute, type DayKey } from "@/lib/date";
import {
  FINANCE_CATEGORIES,
  HABIT_STATUSES,
  PRIORITIES,
  SCHEDULE_CATEGORIES,
  isBookkeepingCategory,
} from "@/lib/enums";
import { operationalDayOfRecord, operationalDayWhere } from "@/lib/logic/operational-day";
import { isSchedulingConflict, type ConflictCandidate } from "@/lib/logic/planner";
import {
  describeRecurrence,
  parseRule,
  serializeRule,
  type RecurrenceRule,
} from "@/lib/logic/recurrence";
import { resetMinuteOf, wallClockToInstant } from "@/lib/logic/schedule";
import { scheduleSettingsFor } from "@/server/schedule";
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
  habitLogSchema,
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

/**
 * Recurrence the assistant may propose, spelled out field by field so the
 * preview sentence can describe every part of it. `endDate` is the series'
 * INCLUSIVE end; explicit `null` means "no end date". On updates, an absent
 * `endDate` inherits the series' existing end date — absent and null are
 * deliberately different.
 */
const plannerRecurrenceSchema = z
  .object({
    repeat: z.enum(["daily", "weekdays", "weekly", "monthly"]),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    interval: z.number().int().min(1).max(30).optional(),
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date")
      .nullable()
      .optional(),
  })
  .strict();

type PlannerRecurrenceInput = z.infer<typeof plannerRecurrenceSchema>;

/** The stored rule a proposed recurrence resolves to. */
function ruleFromRecurrenceInput(
  input: PlannerRecurrenceInput,
  inheritedUntil?: string,
): RecurrenceRule {
  return {
    freq: input.repeat === "weekdays" ? "weekly" : input.repeat,
    interval: input.repeat === "weekdays" ? 1 : Math.max(1, input.interval ?? 1),
    byWeekday:
      input.repeat === "weekly"
        ? (input.weekdays ?? [])
        : input.repeat === "weekdays"
          ? [1, 2, 3, 4, 5]
          : [],
    until:
      input.endDate === undefined
        ? inheritedUntil
        : input.endDate === null
          ? undefined
          : input.endDate,
  };
}

const createPlannerBlockSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date"),
    startMinute: z.number().int().min(0).max(1439).nullable().optional(),
    endMinute: z.number().int().min(0).max(1439).nullable().optional(),
    category: z.enum(SCHEDULE_CATEGORIES).default("personal"),
    recurrence: plannerRecurrenceSchema.optional(),
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
  )
  .refine(
    (value) =>
      !value.recurrence ||
      value.recurrence.endDate === null ||
      value.recurrence.endDate === undefined ||
      value.recurrence.endDate >= value.date,
    { message: "The end date cannot be before the start date", path: ["recurrence"] },
  );

/**
 * Editing or deleting an existing planner block. On a recurring block the
 * scope is REQUIRED and explicit — "this occurrence" or "this and future" —
 * the assistant can never guess it, and a one-occurrence edit cannot carry a
 * recurrence change (that is a series reshape, which is what "future" means).
 */
const updatePlannerBlockSchema = z
  .object({
    id: z.string().min(1),
    scope: z.enum(["one", "future"]).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date")
      .optional(),
    startMinute: z.number().int().min(0).max(1439).nullable().optional(),
    endMinute: z.number().int().min(0).max(1439).nullable().optional(),
    category: z.enum(SCHEDULE_CATEGORIES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    notes: z.string().max(5000).nullable().optional(),
    /** `null` = stop repeating from this point; absent = keep the pattern. */
    recurrence: plannerRecurrenceSchema.nullable().optional(),
  })
  .strict();

const deletePlannerBlockSchema = z
  .object({
    id: z.string().min(1),
    scope: z.enum(["one", "future"]).optional(),
  })
  .strict();

/**
 * The titles a proposed span would double-book, using the same tolerant rule
 * as every planner warning — adjacent blocks stay quiet. Bounded to the one
 * operational day being proposed; a changed recurring series is *not*
 * scanned into the future, the preview says so instead.
 */
async function conflictTitlesFor(
  userId: string,
  resetMinute: number,
  day: DayKey,
  startMinute: number | null,
  endMinute: number | null,
  excludeId?: string,
): Promise<string[]> {
  if (startMinute === null || endMinute === null) return [];
  const others = await prisma.scheduleItem.findMany({
    where: { userId, ...operationalDayWhere(day, resetMinute) },
    select: { id: true, title: true, startMinute: true, endMinute: true, allDay: true, status: true },
  });
  const draft: ConflictCandidate = {
    id: excludeId ?? "__draft__",
    title: "",
    startMinute,
    endMinute,
    allDay: false,
  };
  return others
    .filter((other) => isSchedulingConflict(draft, other))
    .sort((a, b) => (a.startMinute ?? 0) - (b.startMinute ?? 0))
    .map((other) => other.title);
}

/**
 * Logging one habit day. `notes` is deliberately absent: free text the model
 * authored would ride along in a record the preview sentence cannot quote in
 * full, and the checkbox in the app does not write notes either. `excused` is
 * absent too — it is a different server action, and one kind maps to one
 * action here by design.
 */
const logHabitSchema = z
  .object({
    habitId: z.string().min(1),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date")
      .optional(),
    status: z.enum(HABIT_STATUSES).default("done"),
    value: z
      .number()
      .finite()
      .min(0)
      .max(1e6)
      .nullable()
      .optional(),
  })
  .strict();

const byIdSchema = z.object({ id: z.string().min(1) }).strict();

/**
 * The stored shapes of the scoped planner writes, re-validated at execution.
 * The scope is part of the stored payload — it cannot drift from what the
 * preview described. The assistant never gets the whole-series-with-history
 * scope; that stays a deliberate in-app action.
 */
const storedUpdatePlannerBlockSchema = z.object({
  scope: z.enum(["one", "future"]),
  item: scheduleItemSchema,
});

const storedDeletePlannerBlockSchema = z
  .object({
    id: z.string().min(1),
    scope: z.enum(["one", "future"]),
  })
  .strict();

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
      // Recurrence only ever comes through the explicit `recurrence` object
      // above, and the sentence below spells out its pattern, start and end —
      // a raw recurrenceRule in the payload is still refused by `.strict()`,
      // so a "single block" can never quietly become a 120-row series.
      const rule = data.recurrence ? ruleFromRecurrenceInput(data.recurrence) : null;
      const conflicts = timed
        ? await conflictTitlesFor(
            user.id,
            resetMinuteOf(scheduleSettingsFor(user)),
            data.date,
            data.startMinute as number,
            (data.endMinute ?? null) as number | null,
          )
        : [];
      return {
        ok: true,
        // Every field the action will see is set here, explicitly — no tags,
        // no habit link, and exactly the recurrence the sentence describes.
        payload: {
          title: data.title,
          date: data.date,
          allDay: !timed,
          startMinute: timed ? data.startMinute : null,
          endMinute: timed ? (data.endMinute ?? null) : null,
          category: data.category,
          priority: "medium",
          status: "planned",
          recurrenceRule: serializeRule(rule),
          tagIds: [],
        },
        summary: `Add “${data.title}” to the planner on ${data.date}${time}${
          rule ? ` — repeats ${describeRecurrence(rule, data.date)}` : ""
        }${conflicts.length ? ` — overlaps ${conflicts.join(", ")}` : ""}`,
      };
    }
    case "update_planner_block": {
      const parsed = updatePlannerBlockSchema.safeParse(payload);
      if (!parsed.success) return invalid(parsed.error);
      const data = parsed.data;
      const item = await prisma.scheduleItem.findFirst({
        where: { id: data.id, userId: user.id },
        include: { tags: true },
      });
      if (!item) return { ok: false, error: "Planner block not found." };

      const recurring = Boolean(item.seriesId) || Boolean(item.recurrenceRule);
      // The scope question is the user's, never the model's: a recurring
      // block without an explicit scope is refused, not guessed.
      if (recurring && !data.scope) {
        return {
          ok: false,
          error:
            'This block repeats. Ask the user whether the change applies to this occurrence only or to this and all future occurrences, then send scope: "one" or scope: "future".',
        };
      }
      const scope: "one" | "future" = recurring ? (data.scope as "one" | "future") : "one";
      if (recurring && scope === "one" && data.recurrence !== undefined) {
        return {
          ok: false,
          error:
            'A single occurrence cannot change how the series repeats. Propose scope: "future" for recurrence changes.',
        };
      }

      const settings = scheduleSettingsFor(user);
      const reset = resetMinuteOf(settings);
      const currentDay = operationalDayOfRecord(item, reset);
      const targetDay = (data.date as DayKey | undefined) ?? currentDay;

      // Resolve the span: a new start keeps the block's duration unless a new
      // end is given; an explicit null start makes it all-day.
      let allDay = item.allDay;
      let startMinute = item.startMinute;
      let endMinute = item.endMinute;
      if (data.startMinute !== undefined) {
        if (data.startMinute === null) {
          allDay = true;
          startMinute = null;
          endMinute = null;
        } else {
          allDay = false;
          startMinute = data.startMinute;
          endMinute =
            data.endMinute !== undefined
              ? data.endMinute
              : item.startMinute !== null && item.endMinute !== null
                ? Math.min(1439, data.startMinute + (item.endMinute - item.startMinute))
                : null;
        }
      } else if (data.endMinute !== undefined) {
        endMinute = data.endMinute;
        if (endMinute !== null) allDay = false;
      }
      if (startMinute !== null && endMinute !== null && endMinute < startMinute) {
        return { ok: false, error: "The end time must be after the start time." };
      }

      // The recurrence the write will carry. Inheritance is explicit: an
      // absent `recurrence` keeps the stored rule (end date included); an
      // absent `endDate` inside a given recurrence inherits the old end date;
      // `endDate: null` removes it; `recurrence: null` stops the repeat here.
      const parent = item.seriesId
        ? await prisma.scheduleItem.findFirst({
            where: { id: item.seriesId, userId: user.id },
            select: { recurrenceRule: true },
          })
        : item;
      const parentRule = parent ? parseRule(parent.recurrenceRule) : null;
      let nextRule: RecurrenceRule | null;
      if (scope !== "future") {
        nextRule = parseRule(item.recurrenceRule);
      } else if (data.recurrence === null) {
        nextRule = null;
      } else if (data.recurrence === undefined) {
        nextRule = parentRule;
      } else {
        nextRule = ruleFromRecurrenceInput(data.recurrence, parentRule?.until);
      }
      if (scope === "future" && nextRule?.until && nextRule.until < targetDay) {
        return {
          ok: false,
          error: `The series ends ${nextRule.until}, before ${targetDay}. Change the end date too, or pick an earlier day.`,
        };
      }

      const changes: string[] = [];
      if (data.title && data.title !== item.title) changes.push(`title → “${data.title}”`);
      if (targetDay !== currentDay) changes.push(`date → ${targetDay}`);
      if (allDay !== item.allDay || startMinute !== item.startMinute || endMinute !== item.endMinute) {
        changes.push(
          allDay || startMinute === null
            ? "time → all day"
            : `time → ${formatMinute(startMinute)}${endMinute !== null ? `–${formatMinute(endMinute)}` : ""}`,
        );
      }
      if (data.category && data.category !== item.category) changes.push(`category → ${data.category}`);
      if (data.priority && data.priority !== item.priority) changes.push(`priority → ${data.priority}`);
      if (data.notes !== undefined && data.notes !== item.notes) changes.push("notes updated");
      if (scope === "future") {
        changes.push(
          nextRule
            ? `repeats ${describeRecurrence(nextRule, targetDay)}`
            : "stops repeating from this point",
        );
      }
      if (changes.length === 0) {
        return { ok: false, error: "Nothing would change — include at least one field to update." };
      }

      const conflicts =
        !allDay && startMinute !== null
          ? await conflictTitlesFor(user.id, reset, targetDay, startMinute, endMinute, item.id)
          : [];

      const scopeText = recurring
        ? scope === "one"
          ? " — this occurrence only"
          : " — this and all future occurrences"
        : "";
      const conflictText = conflicts.length
        ? ` — overlaps ${conflicts.join(", ")}${
            scope === "future" ? " (later occurrences are not checked ahead of time)" : ""
          }`
        : scope === "future"
          ? " (later occurrences are not checked ahead of time)"
          : "";

      return {
        ok: true,
        // The stored payload is the COMPLETE write, scope included — what the
        // preview names is exactly what executes, nothing rides along.
        payload: {
          scope,
          item: {
            id: item.id,
            title: data.title ?? item.title,
            notes: data.notes === undefined ? item.notes : data.notes,
            date: targetDay,
            startMinute,
            endMinute,
            allDay,
            category: data.category ?? item.category,
            priority: data.priority ?? item.priority,
            status: item.status,
            recurrenceRule: serializeRule(nextRule),
            tagIds: item.tags.map((row) => row.tagId),
          },
        },
        summary: `Update “${item.title}” on ${currentDay}${scopeText}: ${changes.join(", ")}${conflictText}`,
      };
    }
    case "delete_planner_block": {
      const parsed = deletePlannerBlockSchema.safeParse(payload);
      if (!parsed.success) return invalid(parsed.error);
      const item = await prisma.scheduleItem.findFirst({
        where: { id: parsed.data.id, userId: user.id },
      });
      if (!item) return { ok: false, error: "Planner block not found." };

      const recurring = Boolean(item.seriesId) || Boolean(item.recurrenceRule);
      if (recurring && !parsed.data.scope) {
        return {
          ok: false,
          error:
            'This block repeats. Ask the user whether to delete this occurrence only or this and all future occurrences, then send scope: "one" or scope: "future".',
        };
      }
      const scope: "one" | "future" = recurring ? (parsed.data.scope as "one" | "future") : "one";
      const day = operationalDayOfRecord(item, resetMinuteOf(scheduleSettingsFor(user)));
      const scopeText = recurring
        ? scope === "one"
          ? " — this occurrence only; the series continues"
          : " and every later occurrence — earlier ones are kept"
        : "";

      return {
        ok: true,
        payload: { id: item.id, scope },
        summary: `Delete “${item.title}” on ${day}${scopeText} — permanent`,
      };
    }
    case "log_habit": {
      const parsed = logHabitSchema.safeParse(payload);
      if (!parsed.success) return invalid(parsed.error);
      const data = parsed.data;
      const habit = await prisma.habit.findFirst({
        where: { id: data.habitId, userId: user.id },
        select: { id: true, name: true, unit: true },
      });
      if (!habit) return { ok: false, error: "Habit not found." };
      // The model writes a date in the user's own calendar; an omitted one
      // means "today" in THEIR timezone, never the server's.
      const date = data.date ?? scheduleSettingsFor(user).today;
      const amount =
        data.value === null || data.value === undefined
          ? ""
          : ` (${data.value}${habit.unit ? ` ${habit.unit}` : ""})`;
      return {
        ok: true,
        // Every field `logHabit` will see, explicitly. Notes stay null: the
        // assistant records an outcome, it does not annotate the user's day.
        payload: {
          habitId: habit.id,
          date,
          status: data.status,
          value: data.value ?? null,
          notes: null,
        },
        summary: `Log habit “${habit.name}” as ${data.status} for ${date}${amount}`,
      };
    }
    case "complete_inbox_item": {
      const parsed = byIdSchema.safeParse(payload);
      if (!parsed.success) return invalid(parsed.error);
      const item = await prisma.inboxItem.findFirst({
        where: { id: parsed.data.id, userId: user.id },
        select: { id: true, title: true, status: true },
      });
      if (!item) return { ok: false, error: "Inbox note not found." };
      if (item.status !== "open") return { ok: false, error: "That inbox note is not open." };
      return {
        ok: true,
        payload: { id: item.id },
        summary: `Mark inbox note “${item.title}” as done`,
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
              : kind === "update_planner_block"
                ? storedUpdatePlannerBlockSchema
                : kind === "delete_planner_block"
                  ? storedDeletePlannerBlockSchema
                  : kind === "log_habit"
                    ? habitLogSchema
                    : // complete_task, complete_inbox_item, delete_task, delete_reminder
                      byIdSchema;
  const checked = schema.safeParse(parsed);
  if (!checked.success) return { ok: false, error: "The stored proposal is no longer valid." };
  return { ok: true, payload: checked.data };
}
