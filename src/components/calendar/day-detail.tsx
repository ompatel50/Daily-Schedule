import Link from "next/link";
import {
  Apple,
  CalendarDays,
  CheckCircle2,
  Dumbbell,
  HeartPulse,
  Moon,
  NotebookPen,
  Repeat,
  Target,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ProgressRing } from "@/components/shared/progress-ring";
import { ScoreExplanation } from "@/components/shared/score-explanation";
import { SectionCard } from "@/components/shared/section-card";
import { formatDayLong, formatDuration } from "@/lib/date";
import { HEALTH_METRIC_META, type HealthMetricType } from "@/lib/enums";
import { CALENDAR_STATE_META, calendarStateFor } from "@/lib/logic/day-score";
import type { DayStatus } from "@/lib/logic/schedule";
import { cn, formatNumber } from "@/lib/utils";
import { getDayScore, scoreOptionsFor } from "@/server/day-score";
import { evaluateGoalsForDate } from "@/server/goals";
import { getHabitViews } from "@/server/habits";
import { getCurrentUser, prisma } from "@/lib/db";
import { scheduleSettingsFor } from "@/server/schedule";
import { daysBetween } from "@/lib/date";

/**
 * The detail view behind a calendar date.
 *
 * Reads from exactly the same services as the Dashboard and Today — the score,
 * the goal evaluations and the habit views — so opening a date here can never
 * show a different number than opening it there.
 */
export async function DayDetail({ date, anchor }: { date: string; anchor: string }) {
  const user = await getCurrentUser();
  const settings = scheduleSettingsFor(user);

  const [score, goals, habits, meals, workouts, metrics, journal] = await Promise.all([
    getDayScore(user.id, date, settings, scoreOptionsFor(user)),
    evaluateGoalsForDate(user.id, date, settings),
    getHabitViews(user.id, date, settings, { historyDays: 30, stripDays: 0 }),
    prisma.meal.findMany({ where: { userId: user.id, date }, include: { entries: true } }),
    prisma.workout.findMany({ where: { userId: user.id, date } }),
    prisma.healthMetric.findMany({ where: { userId: user.id, date } }),
    prisma.journalEntry.findUnique({ where: { userId_date: { userId: user.id, date } } }),
  ]);

  const entries = meals.flatMap((meal) => meal.entries);
  const totals = entries.reduce(
    (sum, entry) => ({
      calories: sum.calories + entry.calories,
      protein: sum.protein + entry.protein,
      carbs: sum.carbs + entry.carbs,
      fat: sum.fat + entry.fat,
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );

  const isFuture = daysBetween(settings.today, date) > 0;
  const hasAnyRecord =
    entries.length > 0 || workouts.length > 0 || metrics.length > 0 || Boolean(journal);

  const state = calendarStateFor({
    score: score.score,
    applicable: score.totals.applicable,
    completed: score.totals.completed,
    isFuture,
    hasAnyRecord,
    isRestDay: score.exclusions.some((exclusion) => exclusion.reason === "rest_day"),
  });
  const stateMeta = CALENDAR_STATE_META[state];

  const activeHabits = habits.filter((habit) => habit.dueToday || habit.flexibleToday);
  const restingHabits = habits.filter((habit) => !habit.dueToday && !habit.flexibleToday);
  const activeGoals = goals.filter((goal) => goal.applicable);
  const restingGoals = goals.filter((goal) => !goal.applicable);
  const completedWorkouts = workouts.filter((workout) => workout.status === "completed");

  return (
    <SectionCard
      title={formatDayLong(date)}
      icon={CalendarDays}
      accent="text-domain-planner"
      description={stateMeta.description}
      action={
        <div className="flex items-center gap-2">
          <ScoreExplanation score={score} />
          <Button asChild size="sm" variant="outline">
            <Link href={`/today?date=${date}`}>Open in Today</Link>
          </Button>
          <Button asChild size="sm" variant="ghost">
            <Link href={`/calendar?date=${anchor}`} aria-label="Close day detail">
              Close
            </Link>
          </Button>
        </div>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[auto,1fr]">
        <div className="flex flex-col items-center gap-2">
          <ProgressRing
            value={score.score ?? 0}
            size={104}
            label={score.score === null ? "—" : `${score.score}`}
            sublabel={score.score === null ? stateMeta.label.toLowerCase() : "day score"}
            indicatorClassName={
              score.score === null
                ? "text-muted-foreground"
                : score.score >= 80
                  ? "text-emerald-500"
                  : score.score >= 50
                    ? "text-amber-500"
                    : "text-rose-500"
            }
          />
          <Badge variant="outline">{stateMeta.label}</Badge>
        </div>

        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{score.explanation}</p>

          <div className="grid gap-4 sm:grid-cols-2">
            <Block icon={Repeat} title="Habits" accent="text-domain-habit">
              {activeHabits.length === 0 ? (
                <Empty>Nothing scheduled — a rest day, not a missed one.</Empty>
              ) : (
                <ul className="space-y-1">
                  {activeHabits.map((habit) => (
                    <Row key={habit.id} label={habit.name} status={habit.status} detail={habit.statusLabel} />
                  ))}
                </ul>
              )}
              {restingHabits.length > 0 && (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  <Moon className="mr-1 inline h-3 w-3" aria-hidden="true" />
                  {restingHabits.length} not scheduled: {restingHabits.map((h) => h.name).join(", ")}
                </p>
              )}
            </Block>

            <Block icon={Target} title="Goals" accent="text-emerald-500">
              {activeGoals.length === 0 ? (
                <Empty>No goals applied on this day.</Empty>
              ) : (
                <ul className="space-y-1">
                  {activeGoals.map((goal) => (
                    <Row
                      key={goal.goal.id}
                      label={goal.goal.label}
                      status={goal.status}
                      detail={goal.summary}
                    />
                  ))}
                </ul>
              )}
              {restingGoals.length > 0 && (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  <Moon className="mr-1 inline h-3 w-3" aria-hidden="true" />
                  Rest day for: {restingGoals.map((goal) => goal.goal.label).join(", ")}
                </p>
              )}
            </Block>

            <Block icon={Apple} title="Nutrition" accent="text-domain-nutrition">
              {entries.length === 0 ? (
                <Empty>No food logged. That is missing data, not a failure.</Empty>
              ) : (
                <p className="tabular text-sm">
                  {formatNumber(totals.calories)} kcal · {Math.round(totals.protein)} g protein ·{" "}
                  {Math.round(totals.carbs)} g carbs · {Math.round(totals.fat)} g fat
                  <span className="block text-xs text-muted-foreground">
                    {entries.length} item{entries.length === 1 ? "" : "s"} across {meals.length} meal
                    {meals.length === 1 ? "" : "s"}
                  </span>
                </p>
              )}
            </Block>

            <Block icon={Dumbbell} title="Training" accent="text-domain-workout">
              {workouts.length === 0 ? (
                <Empty>No workout recorded.</Empty>
              ) : (
                <ul className="space-y-1">
                  {workouts.map((workout) => (
                    <li key={workout.id} className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="truncate">{workout.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {workout.status === "completed"
                          ? formatDuration(workout.durationMin)
                          : workout.status}
                      </span>
                    </li>
                  ))}
                  {completedWorkouts.length === 0 && (
                    <li className="text-xs text-muted-foreground">Nothing completed yet.</li>
                  )}
                </ul>
              )}
            </Block>

            <Block icon={HeartPulse} title="Health" accent="text-domain-health">
              {metrics.length === 0 ? (
                <Empty>No metrics recorded.</Empty>
              ) : (
                <ul className="space-y-1">
                  {metrics.map((metric) => {
                    const meta = HEALTH_METRIC_META[metric.type as HealthMetricType];
                    return (
                      <li
                        key={metric.id}
                        className="flex items-baseline justify-between gap-2 text-sm"
                      >
                        <span className="truncate">{meta?.label ?? metric.type}</span>
                        <span className="tabular shrink-0 text-xs text-muted-foreground">
                          {formatNumber(metric.value, meta?.decimals ?? 0)} {metric.unit}
                          {metric.source !== "manual" && (
                            <Badge variant="muted" className="ml-1 text-[9px]">
                              {metric.source === "apple_health" ? "Apple Health" : "Imported"}
                            </Badge>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Block>

            <Block icon={NotebookPen} title="Notes" accent="text-amber-500">
              {journal?.content ? (
                <p className="whitespace-pre-wrap text-sm">{journal.content}</p>
              ) : (
                <Empty>No note for this day.</Empty>
              )}
            </Block>
          </div>
        </div>
      </div>
    </SectionCard>
  );
}

const STATUS_TONE: Partial<Record<DayStatus, string>> = {
  completed: "text-emerald-600 dark:text-emerald-400",
  missed: "text-rose-600 dark:text-rose-400",
  skipped: "text-amber-600 dark:text-amber-400",
  excused: "text-sky-600 dark:text-sky-400",
  pending: "text-muted-foreground",
  future: "text-muted-foreground",
};

function Row({ label, status, detail }: { label: string; status: DayStatus; detail: string }) {
  return (
    <li className="flex items-baseline justify-between gap-2 text-sm">
      <span className="flex min-w-0 items-baseline gap-1.5">
        {status === "completed" && (
          <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-500" aria-hidden="true" />
        )}
        <span className="truncate">{label}</span>
      </span>
      <span className={cn("shrink-0 text-xs", STATUS_TONE[status] ?? "text-muted-foreground")}>
        {detail}
      </span>
    </li>
  );
}

function Block({
  icon: Icon,
  title,
  accent,
  children,
}: {
  icon: typeof Repeat;
  title: string;
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border p-3">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className={cn("h-3.5 w-3.5", accent)} aria-hidden="true" />
        {title}
      </p>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}
