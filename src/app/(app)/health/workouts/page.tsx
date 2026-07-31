import type { Metadata } from "next";
import Link from "next/link";
import { Dumbbell } from "lucide-react";

import { RangePicker } from "@/components/health/range-picker";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatCard } from "@/components/shared/stat-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/db";
import { formatDay } from "@/lib/date";
import { rangeFromParam } from "@/lib/health-ranges";
import { toDisplay } from "@/lib/logic/health";
import { formatNumber } from "@/lib/utils";
import { getHealthWorkouts, resolveRange } from "@/server/health-module";
import { scheduleSettingsFor } from "@/server/schedule";

export const metadata: Metadata = { title: "Workouts · Health" };
export const dynamic = "force-dynamic";

export default async function HealthWorkoutsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const range = rangeFromParam((await searchParams).range);
  const user = await getCurrentUser();
  const today = scheduleSettingsFor(user).today;
  const window = await resolveRange(user.id, range, today);
  const workouts = await getHealthWorkouts(user.id, window.from, window.to, 200);

  const totalMinutes = workouts.reduce((sum, workout) => sum + workout.durationMin, 0);
  const totalCalories = workouts.reduce((sum, workout) => sum + (workout.caloriesBurned ?? 0), 0);
  const totalDistanceKm = workouts.reduce((sum, workout) => sum + (workout.distanceKm ?? 0), 0);
  const distance = toDisplay("distance_km", totalDistanceKm, user.unitSystem);

  return (
    <>
      <PageHeader
        title="Workouts"
        description={`Sessions from your health export and from this app · ${formatDay(window.from, "MMM d, yyyy")} → ${formatDay(window.to, "MMM d, yyyy")}`}
        actions={<RangePicker current={range} />}
      />

      {workouts.length === 0 ? (
        <EmptyState
          icon={Dumbbell}
          title="No workouts in this range"
          description="Workouts arrive with an Apple Health import, or from the training log in Workouts."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button asChild>
                <Link href="/health/import">Import health data</Link>
              </Button>
              <Button asChild variant="outline">
                <Link href="/workouts">Open the training log</Link>
              </Button>
            </div>
          }
        />
      ) : (
        <>
          <div className="stat-grid mb-6">
            <StatCard label="Workouts" value={formatNumber(workouts.length)} icon={Dumbbell} accent="text-domain-workout" />
            <StatCard label="Total time" value={`${formatNumber(Math.round(totalMinutes / 60))} h`} hint={`${formatNumber(totalMinutes)} minutes`} />
            <StatCard label="Distance" value={`${formatNumber(distance.value, 1)} ${distance.unit}`} />
            <StatCard label="Calories" value={`${formatNumber(totalCalories)} kcal`} />
          </div>

          <SectionCard title="Sessions" icon={Dumbbell} accent="text-domain-workout">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th scope="col" className="py-2 pr-3 font-medium">Date</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Workout</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Duration</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Distance</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Calories</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Avg HR</th>
                    <th scope="col" className="py-2 font-medium">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {workouts.map((workout) => {
                    const shown =
                      workout.distanceKm === null
                        ? null
                        : toDisplay("distance_km", workout.distanceKm, user.unitSystem);
                    return (
                      <tr key={workout.id} className="border-b last:border-0">
                        <td className="py-2 pr-3 whitespace-nowrap">
                          {formatDay(workout.date, "MMM d, yyyy")}
                          {workout.time && (
                            <span className="ml-1.5 text-xs text-muted-foreground">{workout.time}</span>
                          )}
                        </td>
                        <td className="py-2 pr-3 font-medium">{workout.name}</td>
                        <td className="tabular py-2 pr-3">{workout.durationMin} min</td>
                        <td className="tabular py-2 pr-3">
                          {shown ? `${formatNumber(shown.value, 2)} ${shown.unit}` : "—"}
                        </td>
                        <td className="tabular py-2 pr-3">
                          {workout.caloriesBurned === null ? "—" : `${formatNumber(workout.caloriesBurned)} kcal`}
                        </td>
                        <td className="tabular py-2 pr-3">
                          {workout.avgHeartRate === null ? "—" : `${workout.avgHeartRate} bpm`}
                        </td>
                        <td className="py-2">
                          <Badge variant={workout.imported ? "muted" : "outline"} className="text-[10px]">
                            {workout.source}
                          </Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </SectionCard>
        </>
      )}
    </>
  );
}
