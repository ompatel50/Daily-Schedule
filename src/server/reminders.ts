import { getCurrentUser, prisma } from "@/lib/db";
import { shiftDay } from "@/lib/date";
import { formatMoney } from "@/lib/logic/finance";
import {
  dueReminderKey,
  resolveClassicReminder,
  resolveDueReminder,
  resolveScheduleReminder,
  type ReminderOccurrence,
} from "@/lib/logic/reminders";
import { evaluateGoalsForDate } from "@/server/goals";
import { getHabitViews } from "@/server/habits";
import { scheduleSettingsFor } from "@/server/schedule";

/** The furthest ahead any bill's run-up reminder can start (validation caps
 *  `reminderDaysBefore` at 60), so the feed never scans past this horizon. */
const BILL_REMINDER_HORIZON_DAYS = 60;

/**
 * The reminder feed: every occurrence that is *allowed* to fire today, fully
 * schedule-aware. The client watcher is a dumb poller — everything that knows
 * about rest days, overrides, completions and archived habits lives here (and
 * in the pure module this calls), so a rule change cannot leave a stale copy
 * of the logic in a component.
 */
export async function getReminderFeed(): Promise<ReminderOccurrence[]> {
  const user = await getCurrentUser();
  return getReminderFeedFor(user);
}

/**
 * The same feed for an explicit user row — the scheduled push runner
 * evaluates every subscribed user outside any session, and must share this
 * exact logic so push and in-tab reminders can never disagree about what is
 * allowed to fire.
 */
export async function getReminderFeedFor(user: {
  id: string;
  timezone: string;
  weekStartsOn: number;
}): Promise<ReminderOccurrence[]> {
  const settings = scheduleSettingsFor(user);
  const date = settings.today;

  const [reminders, habits, goals, dueBills, dueTasks] = await Promise.all([
    prisma.reminder.findMany({
      where: { userId: user.id, enabled: true },
      include: { scheduleItem: { select: { status: true } } },
    }),
    getHabitViews(user.id, date, settings, { historyDays: 14 }),
    evaluateGoalsForDate(user.id, date, settings, { historyDays: 14 }),
    prisma.bill.findMany({
      where: {
        userId: user.id,
        reminderEnabled: true,
        archivedAt: null,
        settledAt: null,
        nextDueDate: { gte: date, lte: shiftDay(date, BILL_REMINDER_HORIZON_DAYS) },
      },
      take: 200,
    }),
    prisma.task.findMany({
      where: { userId: user.id, status: "open", reminderEnabled: true, dueDate: date },
      take: 200,
    }),
  ]);

  // One round trip for the delivery ledger: today's schedule keys are
  // deterministic, and classic keys derive from each reminder's instant.
  const candidateKeys = [
    ...reminders.map((reminder) => `reminder:${reminder.id}:${reminder.remindAt.toISOString()}`),
    ...habits.map((habit) => `habit:${habit.id}:${date}`),
    ...goals.map((evaluation) => `goal:${evaluation.goal.id}:${date}`),
    ...dueBills.flatMap((bill) => [
      dueReminderKey("bill", bill.id, bill.nextDueDate),
      dueReminderKey("bill", bill.id, bill.nextDueDate, true),
    ]),
    ...dueTasks.map((task) => dueReminderKey("task", task.id, date)),
  ];
  const delivered = await prisma.reminderDelivery.findMany({
    where: { userId: user.id, key: { in: candidateKeys } },
    select: { key: true },
  });
  const deliveredKeys = new Set(delivered.map((row) => row.key));

  const occurrences: ReminderOccurrence[] = [];

  for (const reminder of reminders) {
    const resolved = resolveClassicReminder({
      id: reminder.id,
      title: reminder.title,
      message: reminder.message,
      enabled: reminder.enabled,
      remindAtIso: reminder.remindAt.toISOString(),
      lastFiredAtIso: reminder.lastFiredAt?.toISOString() ?? null,
      attachedItemStatus: reminder.scheduleItem?.status ?? null,
      deliveredKeys,
    });
    if (resolved.ok) occurrences.push(resolved.occurrence);
  }

  for (const habit of habits) {
    const resolved = resolveScheduleReminder({
      kind: "habit",
      ownerId: habit.id,
      name: habit.name,
      date,
      status: habit.status,
      dueToday: habit.dueToday,
      flexibleToday: habit.flexibleToday,
      completedToday: habit.loggedStatus === "done",
      weeklyTargetMet: habit.weekly ? habit.weekly.done >= habit.weekly.target : false,
      reminderEnabled: habit.reminderEnabled,
      reminderMinute: habit.reminderMinute,
      timeMinute: habit.timeMinute,
      archived: habit.archived,
      deliveredKeys,
    });
    if (resolved.ok) occurrences.push(resolved.occurrence);
  }

  for (const evaluation of goals) {
    const rule = evaluation.occurrence.rule;
    const resolved = resolveScheduleReminder({
      kind: "goal",
      ownerId: evaluation.goal.id,
      name: evaluation.goal.label,
      date,
      status: evaluation.status,
      dueToday: evaluation.occurrence.active,
      flexibleToday: evaluation.occurrence.flexible,
      completedToday: evaluation.outcome.met,
      weeklyTargetMet: evaluation.weekly ? evaluation.weekly.done >= evaluation.weekly.target : false,
      reminderEnabled: rule?.reminderEnabled ?? false,
      reminderMinute: rule?.reminderMinute ?? null,
      timeMinute: evaluation.occurrence.timeMinute,
      archived: false, // evaluateGoalsForDate already filters archived goals
      deliveredKeys,
    });
    if (resolved.ok) occurrences.push(resolved.occurrence);
  }

  // Due-date reminders — bills and tasks share the one foundation resolver;
  // future modules (documents expiring, low balances, review check-ins) add a
  // load here and reuse it rather than growing their own engines.
  for (const bill of dueBills) {
    const resolved = resolveDueReminder({
      kind: "bill",
      ownerId: bill.id,
      name: bill.name,
      dueDate: bill.nextDueDate,
      today: date,
      enabled: bill.reminderEnabled,
      completed: bill.settledAt !== null,
      inactive: bill.archivedAt !== null,
      daysBefore: bill.reminderDaysBefore,
      detail: formatMoney(bill.amount),
      deliveredKeys,
    });
    if (resolved.ok) occurrences.push(resolved.occurrence);
  }

  for (const task of dueTasks) {
    const resolved = resolveDueReminder({
      kind: "task",
      ownerId: task.id,
      name: task.title,
      dueDate: task.dueDate ?? date,
      today: date,
      enabled: task.reminderEnabled,
      completed: task.status !== "open",
      inactive: false,
      daysBefore: 0,
      detail: null,
      deliveredKeys,
    });
    if (resolved.ok) occurrences.push(resolved.occurrence);
  }

  occurrences.sort((a, b) => a.fireAt.localeCompare(b.fireAt));
  return occurrences;
}

/**
 * Record a delivery and, for a classic reminder, advance or disable the row —
 * the same behaviour `markReminderFired` always had, now keyed so an
 * occurrence can never fire twice even across tabs and reloads.
 */
export async function recordReminderDelivery(key: string, reminderId: string | null): Promise<void> {
  const user = await getCurrentUser();
  return recordReminderDeliveryFor(user.id, key, reminderId);
}

/** The ledger write for an explicit user — shared with the push runner. */
export async function recordReminderDeliveryFor(
  userId: string,
  key: string,
  reminderId: string | null,
): Promise<void> {
  const user = { id: userId };

  try {
    await prisma.reminderDelivery.create({ data: { userId: user.id, key } });
  } catch {
    // Unique collision: another tab delivered it first. Nothing more to do.
    return;
  }

  if (reminderId) {
    const reminder = await prisma.reminder.findFirst({
      where: { id: reminderId, userId: user.id },
    });
    if (!reminder) return;
    const next = nextOccurrence(reminder.remindAt, reminder.repeat);
    await prisma.reminder.update({
      where: { id: reminder.id },
      data: {
        lastFiredAt: new Date(),
        remindAt: next ?? reminder.remindAt,
        enabled: next !== null,
      },
    });
  }

  // Old delivery rows are useless after a few days; sweep opportunistically.
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  await prisma.reminderDelivery
    .deleteMany({ where: { userId: user.id, deliveredAt: { lt: cutoff } } })
    .catch(() => {});
}

function nextOccurrence(from: Date, repeat: string): Date | null {
  const next = new Date(from);
  switch (repeat) {
    case "daily":
      next.setDate(next.getDate() + 1);
      return next;
    case "weekdays":
      do {
        next.setDate(next.getDate() + 1);
      } while (next.getDay() === 0 || next.getDay() === 6);
      return next;
    case "weekly":
      next.setDate(next.getDate() + 7);
      return next;
    default:
      return null;
  }
}
