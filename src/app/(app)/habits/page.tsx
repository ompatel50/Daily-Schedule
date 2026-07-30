import type { Metadata } from "next";
import { Suspense } from "react";
import { CheckCircle2, Flame, Repeat, Target } from "lucide-react";

import { HabitBoard, type HabitBoardItem } from "@/components/habits/habit-board";
import { HabitChecklist } from "@/components/habits/habit-checklist";
import { TrendAreaChart } from "@/components/shared/charts";
import { DateNav } from "@/components/shared/date-nav";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatCard } from "@/components/shared/stat-card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDay, isDayKey, lastNDays, shiftDay } from "@/lib/date";
import { average, formatNumber, pct } from "@/lib/utils";
import { getHabitsWithStats, getUser } from "@/server/queries";
import { scheduleSettingsFor } from "@/server/schedule";
import { getSummaries } from "@/server/summaries";

export const metadata: Metadata = { title: "Habits" };
export const dynamic = "force-dynamic";

export default async function HabitsPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; new?: string }>;
}) {
  const params = await searchParams;
  const user = await getUser();
  const settings = scheduleSettingsFor(user);
  const date = params.date && isDayKey(params.date) ? params.date : settings.today;

  const [habits, summaries] = await Promise.all([
    getHabitsWithStats(date, { includeArchived: true, historyDays: 90 }),
    getSummaries(user.id, shiftDay(date, -29), date),
  ]);

  const active = habits.filter((habit) => !habit.archived);
  // "Due" means the schedule places a real requirement today. A times-per-week
  // habit is available rather than required, and a habit that is not scheduled
  // at all is neither.
  const due = active.filter((habit) => habit.dueToday || habit.flexibleToday);
  const resting = active.filter((habit) => !habit.dueToday && !habit.flexibleToday);
  const doneToday = due.filter((habit) => habit.todayStatus === "done").length;

  const bestStreak = active.reduce((best, habit) => Math.max(best, habit.streak), 0);
  // Habits with no scheduled opportunity yet report null, not 0% — averaging
  // them in would drag consistency down for a habit that has not come due.
  const rates = active
    .map((habit) => habit.completionRate)
    .filter((rate): rate is number => rate !== null);
  const avgRate = rates.length === 0 ? 0 : average(rates);

  const summaryByDate = new Map(summaries.map((summary) => [summary.date, summary]));
  const trend = lastNDays(30, date).map((day) => {
    const summary = summaryByDate.get(day);
    return {
      label: formatDay(day, "M/d"),
      rate: summary && summary.habitsDue > 0 ? Math.round((summary.habitsDone / summary.habitsDue) * 100) : 0,
    };
  });

  const boardItems: HabitBoardItem[] = habits.map((habit) => ({
    id: habit.id,
    name: habit.name,
    description: habit.description,
    category: habit.category,
    timeOfDay: habit.timeOfDay,
    startDate: habit.startDate,
    endDate: habit.endDate,
    archived: habit.archived,
    schedule: habit.schedule,
    dueToday: habit.dueToday,
    flexibleToday: habit.flexibleToday,
    todayStatus: habit.todayStatus,
    streak: habit.streak,
    longestStreak: habit.longestStreak,
    streakUnit: habit.streakUnit,
    completionRate: habit.completionRate,
    opportunities: habit.opportunities,
    weekDone: habit.weekDone,
    weekTarget: habit.weekTarget,
    scheduleSummary: habit.scheduleSummary,
    recentLogs: habit.recentLogs,
    dayStates: habit.dayStates,
  }));

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Habits"
        description="Small things, done repeatedly. Click any dot to fix a missed day."
        actions={<DateNav date={date} weekStartsOn={user.weekStartsOn === 0 ? 0 : 1} />}
      />

      <div className="stat-grid mb-6">
        <StatCard
          label="Due today"
          value={`${doneToday}/${due.length}`}
          hint={due.length === 0 ? "rest day — nothing scheduled" : "completed"}
          icon={CheckCircle2}
          accent="text-domain-habit"
          progress={pct(doneToday, due.length)}
          progressClassName="bg-domain-habit"
        />
        <StatCard
          label="Best active streak"
          value={`${bestStreak}`}
          hint={bestStreak === 1 ? "day" : "days"}
          icon={Flame}
          accent="text-orange-500"
        />
        <StatCard
          label="Average consistency"
          value={`${formatNumber(avgRate)}%`}
          hint="last 90 days"
          icon={Target}
          accent="text-emerald-500"
          progress={avgRate}
          progressClassName="bg-emerald-500"
        />
        <StatCard
          label="Active habits"
          value={`${active.length}`}
          hint={`${habits.length - active.length} archived`}
          icon={Repeat}
          accent="text-domain-habit"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-4">
        <div className="lg:col-span-3">
          <Suspense fallback={<Skeleton className="h-96 w-full" />}>
            <HabitBoard habits={boardItems} date={date} weekStartsOn={settings.weekStartsOn} />
          </Suspense>
        </div>

        <div className="space-y-6">
          <SectionCard
            title="Today"
            icon={CheckCircle2}
            accent="text-domain-habit"
            description={
              due.length === 0 ? "Nothing scheduled today" : `${doneToday} of ${due.length} done`
            }
          >
            <HabitChecklist habits={due} restingHabits={resting} date={date} />
          </SectionCard>

          <SectionCard
            title="Consistency"
            icon={Target}
            accent="text-emerald-500"
            description="% of due habits completed"
          >
            <TrendAreaChart
              data={trend}
              dataKey="rate"
              color="hsl(var(--domain-habit))"
              height={170}
              unit="%"
            />
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
