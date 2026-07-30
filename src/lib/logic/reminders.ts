import type { DayKey } from "@/lib/date";
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
  kind: "reminder" | "habit" | "goal";
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
