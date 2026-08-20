/**
 * NOTE ON `server-only`: part of the shared computation layer, not the
 * app-facing server surface. See src/server/facts.ts for the reasoning.
 */
import { prisma } from "@/lib/prisma";
import { shiftDay, weekRange } from "@/lib/date";
import {
  type AnomalyCategory,
  type AnomalyPreferenceLike,
  type AnomalyReport,
  type HabitStreakInput,
  detectAnomalies,
} from "@/lib/logic/anomalies";
import type { ScheduleSettings } from "@/lib/logic/schedule";
import { scheduleSettingsFor } from "@/server/schedule";
import { getHabitViews } from "@/server/habits";
import { getDailyFacts } from "@/server/summaries";

/** How much daily-fact history the detectors read: enough for the longest
 * baseline (8 spending weeks + the current one) with a margin. Bounded —
 * never the whole history. */
const ANOMALY_HISTORY_DAYS = 70;

export interface AnomalyContext {
  report: AnomalyReport;
  date: string;
  weekStart: string;
  preferences: Partial<Record<AnomalyCategory, AnomalyPreferenceLike>>;
}

/**
 * The one anomaly evaluation both consumers share: the reminder feed maps
 * `report.signals` to occurrences (delivery, rate-limited and deduplicated
 * through the ledger), the Observations card shows `report.observations`
 * (a delivered nudge is still a true observation). All reads are this
 * user's own rows; nothing leaves the server.
 */
export async function getAnomalyContextFor(
  user: {
    id: string;
    timezone: string;
    weekStartsOn: number;
    dayResetMinute?: number;
  },
  presetSettings?: ScheduleSettings,
): Promise<AnomalyContext> {
  const settings = presetSettings ?? scheduleSettingsFor(user);
  const date = settings.today;
  const weekStart = weekRange(date, user.weekStartsOn === 0 ? 0 : 1).start;
  const yesterday = shiftDay(date, -1);

  const [facts, preferenceRows, deliveredRows, viewsTwoBack, viewsYesterday] = await Promise.all([
    getDailyFacts(user.id, shiftDay(date, -ANOMALY_HISTORY_DAYS), date),
    prisma.anomalyPreference.findMany({ where: { userId: user.id } }),
    // The delivery ledger sweeps rows older than 7 days, so "rows with an
    // anomaly key" IS the rolling-week delivery count.
    prisma.reminderDelivery.findMany({
      where: { userId: user.id, key: { startsWith: "anomaly:" } },
      select: { key: true },
    }),
    // Streak as it stood before a potential break…
    getHabitViews(user.id, shiftDay(date, -2), settings, { historyDays: 30 }),
    // …and whether yesterday actually broke it.
    getHabitViews(user.id, yesterday, settings, { historyDays: 7 }),
  ]);

  const preferences: Partial<Record<AnomalyCategory, AnomalyPreferenceLike>> = {};
  for (const row of preferenceRows) {
    preferences[row.category as AnomalyCategory] = {
      muted: row.muted,
      dismissals: row.dismissals,
    };
  }

  const statusYesterday = new Map(viewsYesterday.map((view) => [view.id, view.status]));
  const habits: HabitStreakInput[] = viewsTwoBack.map((view) => ({
    name: view.name,
    streakBeforeBreak: view.streak,
    brokeOn: statusYesterday.get(view.id) === "missed" ? yesterday : null,
  }));

  const deliveredKeys = new Set(deliveredRows.map((row) => row.key));
  const report = detectAnomalies({
    facts,
    today: date,
    weekStart,
    habits,
    preferences,
    deliveredThisWeek: deliveredRows.length,
    deliveredKeys,
  });

  return { report, date, weekStart, preferences };
}
