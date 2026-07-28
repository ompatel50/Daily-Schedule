import { INTENSITY_MULTIPLIER, WORKOUT_TYPE_META, type Intensity, type WorkoutType } from "@/lib/enums";
import { round } from "@/lib/utils";

export interface SetLike {
  exercise: string;
  reps?: number | null;
  weightKg?: number | null;
  durationSec?: number | null;
  distanceM?: number | null;
  completed?: boolean;
}

/**
 * Estimated energy expenditure from MET values:
 *   kcal = MET × 3.5 × kg / 200 × minutes
 * Adjusted by the user's reported intensity. Only used when the user hasn't
 * entered a measured value (e.g. from a watch) — measured always wins.
 */
export function estimateCaloriesBurned(input: {
  type: string;
  durationMin: number;
  intensity: string;
  bodyWeightKg: number;
}): number {
  const meta = WORKOUT_TYPE_META[input.type as WorkoutType] ?? WORKOUT_TYPE_META.custom;
  const multiplier = INTENSITY_MULTIPLIER[input.intensity as Intensity] ?? 1;
  const met = meta.met * multiplier;
  const kcal = ((met * 3.5 * input.bodyWeightKg) / 200) * input.durationMin;
  return Math.max(0, Math.round(kcal));
}

/** Total load moved: Σ reps × weight. The single best strength trend number. */
export function totalVolume(sets: SetLike[]): number {
  return round(
    sets
      .filter((set) => set.completed !== false)
      .reduce((total, set) => total + (set.reps ?? 0) * (set.weightKg ?? 0), 0),
    1,
  );
}

export function totalReps(sets: SetLike[]): number {
  return sets.filter((s) => s.completed !== false).reduce((t, s) => t + (s.reps ?? 0), 0);
}

/** Epley 1RM estimate — handy for tracking strength progress per exercise. */
export function estimateOneRepMax(weightKg: number, reps: number): number {
  if (weightKg <= 0 || reps <= 0) return 0;
  if (reps === 1) return round(weightKg, 1);
  return round(weightKg * (1 + reps / 30), 1);
}

/** Best set (by estimated 1RM) for each exercise across a set of workouts. */
export function personalRecords(
  workouts: Array<{ date: string; sets: SetLike[] }>,
): Array<{ exercise: string; weightKg: number; reps: number; oneRepMax: number; date: string }> {
  const best = new Map<string, { exercise: string; weightKg: number; reps: number; oneRepMax: number; date: string }>();

  for (const workout of workouts) {
    for (const set of workout.sets) {
      if (!set.weightKg || !set.reps || set.completed === false) continue;
      const orm = estimateOneRepMax(set.weightKg, set.reps);
      const key = set.exercise.trim().toLowerCase();
      const existing = best.get(key);
      if (!existing || orm > existing.oneRepMax) {
        best.set(key, {
          exercise: set.exercise,
          weightKg: set.weightKg,
          reps: set.reps,
          oneRepMax: orm,
          date: workout.date,
        });
      }
    }
  }

  return Array.from(best.values()).sort((a, b) => b.oneRepMax - a.oneRepMax);
}

/** Pace in min/km for distance work. */
export function pacePerKm(distanceKm: number, durationMin: number): number | null {
  if (!distanceKm || distanceKm <= 0 || !durationMin) return null;
  return round(durationMin / distanceKm, 2);
}

export function formatPace(paceMinPerKm: number | null): string {
  if (paceMinPerKm === null) return "—";
  const mins = Math.floor(paceMinPerKm);
  const secs = Math.round((paceMinPerKm - mins) * 60);
  return `${mins}:${String(secs).padStart(2, "0")} /km`;
}

export const KM_PER_MILE = 1.60934;

export function kmToMiles(km: number): number {
  return km / KM_PER_MILE;
}

export function milesToKm(miles: number): number {
  return miles * KM_PER_MILE;
}

/** Template `exercises` JSON → editable set rows for a new workout. */
export interface TemplateExercise {
  exercise: string;
  sets: number;
  reps?: number;
  weightKg?: number;
  restSec?: number;
  notes?: string;
}

export function expandTemplateExercises(exercises: TemplateExercise[]): SetLike[] {
  const rows: SetLike[] = [];
  for (const exercise of exercises) {
    const count = Math.max(1, Math.round(exercise.sets || 1));
    for (let i = 0; i < count; i += 1) {
      rows.push({
        exercise: exercise.exercise,
        reps: exercise.reps ?? null,
        weightKg: exercise.weightKg ?? null,
        completed: true,
      });
    }
  }
  return rows;
}
