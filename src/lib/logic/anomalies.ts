import { type DayKey, shiftDay } from "@/lib/date";
import { median } from "@/lib/logic/correlations";
import type { DailyFact } from "@/lib/logic/daily-facts";
import { formatCents } from "@/lib/logic/money";
import { round } from "@/lib/utils";

/**
 * Anomaly nudges — robust deviations from the user's OWN baselines, computed
 * over the daily fact layer. Pure, so every gate, threshold and sentence is
 * unit-testable.
 *
 * The rules:
 *
 *  * **Robust baselines.** Every baseline is a rolling median with spread
 *    measured by the scaled MAD (median absolute deviation × 1.4826, the
 *    consistency constant for normal data) — one wild day cannot drag the
 *    baseline the way a mean would. Weekly aggregation is the seasonal
 *    handling for spending: at personal scale the dominant cycle is the
 *    weekday one, and comparing week against weeks removes it.
 *  * **Sufficient history before anything fires.** Each detector documents
 *    its own gate below. A new account clears none of them, so it gets no
 *    nudges — silence, not fabrication.
 *  * **Hard rate limit.** At most `ANOMALY_WEEKLY_LIMIT` anomaly nudges per
 *    rolling week, whatever the detectors find; the surplus is dropped in
 *    priority order (health signals first). Deduplication is by delivery
 *    key: each key embeds a coarse window (the week, or the break date), so
 *    a persisting condition re-fires at most once per window.
 *  * **Dismissal informs sensitivity.** Each dismissal of a category raises
 *    that category's threshold (see `sensitivityBump`), so a nudge the user
 *    keeps waving away needs a progressively larger deviation to return.
 *    Muted categories are skipped entirely.
 *  * **Observations, never diagnosis.** Physiological copy states what the
 *    user's own numbers did and stops. The resting-HR nudge may carry ONE
 *    brief clinician sentence (`clinicianNote`) the first time — never
 *    repeated once the user has seen and dismissed one, never alarmist.
 *  * **No calorie anomalies, deliberately.** A "calories above/below usual"
 *    nudge is exactly the "you went over" alert the nutrition-targets
 *    wellbeing constraint forbids, so no such detector exists.
 */

export const ANOMALY_CATEGORIES = [
  "resting_hr",
  "sleep_debt",
  "habit_streak",
  "workout_frequency",
  "spending",
] as const;
export type AnomalyCategory = (typeof ANOMALY_CATEGORIES)[number];

/** Hard cap on anomaly nudges per rolling week, across every category. */
export const ANOMALY_WEEKLY_LIMIT = 3;

/** Each dismissal raises the category's threshold multiplier by this… */
export const DISMISSAL_SENSITIVITY_STEP = 0.5;
/** …up to this much extra. */
export const DISMISSAL_SENSITIVITY_CAP = 2;

// Per-detector gates and thresholds — documented constants, not magic.
/** Resting HR: baseline needs this many measured days in its 30-day window. */
export const RESTING_HR_BASELINE_MIN_DAYS = 20;
/** Resting HR: the run examined, ending yesterday, and its measured floor. */
export const RESTING_HR_RUN_DAYS = 5;
export const RESTING_HR_RUN_MIN_MEASURED = 4;
/** Resting HR: base MAD multiplier and the minimum band (bpm) when readings
 * are so steady the MAD collapses. */
export const RESTING_HR_BASE_K = 2;
export const RESTING_HR_MIN_SPREAD_BPM = 2;

/** Sleep debt: measured-night floors for the baseline and the recent week. */
export const SLEEP_BASELINE_MIN_NIGHTS = 20;
export const SLEEP_RECENT_MIN_NIGHTS = 5;
/** Sleep debt: hours below the baseline median, summed over the last 7
 * nights, before the nudge fires (scaled by sensitivity). */
export const SLEEP_DEBT_BASE_HOURS = 5;

/** Habit streak: consecutive completions that count as "long consistency". */
export const HABIT_STREAK_MIN = 21;
/** Each dismissal raises the streak floor by this many days. */
export const HABIT_STREAK_DISMISSAL_STEP = 7;

/** Workout frequency: the window compared and how much history the baseline
 * needs (three prior windows), plus the baseline floor that makes a drop
 * meaningful at all. */
export const WORKOUT_WINDOW_DAYS = 14;
export const WORKOUT_BASELINE_WINDOWS = 3;
export const WORKOUT_BASELINE_MIN_PER_WINDOW = 3;

/** Spending: weekly totals per category, current week against this many
 * prior weeks, of which this many must have any activity. */
export const SPEND_BASELINE_WEEKS = 8;
export const SPEND_BASELINE_MIN_ACTIVE_WEEKS = 6;
export const SPEND_BASE_K = 3;
/** Guard when a category's weeks are near-identical: the current week must
 * also exceed the median by half again. */
export const SPEND_MIN_RATIO = 1.5;

// --- inputs / outputs ---------------------------------------------------------

export interface AnomalyPreferenceLike {
  muted: boolean;
  dismissals: number;
}

export interface HabitStreakInput {
  name: string;
  /** The streak as it stood before the break. */
  streakBeforeBreak: number;
  /** The day the habit was missed, or null if it wasn't. */
  brokeOn: DayKey | null;
}

export interface AnomalyInput {
  /** Daily facts, ascending, ending on or before `today`. */
  facts: DailyFact[];
  today: DayKey;
  /** The user's week start — embedded in weekly dedup keys. */
  weekStart: DayKey;
  habits: HabitStreakInput[];
  preferences: Partial<Record<AnomalyCategory, AnomalyPreferenceLike>>;
  /** Anomaly nudges already delivered in the rolling week (ledger count). */
  deliveredThisWeek: number;
  /** Ledger keys already claimed — a delivered signal never re-surfaces
   * inside its window, and never consumes the weekly budget twice. */
  deliveredKeys: ReadonlySet<string>;
}

export interface AnomalySignal {
  category: AnomalyCategory;
  /** Ledger key with its coarse window baked in — the dedup boundary. */
  key: string;
  title: string;
  message: string;
  /** True on a resting-HR signal that should carry the one clinician
   * sentence (first time only — see the module docstring). */
  clinicianNote: boolean;
}

export interface AnomalyReport {
  /** Signals to DELIVER: not yet claimed, inside the weekly budget. */
  signals: AnomalySignal[];
  /** Every current signal regardless of delivery state — what the
   * Observations surface shows (a delivered nudge is still true). */
  observations: AnomalySignal[];
  /** Categories whose history gate passed this run (fired or not) — the
   * honest "baselines are formed" indicator for the UI. */
  ready: AnomalyCategory[];
}

// --- helpers ------------------------------------------------------------------

/** Scaled median absolute deviation — the robust σ stand-in. */
export function scaledMad(values: number[]): number {
  if (values.length === 0) return 0;
  const center = median(values);
  return 1.4826 * median(values.map((value) => Math.abs(value - center)));
}

function bumpOf(preference: AnomalyPreferenceLike | undefined): number {
  return Math.min(
    DISMISSAL_SENSITIVITY_CAP,
    (preference?.dismissals ?? 0) * DISMISSAL_SENSITIVITY_STEP,
  );
}

function slugOf(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

// --- the engine ---------------------------------------------------------------

export function detectAnomalies(input: AnomalyInput): AnomalyReport {
  const byDate = new Map(input.facts.map((fact) => [fact.date, fact]));
  const yesterday = shiftDay(input.today, -1);
  const preference = (category: AnomalyCategory) => input.preferences[category];
  const muted = (category: AnomalyCategory) => preference(category)?.muted === true;

  const ready: AnomalyCategory[] = [];
  const candidates: AnomalySignal[] = [];

  /** The last `count` days ending at `end`, most recent last; missing rows
   * are simply absent (never fabricated). */
  const window = (end: DayKey, count: number): DailyFact[] => {
    const rows: DailyFact[] = [];
    for (let offset = count - 1; offset >= 0; offset -= 1) {
      const fact = byDate.get(shiftDay(end, -offset));
      if (fact) rows.push(fact);
    }
    return rows;
  };

  // 1. Resting heart rate above its own range — the health-first signal.
  if (!muted("resting_hr")) {
    const recent = window(yesterday, RESTING_HR_RUN_DAYS)
      .map((fact) => fact.restingHr)
      .filter((value): value is number => value !== null);
    const baseline = window(shiftDay(yesterday, -RESTING_HR_RUN_DAYS), 30)
      .map((fact) => fact.restingHr)
      .filter((value): value is number => value !== null);
    if (baseline.length >= RESTING_HR_BASELINE_MIN_DAYS) {
      ready.push("resting_hr");
      const center = median(baseline);
      const spread = Math.max(scaledMad(baseline), RESTING_HR_MIN_SPREAD_BPM);
      const threshold = center + (RESTING_HR_BASE_K + bumpOf(preference("resting_hr"))) * spread;
      if (
        recent.length >= RESTING_HR_RUN_MIN_MEASURED &&
        recent.every((value) => value > threshold)
      ) {
        const mean = recent.reduce((sum, value) => sum + value, 0) / recent.length;
        candidates.push({
          category: "resting_hr",
          key: `anomaly:resting_hr:${input.weekStart}`,
          title: "Resting heart rate above its usual range",
          message: `Your resting HR has read above its 30-day range for ${recent.length} days — recent readings average ${round(mean, 0)} bpm against a median of ${round(center, 0)} bpm. An observation about your own numbers, nothing more.`,
          clinicianNote: (preference("resting_hr")?.dismissals ?? 0) === 0,
        });
      }
    }
  }

  // 2. Sleep running below its own median.
  if (!muted("sleep_debt")) {
    const recent = window(yesterday, 7)
      .map((fact) => fact.sleepHours)
      .filter((value): value is number => value !== null);
    const baseline = window(shiftDay(yesterday, -7), 30)
      .map((fact) => fact.sleepHours)
      .filter((value): value is number => value !== null);
    if (baseline.length >= SLEEP_BASELINE_MIN_NIGHTS) {
      ready.push("sleep_debt");
      const center = median(baseline);
      const debt = recent.reduce((sum, value) => sum + Math.max(0, center - value), 0);
      const needed = SLEEP_DEBT_BASE_HOURS * (1 + bumpOf(preference("sleep_debt")));
      if (recent.length >= SLEEP_RECENT_MIN_NIGHTS && debt >= needed) {
        candidates.push({
          category: "sleep_debt",
          key: `anomaly:sleep_debt:${input.weekStart}`,
          title: "Sleep has run below its usual level",
          message: `Across the last 7 nights you slept about ${round(debt, 1)} h less than your 30-day median of ${round(center, 1)} h a night.`,
          clinicianNote: false,
        });
      }
    }
  }

  // 3. A long habit streak just broke. Factual — the record of what
  //    happened, never a judgement.
  if (!muted("habit_streak")) {
    const floor =
      HABIT_STREAK_MIN +
      (preference("habit_streak")?.dismissals ?? 0) * HABIT_STREAK_DISMISSAL_STEP;
    // The gate is per-habit (a long streak IS the history), so the category
    // reads ready whenever any habit has been consistent that long.
    if (input.habits.some((habit) => habit.streakBeforeBreak >= floor)) {
      ready.push("habit_streak");
    }
    for (const habit of input.habits) {
      if (habit.brokeOn !== yesterday) continue;
      if (habit.streakBeforeBreak < floor) continue;
      candidates.push({
        category: "habit_streak",
        key: `anomaly:habit_streak:${slugOf(habit.name)}:${habit.brokeOn}`,
        title: `${habit.name} streak ended`,
        message: `${habit.name} was missed yesterday after ${habit.streakBeforeBreak} consecutive completions. One day is one day — the record is still yours.`,
        clinicianNote: false,
      });
    }
  }

  // 4. Workout frequency dropping off against its own recent rate.
  if (!muted("workout_frequency")) {
    const countIn = (end: DayKey) =>
      window(end, WORKOUT_WINDOW_DAYS).reduce((sum, fact) => sum + fact.workoutCount, 0);
    const spanStart = shiftDay(
      input.today,
      -WORKOUT_WINDOW_DAYS * (WORKOUT_BASELINE_WINDOWS + 1),
    );
    const historyReaches = input.facts.length > 0 && input.facts[0].date <= spanStart;
    if (historyReaches) {
      const baseline = Array.from({ length: WORKOUT_BASELINE_WINDOWS }, (_, index) =>
        countIn(shiftDay(yesterday, -WORKOUT_WINDOW_DAYS * (index + 1))),
      );
      const center = median(baseline);
      if (center >= WORKOUT_BASELINE_MIN_PER_WINDOW) {
        ready.push("workout_frequency");
        const current = countIn(yesterday);
        const cut = center * (0.5 / (1 + bumpOf(preference("workout_frequency"))));
        if (current <= cut) {
          candidates.push({
            category: "workout_frequency",
            key: `anomaly:workout_frequency:${input.weekStart}`,
            title: "Training frequency is below its usual level",
            message: `${current} workout${current === 1 ? "" : "s"} in the last ${WORKOUT_WINDOW_DAYS} days, against a typical ${round(center, 0)} for that span.`,
            clinicianNote: false,
          });
        }
      }
    }
  }

  // 5. A spending category well above its usual weekly range. Weekly totals
  //    absorb the weekday cycle — the seasonal handling the data supports.
  if (!muted("spending")) {
    const weekTotal = (end: DayKey, category: string) =>
      window(end, 7).reduce((sum, fact) => sum + (fact.spendByCategory[category] ?? 0), 0);
    const categories = new Set<string>();
    for (const fact of input.facts) {
      for (const category of Object.keys(fact.spendByCategory)) categories.add(category);
    }
    let anyReady = false;
    for (const category of [...categories].sort()) {
      const baseline = Array.from({ length: SPEND_BASELINE_WEEKS }, (_, index) =>
        weekTotal(shiftDay(yesterday, -7 * (index + 1)), category),
      );
      const activeWeeks = baseline.filter((total) => total > 0).length;
      if (activeWeeks < SPEND_BASELINE_MIN_ACTIVE_WEEKS) continue;
      anyReady = true;
      const center = median(baseline);
      const spread = Math.max(scaledMad(baseline), center * 0.1);
      const threshold = center + (SPEND_BASE_K + bumpOf(preference("spending"))) * spread;
      const current = weekTotal(yesterday, category);
      if (current > threshold && current >= center * SPEND_MIN_RATIO) {
        candidates.push({
          category: "spending",
          key: `anomaly:spending:${category}:${input.weekStart}`,
          title: `${category.charAt(0).toUpperCase()}${category.slice(1)} spend above its usual range`,
          message: `${formatCents(current)} in the last 7 days against a typical ${formatCents(center)} a week.`,
          clinicianNote: false,
        });
      }
    }
    if (anyReady) ready.push("spending");
  }

  // The hard weekly budget: already-delivered signals drop first (they were
  // counted when they fired), then everything past the budget is dropped —
  // candidates are in priority order (health, behaviour, money).
  const fresh = candidates.filter((signal) => !input.deliveredKeys.has(signal.key));
  const budget = Math.max(0, ANOMALY_WEEKLY_LIMIT - input.deliveredThisWeek);
  return { signals: fresh.slice(0, budget), observations: candidates, ready };
}

/** The one clinician sentence — brief, once, without alarm. */
export const CLINICIAN_NOTE =
  "If it stays this way, a clinician is the right person to interpret it.";
