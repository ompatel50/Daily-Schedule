import { daysBetween, type DayKey } from "@/lib/date";
import type { DayStatus } from "@/lib/logic/schedule";

/**
 * Schedule-aware reminder decisions — pure.
 *
 * One module decides whether anything is allowed to remind, and why not. The
 * server feed (`src/server/reminders.ts`) gathers the inputs; the client
 * watcher just fires whatever survives. The suppression reasons are a real
 * enum so tests can assert *why* a reminder stayed silent, not merely that it
 * did:
 *
 *   rest day / not scheduled  → the schedule engine says today asks nothing
 *   excused / canceled        → an override or a skip said "not today"
 *   completed                 → the thing was already done; nagging is noise
 *   inactive                  → archived habit, disabled rule, disabled reminder
 *   delivered                 → this exact occurrence already fired once
 *   no_time                   → nothing says *when* to fire, so nothing can
 */

export type ReminderSuppression =
  | "disabled"
  | "inactive"
  | "rest_day"
  | "not_scheduled"
  | "excused"
  | "canceled"
  | "completed"
  | "delivered"
  | "no_time"
  | "future"
  | "already_fired";

export interface ReminderOccurrence {
  /** Stable identity for exactly-once delivery, e.g. `habit:<id>:<date>`. */
  key: string;
  kind:
    | "reminder"
    | "habit"
    | "goal"
    | "bill"
    | "task"
    | "document"
    | "low_balance"
    | "budget";
  title: string;
  message: string | null;
  /**
   * Local wall-clock fire time, `YYYY-MM-DDTHH:mm:00` with no zone suffix —
   * the browser interprets it in its own zone, which for a local-first app IS
   * the user's clock.
   */
  fireAt: string;
  /** Set for classic reminders so firing can advance/disable the row. */
  reminderId: string | null;
}

export function occurrenceKey(kind: "habit" | "goal", ownerId: string, date: DayKey): string {
  return `${kind}:${ownerId}:${date}`;
}

export function classicReminderKey(reminderId: string, remindAtIso: string): string {
  return `reminder:${reminderId}:${remindAtIso}`;
}

export function minuteToWallClock(date: DayKey, minute: number): string {
  const hours = String(Math.floor(minute / 60)).padStart(2, "0");
  const minutes = String(minute % 60).padStart(2, "0");
  return `${date}T${hours}:${minutes}:00`;
}

// --- classic Reminder rows --------------------------------------------------

export interface ClassicReminderInput {
  id: string;
  title: string;
  message: string | null;
  enabled: boolean;
  remindAtIso: string;
  lastFiredAtIso: string | null;
  /** Status of the planner item the reminder is attached to, if any. */
  attachedItemStatus: string | null;
  deliveredKeys: ReadonlySet<string>;
}

/** A classic reminder occurrence, or the reason it must stay silent. */
export function resolveClassicReminder(
  input: ClassicReminderInput,
): { ok: true; occurrence: ReminderOccurrence } | { ok: false; reason: ReminderSuppression } {
  if (!input.enabled) return { ok: false, reason: "disabled" };

  // Attached to a planner item: the item's state decides. A done item needs no
  // nag; a skipped item was deliberately dropped — reminding would re-litigate
  // a decision the user already made.
  if (input.attachedItemStatus === "done") return { ok: false, reason: "completed" };
  if (input.attachedItemStatus === "skipped") return { ok: false, reason: "canceled" };

  // Already advanced past this occurrence (the fired stamp is not older than
  // the scheduled instant) — never deliver the same occurrence twice.
  if (
    input.lastFiredAtIso &&
    new Date(input.lastFiredAtIso).getTime() >= new Date(input.remindAtIso).getTime()
  ) {
    return { ok: false, reason: "already_fired" };
  }

  const key = classicReminderKey(input.id, input.remindAtIso);
  if (input.deliveredKeys.has(key)) return { ok: false, reason: "delivered" };

  return {
    ok: true,
    occurrence: {
      key,
      kind: "reminder",
      title: input.title,
      message: input.message,
      fireAt: input.remindAtIso,
      reminderId: input.id,
    },
  };
}

// --- schedule-rule reminders (habits & goals) --------------------------------

export interface ScheduleReminderInput {
  kind: "habit" | "goal";
  ownerId: string;
  name: string;
  date: DayKey;
  /** The engine's resolved status for the date. */
  status: DayStatus;
  /** True when today is a real requirement; times-per-week days are flexible. */
  dueToday: boolean;
  flexibleToday: boolean;
  /** Habit: today's log status. Goal: whether the target is already met. */
  completedToday: boolean;
  /** For flexible (times-per-week) items: weekly target already reached. */
  weeklyTargetMet: boolean;
  reminderEnabled: boolean;
  reminderMinute: number | null;
  /** Fallback when no explicit reminder minute is set. */
  timeMinute: number | null;
  archived: boolean;
  deliveredKeys: ReadonlySet<string>;
}

const NEUTRAL_SUPPRESSIONS: Partial<Record<DayStatus, ReminderSuppression>> = {
  rest: "rest_day",
  not_scheduled: "not_scheduled",
  excused: "excused",
  canceled: "canceled",
  inactive: "inactive",
  future: "future",
  skipped: "canceled",
  completed: "completed",
};

/** A habit/goal reminder occurrence for one date, or why it stays silent. */
export function resolveScheduleReminder(
  input: ScheduleReminderInput,
): { ok: true; occurrence: ReminderOccurrence } | { ok: false; reason: ReminderSuppression } {
  if (input.archived) return { ok: false, reason: "inactive" };
  if (!input.reminderEnabled) return { ok: false, reason: "disabled" };

  const neutral = NEUTRAL_SUPPRESSIONS[input.status];
  if (neutral) return { ok: false, reason: neutral };

  // A flexible (times-per-week) item reminds while the week still needs it;
  // once the weekly target is met the remaining days ask nothing.
  if (!input.dueToday && !input.flexibleToday) return { ok: false, reason: "not_scheduled" };
  if (input.flexibleToday && !input.dueToday && input.weeklyTargetMet) {
    return { ok: false, reason: "completed" };
  }

  if (input.completedToday) return { ok: false, reason: "completed" };

  const minute = input.reminderMinute ?? input.timeMinute;
  if (minute === null) return { ok: false, reason: "no_time" };

  const key = occurrenceKey(input.kind, input.ownerId, input.date);
  if (input.deliveredKeys.has(key)) return { ok: false, reason: "delivered" };

  return {
    ok: true,
    occurrence: {
      key,
      kind: input.kind,
      title: input.name,
      message: input.kind === "habit" ? "Habit scheduled today" : "Goal scheduled today",
      fireAt: minuteToWallClock(input.date, minute),
      reminderId: null,
    },
  };
}

// --- due-date reminders (bills, tasks & documents — the shared foundation) ---

/**
 * When a due-date reminder fires, minutes from midnight. Bills, tasks and
 * documents have a due *day* rather than a time; one fixed morning hour keeps
 * the behaviour predictable until per-item times are worth their settings
 * surface.
 */
export const DUE_REMINDER_MINUTE = 9 * 60;

/** Everything that reminds from a single future date on the one resolver. */
export type DueReminderKind = "bill" | "task" | "document";

/**
 * Keys for due-date occurrences. The due date rides inside the key, so paying
 * a bill (which advances `nextDueDate`) — or renewing a document, which moves
 * its expiry date — automatically arms the next occurrence, and the single
 * `ahead` key makes the whole run-up window fire at most once, whichever day a
 * tab or the push runner first sees it.
 */
export function dueReminderKey(
  kind: DueReminderKind,
  ownerId: string,
  dueDate: DayKey,
  ahead = false,
): string {
  return `${kind}:${ownerId}:${dueDate}${ahead ? ":ahead" : ""}`;
}

/**
 * How each kind words its occurrence. A bill is "due"; a passport "expires" —
 * same arithmetic, different sentence, and the difference lives here rather
 * than in three copies of the resolver.
 */
const DUE_PHRASING: Record<DueReminderKind, { onDay: string; ahead: (when: string) => string }> = {
  bill: { onDay: "Bill due today", ahead: (when) => `Bill due ${when}` },
  task: { onDay: "Task due today", ahead: (when) => `Task due ${when}` },
  document: { onDay: "Expires today", ahead: (when) => `Expires ${when}` },
};

export interface DueReminderInput {
  kind: DueReminderKind;
  ownerId: string;
  name: string;
  dueDate: DayKey;
  /** The user's today — the caller resolves it from their timezone. */
  today: DayKey;
  enabled: boolean;
  /** Paid, settled, done — nothing left to remind about. */
  completed: boolean;
  /** Archived / cancelled. */
  inactive: boolean;
  /** Also remind this many days before the due date (0 = only on the day). */
  daysBefore: number;
  /** Extra context appended to the message, e.g. a formatted amount. */
  detail: string | null;
  deliveredKeys: ReadonlySet<string>;
}

/**
 * A due-date occurrence for one bill, task or document, or the reason it stays
 * silent. Fires on the due day itself, and once during the `daysBefore` run-up
 * window. Deliberately silent for an overdue (or already-expired) item: the
 * dashboard and the owning page carry that state, and a daily nag would train
 * people to dismiss it.
 */
export function resolveDueReminder(
  input: DueReminderInput,
): { ok: true; occurrence: ReminderOccurrence } | { ok: false; reason: ReminderSuppression } {
  if (input.inactive) return { ok: false, reason: "inactive" };
  if (!input.enabled) return { ok: false, reason: "disabled" };
  if (input.completed) return { ok: false, reason: "completed" };

  const untilDue = daysBetween(input.today, input.dueDate);
  const dueToday = untilDue === 0;
  const inRunUp = untilDue > 0 && untilDue <= input.daysBefore;
  if (!dueToday && !inRunUp) return { ok: false, reason: "not_scheduled" };

  const key = dueReminderKey(input.kind, input.ownerId, input.dueDate, !dueToday);
  if (input.deliveredKeys.has(key)) return { ok: false, reason: "delivered" };

  const phrasing = DUE_PHRASING[input.kind];
  const duePhrase = dueToday
    ? phrasing.onDay
    : phrasing.ahead(untilDue === 1 ? "tomorrow" : `in ${untilDue} days`);

  return {
    ok: true,
    occurrence: {
      key,
      kind: input.kind,
      title: input.name,
      message: input.detail ? `${duePhrase} · ${input.detail}` : duePhrase,
      fireAt: minuteToWallClock(input.today, DUE_REMINDER_MINUTE),
      reminderId: null,
    },
  };
}

// --- low-balance reminders (finance — first threshold alert on the foundation)

/**
 * The delivery key embeds the WEEK, not the day: while an account sits below
 * its threshold the reminder fires at most once per week, instead of nagging
 * every morning about a number the user already saw. A new week (or a
 * recovered-then-dipped balance in a new week) arms it again. Future finance
 * alerts (budget thresholds, document expiry) follow this same shape: a
 * threshold check plus a coarse-window key on the one delivery ledger.
 */
export function lowBalanceReminderKey(accountId: string, weekStart: DayKey): string {
  return `low_balance:${accountId}:${weekStart}`;
}

export interface LowBalanceReminderInput {
  accountId: string;
  accountName: string;
  /** The computed balance (openingBalance + ledger), in account currency. */
  balance: number;
  /** Null = the account has no low-balance alert configured. */
  threshold: number | null;
  archived: boolean;
  today: DayKey;
  /** Start of the user's current week (their weekStartsOn convention). */
  weekStart: DayKey;
  /** Extra context for the message, e.g. formatted balance/threshold. */
  detail: string | null;
  deliveredKeys: ReadonlySet<string>;
}

/** A low-balance occurrence for one account, or why it stays silent. */
export function resolveLowBalanceReminder(
  input: LowBalanceReminderInput,
): { ok: true; occurrence: ReminderOccurrence } | { ok: false; reason: ReminderSuppression } {
  if (input.archived) return { ok: false, reason: "inactive" };
  if (input.threshold === null) return { ok: false, reason: "disabled" };
  // At or above the line: nothing to say. "not_scheduled" — today asks nothing.
  if (input.balance >= input.threshold) return { ok: false, reason: "not_scheduled" };

  const key = lowBalanceReminderKey(input.accountId, input.weekStart);
  if (input.deliveredKeys.has(key)) return { ok: false, reason: "delivered" };

  return {
    ok: true,
    occurrence: {
      key,
      kind: "low_balance",
      title: `${input.accountName} is low`,
      message: input.detail ?? "Balance is below your alert level",
      fireAt: minuteToWallClock(input.today, DUE_REMINDER_MINUTE),
      reminderId: null,
    },
  };
}

// --- budget-threshold reminders (finance) ------------------------------------

/**
 * The delivery key embeds the budget, the PERIOD START and the threshold, so a
 * budget warns at most once per period per threshold: crossing 75 % on a
 * Tuesday says so once, every further purchase that month stays quiet, and the
 * next month (or next week, for a weekly budget) arms it again. Changing the
 * threshold arms a new alert deliberately — the user asked a different
 * question.
 */
export function budgetThresholdReminderKey(
  budgetId: string,
  periodStart: DayKey,
  threshold: number,
): string {
  return `budget:${budgetId}:${periodStart}:${threshold}`;
}

export interface BudgetThresholdReminderInput {
  budgetId: string;
  /** Display label, e.g. "Groceries". */
  label: string;
  /** The window's first day — what makes the key per-period. */
  periodStart: DayKey;
  /** Money out in the category over the period, as a positive number. */
  spent: number;
  /** The budget's target for the period. */
  target: number;
  /** Null = this budget has no threshold alert configured. */
  threshold: number | null;
  today: DayKey;
  /** Extra context for the message, e.g. formatted spent-of-target. */
  detail: string | null;
  deliveredKeys: ReadonlySet<string>;
}

/** A budget-threshold occurrence, or the reason it stays silent. */
export function resolveBudgetThresholdReminder(
  input: BudgetThresholdReminderInput,
): { ok: true; occurrence: ReminderOccurrence } | { ok: false; reason: ReminderSuppression } {
  if (input.threshold === null) return { ok: false, reason: "disabled" };
  // A zero (or negative) target measures nothing — every purchase would be
  // "over", which is noise rather than news.
  if (input.target <= 0) return { ok: false, reason: "disabled" };

  const percent = Math.round((input.spent / input.target) * 100);
  if (percent < input.threshold) return { ok: false, reason: "not_scheduled" };

  const key = budgetThresholdReminderKey(input.budgetId, input.periodStart, input.threshold);
  if (input.deliveredKeys.has(key)) return { ok: false, reason: "delivered" };

  return {
    ok: true,
    occurrence: {
      key,
      kind: "budget",
      title:
        percent >= 100
          ? `${input.label} budget is spent`
          : `${input.label} budget at ${percent}%`,
      message: input.detail ?? `You have used ${percent}% of this budget`,
      fireAt: minuteToWallClock(input.today, DUE_REMINDER_MINUTE),
      reminderId: null,
    },
  };
}

/**
 * How long past its fire time an occurrence may still be delivered. Beyond
 * this it is silently dropped for the day — surfacing a stale reminder hours
 * later reads as a bug, and the occurrence key stops it re-firing tomorrow
 * for yesterday's date anyway.
 */
export const DELIVERY_WINDOW_MS = 60 * 60 * 1000;

export function isDeliverable(fireAtMs: number, nowMs: number): boolean {
  return nowMs >= fireAtMs && nowMs - fireAtMs <= DELIVERY_WINDOW_MS;
}
