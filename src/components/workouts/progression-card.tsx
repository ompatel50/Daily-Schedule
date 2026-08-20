"use client";

import * as React from "react";
import { TrendingUp } from "lucide-react";

import { SectionCard } from "@/components/shared/section-card";
import { TrendLineChart } from "@/components/shared/charts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDay } from "@/lib/date";
import { kgToLb } from "@/lib/logic/nutrition";
import { type ExerciseProgressionPoint } from "@/lib/logic/workouts";
import { formatNumber } from "@/lib/utils";
import { getExerciseProgression } from "@/server/actions/workouts";

/**
 * Per-exercise history: top set weight and estimated 1RM over time, with the
 * day's volume in the tooltip-ready series. Reads on demand — picking an
 * exercise fetches its (bounded) window; nothing is computed until asked.
 */
export function ProgressionCard({
  exercises,
  unitSystem,
}: {
  exercises: string[];
  unitSystem: string;
}) {
  const [exercise, setExercise] = React.useState<string>("");
  const [points, setPoints] = React.useState<ExerciseProgressionPoint[] | null>(null);
  const [loading, setLoading] = React.useState(false);

  const imperial = unitSystem === "imperial";
  const unit = imperial ? "lb" : "kg";
  const display = (kg: number | null) =>
    kg === null ? null : Math.round((imperial ? kgToLb(kg) : kg) * 10) / 10;

  React.useEffect(() => {
    if (!exercise) return;
    let cancelled = false;
    setLoading(true);
    void getExerciseProgression(exercise)
      .then((result) => {
        if (!cancelled && result.ok) setPoints(result.data.points);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [exercise]);

  const chartData = (points ?? []).map((point) => ({
    label: formatDay(point.date, "M/d"),
    top: display(point.topWeightKg),
    orm: display(point.estOneRepMaxKg),
  }));
  const latest = points && points.length > 0 ? points[points.length - 1] : null;
  const best = (points ?? []).reduce<number | null>(
    (max, point) =>
      point.estOneRepMaxKg !== null && (max === null || point.estOneRepMaxKg > max)
        ? point.estOneRepMaxKg
        : max,
    null,
  );

  return (
    <SectionCard
      title="Exercise progression"
      icon={TrendingUp}
      accent="text-domain-workout"
      description="Weight, reps and volume over time, per exercise"
      action={
        exercises.length > 0 ? (
          <Select value={exercise} onValueChange={setExercise}>
            <SelectTrigger aria-label="Exercise" className="h-8 w-44">
              <SelectValue placeholder="Pick an exercise" />
            </SelectTrigger>
            <SelectContent>
              {exercises.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : undefined
      }
    >
      {exercises.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Log a few strength workouts and their exercises appear here.
        </p>
      ) : !exercise ? (
        <p className="text-sm text-muted-foreground">
          Pick an exercise to see its history — top set and estimated 1RM per session.
        </p>
      ) : loading && points === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : points !== null && points.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No completed sets for {exercise} in the last year.
        </p>
      ) : points !== null ? (
        <div className="space-y-2">
          <TrendLineChart
            data={chartData}
            lines={[
              { dataKey: "top", name: `Top set (${unit})`, color: "hsl(var(--domain-workout))" },
              { dataKey: "orm", name: `Est. 1RM (${unit})`, color: "hsl(var(--domain-health))" },
            ]}
            height={200}
            unit={` ${unit}`}
          />
          <p className="text-xs text-muted-foreground">
            {points.length} session{points.length === 1 ? "" : "s"} in the last year
            {latest
              ? ` · last: ${latest.sets} sets, ${latest.totalReps} reps, ${formatNumber(
                  Math.round(imperial ? kgToLb(latest.volumeKg) : latest.volumeKg),
                )} ${unit} volume`
              : ""}
            {best !== null ? ` · best est. 1RM ${display(best)} ${unit}` : ""}
          </p>
        </div>
      ) : null}
    </SectionCard>
  );
}
