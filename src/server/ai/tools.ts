import "server-only";

import { z } from "zod";

import { shiftDay, weekRange, type DayKey } from "@/lib/date";
import { HEALTH_METRIC_GROUPS, type HealthMetricGroup } from "@/lib/enums";
import { HEALTH_RANGES, type HealthRange } from "@/lib/health-ranges";
import {
  ASSISTANT_ACTION_KINDS,
  ASSISTANT_LIMITS,
  truncateText,
  type AssistantMode,
} from "@/lib/logic/assistant";
import { buildSearchHits } from "@/lib/logic/search";
import { BACKUP_VERSION } from "@/lib/backup-format";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/server/auth/current-user";
import { getCommandCenterSummary } from "@/server/command-center";
import { getDocumentViews } from "@/server/documents";
import {
  getAccountBalances,
  getBillViews,
  getFinanceOverview,
  getImportBatches,
  getTransactionsBetween,
} from "@/server/finance";
import { getImportDashboard } from "@/server/health-import";
import { getGroupView } from "@/server/health-module";
import { getHabitStatusSummary } from "@/server/habits";
import { getInboxPage } from "@/server/inbox";
import { getWeeklyReview } from "@/server/insights";
import { getDayOverview, getScheduleItems, searchEverything } from "@/server/queries";
import { getReminderFeed, listReminders } from "@/server/reminders";
import { resetMinuteOf, type ScheduleSettings } from "@/lib/logic/schedule";
import { operationalDayOfRecord } from "@/lib/logic/operational-day";
import { getTaskBoard } from "@/server/tasks";
import { buildProposalPreview, type ProposalPreview } from "@/server/ai/proposals";

/**
 * The assistant's tool layer — the ONLY way a model reaches the user's data.
 *
 * Every tool wraps an existing read model 1:1, which is what makes the layer
 * safe by construction: those functions already resolve the signed-in user
 * from the session, scope every query by userId, and bound every result. The
 * model supplies arguments; it never supplies a user id, and no tool accepts
 * one. Outputs are pruned projections — enough to answer, small enough for a
 * modest local model's context window.
 *
 * The one non-read tool, `propose_action`, stages a write for the user to
 * decide on. It validates with the same zod schema the real server action
 * uses and stores a proposal row; nothing executes here. Execution lives in
 * src/server/actions/assistant.ts, behind the user's explicit confirmation,
 * and routes through the existing server actions.
 */

export interface ToolContext {
  user: CurrentUser;
  settings: ScheduleSettings;
  mode: AssistantMode;
}

export interface ToolRunOutcome {
  ok: boolean;
  /** Serialized-JSON-friendly result (or { error }) handed back to the model. */
  result: unknown;
  /** Set when this call created a proposal the UI should render. */
  proposal?: ProposalPreview;
}

export interface AssistantTool {
  name: string;
  description: string;
  /** JSON Schema for Ollama; kept next to the zod validator by hand. */
  parameters: Record<string, unknown>;
  /** Runtime validation of what the model actually sent. */
  validate: z.ZodTypeAny;
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolRunOutcome>;
}

const dayKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date");

/** Clamp a model-chosen range: never unbounded, never inverted. */
function clampRange(
  from: string | undefined,
  to: string | undefined,
  today: DayKey,
  maxDays: number,
): { from: DayKey; to: DayKey } {
  let end = (to as DayKey) ?? today;
  let start = (from as DayKey) ?? shiftDay(end, -(maxDays - 1));
  if (start > end) [start, end] = [end, start];
  const earliest = shiftDay(end, -(maxDays - 1));
  if (start < earliest) start = earliest;
  return { from: start, to: end };
}

function toolOk(result: unknown): ToolRunOutcome {
  return { ok: true, result };
}

function toolError(message: string): ToolRunOutcome {
  return { ok: false, result: { error: message } };
}

// --- read tools --------------------------------------------------------------

const searchTool: AssistantTool = {
  name: "search_records",
  description:
    "Search everything the user owns — tasks, planner, inbox, finance, bills, budgets, documents, habits, goals, health, workouts, journal — by text. Returns matches with a title, a one-line subtitle and the in-app link.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Text to search for (at least 2 characters)." },
      limit: { type: "integer", description: "Max results per record type, 1-8. Default 5." },
    },
    required: ["query"],
  },
  validate: z.object({
    query: z.string().trim().min(2).max(200),
    limit: z.number().int().min(1).max(8).optional(),
  }),
  async run(ctx, args) {
    const { query, limit } = args as { query: string; limit?: number };
    const rows = await searchEverything(query, limit ?? 5);
    const hits = buildSearchHits(rows, ctx.settings.today);
    return toolOk({
      hits: hits.map((hit) => ({
        group: hit.group,
        title: hit.title,
        subtitle: hit.subtitle,
        href: hit.href,
      })),
    });
  },
};

const dayOverviewTool: AssistantTool = {
  name: "get_day_overview",
  description:
    "The full picture of one day: planner items with status, habits due and done, day score, nutrition totals, workouts and journal. Defaults to today.",
  parameters: {
    type: "object",
    properties: {
      date: { type: "string", description: "YYYY-MM-DD. Defaults to today." },
    },
  },
  validate: z.object({ date: dayKey.optional() }),
  async run(ctx, args) {
    const date = ((args as { date?: string }).date as DayKey) ?? ctx.settings.today;
    const overview = await getDayOverview(date);
    return toolOk({
      date,
      schedule: overview.schedule.map((item) => ({
        title: item.title,
        status: item.status,
        allDay: item.allDay,
        startMinute: item.startMinute,
        endMinute: item.endMinute,
        category: item.category,
        priority: item.priority,
      })),
      planned: overview.planned,
      completed: overview.completed,
      skipped: overview.skipped,
      habitsDue: overview.dueHabits.length,
      habitsDone: overview.habitsDone,
      score: overview.score.score,
      scoreApplicable: overview.score.hasApplicable,
      nutrition: overview.nutrition.totals,
      workouts: overview.workouts.map((workout) => ({
        name: workout.name,
        type: workout.type,
        durationMinutes: workout.durationMin,
        completed: workout.completedAt !== null,
      })),
      journal: overview.journal ? truncateText(overview.journal.content ?? "", 500) : null,
    });
  },
};

const weekReviewTool: AssistantTool = {
  name: "get_week_review",
  description:
    "A factual review of the week containing a date (defaults to this week): scores, planner and habit completion rates, workouts, nutrition logging and journal notes.",
  parameters: {
    type: "object",
    properties: {
      date: { type: "string", description: "YYYY-MM-DD inside the week. Defaults to today." },
    },
  },
  validate: z.object({ date: dayKey.optional() }),
  async run(ctx, args) {
    const anchor = ((args as { date?: string }).date as DayKey) ?? ctx.settings.today;
    const week = weekRange(anchor, ctx.settings.weekStartsOn);
    const review = await getWeeklyReview(ctx.user.id, week.start, week.end, ctx.settings);
    return toolOk({
      start: review.start,
      end: review.end,
      averageScore: review.averageScore,
      scoredDays: review.scoredDays,
      restDays: review.restDays,
      areas: review.areas,
      strongest: review.strongest,
      mostMissed: review.mostMissed,
      workouts: review.workouts,
      nutrition: review.nutrition,
      focus: review.focus,
      notes: review.notes.map((note) => ({
        date: note.date,
        content: truncateText(note.content, 280),
      })),
    });
  },
};

const needsAttentionTool: AssistantTool = {
  name: "get_needs_attention",
  description:
    "What needs the user's attention right now: overdue and due-today tasks, bills due soon, budgets over or near their limit, account balances and open inbox count. Use this first for 'what should I focus on'.",
  parameters: { type: "object", properties: {} },
  validate: z.object({}),
  async run() {
    const summary = await getCommandCenterSummary();
    return toolOk({
      tasks: {
        openCount: summary.tasks.openCount,
        overdueCount: summary.tasks.overdueCount,
        dueTodayCount: summary.tasks.dueTodayCount,
        top: summary.tasks.top.map((task) => ({
          id: task.id,
          title: task.title,
          priority: task.priority,
          dueDate: task.dueDate,
          project: task.projectName,
        })),
      },
      finance: {
        hasAccounts: summary.finance.hasAccounts,
        net: summary.finance.net,
        month: summary.finance.month,
        billsDueSoon: summary.finance.billsDueSoon,
        billsOverdueCount: summary.finance.billsOverdueCount,
        budgets: summary.finance.budgets,
      },
      inbox: summary.inbox,
    });
  },
};

const listTasksTool: AssistantTool = {
  name: "list_tasks",
  description:
    "Open tasks bucketed by due date (overdue, today, upcoming, someday), with ids, priorities, projects and tags. Also lists projects and recently completed tasks.",
  parameters: { type: "object", properties: {} },
  validate: z.object({}),
  async run() {
    const board = await getTaskBoard();
    const project = (task: { project: { name: string } | null }) => task.project?.name ?? null;
    const shape = (task: (typeof board.buckets.overdue)[number]) => ({
      id: task.id,
      title: task.title,
      priority: task.priority,
      dueDate: task.dueDate,
      project: project(task),
      tags: task.tags.map((row) => row.tag.name),
      subtasks: task.subtasks.length,
    });
    return toolOk({
      openCount: board.openCount,
      buckets: {
        overdue: board.buckets.overdue.map(shape),
        today: board.buckets.today.map(shape),
        upcoming: board.buckets.upcoming.map(shape),
        someday: board.buckets.someday.map(shape),
      },
      projects: board.projects.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        done: row.progress.done,
        total: row.progress.total,
      })),
      recentlyDone: board.recentlyDone.slice(0, 10).map((task) => ({
        title: task.title,
        completedAt: task.completedAt?.toISOString() ?? null,
      })),
    });
  },
};

const listInboxTool: AssistantTool = {
  name: "list_inbox",
  description: "Open inbox notes (life-admin captures), with ids, newest first.",
  parameters: { type: "object", properties: {} },
  validate: z.object({}),
  async run() {
    const page = await getInboxPage();
    return toolOk({
      open: page.open.map((item) => ({
        id: item.id,
        title: item.title,
        notes: item.notes ? truncateText(item.notes, 280) : null,
      })),
      openCount: page.open.length,
    });
  },
};

const habitStatusTool: AssistantTool = {
  name: "get_habit_status",
  description:
    "Habit standing for one date (defaults to today): which habits are due, done, missed or still pending, current and longest streaks, this week's progress against target, which days this week were missed, the last 30 days' completion rate, and when each habit is next due. Use this for any habit or streak question — never infer habits from the day overview or search. Optionally filter by name.",
  parameters: {
    type: "object",
    properties: {
      date: { type: "string", description: "YYYY-MM-DD. Defaults to today." },
      name: {
        type: "string",
        description: "Only habits whose name contains this text (case-insensitive).",
      },
      includeArchived: {
        type: "boolean",
        description: "Include archived habits. Default false.",
      },
    },
  },
  validate: z.object({
    date: dayKey.optional(),
    name: z.string().trim().min(1).max(80).optional(),
    includeArchived: z.boolean().optional(),
  }),
  async run(ctx, args) {
    const { date, name, includeArchived } = args as {
      date?: string;
      name?: string;
      includeArchived?: boolean;
    };
    const summary = await getHabitStatusSummary(
      ctx.user.id,
      (date as DayKey) ?? ctx.settings.today,
      ctx.settings,
      { name, includeArchived },
    );
    return toolOk({
      date: summary.date,
      week: summary.week,
      // Scheduled-opportunity counts across the user's active habits for this
      // date. `restOrUnscheduled` habits place no requirement on it, so they
      // are never a failure — do not report them as missed.
      totals: summary.totals,
      matched: summary.matched,
      returned: summary.habits.length,
      ...(summary.truncated
        ? {
            note: `Only the first ${summary.habits.length} of ${summary.matched} habits are listed. Call this tool again with "name" to ask about a specific one.`,
          }
        : {}),
      habits: summary.habits,
    });
  },
};

const financeOverviewTool: AssistantTool = {
  name: "get_finance_overview",
  description:
    "Finances at a glance: balances and net worth per currency, this month's income/spending by category, this week's flow, bills due soon, budget progress and savings goals.",
  parameters: { type: "object", properties: {} },
  validate: z.object({}),
  async run() {
    const overview = await getFinanceOverview();
    return toolOk({
      net: overview.net,
      balances: overview.balances.map((row) => ({
        id: row.account.id,
        name: row.account.name,
        type: row.account.type,
        currency: row.account.currency,
        balance: row.balance,
        archived: row.account.archivedAt !== null,
      })),
      month: overview.month,
      week: overview.week,
      billsDueSoonTotal: overview.billsDueSoonTotal,
      budgets: overview.budgets.map((view) => ({
        category: view.label,
        period: view.period,
        limit: view.budget.amount,
        spent: view.spent,
        percent: view.percent,
        over: view.over,
      })),
      savingsGoals: overview.savingsGoals.map((goal) => ({
        name: goal.name,
        targetAmount: goal.targetAmount,
        currentAmount: goal.currentAmount,
      })),
    });
  },
};

const listTransactionsTool: AssistantTool = {
  name: "list_transactions",
  description:
    "Transactions in a date range (up to 92 days, defaults to the last 30). Amounts are signed: positive is money in, negative is money out.",
  parameters: {
    type: "object",
    properties: {
      from: { type: "string", description: "YYYY-MM-DD start (inclusive)." },
      to: { type: "string", description: "YYYY-MM-DD end (inclusive). Defaults to today." },
    },
  },
  validate: z.object({ from: dayKey.optional(), to: dayKey.optional() }),
  async run(ctx, args) {
    const { from, to } = clampRange(
      (args as { from?: string }).from,
      (args as { to?: string }).to,
      ctx.settings.today,
      92,
    );
    const [rows, balances] = await Promise.all([
      getTransactionsBetween(from, to),
      getAccountBalances(),
    ]);
    const accountById = new Map(
      balances.map((row) => [row.account.id, { name: row.account.name, currency: row.account.currency }]),
    );
    const limited = rows.slice(0, 100);
    return toolOk({
      from,
      to,
      count: rows.length,
      truncated: rows.length > limited.length,
      transactions: limited.map((tx) => ({
        date: tx.date,
        amount: tx.amount,
        payee: tx.payee,
        category: tx.category,
        account: accountById.get(tx.accountId)?.name ?? null,
        currency: accountById.get(tx.accountId)?.currency ?? null,
      })),
    });
  },
};

const listBillsTool: AssistantTool = {
  name: "list_bills",
  description:
    "Bills and subscriptions with ids, due dates, amounts, recurrence and whether each is overdue, due soon or settled.",
  parameters: { type: "object", properties: {} },
  validate: z.object({}),
  async run() {
    const bills = await getBillViews();
    return toolOk({
      bills: bills.map((view) => ({
        id: view.bill.id,
        name: view.bill.name,
        kind: view.bill.kind,
        amount: view.bill.amount,
        currency: view.bill.account?.currency ?? null,
        nextDueDate: view.bill.nextDueDate,
        recurrence: view.bill.recurrence,
        daysUntilDue: view.daysUntilDue,
        bucket: view.bucket,
      })),
    });
  },
};

const listRemindersTool: AssistantTool = {
  name: "list_reminders",
  description:
    "The user's standing reminders with ids, fire times, repeat rules and enabled state. Use get_reminder_feed for what is actually due today.",
  parameters: { type: "object", properties: {} },
  validate: z.object({}),
  async run() {
    const reminders = await listReminders();
    return toolOk({
      reminders: reminders.map((reminder) => ({
        id: reminder.id,
        title: reminder.title,
        message: reminder.message,
        remindAt: reminder.remindAt.toISOString(),
        repeat: reminder.repeat,
        enabled: reminder.enabled,
      })),
    });
  },
};

const reminderFeedTool: AssistantTool = {
  name: "get_reminder_feed",
  description:
    "Everything allowed to remind the user today, across reminders, habits, goals, due bills and tasks, expiring documents, budget thresholds and low balances.",
  parameters: { type: "object", properties: {} },
  validate: z.object({}),
  async run() {
    const feed = await getReminderFeed();
    return toolOk({
      occurrences: feed.slice(0, 40).map((occurrence) => ({
        kind: occurrence.kind,
        title: occurrence.title,
        message: occurrence.message,
        fireAt: occurrence.fireAt,
      })),
    });
  },
};

const healthTrendsTool: AssistantTool = {
  name: "get_health_trends",
  description:
    "Health metric trends for one group (activity, sleep, heart, body, vitals, nutrition) over a range. Returns per-metric averages, extremes and the most recent days — in the user's own units.",
  parameters: {
    type: "object",
    properties: {
      group: { type: "string", enum: [...HEALTH_METRIC_GROUPS] },
      range: { type: "string", enum: [...HEALTH_RANGES], description: "Defaults to 30d." },
    },
    required: ["group"],
  },
  validate: z.object({
    group: z.enum(HEALTH_METRIC_GROUPS),
    range: z.enum(HEALTH_RANGES).optional(),
  }),
  async run(_ctx, args) {
    const group = (args as { group: HealthMetricGroup }).group;
    const range = ((args as { range?: HealthRange }).range ?? "30d") as HealthRange;
    const view = await getGroupView(group, range);
    return toolOk({
      group: view.group,
      from: view.from,
      to: view.to,
      empty: view.empty,
      metrics: view.series.map((series) => {
        const logged = series.points.filter((point) => point.value !== null);
        return {
          label: series.label,
          unit: series.unit,
          average: series.average,
          total: series.total,
          min: series.min,
          max: series.max,
          daysLogged: logged.length,
          recent: logged.slice(-7).map((point) => ({ date: point.date, value: point.value })),
        };
      }),
    });
  },
};

const listDocumentsTool: AssistantTool = {
  name: "list_documents",
  description:
    "Important documents (IDs, insurance, leases, warranties…) with expiry dates and how urgent each renewal is.",
  parameters: { type: "object", properties: {} },
  validate: z.object({}),
  async run() {
    const documents = await getDocumentViews();
    return toolOk({
      documents: documents.map((view) => ({
        id: view.document.id,
        name: view.document.name,
        kind: view.document.kind,
        issuer: view.document.issuer,
        expiryDate: view.document.expiryDate,
        expired: view.expired,
        daysUntilExpiry: view.daysUntilExpiry,
      })),
    });
  },
};

const scheduleTool: AssistantTool = {
  name: "get_schedule",
  description:
    "Planner/calendar blocks in a date range of operational days (up to 31, defaults to the next 7 starting today). Times are minutes from midnight. `day` is the day a block belongs to under the user's daily reset; `date` is its real calendar date — they differ only for after-midnight blocks, which group with the previous day.",
  parameters: {
    type: "object",
    properties: {
      from: { type: "string", description: "YYYY-MM-DD start. Defaults to today." },
      to: { type: "string", description: "YYYY-MM-DD end. Defaults to a week from the start." },
    },
  },
  validate: z.object({ from: dayKey.optional(), to: dayKey.optional() }),
  async run(ctx, args) {
    const rawFrom = ((args as { from?: string }).from as DayKey) ?? ctx.settings.today;
    const rawTo = ((args as { to?: string }).to as DayKey) ?? shiftDay(rawFrom, 6);
    const { from, to } = clampRange(rawFrom, rawTo, ctx.settings.today, 31);
    // One calendar date past the range: each operational day's after-midnight
    // tail lives on the next calendar date.
    const reset = resetMinuteOf(ctx.settings);
    const items = await getScheduleItems(from, shiftDay(to, 1));
    const inRange = items.filter((item) => {
      const day = operationalDayOfRecord(item, reset);
      return day >= from && day <= to;
    });
    return toolOk({
      from,
      to,
      items: inRange.slice(0, 200).map((item) => ({
        id: item.id,
        day: operationalDayOfRecord(item, reset),
        date: item.date,
        title: item.title,
        status: item.status,
        allDay: item.allDay,
        startMinute: item.startMinute,
        endMinute: item.endMinute,
        category: item.category,
        priority: item.priority,
      })),
    });
  },
};

const importHistoryTool: AssistantTool = {
  name: "get_import_history",
  description:
    "History of data imports: Apple Health import runs (counts, recency, undo state) and finance CSV import batches. Counts and dates only — never file contents.",
  parameters: { type: "object", properties: {} },
  validate: z.object({}),
  async run(ctx) {
    const [health, finance] = await Promise.all([
      getImportDashboard(ctx.user.id, ctx.settings.today, 10),
      getImportBatches(5),
    ]);
    return toolOk({
      health: {
        totals: health.totals,
        recency: health.recency,
        lastSuccessful: health.lastSuccessful,
        batches: health.batches.slice(0, 10).map((batch) => ({
          fileName: batch.fileName,
          status: batch.status,
          createdAt: batch.createdAt.toISOString(),
          imported: batch.imported,
          duplicates: batch.duplicates,
        })),
      },
      finance: finance.map((batch) => ({
        fileName: batch.fileName,
        account: batch.account?.name ?? null,
        createdAt: batch.createdAt.toISOString(),
        imported: batch.createdCount,
        skipped: batch.skippedCount,
        undone: batch.undoneAt !== null,
        transactionsRemaining: batch._count.transactions,
      })),
    });
  },
};

const backupStatusTool: AssistantTool = {
  name: "get_backup_status",
  description:
    "How much data the account holds per area (row counts) and the backup format version — useful for 'when should I back up'. Never returns the data itself.",
  parameters: { type: "object", properties: {} },
  validate: z.object({}),
  async run(ctx) {
    const userId = ctx.user.id;
    const [tasks, projects, scheduleItems, habits, meals, workouts, healthMetrics, transactions, accounts, bills, inboxItems, documents, reminders, journalEntries, goals] =
      await Promise.all([
        prisma.task.count({ where: { userId } }),
        prisma.project.count({ where: { userId } }),
        prisma.scheduleItem.count({ where: { userId } }),
        prisma.habit.count({ where: { userId } }),
        prisma.meal.count({ where: { userId } }),
        prisma.workout.count({ where: { userId } }),
        prisma.healthMetric.count({ where: { userId } }),
        prisma.financeTransaction.count({ where: { userId } }),
        prisma.financeAccount.count({ where: { userId } }),
        prisma.bill.count({ where: { userId } }),
        prisma.inboxItem.count({ where: { userId } }),
        prisma.lifeDocument.count({ where: { userId } }),
        prisma.reminder.count({ where: { userId } }),
        prisma.journalEntry.count({ where: { userId } }),
        prisma.goal.count({ where: { userId } }),
      ]);
    return toolOk({
      backupFormatVersion: BACKUP_VERSION,
      exportPath: "/settings#backup",
      recordCounts: {
        tasks, projects, scheduleItems, habits, meals, workouts, healthMetrics,
        transactions, accounts, bills, inboxItems, documents, reminders,
        journalEntries, goals,
      },
    });
  },
};

// --- the one non-read tool ---------------------------------------------------

const proposeActionTool: AssistantTool = {
  name: "propose_action",
  description:
    "Propose ONE change for the user to review — never performed directly. Send ONLY the fields listed for the kind; anything else is refused. create_task {title, notes?, dueDate?, priority?} (always a plain one-off task); complete_task {id}; create_reminder {title, message?, remindAt: 'YYYY-MM-DDTHH:mm' in the user's own clock, repeat?}; create_inbox_item {title, notes?}; complete_inbox_item {id}; create_transaction {accountId, date, amount (signed: negative = money out), payee, category?, notes?}; create_planner_block {title, date, startMinute?, endMinute?, category?} (a single day, never recurring); log_habit {habitId, date? (defaults to today), status? ('done' | 'skipped' | 'missed', defaults to done), value?} (one day of one habit); delete_task {id}; delete_reminder {id}. Use real ids from other tools — get_habit_status for habit ids, list_inbox for inbox ids. The user sees a preview and decides.",
  parameters: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: [...ASSISTANT_ACTION_KINDS],
      },
      payload: { type: "object", description: "The action's fields, per the kind." },
    },
    required: ["kind", "payload"],
  },
  validate: z.object({
    kind: z.string(),
    payload: z.record(z.unknown()),
  }),
  async run(ctx, args) {
    if (ctx.mode === "readonly") {
      return toolError(
        "The assistant is in read-only mode. Tell the user to switch to Draft or Confirm mode in the assistant settings if they want proposals.",
      );
    }
    const { kind, payload } = args as { kind: string; payload: Record<string, unknown> };
    const preview = await buildProposalPreview(ctx.user, kind, payload);
    if (!preview.ok) return toolError(preview.error);
    return {
      ok: true,
      result: {
        proposed: true,
        proposalId: preview.proposal.id,
        summary: preview.proposal.summary,
        risk: preview.proposal.risk,
        note:
          ctx.mode === "confirm"
            ? "The user now sees a preview with Confirm and Cancel buttons. Do not claim the change happened."
            : "Draft mode: the user sees a preview, but executing it requires switching to Confirm mode. Do not claim the change happened.",
      },
      proposal: preview.proposal,
    };
  },
};

// --- registry ----------------------------------------------------------------

export const ASSISTANT_TOOLS: AssistantTool[] = [
  searchTool,
  needsAttentionTool,
  dayOverviewTool,
  weekReviewTool,
  scheduleTool,
  listTasksTool,
  listInboxTool,
  habitStatusTool,
  financeOverviewTool,
  listTransactionsTool,
  listBillsTool,
  listRemindersTool,
  reminderFeedTool,
  healthTrendsTool,
  listDocumentsTool,
  importHistoryTool,
  backupStatusTool,
  proposeActionTool,
];

export function toolsForMode(mode: AssistantMode): AssistantTool[] {
  if (mode === "readonly") {
    return ASSISTANT_TOOLS.filter((tool) => tool.name !== "propose_action");
  }
  return ASSISTANT_TOOLS;
}

export function toolByName(name: string): AssistantTool | null {
  return ASSISTANT_TOOLS.find((tool) => tool.name === name) ?? null;
}

/**
 * Run one tool call from the model: validate the arguments, execute, and
 * bound the serialized result. Anything unexpected becomes a phrased error
 * the model can read — never a throw that would kill the exchange.
 */
export async function runTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolRunOutcome> {
  const tool = toolByName(name);
  if (!tool) return toolError(`Unknown tool "${truncateText(name, 60)}".`);
  if (ctx.mode === "readonly" && tool.name === "propose_action") {
    return toolError("The assistant is in read-only mode; proposing changes is disabled.");
  }
  const parsed = tool.validate.safeParse(args ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return toolError(
      `Invalid arguments for ${tool.name}: ${first ? `${first.path.join(".") || "input"} — ${first.message}` : "could not be read"}.`,
    );
  }
  try {
    return await tool.run(ctx, parsed.data as Record<string, unknown>);
  } catch {
    // Read models can redirect (NEXT_REDIRECT) or fail unexpectedly; the
    // exchange must survive with a readable note either way.
    return toolError(`The ${tool.name} tool failed. Answer from what you already have.`);
  }
}

/** Serialize a tool result for the model, bounded and cut-marked. */
export function serializeToolResult(outcome: ToolRunOutcome): string {
  const raw = JSON.stringify(outcome.result);
  if (raw.length <= ASSISTANT_LIMITS.maxToolResultChars) return raw;
  return JSON.stringify({
    truncated: true,
    note: "Result was too large and was cut off. Ask something narrower.",
    partial: raw.slice(0, ASSISTANT_LIMITS.maxToolResultChars),
  });
}
