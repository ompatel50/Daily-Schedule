/**
 * The workout session: what state it can be in, and everything derived from it.
 *
 * Before this, "starting" a template wrote a finished workout with every set
 * pre-ticked. That is fine for logging something you already did, and useless
 * while you are actually training — there was no notion of a set you have not
 * done yet, no real elapsed time, and no way to put your phone down and come
 * back.
 *
 * A session is a `Workout` with `status: "in_progress"`, real `startedAt` /
 * `completedAt` stamps, and sets that begin incomplete and carry the plan
 * (`targetReps` / `targetWeightKg`) separately from what happened (`reps` /
 * `weightKg`). Everything in this module is pure, so the transitions and the
 * timer arithmetic are testable without a database or a clock.
 */

export const WORKOUT_STATUSES = [
  "planned",
  "in_progress",
  "completed",
  "abandoned",
  "skipped",
] as const;
export type WorkoutStatus = (typeof WORKOUT_STATUSES)[number];

export const WORKOUT_STATUS_META: Record<
  WorkoutStatus,
  { label: string; description: string; countsAsTrained: boolean }
> = {
  planned: {
    label: "Planned",
    description: "On the schedule, not started yet",
    countsAsTrained: false,
  },
  in_progress: {
    label: "In progress",
    description: "A live session — finish or abandon it",
    // Deliberately false: a session you are still in has not happened yet, and
    // counting it would let an abandoned warm-up inflate the day's training.
    countsAsTrained: false,
  },
  completed: {
    label: "Completed",
    description: "Done, and counted",
    countsAsTrained: true,
  },
  abandoned: {
    label: "Stopped early",
    description: "Started and stopped — whatever was done is kept",
    // True: you did train. How much is a question the sets answer.
    countsAsTrained: true,
  },
  skipped: {
    label: "Skipped",
    description: "Deliberately not done",
    countsAsTrained: false,
  },
};

export function isWorkoutStatus(value: string): value is WorkoutStatus {
  return (WORKOUT_STATUSES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * Which status can become which.
 *
 * The rules worth stating: a session can only be finished or abandoned from
 * `in_progress`, a completed workout can be reopened (people notice a missed
 * set a minute later), and nothing can go back to `planned` once real sets have
 * been recorded — that is what `reopenSession` guards, not this table.
 */
const ALLOWED_TRANSITIONS: Record<WorkoutStatus, readonly WorkoutStatus[]> = {
  planned: ["in_progress", "completed", "skipped"],
  in_progress: ["completed", "abandoned", "planned"],
  completed: ["in_progress", "skipped"],
  abandoned: ["in_progress", "completed"],
  skipped: ["planned", "in_progress", "completed"],
};

export function canTransition(from: string, to: string): boolean {
  if (!isWorkoutStatus(from) || !isWorkoutStatus(to)) return false;
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function transitionsFrom(status: WorkoutStatus): readonly WorkoutStatus[] {
  return ALLOWED_TRANSITIONS[status];
}

/** True for the one status that means "a session is open right now". */
export function isLive(status: string): boolean {
  return status === "in_progress";
}

// ---------------------------------------------------------------------------
// Sets
// ---------------------------------------------------------------------------

export interface SessionSet {
  id: string;
  exercise: string;
  setNumber: number;
  reps: number | null;
  weightKg: number | null;
  durationSec: number | null;
  distanceM: number | null;
  targetReps: number | null;
  targetWeightKg: number | null;
  restSec: number | null;
  rpe: number | null;
  completed: boolean;
  /** ISO string; null while the set is outstanding. */
  completedAt: string | null;
  sortOrder: number;
}

export interface SessionProgress {
  total: number;
  done: number;
  remaining: number;
  /** 0–100. 0 for an empty session rather than NaN. */
  percent: number;
  /** Index into the ordered set list of the next set to do; null when finished. */
  nextIndex: number | null;
  /** The next set itself, for convenience. */
  next: SessionSet | null;
  /** The most recently ticked set — what the rest timer counts from. */
  lastCompleted: SessionSet | null;
}

/** Sets in the order they should be worked: by sortOrder, then set number. */
export function orderSets(sets: SessionSet[]): SessionSet[] {
  return sets
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder || a.setNumber - b.setNumber);
}

export function sessionProgress(sets: SessionSet[]): SessionProgress {
  const ordered = orderSets(sets);
  const done = ordered.filter((set) => set.completed).length;
  const total = ordered.length;

  const nextIndex = ordered.findIndex((set) => !set.completed);

  // The most recent tick by wall clock, not by position — sets can be done out
  // of order, and the rest timer should follow the last thing you actually did.
  const lastCompleted =
    ordered
      .filter((set) => set.completed && set.completedAt)
      .sort((a, b) => (a.completedAt ?? "").localeCompare(b.completedAt ?? ""))
      .at(-1) ?? null;

  return {
    total,
    done,
    remaining: total - done,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
    nextIndex: nextIndex === -1 ? null : nextIndex,
    next: nextIndex === -1 ? null : ordered[nextIndex],
    lastCompleted,
  };
}

/** True when every set is ticked — the cue to offer "finish". */
export function isSessionComplete(sets: SessionSet[]): boolean {
  return sets.length > 0 && sets.every((set) => set.completed);
}

/**
 * Group the ordered sets by exercise, preserving first-appearance order.
 * A session is worked exercise by exercise, so this is how it renders.
 */
export function groupByExercise(
  sets: SessionSet[],
): Array<{ exercise: string; sets: SessionSet[]; done: number }> {
  const groups = new Map<string, SessionSet[]>();
  for (const set of orderSets(sets)) {
    const key = set.exercise;
    const list = groups.get(key);
    if (list) list.push(set);
    else groups.set(key, [set]);
  }
  return Array.from(groups.entries()).map(([exercise, list]) => ({
    exercise,
    sets: list,
    done: list.filter((set) => set.completed).length,
  }));
}

export interface SessionExerciseBlock {
  exercise: string;
  sets: SessionSet[];
  done: number;
}

export interface SessionGroupBlock {
  /** Superset/circuit key; null for an exercise worked on its own. */
  group: string | null;
  /** "Superset A" for a pair, "Circuit B" for three or more; null when ungrouped. */
  label: string | null;
  exercises: SessionExerciseBlock[];
}

/**
 * The exercise blocks, folded into superset/circuit blocks.
 *
 * Only *consecutive* exercises sharing a group key merge: grouped exercises are
 * planned interleaved, so their first appearances are adjacent, and merging
 * across a distance would display an order you are not actually working in.
 * With no group map (or a group that ended up with one member) every exercise
 * stands alone — exactly the pre-grouping rendering.
 */
export function sessionBlocks(
  sets: SessionSet[],
  groupOf: Record<string, string> = {},
): SessionGroupBlock[] {
  const blocks: SessionGroupBlock[] = [];
  for (const entry of groupByExercise(sets)) {
    const group = groupOf[entry.exercise] ?? null;
    const last = blocks.at(-1);
    if (group !== null && last && last.group === group) {
      last.exercises.push(entry);
      continue;
    }
    blocks.push({ group, label: null, exercises: [entry] });
  }
  return blocks.map((block) => {
    if (block.group === null || block.exercises.length < 2) {
      return { ...block, group: null, label: null };
    }
    const kind = block.exercises.length >= 3 ? "Circuit" : "Superset";
    return { ...block, label: `${kind} ${block.group}` };
  });
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

const MS_PER_MINUTE = 60_000;
/** Nobody trains for 12 hours. A session left open overnight is a mistake. */
export const MAX_SESSION_MINUTES = 720;

/**
 * How long the session has run, in whole minutes.
 *
 * Clamped at both ends: never negative (a clock that moved backwards), and
 * never beyond `MAX_SESSION_MINUTES`, so a session forgotten overnight does not
 * report 14 hours of training into the day score.
 */
export function elapsedMinutes(
  startedAt: string | Date | null | undefined,
  endedAt: string | Date | null | undefined,
  now: Date = new Date(),
): number {
  if (!startedAt) return 0;
  const start = new Date(startedAt).getTime();
  if (!Number.isFinite(start)) return 0;

  const end = endedAt ? new Date(endedAt).getTime() : now.getTime();
  if (!Number.isFinite(end)) return 0;

  const minutes = Math.round((end - start) / MS_PER_MINUTE);
  return Math.min(Math.max(minutes, 0), MAX_SESSION_MINUTES);
}

/**
 * The duration to record when a session finishes.
 *
 * Elapsed wall-clock time is the honest answer, but a session that was started
 * and finished inside a minute would round to 0 and read as "no workout" to
 * every other surface. One minute is the floor for a session that did anything.
 */
export function sessionDurationMinutes(
  startedAt: string | Date | null | undefined,
  endedAt: string | Date | null | undefined,
  sets: SessionSet[],
  now: Date = new Date(),
): number {
  const elapsed = elapsedMinutes(startedAt, endedAt, now);
  const didAnything = sets.some((set) => set.completed);
  if (!didAnything) return elapsed;
  return Math.max(1, elapsed);
}

export interface RestState {
  /** Seconds left, 0 once the rest is over. */
  remaining: number;
  total: number;
  /** True while there is time on the clock. */
  resting: boolean;
}

/**
 * The rest timer, derived rather than stored.
 *
 * Keeping this a function of (last tick, rest length, now) means the timer
 * survives a reload, a backgrounded tab and a navigation — there is no ticking
 * state to lose, only a stamp to subtract from.
 */
export function restState(
  lastCompletedAt: string | Date | null | undefined,
  restSec: number | null | undefined,
  now: Date = new Date(),
): RestState {
  const total = restSec && restSec > 0 ? Math.round(restSec) : 0;
  if (!lastCompletedAt || total === 0) return { remaining: 0, total, resting: false };

  const since = new Date(lastCompletedAt).getTime();
  if (!Number.isFinite(since)) return { remaining: 0, total, resting: false };

  const elapsedSec = Math.floor((now.getTime() - since) / 1000);
  const remaining = Math.max(0, total - elapsedSec);
  return { remaining, total, resting: remaining > 0 };
}

export function formatRest(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

/**
 * How long to rest after the set that was just ticked, or null for none.
 *
 * The precedence is: the set's own rest (a per-exercise override lands there)
 * over the session default. On top of that sits the superset rule, stated
 * once: **inside a group, rest belongs to the round, not the set** — moving to
 * the next exercise of the round is immediate, and the full rest starts only
 * when every exercise in the group has done its set of that round. Sets share
 * a round by `setNumber`, so ticking out of order still ends the round on the
 * last member, and an exercise with fewer sets simply drops out of later
 * rounds without blocking them.
 */
export function restSecAfterSet(
  lastCompleted: SessionSet | null | undefined,
  sets: SessionSet[],
  groupOf: Record<string, string> = {},
  sessionDefault: number | null = null,
): number | null {
  if (!lastCompleted) return null;
  const base = lastCompleted.restSec ?? sessionDefault;

  const group = groupOf[lastCompleted.exercise];
  if (group === undefined) return base;

  const members = new Set(
    sets.filter((set) => groupOf[set.exercise] === group).map((set) => set.exercise),
  );
  if (members.size < 2) return base;

  const round = lastCompleted.setNumber;
  const roundDone = Array.from(members).every((exercise) => {
    const inRound = sets.find(
      (set) => set.exercise === exercise && set.setNumber === round,
    );
    return !inRound || inRound.completed;
  });
  return roundDone ? base : null;
}

// ---------------------------------------------------------------------------
// Planned vs actual
// ---------------------------------------------------------------------------

export type SetOutcome = "pending" | "on_target" | "over" | "under" | "done";

/**
 * How a completed set compares with what was planned.
 *
 * Only meaningful when there was a target; a set logged with no plan is just
 * `done`. Weight is compared first because that is what people are usually
 * pushing, and reps second.
 */
export function setOutcome(set: SessionSet): SetOutcome {
  if (!set.completed) return "pending";

  const hasTarget = set.targetReps !== null || set.targetWeightKg !== null;
  if (!hasTarget) return "done";

  if (set.targetWeightKg !== null && set.weightKg !== null) {
    if (set.weightKg > set.targetWeightKg) return "over";
    if (set.weightKg < set.targetWeightKg) return "under";
  }
  if (set.targetReps !== null && set.reps !== null) {
    if (set.reps > set.targetReps) return "over";
    if (set.reps < set.targetReps) return "under";
  }
  return "on_target";
}

/** "3 × 8 @ 60 kg" for a plan or an outcome; "—" when there is nothing to say. */
export function describeSetTarget(set: SessionSet): string {
  const reps = set.targetReps;
  const weight = set.targetWeightKg;
  if (reps === null && weight === null) return "—";
  if (weight === null) return `${reps} reps`;
  if (reps === null) return `${weight} kg`;
  return `${reps} × ${weight} kg`;
}

export function describeSetActual(set: SessionSet): string {
  if (!set.completed) return "—";
  const { reps, weightKg } = set;
  if (reps === null && weightKg === null) return "done";
  if (weightKg === null) return `${reps} reps`;
  if (reps === null) return `${weightKg} kg`;
  return `${reps} × ${weightKg} kg`;
}

// ---------------------------------------------------------------------------
// Seeding a session's sets from a plan
// ---------------------------------------------------------------------------

export interface PlannedSet {
  exercise: string;
  setNumber: number;
  targetReps: number | null;
  targetWeightKg: number | null;
  restSec: number | null;
  sortOrder: number;
}

export interface TemplateExerciseLike {
  exercise: string;
  sets: number;
  reps?: number | null;
  weightKg?: number | null;
  restSec?: number | null;
  /** Superset/circuit key ("A", "B"…). Absent or blank means ungrouped. */
  group?: string | null;
}

function clampSetCount(sets: number): number {
  return Math.min(Math.max(Math.round(sets || 1), 1), 20);
}

function groupKeyOf(exercise: TemplateExerciseLike): string {
  return typeof exercise.group === "string" ? exercise.group.trim() : "";
}

/**
 * Expand a template into the sets a session starts with.
 *
 * The numbers become **targets**, not results — which is the whole difference
 * between starting a session and logging a finished workout. Nothing is marked
 * complete, so the session has real work outstanding from the first second.
 *
 * Exercises sharing a group key expand as a superset/circuit: round-robin
 * (A1 set 1, A2 set 1, A1 set 2 …) rather than exercise by exercise, with the
 * block anchored where the group's first member sits in the template. An
 * exercise with fewer sets drops out of later rounds. No group keys means the
 * expansion is byte-for-byte what it was before grouping existed.
 */
export function planSetsFromTemplate(exercises: TemplateExerciseLike[]): PlannedSet[] {
  // Blocks preserve template order; every member of a group joins the block at
  // its first member's position.
  const blocks: TemplateExerciseLike[][] = [];
  const blockByGroup = new Map<string, TemplateExerciseLike[]>();

  for (const exercise of exercises) {
    const name = String(exercise.exercise ?? "").trim();
    if (!name) continue;

    const key = groupKeyOf(exercise);
    if (!key) {
      blocks.push([exercise]);
      continue;
    }
    const existing = blockByGroup.get(key);
    if (existing) {
      existing.push(exercise);
    } else {
      const block = [exercise];
      blockByGroup.set(key, block);
      blocks.push(block);
    }
  }

  const rows: PlannedSet[] = [];
  let order = 0;

  for (const block of blocks) {
    const counts = block.map((exercise) => clampSetCount(exercise.sets));
    const rounds = Math.max(...counts);
    // A block of one is a plain exercise: round-robin over it is sequential.
    for (let round = 0; round < rounds; round += 1) {
      for (let index = 0; index < block.length; index += 1) {
        if (round >= counts[index]) continue;
        const exercise = block[index];
        rows.push({
          exercise: String(exercise.exercise).trim(),
          setNumber: round + 1,
          targetReps: numberOrNull(exercise.reps),
          targetWeightKg: numberOrNull(exercise.weightKg),
          restSec: numberOrNull(exercise.restSec),
          sortOrder: order,
        });
        order += 1;
      }
    }
  }

  return rows;
}

/**
 * The template's exercise → group map, for the session panel and the rest
 * rule. A key claimed by a single exercise is dropped — a superset of one is
 * just an exercise, and treating it as a group would change its rest for
 * nothing.
 */
export function templateGroups(exercises: TemplateExerciseLike[]): Record<string, string> {
  const byGroup = new Map<string, string[]>();
  for (const exercise of exercises) {
    const name = String(exercise.exercise ?? "").trim();
    const key = groupKeyOf(exercise);
    if (!name || !key) continue;
    const names = byGroup.get(key) ?? [];
    if (!names.includes(name)) names.push(name);
    byGroup.set(key, names);
  }

  const out: Record<string, string> = {};
  for (const [key, names] of byGroup) {
    if (names.length < 2) continue;
    for (const name of names) out[name] = key;
  }
  return out;
}

/**
 * Re-run a past workout as a session: what you did last time becomes this
 * time's target, which is the progression model most people actually use.
 */
export function planSetsFromWorkout(
  sets: Array<Pick<SessionSet, "exercise" | "setNumber" | "reps" | "weightKg" | "restSec" | "sortOrder">>,
): PlannedSet[] {
  return sets
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder || a.setNumber - b.setNumber)
    .map((set, index) => ({
      exercise: set.exercise,
      setNumber: set.setNumber,
      targetReps: set.reps ?? null,
      targetWeightKg: set.weightKg ?? null,
      restSec: set.restSec ?? null,
      sortOrder: index,
    }));
}

function numberOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

/**
 * The default rest for a session, taken from the first set that declares one.
 * Null rather than a made-up 90 seconds: no plan means no timer, not a guess.
 */
export function defaultRestSec(sets: Array<{ restSec: number | null }>): number | null {
  for (const set of sets) {
    if (set.restSec && set.restSec > 0) return Math.round(set.restSec);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Progression
// ---------------------------------------------------------------------------

/** One small plate a side — the smallest step most racks can actually make. */
export const PROGRESSION_INCREMENT_KG = 2.5;

/** Matches the validator's ceiling, so an applied suggestion can never fail it. */
const MAX_TARGET_WEIGHT_KG = 2000;

export interface PriorSetPerformance {
  reps: number | null;
  weightKg: number | null;
  targetReps: number | null;
}

export interface ProgressionSuggestion {
  kind: "increase" | "repeat";
  /** Weight to write onto the outstanding targets; null means keep them as-is. */
  targetWeightKg: number | null;
  /** One plain sentence of why. Shown verbatim next to the estimate label. */
  reason: string;
}

/**
 * A conservative next target from the last completed performance of an
 * exercise. This is an estimate from the user's own logs, never advice — the
 * UI labels it as such and nothing applies it without an explicit tap.
 *
 * The rule errs on the side of "do it again": weight goes up by one increment
 * only when every set hit its target reps *and* the weight was the same across
 * sets. Anything ambiguous — targets missed, no targets recorded, a pyramid of
 * different weights — suggests repeating. And where there is no load to reason
 * about at all (no history, bodyweight or duration work) there is no
 * suggestion, because inventing one would be exactly the coaching this app
 * must not do.
 */
export function suggestProgression(prior: PriorSetPerformance[]): ProgressionSuggestion | null {
  if (prior.length === 0) return null;

  const sets: Array<{ reps: number; weightKg: number; targetReps: number | null }> = [];
  for (const set of prior) {
    if (set.reps === null || set.weightKg === null) return null;
    sets.push({ reps: set.reps, weightKg: set.weightKg, targetReps: set.targetReps });
  }

  const repeat = (reason: string): ProgressionSuggestion => ({
    kind: "repeat",
    targetWeightKg: null,
    reason,
  });

  if (sets.some((set) => set.targetReps === null)) {
    return repeat("Last time had no rep targets to compare against — repeat it before adding load.");
  }
  if (sets.some((set) => set.targetReps !== null && set.reps < set.targetReps)) {
    return repeat("Not every set hit its target reps last time — repeat the same weight.");
  }
  const weights = new Set(sets.map((set) => set.weightKg));
  if (weights.size > 1) {
    return repeat("The weight varied across sets last time — repeat them before adding load.");
  }

  const weight = sets[0].weightKg;
  const next = Math.round((weight + PROGRESSION_INCREMENT_KG) * 1000) / 1000;
  if (next > MAX_TARGET_WEIGHT_KG) {
    return repeat("Already at the highest weight the tracker accepts.");
  }

  return {
    kind: "increase",
    targetWeightKg: next,
    reason: `Every set hit its target reps at ${weight} kg last time.`,
  };
}
