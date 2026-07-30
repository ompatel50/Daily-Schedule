import type { Metadata } from "next";
import Link from "next/link";
import { Apple, ArrowRight, CheckCircle2, Dumbbell, Repeat } from "lucide-react";

import { DaySchedule } from "@/components/planner/day-schedule";
import { HabitChecklist } from "@/components/habits/habit-checklist";
import { JournalCard } from "@/components/shared/journal-card";
import { DateNav } from "@/components/shared/date-nav";
import { DayScoreCard } from "@/components/shared/day-score-card";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatCard } from "@/components/shared/stat-card";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MEAL_TYPE_META, WORKOUT_TYPE_META, type MealType, type WorkoutType } from "@/lib/enums";
import { formatDuration, isDayKey, relativeDayLabel } from "@/lib/date";
import { SURFACE_ROLES, surfaceHref } from "@/lib/logic/surfaces";
import { cn, formatNumber, pct } from "@/lib/utils";
import {
  getToday, getDayOverview } from "@/server/queries";
import { toScheduleRowItems } from "@/lib/serializers";

export const metadata: Metadata = { title: "Today" };
export const dynamic = "force-dynamic";

export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const params = await searchParams;
  const todayKey = await getToday();
  const date = params.date && isDayKey(params.date) ? params.date : todayKey;

  const overview = await getDayOverview(date);
  const { user, schedule, nutrition, workouts, dueHabits, restingHabits, habitsDone, goals } =
    overview;

  const calorieGoal = goals.get("calories")?.target ?? 0;
  const proteinGoal = goals.get("protein")?.target ?? 0;
  const workoutGoal = goals.get("workouts_per_week")?.target ?? 0;

  // One score from the one service — the same object the Dashboard, the
  // calendar detail and Insights read for this date.
  const { score } = overview;

  const rows = toScheduleRowItems(schedule);
  const remaining = schedule.filter((item) => item.status === "planned");
  const nextUp = remaining.find((item) => !item.allDay && item.startMinute !== null) ?? remaining[0];

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title={relativeDayLabel(date, todayKey)}
        description={
          nextUp
            ? `Next up: ${nextUp.title}`
            : overview.planned > 0
              ? "Everything on the schedule is handled."
              : "Nothing scheduled yet — plan the day below."
        }
        actions={
          <DateNav
            date={date}
            weekStartsOn={user.weekStartsOn === 0 ? 0 : 1}
            todayKey={todayKey}
          />
        }
      />

      <div className="stat-grid mb-6">
        <StatCard
          label="Schedule"
          value={`${overview.completed}/${overview.planned}`}
          hint={overview.planned === 0 ? "Nothing planned" : `${remaining.length} left`}
          icon={CheckCircle2}
          accent="text-domain-planner"
          progress={pct(overview.completed, overview.planned)}
          progressClassName="bg-domain-planner"
        />
        <StatCard
          label="Habits"
          value={`${habitsDone}/${dueHabits.length}`}
          hint={dueHabits.length === 0 ? "Rest day — none scheduled" : "due today"}
          icon={Repeat}
          accent="text-domain-habit"
          progress={pct(habitsDone, dueHabits.length)}
          progressClassName="bg-domain-habit"
        />
        <StatCard
          label="Calories"
          value={formatNumber(nutrition.totals.calories)}
          hint={calorieGoal > 0 ? `of ${formatNumber(calorieGoal)} kcal` : "no goal set"}
          icon={Apple}
          accent="text-domain-nutrition"
          progress={pct(nutrition.totals.calories, calorieGoal)}
          progressClassName="bg-domain-nutrition"
        />
        <StatCard
          label="Training"
          value={
            workouts.length === 0
              ? "Rest"
              : formatDuration(workouts.reduce((total, workout) => total + workout.durationMin, 0))
          }
          hint={workouts.length === 0 ? "no workout logged" : workouts.map((w) => w.name).join(", ")}
          icon={Dumbbell}
          accent="text-domain-workout"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <SectionCard
            title="Your day"
            icon={CheckCircle2}
            accent="text-domain-planner"
            description={
              overview.planned === 0
                ? "Nothing scheduled"
                : `${remaining.length} of ${overview.planned} still to do`
            }
            action={
              // Today runs the day; laying it out on a time axis, reshaping a
              // series or resolving overlaps is the planner's job.
              <Button asChild variant="ghost" size="sm">
                <Link href={surfaceHref("planner", date)}>
                  Planner <ArrowRight />
                </Link>
              </Button>
            }
          >
            <DaySchedule date={date} items={rows} surface="today" todayKey={todayKey} />
          </SectionCard>

          <SectionCard
            title="Meals"
            icon={Apple}
            accent="text-domain-nutrition"
            description={
              nutrition.totals.calories > 0
                ? `${formatNumber(nutrition.totals.calories)} kcal · ${formatNumber(nutrition.totals.protein)}g protein`
                : "Nothing logged yet"
            }
          >
            {nutrition.meals.length === 0 ? (
              <EmptyState
                icon={Apple}
                title="No food logged"
                description="Head to Nutrition to log a meal — favourites and templates make it a couple of clicks."
              />
            ) : (
              <div className="space-y-2">
                {nutrition.meals.map((meal) => (
                  <div
                    key={meal.id}
                    className="flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {meal.label || MEAL_TYPE_META[meal.type as MealType]?.label || meal.type}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {meal.entries.map((entry) => entry.foodItem.name).join(", ")}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="tabular text-sm font-medium">
                        {formatNumber(meal.totals.calories)} kcal
                      </p>
                      <p className="tabular text-xs text-muted-foreground">
                        P {formatNumber(meal.totals.protein)} · C {formatNumber(meal.totals.carbs)} · F{" "}
                        {formatNumber(meal.totals.fat)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </div>

        <div className="space-y-6">
          <DayScoreCard score={score}>
            <p className="text-center text-xs text-muted-foreground">{score.explanation}</p>
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
          >
            <HabitChecklist habits={dueHabits} restingHabits={restingHabits} date={date} />
          </SectionCard>

          {workouts.length > 0 && (
            <SectionCard title="Training" icon={Dumbbell} accent="text-domain-workout">
              <div className="space-y-2">
                {workouts.map((workout) => {
                  const meta =
                    WORKOUT_TYPE_META[workout.type as WorkoutType] ?? WORKOUT_TYPE_META.custom;
                  return (
                    <div key={workout.id} className="rounded-lg border px-3 py-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-medium">{workout.name}</p>
                        <Badge variant="outline" className={cn("shrink-0", meta.chip)}>
                          {meta.label}
                        </Badge>
                      </div>
                      <p className="tabular mt-1 text-xs text-muted-foreground">
                        {formatDuration(workout.durationMin)}
                        {workout.caloriesBurned ? ` · ${workout.caloriesBurned} kcal` : ""}
                        {workout.sets.length ? ` · ${workout.sets.length} sets` : ""}
                      </p>
                    </div>
                  );
                })}
              </div>
            </SectionCard>
          )}

          <JournalCard
            date={date}
            entry={
              overview.journal
                ? {
                    title: overview.journal.title,
                    content: overview.journal.content,
                    mood: overview.journal.mood,
                    energy: overview.journal.energy,
                  }
                : null
            }
          />

          {proteinGoal > 0 && (
            <SectionCard title="Protein" icon={Apple} accent="text-domain-nutrition">
              <div className="flex items-center justify-between text-sm">
                <span className="tabular font-medium">
                  {formatNumber(nutrition.totals.protein)}g
                </span>
                <span className="text-muted-foreground">of {formatNumber(proteinGoal)}g</span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-domain-nutrition transition-all"
                  style={{ width: `${pct(nutrition.totals.protein, proteinGoal)}%` }}
                />
              </div>
            </SectionCard>
          )}
        </div>
      </div>
    </div>
  );
}

