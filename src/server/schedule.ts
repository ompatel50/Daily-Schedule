/**
 * NOTE ON `server-only`: this module is part of the shared computation layer
 * (facts → schedule → goals → score → summaries) rather than the app-facing
 * server surface. The guard lives on `src/server/queries.ts` and the modules in
 * `src/server/actions/`, which are what pages and components import directly.
 * Keeping it off the computation modules is deliberate: it lets the seed script
 * and future CLI tooling call the *real* aggregation instead of maintaining a
 * hand-copied duplicate of the formula, which is precisely the drift this
 * upgrade set out to remove.
 */
import { prisma } from "@/lib/db";
import { type DayKey, shiftDay } from "@/lib/date";
import {
  normalizeRuleInput,
  type SchedulableItem,
  type ScheduleOverrideLike,
  type ScheduleRuleLike,
  type ScheduleSettings,
  todayIn,
} from "@/lib/logic/schedule";

/**
 * Persistence for the schedule engine.
 *
 * The engine itself (src/lib/logic/schedule.ts) is pure. This module is the
 * only thing that reads and writes `ScheduleRule` / `ScheduleRuleDay` /
 * `ScheduleOverride`, which keeps the versioning invariant — non-overlapping
 * effective windows per owner — in one place.
 */

export type OwnerType = "goal" | "habit";

type RuleRow = {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  mode: string;
  interval: number;
  timesPerWeek: number | null;
  monthDay: number | null;
  enabled: boolean;
  daypart: string;
  timeMinute: number | null;
  reminderEnabled: boolean;
  reminderMinute: number | null;
  days: Array<{ weekday: number }>;
};

function toRuleLike(row: RuleRow): ScheduleRuleLike {
  return {
    id: row.id,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    mode: row.mode,
    interval: row.interval,
    timesPerWeek: row.timesPerWeek,
    monthDay: row.monthDay,
    enabled: row.enabled,
    daypart: row.daypart,
    timeMinute: row.timeMinute,
    reminderEnabled: row.reminderEnabled,
    reminderMinute: row.reminderMinute,
    weekdays: row.days.map((day) => day.weekday).sort((a, b) => a - b),
  };
}

export interface ScheduleBundle {
  rules: ScheduleRuleLike[];
  overrides: ScheduleOverrideLike[];
}

/**
 * Load every rule and override for a set of owners in two queries.
 *
 * Batched deliberately: resolving a month of calendar cells one owner at a time
 * is the N+1 that would make the calendar slow.
 */
export async function loadSchedules(
  userId: string,
  ownerType: OwnerType,
  ownerIds?: string[],
): Promise<Map<string, ScheduleBundle>> {
  const where = {
    userId,
    ownerType,
    ...(ownerIds ? { ownerId: { in: ownerIds } } : {}),
  };

  const [rules, overrides] = await Promise.all([
    prisma.scheduleRule.findMany({
      where,
      include: { days: true },
      orderBy: { effectiveFrom: "asc" },
    }),
    prisma.scheduleOverride.findMany({ where, orderBy: { date: "asc" } }),
  ]);

  const bundles = new Map<string, ScheduleBundle>();
  const bundleFor = (ownerId: string): ScheduleBundle => {
    let bundle = bundles.get(ownerId);
    if (!bundle) {
      bundle = { rules: [], overrides: [] };
      bundles.set(ownerId, bundle);
    }
    return bundle;
  };

  for (const rule of rules) bundleFor(rule.ownerId).rules.push(toRuleLike(rule));
  for (const override of overrides) {
    bundleFor(override.ownerId).overrides.push({
      date: override.date,
      kind: override.kind,
      movedToDate: override.movedToDate,
      timeMinute: override.timeMinute,
      note: override.note,
    });
  }

  return bundles;
}

/** Combine an owner record with its schedule into the engine's input shape. */
export function toSchedulable(
  owner: { id: string; startDate?: string | null; endDate?: string | null; enabled: boolean },
  bundle: ScheduleBundle | undefined,
): SchedulableItem {
  return {
    id: owner.id,
    startDate: owner.startDate ?? null,
    endDate: owner.endDate ?? null,
    enabled: owner.enabled,
    rules: bundle?.rules ?? [],
    overrides: bundle?.overrides ?? [],
  };
}

/** The engine's settings, derived from the user record. */
export function scheduleSettingsFor(user: {
  weekStartsOn: number;
  timezone: string;
}): ScheduleSettings {
  const timezone = user.timezone || "UTC";
  return {
    weekStartsOn: user.weekStartsOn === 0 ? 0 : 1,
    timezone,
    today: todayIn(timezone),
  };
}

// ---------------------------------------------------------------------------
// Writing schedules
// ---------------------------------------------------------------------------

export interface ScheduleInput {
  mode: string;
  weekdays?: number[];
  interval?: number;
  timesPerWeek?: number | null;
  monthDay?: number | null;
  enabled?: boolean;
  daypart?: string;
  timeMinute?: number | null;
  reminderEnabled?: boolean;
  reminderMinute?: number | null;
}

/**
 * How a schedule edit should treat history.
 *
 *  forward  — close the current version and start a new one (the default, and
 *             the only choice that cannot rewrite a past score)
 *  from     — same, but from an explicit date
 *  all      — replace every version, recalculating all history. Destructive to
 *             historical accuracy, so callers must ask first.
 */
export type ScheduleApplyMode = "forward" | "from" | "all";

export interface WriteScheduleOptions {
  userId: string;
  ownerType: OwnerType;
  ownerId: string;
  input: ScheduleInput;
  apply?: ScheduleApplyMode;
  /** Required when `apply` is "from". */
  applyFrom?: DayKey;
  /** The owner's own start date, used when creating the very first version. */
  ownerStartDate?: DayKey | null;
  today: DayKey;
}

/**
 * Write a schedule, versioning rather than overwriting.
 *
 * The invariant this protects: a date in the past must keep resolving against
 * the rule that was actually in force then. So an edit closes the current
 * version at the day before the change and opens a new one — it never edits a
 * window that has already been scored.
 */
export async function writeSchedule(options: WriteScheduleOptions): Promise<string> {
  const { userId, ownerType, ownerId, today } = options;
  const apply = options.apply ?? "forward";
  const normalized = normalizeRuleInput(options.input);

  const existing = await prisma.scheduleRule.findMany({
    where: { userId, ownerType, ownerId },
    orderBy: { effectiveFrom: "asc" },
    include: { days: true },
  });

  const data = {
    mode: normalized.mode,
    interval: normalized.interval,
    timesPerWeek: normalized.timesPerWeek,
    monthDay: normalized.monthDay,
    enabled: options.input.enabled ?? true,
    daypart: options.input.daypart ?? "anytime",
    timeMinute: options.input.timeMinute ?? null,
    reminderEnabled: options.input.reminderEnabled ?? false,
    reminderMinute: options.input.reminderMinute ?? null,
  };

  // --- first ever version ---------------------------------------------------
  if (existing.length === 0) {
    const created = await prisma.scheduleRule.create({
      data: {
        userId,
        ownerType,
        ownerId,
        effectiveFrom: options.ownerStartDate ?? today,
        effectiveTo: null,
        ...data,
        days: normalized.weekdays.length
          ? { create: normalized.weekdays.map((weekday) => ({ weekday })) }
          : undefined,
      },
    });
    return created.id;
  }

  // --- recalculate all history ---------------------------------------------
  if (apply === "all") {
    const earliest = existing[0].effectiveFrom;
    return prisma.$transaction(async (tx) => {
      await tx.scheduleRule.deleteMany({ where: { userId, ownerType, ownerId } });
      const created = await tx.scheduleRule.create({
        data: {
          userId,
          ownerType,
          ownerId,
          effectiveFrom: options.ownerStartDate ?? earliest,
          effectiveTo: null,
          ...data,
          days: normalized.weekdays.length
            ? { create: normalized.weekdays.map((weekday) => ({ weekday })) }
            : undefined,
        },
      });
      return created.id;
    });
  }

  const from = apply === "from" && options.applyFrom ? options.applyFrom : today;

  // The version currently covering `from`.
  const current = existing
    .filter((rule) => rule.effectiveFrom <= from && (!rule.effectiveTo || rule.effectiveTo >= from))
    .at(-1);

  // Editing a version that has not started producing history yet is a genuine
  // correction, not a change of plan — update it in place.
  if (current && current.effectiveFrom >= from) {
    await prisma.$transaction(async (tx) => {
      await tx.scheduleRuleDay.deleteMany({ where: { ruleId: current.id } });
      await tx.scheduleRule.update({
        where: { id: current.id },
        data: {
          ...data,
          effectiveFrom: current.effectiveFrom,
          days: normalized.weekdays.length
            ? { create: normalized.weekdays.map((weekday) => ({ weekday })) }
            : undefined,
        },
      });
    });
    return current.id;
  }

  return prisma.$transaction(async (tx) => {
    if (current) {
      await tx.scheduleRule.update({
        where: { id: current.id },
        data: { effectiveTo: shiftDay(from, -1) },
      });
    }
    // Any version starting on/after the change point is superseded outright.
    await tx.scheduleRule.deleteMany({
      where: { userId, ownerType, ownerId, effectiveFrom: { gte: from } },
    });

    const created = await tx.scheduleRule.create({
      data: {
        userId,
        ownerType,
        ownerId,
        effectiveFrom: from,
        effectiveTo: null,
        ...data,
        days: normalized.weekdays.length
          ? { create: normalized.weekdays.map((weekday) => ({ weekday })) }
          : undefined,
      },
    });
    return created.id;
  });
}

/** Flip the enabled flag on every version — used by "pause this goal". */
export async function setScheduleEnabled(
  userId: string,
  ownerType: OwnerType,
  ownerId: string,
  enabled: boolean,
): Promise<void> {
  await prisma.scheduleRule.updateMany({
    where: { userId, ownerType, ownerId },
    data: { enabled },
  });
}

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

export async function setDateOverride(params: {
  userId: string;
  ownerType: OwnerType;
  ownerId: string;
  date: DayKey;
  kind: string;
  movedToDate?: DayKey | null;
  timeMinute?: number | null;
  note?: string | null;
}): Promise<void> {
  const { userId, ownerType, ownerId, date, kind } = params;
  const data = {
    kind,
    movedToDate: params.movedToDate ?? null,
    timeMinute: params.timeMinute ?? null,
    note: params.note ?? null,
  };

  await prisma.scheduleOverride.upsert({
    where: { ownerType_ownerId_date: { ownerType, ownerId, date } },
    create: { userId, ownerType, ownerId, date, ...data },
    update: data,
  });
}

/** "Restore the normal occurrence" — remove the exception, keep the schedule. */
export async function clearDateOverride(
  userId: string,
  ownerType: OwnerType,
  ownerId: string,
  date: DayKey,
): Promise<void> {
  await prisma.scheduleOverride.deleteMany({ where: { userId, ownerType, ownerId, date } });
}

/** Remove an owner's schedule entirely — called when the owner is deleted. */
export async function deleteSchedule(
  userId: string,
  ownerType: OwnerType,
  ownerId: string,
): Promise<void> {
  await prisma.$transaction([
    prisma.scheduleRule.deleteMany({ where: { userId, ownerType, ownerId } }),
    prisma.scheduleOverride.deleteMany({ where: { userId, ownerType, ownerId } }),
  ]);
}
