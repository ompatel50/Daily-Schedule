import type { Metadata } from "next";
import { Suspense } from "react";
import { Activity, Dumbbell, Flame, Timer, Trophy } from "lucide-react";

import { CategoryBarChart } from "@/components/shared/charts";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatCard } from "@/components/shared/stat-card";
import { Skeleton } from "@/components/ui/skeleton";
import { WorkoutManager, type WorkoutView } from "@/components/workouts/workout-manager";
import { WORKOUT_TYPE_META, type WorkoutType } from "@/lib/enums";
import { formatDay, formatDuration, isDayKey, lastNDays, shiftDay } from "@/lib/date";
import { personalRecords } from "@/lib/logic/workouts";
import { formatNumber, groupBy, pct, sum } from "@/lib/utils";
import {
  getToday,
  getExerciseNames,
  getGoalMap,
  getRecentWorkouts,
  getUser,
  getWindowStats,
  getWorkouts,
  getWorkoutTemplates,
} from "@/server/queries";
import { getSummaries } from "@/server/summaries";

export const metadata: Metadata = { title: "Workouts" };
export const dynamic = "force-dynamic";

export default async function WorkoutsPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; new?: string }>;
}) {
  const params = await searchParams;
  const todayKey = await getToday();
  const date = params.date && isDayKey(params.date) ? params.date : todayKey;

  const user = await getUser();
  const [recent, templates, exerciseNames, goals, thisWeek, historyWorkouts, summaries] =
    await Promise.all([
      getRecentWorkouts(25),
      getWorkoutTemplates(),
      getExerciseNames(),
      getGoalMap(),
      getWindowStats(shiftDay(todayKey, -6), todayKey),
      getWorkouts(shiftDay(todayKey, -89), todayKey),
      getSummaries(user.id, shiftDay(todayKey, -27), todayKey),
    ]);

  const workoutGoal = goals.get("workouts_per_week")?.target ?? 0;
  const summaryByDate = new Map(summaries.map((summary) => [summary.date, summary]));

  const trend = lastNDays(28, todayKey).map((day) => ({
    label: formatDay(day, "M/d"),
    minutes: summaryByDate.get(day)?.workoutMinutes ?? 0,
    day,
  }));

  const byType = groupBy(historyWorkouts, (workout) => workout.type);
  const typeBreakdown = Object.entries(byType)
    .map(([type, list]) => ({
      label: WORKOUT_TYPE_META[type as WorkoutType]?.label ?? type,
      count: list.length,
      minutes: sum(list, (workout) => workout.durationMin),
    }))
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, 6);

  const records = personalRecords(
    historyWorkouts.map((workout) => ({
      date: workout.date,
      sets: workout.sets.map((set) => ({
        exercise: set.exercise,
        reps: set.reps,
        weightKg: set.weightKg,
        completed: set.completed,
      })),
    })),
  ).slice(0, 6);

  const views: WorkoutView[] = recent.map((workout) => ({
    id: workout.id,
    date: workout.date,
    time: workout.time,
    name: workout.name,
    type: workout.type,
    durationMin: workout.durationMin,
    intensity: workout.intensity,
    caloriesBurned: workout.caloriesBurned,
    avgHeartRate: workout.avgHeartRate,
    distanceKm: workout.distanceKm,
    perceivedEffort: workout.perceivedEffort,
    notes: workout.notes,
    status: workout.status,
    setCount: workout.sets.length,
    sets: workout.sets.map((set) => ({
      exercise: set.exercise,
      reps: set.reps,
      weightKg: set.weightKg,
      durationSec: set.durationSec,
      distanceM: set.distanceM,
    })),
  }));

  const ninetyDayMinutes = sum(historyWorkouts, (workout) => workout.durationMin);

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Workouts"
        description="Log training, review the history, watch the trend."
      />

      <div className="stat-grid mb-6">
        <StatCard
          label="This week"
          value={`${thisWeek.workouts}`}
          hint={workoutGoal > 0 ? `of ${workoutGoal} target` : "sessions"}
          icon={Dumbbell}
          accent="text-domain-workout"
          progress={pct(thisWeek.workouts, workoutGoal)}
          progressClassName="bg-domain-workout"
        />
        <StatCard
          label="Weekly minutes"
          value={formatDuration(thisWeek.workoutMinutes)}
          hint="time under tension"
          icon={Timer}
          accent="text-domain-workout"
        />
        <StatCard
          label="Calories burned"
          value={formatNumber(thisWeek.caloriesBurned)}
          hint="last 7 days"
          icon={Flame}
          accent="text-orange-500"
        />
        <StatCard
          label="90-day volume"
          value={formatDuration(ninetyDayMinutes)}
          hint={`${historyWorkouts.length} sessions`}
          icon={Activity}
          accent="text-domain-health"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Suspense fallback={<Skeleton className="h-96 w-full" />}>
            <WorkoutManager
              date={date}
              workouts={views}
              templates={templates.map((template) => ({
                id: template.id,
                name: template.name,
                type: template.type,
                durationMin: template.durationMin,
                exerciseCount: template.parsedExercises.length,
                useCount: template.useCount,
              }))}
              exerciseNames={exerciseNames}
            />
          </Suspense>
        </div>

        <div className="space-y-6 lg:col-span-2">
          <SectionCard
            title="Training load"
            icon={Activity}
            accent="text-domain-workout"
            description="Minutes per day, last 4 weeks"
          >
            <CategoryBarChart
              data={trend}
              dataKey="minutes"
              height={180}
              unit=" min"
              color="hsl(var(--domain-workout))"
              highlight={todayKey}
            />
          </SectionCard>

          {typeBreakdown.length > 0 && (
            <SectionCard
              title="Training mix"
              icon={Dumbbell}
              accent="text-domain-workout"
              description="Last 90 days"
            >
              <div className="space-y-2">
                {typeBreakdown.map((row) => {
                  const share = pct(row.minutes, typeBreakdown[0].minutes);
                  return (
                    <div key={row.label}>
                      <div className="flex items-center justify-between text-sm">
                        <span>{row.label}</span>
                        <span className="tabular text-xs text-muted-foreground">
                          {row.count}× · {formatDuration(row.minutes)}
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-secondary">
                        <div
                          className="h-full rounded-full bg-domain-workout"
                          style={{ width: `${share}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </SectionCard>
          )}

          {records.length > 0 && (
            <SectionCard
              title="Personal bests"
              icon={Trophy}
              accent="text-amber-500"
              description="Estimated 1RM from logged sets"
            >
              <div className="space-y-1.5">
                {records.map((record) => (
                  <div
                    key={record.exercise}
                    className="flex items-center justify-between border-b pb-1.5 text-sm last:border-0"
                  >
                    <span className="truncate">{record.exercise}</span>
                    <span className="tabular shrink-0 text-xs text-muted-foreground">
                      {formatNumber(record.weightKg, 1)} kg × {record.reps} ·{" "}
                      <span className="font-medium text-foreground">
                        {formatNumber(record.oneRepMax, 1)} kg
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </SectionCard>
          )}
        </div>
      </div>
    </div>
  );
}
