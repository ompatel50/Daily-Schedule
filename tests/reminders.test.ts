import { describe, expect, it } from "vitest";

import {
  classicReminderKey,
  DELIVERY_WINDOW_MS,
  isDeliverable,
  minuteToWallClock,
  occurrenceKey,
  resolveClassicReminder,
  resolveScheduleReminder,
  type ClassicReminderInput,
  type ScheduleReminderInput,
} from "@/lib/logic/reminders";

const none = new Set<string>();

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
