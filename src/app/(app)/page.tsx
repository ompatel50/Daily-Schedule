import Link from "next/link";
import {
  Activity,
  Apple,
  ArrowRight,
  CheckCircle2,
  CheckSquare,
  Dumbbell,
  Flame,
  Footprints,
  Inbox,
  Moon,
  Repeat,
  Sparkles,
  TrendingUp,
  Wallet,
} from "lucide-react";

import { DashboardQuickActions } from "@/components/dashboard/quick-actions";
import { OnboardingCard } from "@/components/dashboard/onboarding-card";
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
  lastNDays,
  shiftDay,
} from "@/lib/date";
import { describeDueDistance } from "@/lib/logic/due";
import { formatMoney } from "@/lib/logic/finance";
import { parseOnboardingState } from "@/lib/logic/onboarding";
import { trendDelta } from "@/lib/logic/scoring";
import { SURFACE_ROLES, surfaceHref } from "@/lib/logic/surfaces";
import { cn, formatNumber, pct, pluralize, sum } from "@/lib/utils";
import { PRIORITY_META, type Priority } from "@/lib/enums";
import { getCommandCenterSummary } from "@/server/command-center";
import { getDemoStatus } from "@/server/demo";
import { getConsistencyWindow, getDayOverview, getToday, getWindowStats } from "@/server/queries";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  // The user's configured timezone decides what "today" is, not the host clock.
  const date = await getToday();

  const [overview, window, thisWeek, lastWeek, lifeAdmin] = await Promise.all([
    getDayOverview(date),
    getConsistencyWindow(30, date),
    getWindowStats(shiftDay(date, -6), date),
    getWindowStats(shiftDay(date, -13), shiftDay(date, -7)),
    getCommandCenterSummary(),
  ]);

  const onboarding = parseOnboardingState(overview.user.onboardingState);
  // The demo status is only needed while the checklist is showing.
  const demoStatus = onboarding.dismissed ? null : await getDemoStatus(overview.user.id);

  const {
    user,
    schedule,
    nutrition,
    workouts,
    dueHabits,
    restingHabits,
    habitsDone,
    goals,
    metricSummary,
  } = overview;

  const calorieGoal = goals.get("calories")?.target ?? 0;
  const stepGoal = goals.get("steps")?.target ?? 0;
  const workoutGoal = goals.get("workouts_per_week")?.target ?? 0;

  const workoutMinutesToday = sum(workouts, (workout) => workout.durationMin);
  // One score from the one service — Today, the calendar detail and Insights
  // read the same object for this date, so they cannot disagree.
  const { score } = overview;

  const steps = metricSummary.get("steps")?.value ?? 0;
  const sleep = metricSummary.get("sleep_hours")?.value ?? null;

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
            <Link href={surfaceHref("today")}>
              Open today <ArrowRight />
            </Link>
          </Button>
        }
      />

      {!onboarding.dismissed && (
        <OnboardingCard state={onboarding} canLoadSample={demoStatus?.canLoad ?? false} />
      )}

      {/*
        Rolling-week tiles, each a link to the surface that owns the number.
        Today shows the same domains for *today* and lets you act on them; the
        dashboard's job is the trend behind them and the way in, so these read
        "how is the week going" with today as the hint — not a second copy of
        Today's counters that gives you no reason to prefer either screen.
      */}
      <div className="stat-grid mb-6">
        <StatCard
          label="Schedule · 7 days"
          value={`${thisWeek.completed}/${thisWeek.planned}`}
          hint={
            overview.planned === 0
              ? "nothing scheduled today"
              : `${overview.completed} of ${overview.planned} done today`
          }
          icon={CheckCircle2}
          accent="text-domain-planner"
          progress={pct(thisWeek.completed, thisWeek.planned)}
          progressClassName="bg-domain-planner"
          delta={thisWeek.planned > 0 ? completionDelta : undefined}
          href={surfaceHref("today")}
        />
        <StatCard
          label="Habits · 7 days"
          value={`${thisWeek.habitsDone}/${thisWeek.habitsDue}`}
          hint={
            dueHabits.length === 0
              ? "rest day today"
              : `${habitsDone} of ${dueHabits.length} done today`
          }
          icon={Repeat}
          accent="text-domain-habit"
          progress={pct(thisWeek.habitsDone, thisWeek.habitsDue)}
          progressClassName="bg-domain-habit"
          delta={thisWeek.habitsDue > 0 ? habitDelta : undefined}
          href={surfaceHref("today")}
        />
        <StatCard
          label="Calories · daily average"
          value={
            thisWeek.loggedDays > 0
              ? formatNumber(Math.round(thisWeek.caloriesEaten / thisWeek.loggedDays))
              : "—"
          }
          hint={
            nutrition.totals.calories > 0
              ? `${formatNumber(nutrition.totals.calories)} today`
              : "nothing logged today"
          }
          icon={Apple}
          accent="text-domain-nutrition"
          progress={
            calorieGoal > 0 && thisWeek.loggedDays > 0
              ? pct(thisWeek.caloriesEaten / thisWeek.loggedDays, calorieGoal)
              : undefined
          }
          progressClassName="bg-domain-nutrition"
          href="/nutrition"
        />
        <StatCard
          label="Training · 7 days"
          value={`${thisWeek.workouts}`}
          hint={
            workoutMinutesToday > 0
              ? `${formatDuration(workoutMinutesToday)} today`
              : workoutGoal > 0
                ? `of ${workoutGoal} target`
                : formatDuration(thisWeek.workoutMinutes)
          }
          icon={Dumbbell}
          accent="text-domain-workout"
          progress={pct(thisWeek.workouts, workoutGoal)}
          progressClassName="bg-domain-workout"
          href="/workouts"
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
              // A preview, not a checklist. Ticking things off happens on the
              // surface that owns the day.
              <Button asChild variant="ghost" size="sm">
                <Link href={surfaceHref("today")}>
                  {SURFACE_ROLES.today.label} <ArrowRight />
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
                    <Link href={surfaceHref("planner", date)}>Plan today</Link>
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

          {/*
            Read-only, like everything on the dashboard: status and a way in.
            Completing a task happens on /tasks, which owns the interaction.
          */}
          <SectionCard
            title="Tasks"
            icon={CheckSquare}
            accent="text-domain-task"
            description={taskLine(lifeAdmin.tasks)}
            action={
              <Button asChild variant="ghost" size="sm">
                <Link href="/tasks">
                  All <ArrowRight />
                </Link>
              </Button>
            }
          >
            {lifeAdmin.tasks.top.length === 0 ? (
              <EmptyState
                icon={CheckSquare}
                title="Nothing due right now"
                description={
                  lifeAdmin.tasks.openCount > 0
                    ? `${lifeAdmin.tasks.openCount} open ${pluralize(lifeAdmin.tasks.openCount, "task")}, none with a pressing date.`
                    : "Capture a task with a due date and it will surface here on the day."
                }
                action={
                  <Button asChild size="sm" variant="outline">
                    <Link href="/tasks?new=1">New task</Link>
                  </Button>
                }
              />
            ) : (
              <div className="space-y-1.5">
                {lifeAdmin.tasks.top.map((task) => {
                  const overdue = task.dueDate !== null && task.dueDate < date;
                  const priority = PRIORITY_META[task.priority as Priority];
                  return (
                    <div key={task.id} className="flex items-baseline gap-2 text-sm">
                      <span
                        className={cn(
                          "h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full",
                          overdue ? "bg-red-500" : "bg-domain-task",
                        )}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1 truncate font-medium">{task.title}</span>
                      {task.projectName && (
                        <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                          {task.projectName}
                        </span>
                      )}
                      {(task.priority === "high" || task.priority === "urgent") && (
                        <Badge variant="outline" className={cn("shrink-0 text-[10px]", priority?.chip)}>
                          {priority?.label}
                        </Badge>
                      )}
                      {task.dueDate && (
                        <span
                          className={cn(
                            "shrink-0 text-xs",
                            overdue ? "text-red-700 dark:text-red-400" : "text-muted-foreground",
                          )}
                        >
                          {describeDueDistance(task.dueDate, date)}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <Link
              href="/inbox"
              className="mt-3 flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <Inbox className="h-3.5 w-3.5" aria-hidden />
              {lifeAdmin.inbox.openCount === 0
                ? "Inbox zero — nothing waiting on a decision."
                : `Inbox · ${lifeAdmin.inbox.openCount} ${pluralize(lifeAdmin.inbox.openCount, "item")} waiting`}
              <ArrowRight className="ml-auto h-3.5 w-3.5" aria-hidden />
            </Link>
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
            {/*
              Read-only. The dashboard used to render a second, truncated copy
              of Today's checklist, so the same habit could be ticked in two
              places and the first eight were the only ones you could reach.
              Status here, the actual ticking on Today.
            */}
            {dueHabits.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                A rest day, not a missed one
                {restingHabits.length > 0 ? ` — ${restingHabits.length} not scheduled.` : "."}
              </p>
            ) : (
              <div className="space-y-1.5">
                {dueHabits.map((habit) => {
                  const done = habit.todayStatus === "done";
                  return (
                    <div key={habit.id} className="flex items-baseline gap-2 text-sm">
                      <CheckCircle2
                        className={cn(
                          "h-3.5 w-3.5 shrink-0 translate-y-0.5",
                          done ? "text-emerald-500" : "text-muted-foreground/30",
                        )}
                        aria-hidden
                      />
                      <span className={cn("min-w-0 flex-1 truncate", done && "text-muted-foreground line-through")}>
                        {habit.name}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">{habit.statusLabel}</span>
                    </div>
                  );
                })}
                <Button asChild variant="outline" size="sm" className="mt-1 w-full">
                  <Link href={surfaceHref("today")}>
                    Tick them off in {SURFACE_ROLES.today.label} <ArrowRight />
                  </Link>
                </Button>
              </div>
            )}
          </SectionCard>

          <SectionCard
            title="Health"
            icon={Activity}
            accent="text-domain-health"
            action={
              <Button asChild variant="ghost" size="sm">
                <Link href="/health">
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

          <SectionCard
            title="Money"
            icon={Wallet}
            accent="text-domain-finance"
            action={
              <Button asChild variant="ghost" size="sm">
                <Link href="/finance">
                  Finance <ArrowRight />
                </Link>
              </Button>
            }
          >
            {!lifeAdmin.finance.hasAccounts ? (
              <p className="text-sm text-muted-foreground">
                Accounts, bills and savings goals — entered by hand, private by design.{" "}
                <Link href="/finance" className="font-medium text-foreground underline-offset-2 hover:underline">
                  Set up Finance
                </Link>
                .
              </p>
            ) : (
              <div className="space-y-3">
                <div>
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="text-muted-foreground">Net balance</span>
                    <span className="tabular font-semibold">
                      {formatMoney(lifeAdmin.finance.net[0]?.net ?? 0, lifeAdmin.finance.net[0]?.currency)}
                    </span>
                  </div>
                  {lifeAdmin.finance.net.length > 1 && (
                    <p className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      +{lifeAdmin.finance.net.length - 1} more{" "}
                      {pluralize(lifeAdmin.finance.net.length - 1, "currency", "currencies")}
                    </p>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2 text-center">
                  <MiniStat
                    label="In · month"
                    value={formatMoney(lifeAdmin.finance.month.income)}
                  />
                  <MiniStat
                    label="Out · month"
                    value={formatMoney(lifeAdmin.finance.month.spending)}
                  />
                </div>
                {lifeAdmin.finance.billsDueSoon.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No bills due in the next two weeks.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {lifeAdmin.finance.billsDueSoon.map((bill) => (
                      <div key={bill.id} className="flex items-baseline gap-2 text-sm">
                        <span className="min-w-0 flex-1 truncate">{bill.name}</span>
                        <span
                          className={cn(
                            "shrink-0 text-xs",
                            bill.bucket === "overdue"
                              ? "text-red-700 dark:text-red-400"
                              : bill.bucket === "today"
                                ? "text-amber-800 dark:text-amber-400"
                                : "text-muted-foreground",
                          )}
                        >
                          {describeDueDistance(bill.nextDueDate, date)}
                        </span>
                        <span className="tabular shrink-0 text-xs font-medium">
                          {formatMoney(bill.amount)}
                        </span>
                      </div>
                    ))}
                    {lifeAdmin.finance.billsDueSoonCount > lifeAdmin.finance.billsDueSoon.length && (
                      <p className="text-xs text-muted-foreground">
                        {lifeAdmin.finance.billsDueSoonCount - lifeAdmin.finance.billsDueSoon.length}{" "}
                        more due within two weeks ·{" "}
                        {formatMoney(lifeAdmin.finance.billsDueSoonTotal)} in total.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

function taskLine(tasks: {
  overdueCount: number;
  dueTodayCount: number;
  openCount: number;
  activeProjects: number;
}): string {
  const parts: string[] = [];
  if (tasks.overdueCount > 0) parts.push(`${tasks.overdueCount} overdue`);
  if (tasks.dueTodayCount > 0) parts.push(`${tasks.dueTodayCount} due today`);
  if (parts.length === 0) {
    return tasks.openCount === 0
      ? "No open tasks yet"
      : `${tasks.openCount} open · ${tasks.activeProjects} active ${pluralize(tasks.activeProjects, "project")}`;
  }
  return parts.join(" · ");
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
