/**
 * NOTE ON `server-only`: part of the shared computation layer, not the
 * app-facing server surface. See src/server/facts.ts for the reasoning.
 *
 * The rules engine's executor. The pure vocabulary, validation and safety
 * checks live in src/lib/logic/automation.ts; this module owns the parts
 * that touch the database:
 *
 *  * `dispatchAutomationEvent` — called from the EXISTING server actions
 *    after a successful write (the "execution happens in the server action
 *    path" requirement). Never throws; a broken rule cannot break a save.
 *  * `runDailyAutomationsFor` — the tick-evaluated triggers (fact
 *    thresholds over yesterday's DailyFact, date rules, anomaly rules),
 *    folded into the existing daily maintenance tick. No new scheduler.
 *    Deduplicated per rule per operational day (`dedupKey`), so a tick
 *    that runs twice cannot fire a rule twice.
 *  * Action executors that write ONLY through the same shapes the app's
 *    own actions write (the same recompute wiring, the same soft-delete
 *    models), with every created id and every previous field value
 *    recorded on the execution row — the undo handle.
 *
 * SAFETY, ENFORCED HERE:
 *  * Depth bound: an event at `depth >= MAX_AUTOMATION_DEPTH` is not
 *    evaluated at all; records the engine creates dispatch their own
 *    events at `depth + 1`, so cascades stop after one hop.
 *  * Rules never delete — the executor switch has no delete branch, and
 *    `parseActions` refuses unknown verbs before anything runs.
 *  * A rule that errors `RULE_FAILURE_LIMIT` times in a row disables
 *    itself with the error message as the reason.
 *  * Everything is scoped to one userId; no query here crosses users.
 */
import { prisma } from "@/lib/prisma";
import { type DayKey, shiftDay } from "@/lib/date";
import {
  FINANCE_CATEGORY_META,
  SCHEDULE_CATEGORIES,
  isBookkeepingCategory,
} from "@/lib/enums";
import {
  DRY_RUN_DAYS,
  MAX_AUTOMATION_DEPTH,
  RULE_FAILURE_LIMIT,
  type AutomationAction,
  type EventContext,
  type RecordEvent,
  type RecordModule,
  type RuleDefinition,
  evaluateConditions,
  parseRuleDefinition,
  renderTemplate,
} from "@/lib/logic/automation";
import { centsOrLegacy, centsToAmount } from "@/lib/logic/money";
import { DUE_REMINDER_MINUTE } from "@/lib/logic/reminders";
import { wallClockToInstant } from "@/lib/logic/schedule";
import { trashStamp } from "@/lib/soft-delete";
import { getAnomalyContextFor } from "@/server/anomalies";
import { scheduleSettingsFor } from "@/server/schedule";
import { getDailyFacts, recomputeDay, recomputeDaysFor } from "@/server/summaries";

// --- events -------------------------------------------------------------------

export interface AutomationEvent {
  /** Null for tick-evaluated triggers (fact/date/anomaly) — there is no
   * triggering record, and record-targeting actions refuse cleanly. */
  module: RecordModule | null;
  event: RecordEvent | null;
  /** The triggering record's id (for set_category / link_bill). */
  recordId: string | null;
  context: EventContext;
  /** The operational day the event belongs to. */
  date: DayKey;
}

/** What one executed action did — stored on the execution row. */
export interface ActionOutcome {
  type: AutomationAction["type"];
  summary: string;
  /** Record this action created, if any — the trash-undo handle. */
  created?: { table: string; id: string };
  /** Previous value this action overwrote, if any — the revert handle. */
  previous?: { table: string; id: string; field: string; value: string | null };
}

// --- context builders (shared by dispatch sites and dry run) ------------------

export function transactionContext(row: {
  payee: string | null;
  category: string;
  amountCents: number | null;
  amount: number;
  date: string;
  notes: string | null;
}): EventContext {
  const cents = centsOrLegacy(row.amountCents, row.amount);
  return {
    payee: row.payee,
    category: row.category,
    amount: centsToAmount(Math.abs(cents)),
    direction: cents < 0 ? "out" : "in",
    date: row.date,
    notes: row.notes,
  };
}

export function taskContext(row: {
  title: string;
  priority: string;
  status: string;
  dueDate: string | null;
  notes: string | null;
}): EventContext {
  return {
    title: row.title,
    priority: row.priority,
    status: row.status,
    dueDate: row.dueDate,
    notes: row.notes,
  };
}

export function scheduleItemContext(row: {
  title: string;
  category: string;
  status: string;
  date: string;
  allDay: boolean;
  startMinute: number | null;
}): EventContext {
  return {
    title: row.title,
    category: row.category,
    status: row.status,
    date: row.date,
    startMinute: row.startMinute,
    allDay: row.allDay ? 1 : 0,
  };
}

export function habitLogContext(row: {
  habitName: string;
  status: string;
  date: string;
}): EventContext {
  return { habit: row.habitName, status: row.status, date: row.date };
}

export function mealContext(row: { type: string; date: string }): EventContext {
  return { mealType: row.type, date: row.date };
}

export function workoutContext(row: {
  name: string;
  type: string;
  status: string;
  date: string;
}): EventContext {
  return { name: row.name, workoutType: row.type, status: row.status, date: row.date };
}

export function healthMetricContext(row: {
  type: string;
  value: number;
  unit: string | null;
  date: string;
}): EventContext {
  return { metric: row.type, value: row.value, unit: row.unit, date: row.date };
}

export function inboxContext(row: { title: string; notes: string | null }): EventContext {
  return { title: row.title, notes: row.notes };
}

// --- the request-path entry ---------------------------------------------------

/**
 * Evaluate this user's enabled record-trigger rules against one write.
 * NEVER throws — a failing rule logs and (eventually) disables itself; the
 * user's own save must always succeed regardless.
 */
export async function dispatchAutomationEvent(
  userId: string,
  event: AutomationEvent,
  depth = 0,
): Promise<void> {
  try {
    if (depth >= MAX_AUTOMATION_DEPTH) return;
    const rules = await prisma.automationRule.findMany({
      where: { userId, enabled: true },
    });
    if (rules.length === 0) return;

    for (const rule of rules) {
      let definition: RuleDefinition;
      try {
        definition = parseRuleDefinition(rule);
      } catch (error) {
        await recordFailure(rule, event, `Stored definition is invalid: ${message(error)}`);
        continue;
      }
      const trigger = definition.trigger;
      if (
        trigger.type !== "record" ||
        trigger.module !== event.module ||
        trigger.event !== event.event
      ) {
        continue;
      }
      if (!evaluateConditions(definition.conditions, event.context, { date: event.date })) {
        continue;
      }
      await executeRule(userId, rule.id, definition, event, depth, null);
    }
  } catch {
    // The engine itself failing must never surface into the user's write.
  }
}

// --- the tick entry -----------------------------------------------------------

/**
 * Tick-evaluated triggers for one user: fact thresholds read YESTERDAY's
 * daily fact (the last complete day), date rules match today, anomaly
 * rules match the current observations. Once per rule per operational day.
 */
export async function runDailyAutomationsFor(user: {
  id: string;
  timezone: string;
  weekStartsOn: number;
  dayResetMinute?: number;
}): Promise<{ fired: number }> {
  let fired = 0;
  try {
    const rules = await prisma.automationRule.findMany({
      where: { userId: user.id, enabled: true },
    });
    const tickRules = rules.filter((rule) => {
      try {
        return parseRuleDefinition(rule).trigger.type !== "record";
      } catch {
        return false;
      }
    });
    if (tickRules.length === 0) return { fired };

    const settings = scheduleSettingsFor(user);
    const today = settings.today;
    const yesterday = shiftDay(today, -1);

    // Load shared inputs at most once.
    const needsFact = tickRules.some((rule) => parseRuleDefinition(rule).trigger.type === "fact");
    const needsAnomaly = tickRules.some(
      (rule) => parseRuleDefinition(rule).trigger.type === "anomaly",
    );
    const [facts, anomalies] = await Promise.all([
      needsFact
        ? getDailyFacts(user.id, yesterday, yesterday)
        : Promise.resolve([] as Awaited<ReturnType<typeof getDailyFacts>>),
      needsAnomaly ? getAnomalyContextFor(user, settings) : Promise.resolve(null),
    ]);
    const fact = facts[0] ?? null;

    for (const rule of tickRules) {
      const definition = parseRuleDefinition(rule);
      const trigger = definition.trigger;
      const dedupKey = `${rule.id}:${today}`;
      const already = await prisma.automationExecution.findFirst({
        where: { userId: user.id, dedupKey },
        select: { id: true },
      });
      if (already) continue;

      let context: EventContext | null = null;
      if (trigger.type === "fact") {
        // Missing data is missing: a null metric never crosses a threshold.
        const value = fact ? (fact[trigger.metric] as number | null) : null;
        if (value === null || value === undefined) continue;
        const crossed =
          trigger.direction === "above" ? value > trigger.value : value < trigger.value;
        if (!crossed) continue;
        context = { metric: trigger.metric, value, date: yesterday };
      } else if (trigger.type === "date") {
        const weekdayOk =
          !trigger.weekdays || trigger.weekdays.length === 0
            ? true
            : trigger.weekdays.includes(new Date(`${today}T12:00:00Z`).getUTCDay());
        const dateOk = !trigger.date || trigger.date === today;
        if (!weekdayOk || !dateOk) continue;
        context = { date: today };
      } else if (trigger.type === "anomaly") {
        const observation = anomalies?.report.observations.find(
          (signal) => !trigger.category || signal.category === trigger.category,
        );
        if (!observation) continue;
        context = {
          category: observation.category,
          title: observation.title,
          message: observation.message,
          date: today,
        };
      } else {
        continue;
      }

      if (!evaluateConditions(definition.conditions, context, { date: today })) continue;
      const ran = await executeRule(
        user.id,
        rule.id,
        definition,
        { module: null, event: null, recordId: null, context, date: today },
        0,
        dedupKey,
      );
      if (ran) fired += 1;
    }
  } catch {
    // Never fatal — the tick's other duties must run regardless.
  }
  return { fired };
}

/**
 * The daily-tick sweep: every user with any enabled rule gets one
 * `runDailyAutomationsFor` pass. Folded into the existing maintenance tick
 * (/api/reminders/run) — no new scheduler.
 */
export async function runDailyAutomations(): Promise<{ users: number; fired: number }> {
  const owners = await prisma.automationRule.findMany({
    where: { enabled: true },
    select: { userId: true },
    distinct: ["userId"],
  });
  let fired = 0;
  for (const owner of owners) {
    const user = await prisma.user.findUnique({ where: { id: owner.userId } });
    if (!user) continue;
    fired += (await runDailyAutomationsFor(user)).fired;
  }
  return { users: owners.length, fired };
}

// --- execution ----------------------------------------------------------------

async function executeRule(
  userId: string,
  ruleId: string,
  definition: RuleDefinition,
  event: AutomationEvent,
  depth: number,
  dedupKey: string | null,
): Promise<boolean> {
  const outcomes: ActionOutcome[] = [];
  try {
    for (const action of definition.actions) {
      outcomes.push(await executeAction(userId, action, event, depth));
    }
    await prisma.automationExecution.create({
      data: {
        userId,
        ruleId,
        trigger: JSON.stringify({ ...definition.trigger, at: event.date }),
        matched: JSON.stringify(event.context),
        actions: JSON.stringify(outcomes),
        status: "success",
        dedupKey,
      },
    });
    await prisma.automationRule.update({
      where: { id: ruleId },
      data: { lastRunAt: new Date(), lastStatus: "matched", consecutiveFailures: 0 },
    });
    return true;
  } catch (error) {
    await prisma.automationExecution
      .create({
        data: {
          userId,
          ruleId,
          trigger: JSON.stringify({ ...definition.trigger, at: event.date }),
          matched: JSON.stringify(event.context),
          actions: JSON.stringify(outcomes),
          status: "error",
          error: message(error),
          dedupKey,
        },
      })
      .catch(() => {});
    const rule = await prisma.automationRule.findFirst({ where: { id: ruleId, userId } });
    if (rule) await recordFailure(rule, event, message(error));
    return false;
  }
}

/** Count a failure; at the limit, disable the rule and say why. */
async function recordFailure(
  rule: { id: string; consecutiveFailures: number; name: string },
  _event: AutomationEvent,
  reason: string,
): Promise<void> {
  const failures = rule.consecutiveFailures + 1;
  const disable = failures >= RULE_FAILURE_LIMIT;
  await prisma.automationRule
    .update({
      where: { id: rule.id },
      data: {
        consecutiveFailures: failures,
        lastRunAt: new Date(),
        lastStatus: "error",
        ...(disable
          ? {
              enabled: false,
              disabledReason: `Disabled after ${failures} consecutive failures. Last error: ${reason.slice(0, 300)}`,
            }
          : {}),
      },
    })
    .catch(() => {});
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- action executors ---------------------------------------------------------

async function executeAction(
  userId: string,
  action: AutomationAction,
  event: AutomationEvent,
  depth: number,
): Promise<ActionOutcome> {
  const render = (text: string) => renderTemplate(text, event.context);
  const settings = scheduleSettingsFor(
    await prisma.user.findUniqueOrThrow({ where: { id: userId } }),
  );
  const today = settings.today;

  switch (action.type) {
    case "set_category": {
      if (event.module === "transaction" && event.recordId) {
        const category = action.category.trim().toLowerCase();
        if (!(category in FINANCE_CATEGORY_META)) {
          throw new Error(`Unknown finance category "${action.category}"`);
        }
        // The same refusal saveTransaction makes: bookkeeping categories
        // pair with structure a rule cannot provide.
        if (isBookkeepingCategory(category)) {
          throw new Error("Rules cannot assign bookkeeping categories (transfer/adjustment)");
        }
        const transaction = await prisma.financeTransaction.findFirst({
          where: { id: event.recordId, userId },
        });
        if (!transaction) throw new Error("Transaction not found");
        if (transaction.transferGroupId) throw new Error("Transfer legs keep their category");
        await prisma.financeTransaction.update({
          where: { id: transaction.id },
          data: { category },
        });
        await recomputeDay(userId, transaction.date);
        return {
          type: action.type,
          summary: `Set category to ${category}`,
          previous: {
            table: "financeTransaction",
            id: transaction.id,
            field: "category",
            value: transaction.category,
          },
        };
      }
      if (event.module === "schedule_item" && event.recordId) {
        const category = action.category.trim().toLowerCase();
        if (!SCHEDULE_CATEGORIES.includes(category as (typeof SCHEDULE_CATEGORIES)[number])) {
          throw new Error(`Unknown schedule category "${action.category}"`);
        }
        const item = await prisma.scheduleItem.findFirst({
          where: { id: event.recordId, userId },
        });
        if (!item) throw new Error("Planner block not found");
        await prisma.scheduleItem.update({ where: { id: item.id }, data: { category } });
        await recomputeDay(userId, item.date);
        return {
          type: action.type,
          summary: `Set category to ${category}`,
          previous: {
            table: "scheduleItem",
            id: item.id,
            field: "category",
            value: item.category,
          },
        };
      }
      throw new Error("set_category applies to transactions and planner blocks");
    }

    case "create_task": {
      const title = render(action.title);
      if (!title) throw new Error("The task title rendered empty");
      const dueDate =
        action.due === "today" ? today : action.due === "tomorrow" ? shiftDay(today, 1) : null;
      // Mirrors saveTask's create branch for the fields a rule may set
      // (title/notes/priority/due) — same sortOrder rule, same recompute.
      const created = await prisma.task.create({
        data: {
          userId,
          title,
          notes: action.notes ? render(action.notes) : null,
          priority: action.priority ?? "medium",
          dueDate,
          sortOrder: await prisma.task.count({ where: { userId, status: "open" } }),
        },
      });
      await recomputeDaysFor(userId, [today, ...(dueDate ? [dueDate] : [])]);
      await dispatchAutomationEvent(
        userId,
        {
          module: "task",
          event: "created",
          recordId: created.id,
          context: taskContext(created),
          date: today,
        },
        depth + 1,
      );
      return {
        type: action.type,
        summary: `Created task “${title}”`,
        created: { table: "task", id: created.id },
      };
    }

    case "create_inbox": {
      const title = render(action.title);
      if (!title) throw new Error("The inbox title rendered empty");
      const created = await prisma.inboxItem.create({
        data: { userId, title, notes: action.notes ? render(action.notes) : null },
      });
      await dispatchAutomationEvent(
        userId,
        {
          module: "inbox",
          event: "created",
          recordId: created.id,
          context: inboxContext(created),
          date: today,
        },
        depth + 1,
      );
      return {
        type: action.type,
        summary: `Captured “${title}” to the Inbox`,
        created: { table: "inboxItem", id: created.id },
      };
    }

    case "create_reminder":
    case "notify": {
      const title = render(action.title);
      if (!title) throw new Error("The title rendered empty");
      // Both ride the classic reminder row → the one delivery ledger. A
      // "notify" fires at the next feed/push pass; a reminder at its minute.
      const minute = action.type === "create_reminder" ? (action.minute ?? DUE_REMINDER_MINUTE) : null;
      const remindAt =
        minute === null
          ? new Date()
          : (wallClockToInstant(
              `${today}T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`,
              settings.timezone,
            ) ?? new Date());
      const created = await prisma.reminder.create({
        data: {
          userId,
          title,
          message: action.message ? render(action.message) : null,
          remindAt,
          repeat: "none",
          enabled: true,
        },
      });
      return {
        type: action.type,
        summary:
          action.type === "notify" ? `Notified “${title}”` : `Created reminder “${title}”`,
        created: { table: "reminder", id: created.id },
      };
    }

    case "create_block": {
      const title = render(action.title);
      if (!title) throw new Error("The block title rendered empty");
      const timed = typeof action.startMinute === "number";
      const category =
        action.category &&
        SCHEDULE_CATEGORIES.includes(action.category as (typeof SCHEDULE_CATEGORIES)[number])
          ? action.category
          : "admin";
      const created = await prisma.scheduleItem.create({
        data: {
          userId,
          title,
          date: today,
          allDay: !timed,
          startMinute: timed ? action.startMinute : null,
          endMinute: timed ? (action.endMinute ?? null) : null,
          category,
        },
      });
      await recomputeDay(userId, today);
      await dispatchAutomationEvent(
        userId,
        {
          module: "schedule_item",
          event: "created",
          recordId: created.id,
          context: scheduleItemContext(created),
          date: today,
        },
        depth + 1,
      );
      return {
        type: action.type,
        summary: `Added “${title}” to today's planner`,
        created: { table: "scheduleItem", id: created.id },
      };
    }

    case "log_habit": {
      const habit = await prisma.habit.findFirst({
        where: { userId, archived: false, name: { equals: action.habit, mode: "insensitive" } },
      });
      if (!habit) throw new Error(`No habit named "${action.habit}"`);
      const date = event.date ?? today;
      const existing = await prisma.habitLog.findFirst({
        where: { userId, habitId: habit.id, date },
      });
      if (existing) {
        // Never overwrite the user's own log — that would rewrite their day.
        return { type: action.type, summary: `${habit.name} was already logged for ${date}` };
      }
      const created = await prisma.habitLog.create({
        data: { userId, habitId: habit.id, date, status: "done" },
      });
      await recomputeDay(userId, date);
      await dispatchAutomationEvent(
        userId,
        {
          module: "habit_log",
          event: "created",
          recordId: created.id,
          context: habitLogContext({ habitName: habit.name, status: "done", date }),
          date,
        },
        depth + 1,
      );
      return {
        type: action.type,
        summary: `Logged ${habit.name} done for ${date}`,
        created: { table: "habitLog", id: created.id },
      };
    }

    case "link_bill": {
      if (event.module !== "transaction" || !event.recordId) {
        throw new Error("link_bill applies to transaction triggers");
      }
      const transaction = await prisma.financeTransaction.findFirst({
        where: { id: event.recordId, userId },
      });
      if (!transaction) throw new Error("Transaction not found");
      if (transaction.billId) {
        return { type: action.type, summary: "Already linked to a bill" };
      }
      const needle = (action.bill ?? transaction.payee ?? "").trim().toLowerCase();
      if (!needle) return { type: action.type, summary: "No payee to match a bill against" };
      const bills = await prisma.bill.findMany({
        where: { userId, archivedAt: null, name: { contains: needle, mode: "insensitive" } },
        take: 2,
      });
      if (bills.length !== 1) {
        return {
          type: action.type,
          summary:
            bills.length === 0
              ? `No bill matches “${needle}”`
              : `Several bills match “${needle}” — left unlinked`,
        };
      }
      await prisma.financeTransaction.update({
        where: { id: transaction.id },
        data: { billId: bills[0].id },
      });
      return {
        type: action.type,
        summary: `Linked to the ${bills[0].name} bill`,
        previous: {
          table: "financeTransaction",
          id: transaction.id,
          field: "billId",
          value: null,
        },
      };
    }
  }
}

// --- undo ---------------------------------------------------------------------

const UNDO_CREATED_TABLES = ["task", "inboxItem", "scheduleItem", "reminder"] as const;

/**
 * Undo one execution: records the rule CREATED go to the Trash through the
 * ordinary soft-delete (restorable like any other delete); the habit-log
 * exception is removed outright (habit logs are not trash-kept, and the row
 * was the rule's, not the user's); field changes revert to the recorded
 * previous value. Last-write-wins by design: if the user re-categorised the
 * transaction meanwhile, the revert still restores the pre-rule value —
 * that is what "undo the rule" means. Idempotent via `undoneAt`.
 */
export async function undoExecution(
  userId: string,
  executionId: string,
): Promise<{ undone: boolean; reason?: string }> {
  const execution = await prisma.automationExecution.findFirst({
    where: { id: executionId, userId },
  });
  if (!execution) return { undone: false, reason: "Execution not found" };
  if (execution.undoneAt) return { undone: false, reason: "Already undone" };
  if (execution.status !== "success") {
    return { undone: false, reason: "Only successful executions can be undone" };
  }

  const outcomes = JSON.parse(execution.actions) as ActionOutcome[];
  const touchedDays = new Set<DayKey>();

  for (const outcome of outcomes) {
    if (outcome.created) {
      const { table, id } = outcome.created;
      if (table === "habitLog") {
        const log = await prisma.habitLog.findFirst({ where: { id, userId } });
        if (log) {
          await prisma.habitLog.delete({ where: { id } });
          touchedDays.add(log.date);
        }
      } else if ((UNDO_CREATED_TABLES as readonly string[]).includes(table)) {
        const delegate = prisma[table as (typeof UNDO_CREATED_TABLES)[number]] as unknown as {
          findFirst(args: unknown): Promise<{ date?: string; dueDate?: string | null } | null>;
          updateMany(args: unknown): Promise<unknown>;
        };
        const row = await delegate.findFirst({ where: { id, userId } });
        await delegate.updateMany({
          where: { id, userId },
          data: { deletedAt: trashStamp() },
        });
        if (row?.date) touchedDays.add(row.date);
        if (row?.dueDate) touchedDays.add(row.dueDate);
      }
    }
    if (outcome.previous) {
      const { table, id, field, value } = outcome.previous;
      if (table === "financeTransaction") {
        const row = await prisma.financeTransaction.findFirst({ where: { id, userId } });
        if (row) {
          await prisma.financeTransaction.update({ where: { id }, data: { [field]: value } });
          touchedDays.add(row.date);
        }
      } else if (table === "scheduleItem") {
        const row = await prisma.scheduleItem.findFirst({ where: { id, userId } });
        if (row) {
          await prisma.scheduleItem.update({ where: { id }, data: { [field]: value } });
          touchedDays.add(row.date);
        }
      }
    }
  }

  await recomputeDaysFor(userId, touchedDays);
  await prisma.automationExecution.update({
    where: { id: execution.id },
    data: { undoneAt: new Date(), status: "undone" },
  });
  return { undone: true };
}

/** Undo a rule's recent successful executions as a batch, newest first. */
export async function undoRuleBatch(
  userId: string,
  ruleId: string,
): Promise<{ undone: number }> {
  const executions = await prisma.automationExecution.findMany({
    where: { userId, ruleId, status: "success", undoneAt: null },
    orderBy: { firedAt: "desc" },
    take: 100,
    select: { id: true },
  });
  let undone = 0;
  for (const execution of executions) {
    const result = await undoExecution(userId, execution.id);
    if (result.undone) undone += 1;
  }
  return { undone };
}

// --- dry run ------------------------------------------------------------------

export interface DryRunMatch {
  when: string;
  matched: string;
  actions: string[];
}

export interface DryRunResult {
  /** Rows/days examined. */
  samples: number;
  matches: DryRunMatch[];
  windowDays: number;
}

/**
 * What this rule WOULD have done against the last 30 days of the user's
 * real data. Reads only — nothing is written, nothing is logged. The
 * enable flow requires one of these for the exact current definition.
 */
export async function dryRunDefinition(
  userId: string,
  definition: RuleDefinition,
): Promise<DryRunResult> {
  const userRow = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const settings = scheduleSettingsFor(userRow);
  const today = settings.today;
  const from = shiftDay(today, -(DRY_RUN_DAYS - 1));
  const trigger = definition.trigger;

  const preview = (context: EventContext) =>
    definition.actions.map((action) => previewAction(action, context));

  const matches: DryRunMatch[] = [];
  let samples = 0;

  const consider = (when: string, context: EventContext, date: DayKey) => {
    samples += 1;
    if (!evaluateConditions(definition.conditions, context, { date })) return;
    if (matches.length >= 50) return;
    matches.push({ when, matched: summarizeContext(context), actions: preview(context) });
  };

  if (trigger.type === "record") {
    const rows = await loadRecent(userId, trigger.module, from);
    for (const row of rows) consider(row.when, row.context, row.date);
  } else if (trigger.type === "fact") {
    const facts = await getDailyFacts(userId, from, today);
    for (const fact of facts) {
      const value = fact[trigger.metric] as number | null;
      if (value === null || value === undefined) continue;
      const crossed =
        trigger.direction === "above" ? value > trigger.value : value < trigger.value;
      if (!crossed) continue;
      consider(fact.date, { metric: trigger.metric, value, date: fact.date }, fact.date);
    }
  } else if (trigger.type === "date") {
    for (let offset = 0; offset < DRY_RUN_DAYS; offset += 1) {
      const date = shiftDay(from, offset);
      const weekdayOk =
        !trigger.weekdays || trigger.weekdays.length === 0
          ? true
          : trigger.weekdays.includes(new Date(`${date}T12:00:00Z`).getUTCDay());
      const dateOk = !trigger.date || trigger.date === date;
      if (weekdayOk && dateOk) consider(date, { date }, date);
    }
  } else if (trigger.type === "anomaly") {
    const anomalies = await getAnomalyContextFor(userRow, settings);
    for (const signal of anomalies.report.observations) {
      if (trigger.category && signal.category !== trigger.category) continue;
      consider(
        `current: ${signal.title}`,
        { category: signal.category, title: signal.title, message: signal.message, date: today },
        today,
      );
    }
  }

  return { samples, matches, windowDays: DRY_RUN_DAYS };
}

function previewAction(action: AutomationAction, context: EventContext): string {
  const render = (text: string) => renderTemplate(text, context);
  switch (action.type) {
    case "set_category":
      return `Would set category to ${action.category}`;
    case "create_task":
      return `Would create task “${render(action.title)}”`;
    case "create_inbox":
      return `Would capture “${render(action.title)}” to the Inbox`;
    case "create_reminder":
      return `Would create reminder “${render(action.title)}”`;
    case "create_block":
      return `Would add “${render(action.title)}” to the planner`;
    case "log_habit":
      return `Would log ${action.habit} done`;
    case "link_bill":
      return `Would link to a matching bill`;
    case "notify":
      return `Would notify “${render(action.title)}”`;
  }
}

function summarizeContext(context: EventContext): string {
  return Object.entries(context)
    .filter(([, value]) => value !== null && value !== "")
    .slice(0, 5)
    .map(([key, value]) => `${key}: ${value}`)
    .join(" · ");
}

/** The last 30 days of a module's rows as trigger contexts (bounded). */
async function loadRecent(
  userId: string,
  module: RecordModule,
  from: DayKey,
): Promise<Array<{ when: string; context: EventContext; date: DayKey }>> {
  const TAKE = 300;
  switch (module) {
    case "transaction": {
      const rows = await prisma.financeTransaction.findMany({
        where: { userId, date: { gte: from } },
        orderBy: { date: "desc" },
        take: TAKE,
      });
      return rows.map((row) => ({
        when: `${row.date} · ${row.payee ?? row.category}`,
        context: transactionContext(row),
        date: row.date,
      }));
    }
    case "task": {
      const rows = await prisma.task.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: TAKE,
      });
      return rows.map((row) => ({
        when: row.title,
        context: taskContext(row),
        date: row.dueDate ?? from,
      }));
    }
    case "schedule_item": {
      const rows = await prisma.scheduleItem.findMany({
        where: { userId, date: { gte: from } },
        orderBy: { date: "desc" },
        take: TAKE,
      });
      return rows.map((row) => ({
        when: `${row.date} · ${row.title}`,
        context: scheduleItemContext(row),
        date: row.date,
      }));
    }
    case "habit_log": {
      const rows = await prisma.habitLog.findMany({
        where: { userId, date: { gte: from } },
        orderBy: { date: "desc" },
        take: TAKE,
        include: { habit: { select: { name: true } } },
      });
      return rows.map((row) => ({
        when: `${row.date} · ${row.habit.name}`,
        context: habitLogContext({ habitName: row.habit.name, status: row.status, date: row.date }),
        date: row.date,
      }));
    }
    case "meal": {
      const rows = await prisma.meal.findMany({
        where: { userId, date: { gte: from } },
        orderBy: { date: "desc" },
        take: TAKE,
      });
      return rows.map((row) => ({
        when: `${row.date} · ${row.type}`,
        context: mealContext(row),
        date: row.date,
      }));
    }
    case "workout": {
      const rows = await prisma.workout.findMany({
        where: { userId, date: { gte: from } },
        orderBy: { date: "desc" },
        take: TAKE,
      });
      return rows.map((row) => ({
        when: `${row.date} · ${row.name}`,
        context: workoutContext(row),
        date: row.date,
      }));
    }
    case "health_metric": {
      const rows = await prisma.healthMetric.findMany({
        where: { userId, date: { gte: from } },
        orderBy: { date: "desc" },
        take: TAKE,
      });
      return rows.map((row) => ({
        when: `${row.date} · ${row.type}`,
        context: healthMetricContext(row),
        date: row.date,
      }));
    }
    case "inbox": {
      const rows = await prisma.inboxItem.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: TAKE,
      });
      return rows.map((row) => ({
        when: row.title,
        context: inboxContext(row),
        date: from,
      }));
    }
  }
}
