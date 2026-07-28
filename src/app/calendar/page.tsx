import type { Metadata } from "next";

import { CalendarView } from "@/components/calendar/calendar-view";
import type { HeatDay } from "@/components/calendar/consistency-heatmap";
import { DateNav } from "@/components/shared/date-nav";
import { PageHeader } from "@/components/shared/page-header";
import { isDayKey, today, weekdayLabelsFor } from "@/lib/date";
import { getConsistencyWindow, getMonthCalendar } from "@/server/queries";

export const metadata: Metadata = { title: "Calendar" };
export const dynamic = "force-dynamic";

const WINDOW_DAYS = 182;

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const params = await searchParams;
  const anchor = params.date && isDayKey(params.date) ? params.date : today();

  const [window, month] = await Promise.all([
    getConsistencyWindow(WINDOW_DAYS, today()),
    getMonthCalendar(anchor),
  ]);

  // Merge both queries into one plain record for the client component.
  const byDate: Record<string, HeatDay> = {};
  for (const map of [window.byDate, month.byDate]) {
    for (const [date, summary] of map) {
      byDate[date] = {
        date,
        score: summary.score,
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

      <CalendarView
        windowDays={window.days}
        byDate={byDate}
        monthDays={month.days}
        monthAnchor={anchor}
        weekdayLabels={weekdayLabelsFor(month.weekStartsOn)}
        journalDates={Array.from(month.journalDates)}
      />
    </div>
  );
}
