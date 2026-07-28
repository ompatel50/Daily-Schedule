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
import { formatDay, isDayKey, lastNDays, shiftDay, today } from "@/lib/date";
import { average, formatNumber, pct } from "@/lib/utils";
import { getHabitsWithStats, getUser } from "@/server/queries";
import { getSummaries } from "@/server/summaries";

export const metadata: Metadata = { title: "Habits" };
export const dynamic = "force-dynamic";

export default async function HabitsPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; new?: string }>;
}) {
  const params = await searchParams;
  const date = params.date && isDayKey(params.date) ? params.date : today();

  const user = await getUser();
  const [habits, summaries] = await Promise.all([
    getHabitsWithStats(date, { includeArchived: true, historyDays: 90 }),
    getSummaries(user.id, shiftDay(date, -29), date),
  ]);

  const active = habits.filter((habit) => !habit.archived);
  const due = active.filter((habit) => habit.dueToday);
  const doneToday = due.filter((habit) => habit.todayStatus === "done").length;

  const bestStreak = active.reduce((best, habit) => Math.max(best, habit.streak), 0);
  const avgRate = average(active.map((habit) => habit.completionRate));

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
    frequency: habit.frequency,
    weekdays: habit.weekdays,
    targetPerWeek: habit.targetPerWeek,
    startDate: habit.startDate,
    archived: habit.archived,
    dueToday: habit.dueToday,
    todayStatus: habit.todayStatus,
    streak: habit.streak,
    longestStreak: habit.longestStreak,
    completionRate: habit.completionRate,
    weekDone: habit.weekDone,
    weekTarget: habit.weekTarget,
    recentLogs: habit.recentLogs,
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
          hint={due.length === 0 ? "nothing due" : "completed"}
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
            <HabitBoard habits={boardItems} date={date} />
          </Suspense>
        </div>

        <div className="space-y-6">
          <SectionCard
            title="Today"
            icon={CheckCircle2}
            accent="text-domain-habit"
            description={`${doneToday} of ${due.length} done`}
          >
            <HabitChecklist habits={due} date={date} />
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
