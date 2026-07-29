import Link from "next/link";
import {
  Activity,
  Apple,
  ArrowRight,
  CheckCircle2,
  Dumbbell,
  Flame,
  Footprints,
  Moon,
  Repeat,
  Sparkles,
  TrendingUp,
} from "lucide-react";

import { DashboardQuickActions } from "@/components/dashboard/quick-actions";
import { HabitChecklist } from "@/components/habits/habit-checklist";
import { TrendAreaChart, CategoryBarChart } from "@/components/shared/charts";
import { DayScoreCard } from "@/components/shared/day-score-card";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatCard } from "@/components/shared/stat-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CATEGORY_META, type ScheduleCategory } from "@/lib/enums";
import {
  formatDay,
  formatDuration,
  formatTimeRange,
  isPast,
  lastNDays,
  shiftDay,
  today,
} from "@/lib/date";
import { trendDelta } from "@/lib/logic/scoring";
import { cn, formatNumber, pct, sum } from "@/lib/utils";
import { getConsistencyWindow, getDayOverview, getToday, getWindowStats } from "@/server/queries";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  // The user's configured timezone decides what "today" is, not the host clock.
  const date = await getToday();

  const [overview, window, thisWeek, lastWeek] = await Promise.all([
    getDayOverview(date),
    getConsistencyWindow(30, date),
    getWindowStats(shiftDay(date, -6), date),
    getWindowStats(shiftDay(date, -13), shiftDay(date, -7)),
  ]);

  const { user, schedule, nutrition, workouts, dueHabits, restingHabits, habitsDone, goals, metrics } =
    overview;

  const calorieGoal = goals.get("calories")?.target ?? 0;
  const stepGoal = goals.get("steps")?.target ?? 0;
  const workoutGoal = goals.get("workouts_per_week")?.target ?? 0;

  const workoutMinutesToday = sum(workouts, (workout) => workout.durationMin);
  // One score from the one service — Today, the calendar detail and Insights
  // read the same object for this date, so they cannot disagree.
  const { score } = overview;

  const steps = metrics.find((metric) => metric.type === "steps")?.value ?? 0;
  const sleep = metrics.find((metric) => metric.type === "sleep_hours")?.value ?? null;

  const remaining = schedule.filter((item) => item.status === "planned");
  const missed = schedule.filter((item) => item.status === "skipped");
  const upcoming = remaining
    .filter((item) => !item.allDay && item.startMinute !== null)
    .slice(0, 5);

  // 30-day series for the mini charts.
  const trend = lastNDays(30, date).map((day) => {
    const summary = window.byDate.get(day);
    return {
      label: formatDay(day, "M/d"),
      score: summary?.score ?? 0,
      calories: summary?.calories ?? 0,
    };
  });

  const weeklyTraining = lastNDays(7, date).map((day) => {
    const summary = window.byDate.get(day);
    return { label: formatDay(day, "EEE"), minutes: summary?.workoutMinutes ?? 0, day };
  });

  const completionDelta = trendDelta(
    thisWeek.planned > 0 ? (thisWeek.completed / thisWeek.planned) * 100 : 0,
    lastWeek.planned > 0 ? (lastWeek.completed / lastWeek.planned) * 100 : 0,
  );
  const habitDelta = trendDelta(
    thisWeek.habitsDue > 0 ? (thisWeek.habitsDone / thisWeek.habitsDue) * 100 : 0,
    lastWeek.habitsDue > 0 ? (lastWeek.habitsDone / lastWeek.habitsDue) * 100 : 0,
  );

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title={`${greeting()}, ${user.name.split(" ")[0]}`}
        description={summaryLine(overview.planned, overview.completed, dueHabits.length, habitsDone)}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/today">
              Open today <ArrowRight />
            </Link>
          </Button>
        }
      />

      <div className="stat-grid mb-6">
        <StatCard
          label="Today's schedule"
          value={`${overview.completed}/${overview.planned}`}
          hint={remaining.length > 0 ? `${remaining.length} remaining` : "all clear"}
          icon={CheckCircle2}
          accent="text-domain-planner"
          progress={pct(overview.completed, overview.planned)}
          progressClassName="bg-domain-planner"
          delta={thisWeek.planned > 0 ? completionDelta : undefined}
        />
        <StatCard
          label="Habits today"
          value={`${habitsDone}/${dueHabits.length}`}
          hint={dueHabits.length === 0 ? "rest day" : "due today"}
          icon={Repeat}
          accent="text-domain-habit"
          progress={pct(habitsDone, dueHabits.length)}
          progressClassName="bg-domain-habit"
          delta={thisWeek.habitsDue > 0 ? habitDelta : undefined}
        />
        <StatCard
          label="Calories"
          value={formatNumber(nutrition.totals.calories)}
          hint={calorieGoal > 0 ? `of ${formatNumber(calorieGoal)} goal` : "log a meal"}
          icon={Apple}
          accent="text-domain-nutrition"
          progress={pct(nutrition.totals.calories, calorieGoal)}
          progressClassName="bg-domain-nutrition"
        />
        <StatCard
          label="Workouts this week"
          value={`${thisWeek.workouts}`}
          hint={workoutGoal > 0 ? `of ${workoutGoal} target` : formatDuration(thisWeek.workoutMinutes)}
          icon={Dumbbell}
          accent="text-domain-workout"
          progress={pct(thisWeek.workouts, workoutGoal)}
          progressClassName="bg-domain-workout"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <SectionCard
            title="What's next"
            icon={Sparkles}
            accent="text-domain-planner"
            description={
              upcoming.length > 0
                ? `${upcoming.length} upcoming ${upcoming.length === 1 ? "block" : "blocks"}`
                : "Nothing timed left today"
            }
            action={
              <Button asChild variant="ghost" size="sm">
                <Link href="/planner">
                  Planner <ArrowRight />
                </Link>
              </Button>
            }
          >
            {schedule.length === 0 ? (
              <EmptyState
                icon={CheckCircle2}
                title="Your day is empty"
                description="Add a few blocks, or apply a routine template from the planner."
                action={
                  <Button asChild size="sm">
                    <Link href="/planner">Plan today</Link>
                  </Button>
                }
              />
            ) : upcoming.length === 0 && remaining.length === 0 ? (
              <div className="flex items-center gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-4">
                <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" />
                <div>
                  <p className="text-sm font-medium">Everything planned is done.</p>
                  <p className="text-xs text-muted-foreground">
                    {overview.completed} {overview.completed === 1 ? "item" : "items"} completed today.
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-1.5">
                {(upcoming.length > 0 ? upcoming : remaining.slice(0, 5)).map((item) => {
                  const meta =
                    CATEGORY_META[item.category as ScheduleCategory] ?? CATEGORY_META.personal;
                  return (
                    <div
                      key={item.id}
                      className={cn(
                        "flex items-center gap-3 rounded-lg border border-l-[3px] px-3 py-2",
                        meta.bar,
                      )}
                    >
                      <span className="tabular w-28 shrink-0 text-xs text-muted-foreground">
                        {formatTimeRange(item.startMinute, item.endMinute, item.allDay)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.title}</span>
                      <Badge variant="outline" className={cn("shrink-0 text-[10px]", meta.chip)}>
                        {meta.label}
                      </Badge>
                    </div>
                  );
                })}
                {missed.length > 0 && (
                  <p className="pt-1 text-xs text-muted-foreground">
                    {missed.length} skipped today.
                  </p>
                )}
              </div>
            )}
          </SectionCard>

          <div className="grid gap-6 md:grid-cols-2">
            <SectionCard
              title="Consistency"
              icon={TrendingUp}
              accent="text-emerald-500"
              description="Day score, last 30 days"
            >
              <TrendAreaChart
                data={trend}
                dataKey="score"
                color="hsl(var(--domain-habit))"
                height={170}
              />
            </SectionCard>

            <SectionCard
              title="Training load"
              icon={Dumbbell}
              accent="text-domain-workout"
              description="Minutes trained this week"
            >
              <CategoryBarChart
                data={weeklyTraining}
                dataKey="minutes"
                height={170}
                unit=" min"
                color="hsl(var(--domain-workout))"
                highlight={date}
              />
            </SectionCard>
          </div>

          <DashboardQuickActions date={date} />
        </div>

        <div className="space-y-6">
          <DayScoreCard score={score} size={112} sublabel="today">
            <div className="grid w-full grid-cols-3 gap-2 text-center">
              <MiniStat label="7d avg" value={`${thisWeek.averageScore}`} />
              <MiniStat label="Active days" value={`${thisWeek.activeDays}/7`} />
              <MiniStat label="Logged" value={`${thisWeek.loggedDays}/7`} hint="days with food" />
            </div>
          </DayScoreCard>

          <SectionCard
            title="Habits"
            icon={Repeat}
            accent="text-domain-habit"
            description={
              dueHabits.length === 0
                ? "Nothing scheduled today"
                : `${habitsDone} of ${dueHabits.length} done`
            }
            action={
              <Button asChild variant="ghost" size="sm">
                <Link href="/habits">
                  All <ArrowRight />
                </Link>
              </Button>
            }
          >
            <HabitChecklist habits={dueHabits.slice(0, 8)} restingHabits={restingHabits} date={date} />
          </SectionCard>

          <SectionCard
            title="Health"
            icon={Activity}
            accent="text-domain-health"
            action={
              <Button asChild variant="ghost" size="sm">
                <Link href="/insights">
                  Trends <ArrowRight />
                </Link>
              </Button>
            }
          >
            <div className="space-y-2.5">
              <HealthRow
                icon={Footprints}
                label="Steps"
                value={steps > 0 ? formatNumber(steps) : "—"}
                progress={stepGoal > 0 ? pct(steps, stepGoal) : undefined}
              />
              <HealthRow
                icon={Moon}
                label="Sleep"
                value={sleep !== null ? `${sleep.toFixed(1)} h` : "—"}
                progress={sleep !== null ? pct(sleep, 8) : undefined}
              />
              <HealthRow
                icon={Flame}
                label="Burned"
                value={
                  workouts.length > 0
                    ? `${formatNumber(sum(workouts, (w) => w.caloriesBurned ?? 0))} kcal`
                    : "—"
                }
              />
            </div>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

function MiniStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg bg-muted/50 px-2 py-2">
      <p className="tabular text-sm font-semibold leading-none">{value}</p>
      <p className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground" title={hint}>
        {label}
      </p>
    </div>
  );
}

function HealthRow({
  icon: Icon,
  label,
  value,
  progress,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  progress?: number;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 text-sm">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular ml-auto font-medium">{value}</span>
      </div>
      {progress !== undefined && (
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-secondary">
          <div
            className="h-full rounded-full bg-domain-health transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
    </div>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return "Still up";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function summaryLine(planned: number, completed: number, habitsDue: number, habitsDone: number): string {
  if (planned === 0 && habitsDue === 0) return "Nothing on the books yet — start by planning your day.";
  const parts: string[] = [];
  if (planned > 0) parts.push(`${completed} of ${planned} scheduled items done`);
  if (habitsDue > 0) parts.push(`${habitsDone} of ${habitsDue} habits complete`);
  return `${parts.join(" · ")}.`;
}
