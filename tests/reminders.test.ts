import { describe, expect, it } from "vitest";

import {
  budgetThresholdReminderKey,
  classicReminderKey,
  DELIVERY_WINDOW_MS,
  DUE_REMINDER_MINUTE,
  dueReminderKey,
  isDeliverable,
  lowBalanceReminderKey,
  minuteToWallClock,
  occurrenceKey,
  resolveBudgetThresholdReminder,
  resolveClassicReminder,
  resolveDueReminder,
  resolveLowBalanceReminder,
  resolveScheduleReminder,
  type BudgetThresholdReminderInput,
  type ClassicReminderInput,
  type DueReminderInput,
  type LowBalanceReminderInput,
  type ScheduleReminderInput,
} from "@/lib/logic/reminders";

const none = new Set<string>();

/** Assert a due reminder resolved, and hand back the occurrence. */
function resolveExpecting(input: DueReminderInput) {
  const result = resolveDueReminder(input);
  if (!result.ok) throw new Error(`expected an occurrence, got "${result.reason}"`);
  return result;
}

function classic(partial: Partial<ClassicReminderInput> = {}): ClassicReminderInput {
  return {
    id: "r1",
    title: "Plan your day",
    message: null,
    enabled: true,
    remindAtIso: "2026-07-30T07:00:00.000Z",
    lastFiredAtIso: null,
    attachedItemStatus: null,
    deliveredKeys: none,
    ...partial,
  };
}

function scheduled(partial: Partial<ScheduleReminderInput> = {}): ScheduleReminderInput {
  return {
    kind: "habit",
    ownerId: "h1",
    name: "Morning stretch",
    date: "2026-07-30",
    status: "pending",
    dueToday: true,
    flexibleToday: false,
    completedToday: false,
    weeklyTargetMet: false,
    reminderEnabled: true,
    reminderMinute: 7 * 60,
    timeMinute: null,
    archived: false,
    deliveredKeys: none,
    ...partial,
  };
}

describe("classic reminders", () => {
  it("fires a plain enabled reminder", () => {
    const result = resolveClassicReminder(classic());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.occurrence.fireAt).toBe("2026-07-30T07:00:00.000Z");
      expect(result.occurrence.reminderId).toBe("r1");
    }
  });

  it("stays silent when disabled", () => {
    expect(resolveClassicReminder(classic({ enabled: false }))).toEqual({
      ok: false,
      reason: "disabled",
    });
  });

  it("never fires for a completed planner item", () => {
    expect(resolveClassicReminder(classic({ attachedItemStatus: "done" }))).toEqual({
      ok: false,
      reason: "completed",
    });
  });

  it("never fires for a skipped (canceled) planner item", () => {
    expect(resolveClassicReminder(classic({ attachedItemStatus: "skipped" }))).toEqual({
      ok: false,
      reason: "canceled",
    });
  });

  it("never re-fires an occurrence that already fired", () => {
    expect(
      resolveClassicReminder(classic({ lastFiredAtIso: "2026-07-30T07:00:01.000Z" })),
    ).toEqual({ ok: false, reason: "already_fired" });
    // A fired stamp from a *previous* occurrence does not block the next one.
    expect(
      resolveClassicReminder(classic({ lastFiredAtIso: "2026-07-29T07:00:00.000Z" })).ok,
    ).toBe(true);
  });

  it("never re-delivers a key already in the ledger", () => {
    const key = classicReminderKey("r1", "2026-07-30T07:00:00.000Z");
    expect(resolveClassicReminder(classic({ deliveredKeys: new Set([key]) }))).toEqual({
      ok: false,
      reason: "delivered",
    });
  });
});

describe("schedule-rule reminders", () => {
  it("fires for a due habit at the configured minute", () => {
    const result = resolveScheduleReminder(scheduled());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.occurrence.key).toBe("habit:h1:2026-07-30");
      expect(result.occurrence.fireAt).toBe("2026-07-30T07:00:00");
    }
  });

  it.each([
    ["rest", "rest_day"],
    ["not_scheduled", "not_scheduled"],
    ["excused", "excused"],
    ["canceled", "canceled"],
    ["skipped", "canceled"],
    ["completed", "completed"],
    ["inactive", "inactive"],
    ["future", "future"],
  ] as const)("never fires when the engine says the day is %s", (status, reason) => {
    expect(resolveScheduleReminder(scheduled({ status }))).toEqual({ ok: false, reason });
  });

  it("never fires for an archived habit", () => {
    expect(resolveScheduleReminder(scheduled({ archived: true }))).toEqual({
      ok: false,
      reason: "inactive",
    });
  });

  it("never fires when the reminder is not enabled on the rule", () => {
    expect(resolveScheduleReminder(scheduled({ reminderEnabled: false }))).toEqual({
      ok: false,
      reason: "disabled",
    });
  });

  it("never fires once today's occurrence is done", () => {
    expect(resolveScheduleReminder(scheduled({ completedToday: true }))).toEqual({
      ok: false,
      reason: "completed",
    });
  });

  it("a times-per-week item reminds while the week still needs it, then stops", () => {
    const flexible = { dueToday: false, flexibleToday: true } as const;
    expect(resolveScheduleReminder(scheduled({ ...flexible, weeklyTargetMet: false })).ok).toBe(true);
    expect(resolveScheduleReminder(scheduled({ ...flexible, weeklyTargetMet: true }))).toEqual({
      ok: false,
      reason: "completed",
    });
  });

  it("falls back to the scheduled time, and stays silent with no time at all", () => {
    const fellBack = resolveScheduleReminder(
      scheduled({ reminderMinute: null, timeMinute: 8 * 60 + 30 }),
    );
    expect(fellBack.ok && fellBack.occurrence.fireAt).toBe("2026-07-30T08:30:00");
    expect(resolveScheduleReminder(scheduled({ reminderMinute: null, timeMinute: null }))).toEqual({
      ok: false,
      reason: "no_time",
    });
  });

  it("never delivers the same occurrence twice", () => {
    const key = occurrenceKey("habit", "h1", "2026-07-30");
    expect(resolveScheduleReminder(scheduled({ deliveredKeys: new Set([key]) }))).toEqual({
      ok: false,
      reason: "delivered",
    });
  });

  it("goal occurrences are keyed apart from habit occurrences", () => {
    expect(occurrenceKey("goal", "x", "2026-07-30")).not.toBe(
      occurrenceKey("habit", "x", "2026-07-30"),
    );
  });
});

function due(partial: Partial<DueReminderInput> = {}): DueReminderInput {
  return {
    kind: "bill",
    ownerId: "b1",
    name: "Rent",
    dueDate: "2026-07-30",
    today: "2026-07-30",
    enabled: true,
    completed: false,
    inactive: false,
    daysBefore: 3,
    detail: "$1,800",
    deliveredKeys: none,
    ...partial,
  };
}

describe("due-date reminders (bills & tasks foundation)", () => {
  it("fires on the due day with the amount in the message", () => {
    const result = resolveDueReminder(due());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.occurrence.key).toBe("bill:b1:2026-07-30");
      expect(result.occurrence.kind).toBe("bill");
      expect(result.occurrence.message).toBe("Bill due today · $1,800");
      expect(result.occurrence.fireAt).toBe(minuteToWallClock("2026-07-30", DUE_REMINDER_MINUTE));
      expect(result.occurrence.reminderId).toBeNull();
    }
  });

  it("fires once during the run-up window, under a distinct 'ahead' key", () => {
    const result = resolveDueReminder(due({ today: "2026-07-28" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.occurrence.key).toBe("bill:b1:2026-07-30:ahead");
      expect(result.occurrence.message).toBe("Bill due in 2 days · $1,800");
      // It fires on TODAY's wall clock — the run-up day — not the due day's.
      expect(result.occurrence.fireAt).toBe(minuteToWallClock("2026-07-28", DUE_REMINDER_MINUTE));
    }
  });

  it("says 'tomorrow' the day before", () => {
    const result = resolveDueReminder(due({ today: "2026-07-29", detail: null }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.occurrence.message).toBe("Bill due tomorrow");
  });

  it("stays silent outside the run-up window", () => {
    expect(resolveDueReminder(due({ today: "2026-07-26" }))).toEqual({
      ok: false,
      reason: "not_scheduled",
    });
  });

  it("stays silent for an overdue item — nagging is the dashboard's job", () => {
    expect(resolveDueReminder(due({ today: "2026-07-31" }))).toEqual({
      ok: false,
      reason: "not_scheduled",
    });
  });

  it("daysBefore 0 means only the due day itself", () => {
    expect(resolveDueReminder(due({ today: "2026-07-29", daysBefore: 0 }))).toEqual({
      ok: false,
      reason: "not_scheduled",
    });
    expect(resolveDueReminder(due({ today: "2026-07-30", daysBefore: 0 })).ok).toBe(true);
  });

  it("never reminds for paid, archived or disabled items", () => {
    expect(resolveDueReminder(due({ completed: true }))).toEqual({
      ok: false,
      reason: "completed",
    });
    expect(resolveDueReminder(due({ inactive: true }))).toEqual({ ok: false, reason: "inactive" });
    expect(resolveDueReminder(due({ enabled: false }))).toEqual({ ok: false, reason: "disabled" });
  });

  it("respects the delivery ledger for both keys independently", () => {
    const deliveredMain = new Set([dueReminderKey("bill", "b1", "2026-07-30")]);
    expect(resolveDueReminder(due({ deliveredKeys: deliveredMain }))).toEqual({
      ok: false,
      reason: "delivered",
    });
    // The ahead key is separate: yesterday's run-up delivery never suppresses
    // the due-day reminder itself.
    const aheadResult = resolveDueReminder(
      due({ today: "2026-07-28", deliveredKeys: deliveredMain }),
    );
    expect(aheadResult.ok).toBe(true);
  });

  it("tasks read as tasks", () => {
    const result = resolveDueReminder(
      due({ kind: "task", ownerId: "t1", name: "Renew passport", detail: null, daysBefore: 0 }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.occurrence.key).toBe("task:t1:2026-07-30");
      expect(result.occurrence.message).toBe("Task due today");
    }
  });
});

describe("low-balance reminders", () => {
  function low(partial: Partial<LowBalanceReminderInput> = {}): LowBalanceReminderInput {
    return {
      accountId: "acc1",
      accountName: "Everyday checking",
      balance: 40,
      threshold: 100,
      archived: false,
      today: "2026-07-30",
      weekStart: "2026-07-27",
      detail: "Balance $40 is below your $100 alert level",
      deliveredKeys: none,
      ...partial,
    };
  }

  it("fires when the balance sits below the threshold, keyed by the WEEK", () => {
    const result = resolveLowBalanceReminder(low());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.occurrence.key).toBe("low_balance:acc1:2026-07-27");
      expect(result.occurrence.kind).toBe("low_balance");
      expect(result.occurrence.title).toBe("Everyday checking is low");
      expect(result.occurrence.message).toContain("below your");
      expect(result.occurrence.fireAt).toBe(minuteToWallClock("2026-07-30", DUE_REMINDER_MINUTE));
      expect(result.occurrence.reminderId).toBeNull();
    }
  });

  it("stays silent at or above the threshold — including exactly at it", () => {
    expect(resolveLowBalanceReminder(low({ balance: 100 }))).toEqual({
      ok: false,
      reason: "not_scheduled",
    });
    expect(resolveLowBalanceReminder(low({ balance: 5000 }))).toEqual({
      ok: false,
      reason: "not_scheduled",
    });
  });

  it("no threshold means no alert; archived accounts never remind", () => {
    expect(resolveLowBalanceReminder(low({ threshold: null }))).toEqual({
      ok: false,
      reason: "disabled",
    });
    expect(resolveLowBalanceReminder(low({ archived: true }))).toEqual({
      ok: false,
      reason: "inactive",
    });
  });

  it("fires at most once per week — the ledger key covers the whole week", () => {
    const delivered = new Set([lowBalanceReminderKey("acc1", "2026-07-27")]);
    // Any later day in the same week is suppressed…
    expect(
      resolveLowBalanceReminder(low({ today: "2026-08-01", deliveredKeys: delivered })),
    ).toEqual({ ok: false, reason: "delivered" });
    // …and a new week arms it again.
    const nextWeek = resolveLowBalanceReminder(
      low({ today: "2026-08-03", weekStart: "2026-08-03", deliveredKeys: delivered }),
    );
    expect(nextWeek.ok).toBe(true);
  });

  it("a negative threshold works for debt accounts", () => {
    // "Tell me when the card balance drops below −500" (more owed than 500).
    expect(resolveLowBalanceReminder(low({ balance: -600, threshold: -500 })).ok).toBe(true);
    expect(resolveLowBalanceReminder(low({ balance: -400, threshold: -500 }))).toEqual({
      ok: false,
      reason: "not_scheduled",
    });
  });
});

describe("document-expiry reminders", () => {
  function expiring(partial: Partial<DueReminderInput> = {}): DueReminderInput {
    return {
      kind: "document",
      ownerId: "doc1",
      name: "Passport",
      dueDate: "2026-08-29",
      today: "2026-07-30",
      enabled: true,
      completed: false,
      inactive: false,
      daysBefore: 30,
      detail: null,
      deliveredKeys: none,
      ...partial,
    };
  }

  it("fires inside the run-up window, worded as an expiry", () => {
    const result = resolveExpecting(expiring());
    expect(result.occurrence).toMatchObject({
      key: "document:doc1:2026-08-29:ahead",
      kind: "document",
      title: "Passport",
      message: "Expires in 30 days",
      fireAt: minuteToWallClock("2026-07-30", DUE_REMINDER_MINUTE),
    });
  });

  it("fires on the expiry day itself, on its own key", () => {
    const result = resolveExpecting(expiring({ today: "2026-08-29" }));
    expect(result.occurrence.key).toBe("document:doc1:2026-08-29");
    expect(result.occurrence.message).toBe("Expires today");
  });

  it("appends the issuer as context when there is one", () => {
    const result = resolveExpecting(expiring({ today: "2026-08-28", detail: "State Department" }));
    expect(result.occurrence.message).toBe("Expires tomorrow · State Department");
  });

  it("stays silent outside the window, when disabled, and when archived", () => {
    expect(resolveDueReminder(expiring({ today: "2026-07-01" }))).toEqual({
      ok: false,
      reason: "not_scheduled",
    });
    expect(resolveDueReminder(expiring({ enabled: false }))).toEqual({
      ok: false,
      reason: "disabled",
    });
    expect(resolveDueReminder(expiring({ inactive: true }))).toEqual({
      ok: false,
      reason: "inactive",
    });
  });

  it("stays silent once expired — the page carries that state, not a daily nag", () => {
    expect(resolveDueReminder(expiring({ today: "2026-09-01" }))).toEqual({
      ok: false,
      reason: "not_scheduled",
    });
  });

  it("the whole run-up window fires at most once", () => {
    const delivered = new Set([dueReminderKey("document", "doc1", "2026-08-29", true)]);
    expect(resolveDueReminder(expiring({ deliveredKeys: delivered }))).toEqual({
      ok: false,
      reason: "delivered",
    });
    // …and the day itself is still its own occurrence.
    expect(resolveDueReminder(expiring({ today: "2026-08-29", deliveredKeys: delivered })).ok).toBe(
      true,
    );
  });

  it("renewing re-arms it: a new expiry date is a new key", () => {
    const delivered = new Set([dueReminderKey("document", "doc1", "2026-08-29", true)]);
    const renewed = resolveDueReminder(
      expiring({ dueDate: "2036-08-29", today: "2036-08-20", deliveredKeys: delivered }),
    );
    expect(renewed.ok).toBe(true);
  });

  it("a zero lead time reminds only on the day", () => {
    expect(resolveDueReminder(expiring({ daysBefore: 0, today: "2026-08-28" }))).toEqual({
      ok: false,
      reason: "not_scheduled",
    });
    expect(resolveDueReminder(expiring({ daysBefore: 0, today: "2026-08-29" })).ok).toBe(true);
  });
});

describe("budget-threshold reminders", () => {
  function budget(
    partial: Partial<BudgetThresholdReminderInput> = {},
  ): BudgetThresholdReminderInput {
    return {
      budgetId: "b1",
      label: "Groceries",
      periodStart: "2026-07-01",
      spent: 80,
      target: 100,
      threshold: 75,
      today: "2026-07-30",
      detail: null,
      deliveredKeys: none,
      ...partial,
    };
  }

  it("fires once spending reaches the threshold", () => {
    const result = resolveBudgetThresholdReminder(budget());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.occurrence).toMatchObject({
      key: "budget:b1:2026-07-01:75",
      kind: "budget",
      title: "Groceries budget at 80%",
      fireAt: minuteToWallClock("2026-07-30", DUE_REMINDER_MINUTE),
    });
  });

  it("exactly at the threshold counts as reached", () => {
    expect(resolveBudgetThresholdReminder(budget({ spent: 75 })).ok).toBe(true);
  });

  it("stays quiet below the threshold", () => {
    expect(resolveBudgetThresholdReminder(budget({ spent: 74 }))).toEqual({
      ok: false,
      reason: "not_scheduled",
    });
  });

  it("a budget with no threshold, or no target, never fires", () => {
    expect(resolveBudgetThresholdReminder(budget({ threshold: null }))).toEqual({
      ok: false,
      reason: "disabled",
    });
    expect(resolveBudgetThresholdReminder(budget({ target: 0, spent: 50 }))).toEqual({
      ok: false,
      reason: "disabled",
    });
  });

  it("reads as spent, not as a percentage, once past the target", () => {
    const result = resolveBudgetThresholdReminder(budget({ spent: 130, threshold: 100 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.occurrence.title).toBe("Groceries budget is spent");
  });

  it("never repeats inside one period, and re-arms in the next", () => {
    const delivered = new Set([budgetThresholdReminderKey("b1", "2026-07-01", 75)]);
    expect(
      resolveBudgetThresholdReminder(budget({ spent: 95, deliveredKeys: delivered })),
    ).toEqual({ ok: false, reason: "delivered" });

    const nextMonth = resolveBudgetThresholdReminder(
      budget({ periodStart: "2026-08-01", today: "2026-08-02", spent: 90, deliveredKeys: delivered }),
    );
    expect(nextMonth.ok).toBe(true);
  });

  it("a weekly budget's key is its week — each week alerts once", () => {
    const delivered = new Set([budgetThresholdReminderKey("b2", "2026-07-27", 90)]);
    const sameWeek = resolveBudgetThresholdReminder(
      budget({ budgetId: "b2", periodStart: "2026-07-27", threshold: 90, spent: 95, deliveredKeys: delivered }),
    );
    expect(sameWeek).toEqual({ ok: false, reason: "delivered" });

    const nextWeek = resolveBudgetThresholdReminder(
      budget({ budgetId: "b2", periodStart: "2026-08-03", threshold: 90, spent: 95, deliveredKeys: delivered }),
    );
    expect(nextWeek.ok).toBe(true);
  });

  it("changing the threshold arms a new alert — a different question", () => {
    const delivered = new Set([budgetThresholdReminderKey("b1", "2026-07-01", 75)]);
    expect(
      resolveBudgetThresholdReminder(budget({ threshold: 90, spent: 95, deliveredKeys: delivered }))
        .ok,
    ).toBe(true);
  });

  it("carries the supplied detail through as the message", () => {
    const result = resolveBudgetThresholdReminder(budget({ detail: "$80 of $100 this month" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.occurrence.message).toBe("$80 of $100 this month");
  });
});

describe("delivery window", () => {
  it("delivers on time and within the window, never early, never stale", () => {
    const fireAt = Date.parse("2026-07-30T07:00:00");
    expect(isDeliverable(fireAt, fireAt - 1)).toBe(false); // early
    expect(isDeliverable(fireAt, fireAt)).toBe(true);
    expect(isDeliverable(fireAt, fireAt + DELIVERY_WINDOW_MS)).toBe(true);
    expect(isDeliverable(fireAt, fireAt + DELIVERY_WINDOW_MS + 1)).toBe(false); // stale
  });

  it("formats wall-clock fire times without a zone suffix", () => {
    expect(minuteToWallClock("2026-07-30", 0)).toBe("2026-07-30T00:00:00");
    expect(minuteToWallClock("2026-07-30", 22 * 60 + 5)).toBe("2026-07-30T22:05:00");
  });
});
