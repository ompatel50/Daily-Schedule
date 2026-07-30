/**
 * Workout duplicate judgement, kept pure so the rule is testable.
 *
 * An imported Apple Health workout is a *likely* duplicate of a workout the
 * user logged themselves when they sit on the same day, their lengths are
 * within 25% of each other, and their start times don't disagree by more than
 * 45 minutes (or one of them has no time at all). A likely duplicate is
 * skipped and reported — never merged into, and never a reason to delete, the
 * user's own record. When confidence is insufficient either way, the honest
 * answer is "possible duplicate, not imported", which is what this produces.
 */

export interface WorkoutCandidate {
  /** HH:mm, or null when the workout has no recorded time. */
  time: string | null;
  durationMin: number;
}

const toMinutes = (value: string): number =>
  Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));

export function isLikelyDuplicateWorkout(
  existing: WorkoutCandidate,
  imported: WorkoutCandidate,
): boolean {
  const durationClose =
    existing.durationMin > 0 &&
    imported.durationMin > 0 &&
    Math.abs(existing.durationMin - imported.durationMin) /
      Math.max(existing.durationMin, imported.durationMin) <=
      0.25;
  if (!durationClose) return false;
  if (!existing.time || !imported.time) return true;
  return Math.abs(toMinutes(existing.time) - toMinutes(imported.time)) <= 45;
}
