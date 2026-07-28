import type { Metadata } from "next";

import { CalendarView } from "@/components/calendar/calendar-view";
import type { HeatDay } from "@/components/calendar/consistency-heatmap";
import { DateNav } from "@/components/shared/date-nav";
import { PageHeader } from "@/components/shared/page-header";
import { DayDetail } from "@/components/calendar/day-detail";
import { isDayKey, weekdayLabelsFor } from "@/lib/date";
import { getUser } from "@/server/queries";
import { getConsistencyWindow, getMonthCalendar } from "@/server/queries";
import { scheduleSettingsFor } from "@/server/schedule";

export const metadata: Metadata = { title: "Calendar" };
export const dynamic = "force-dynamic";

const WINDOW_DAYS = 182;

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; detail?: string }>;
}) {
  const params = await searchParams;
  const user = await getUser();
  const settings = scheduleSettingsFor(user);
  const anchor = params.date && isDayKey(params.date) ? params.date : settings.today;
  const detail = params.detail && isDayKey(params.detail) ? params.detail : undefined;

  const [window, month] = await Promise.all([
    getConsistencyWindow(WINDOW_DAYS, settings.today),
    getMonthCalendar(anchor),
  ]);

  // Merge both queries into one plain record for the client component.
  const byDate: Record<string, HeatDay> = {};
  for (const map of [window.byDate, month.byDate]) {
    for (const [date, summary] of map) {
      byDate[date] = {
        date,
        score: summary.score,
        scoreApplicable: summary.scoreApplicable,
        scoreCompleted: summary.scoreCompleted,
        scoreMissed: summary.scoreMissed,
        scoreExcluded: summary.scoreExcluded,
        plannedCount: summary.plannedCount,
        completedCount: summary.completedCount,
        habitsDue: summary.habitsDue,
        habitsDone: summary.habitsDone,
        calories: summary.calories,
        workoutCount: summary.workoutCount,
        workoutMinutes: summary.workoutMinutes,
      };
    }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Calendar"
        description="Six months of consistency at a glance, and the month in detail."
        actions={<DateNav date={anchor} scope="month" weekStartsOn={month.weekStartsOn} />}
      />

      {detail && (
        <div className="mb-6">
          <DayDetail date={detail} anchor={anchor} />
        </div>
      )}

      <CalendarView
        windowDays={window.days}
        byDate={byDate}
        monthDays={month.days}
        monthAnchor={anchor}
        weekdayLabels={weekdayLabelsFor(month.weekStartsOn)}
        journalDates={Array.from(month.journalDates)}
        today={settings.today}
        selected={detail}
      />
    </div>
  );
}
