import { type DayKey, shiftDay } from "@/lib/date";
import type { DailyFact } from "@/lib/logic/daily-facts";
import { average, round } from "@/lib/utils";

/**
 * Correlation insights over the daily fact layer — the statistical core,
 * kept pure so every honesty rule is unit-testable.
 *
 * The rules this module enforces (they are requirements, not preferences):
 *
 *  * **Explicit candidate set.** Only the pairs in `CORRELATION_CANDIDATES`
 *    are ever tested — never everything against everything. Adding a pair is
 *    a code change that also grows the multiple-comparison correction below.
 *  * **Minimum sample.** A pair with fewer than `MIN_PAIRED_OBSERVATIONS`
 *    paired days is not tested at all; it surfaces as "not enough data yet",
 *    never as a weak insight.
 *  * **Effect size, not just direction.** Spearman's ρ is reported on every
 *    finding, with a plain-language strength band.
 *  * **Multiple comparisons.** Benjamini–Hochberg across every pair actually
 *    tested; a finding surfaces only when its q-value clears
 *    `CORRELATION_FDR`. Suppressed findings are suppressed — not shown with
 *    hedging copy.
 *  * **Missing data stays missing.** A day where either variable is null is
 *    dropped from that pair. Nothing is imputed, ever.
 *  * **Correlational language only.** The description helpers phrase every
 *    finding as an association in the user's own data with its sample size
 *    and window; nothing here suggests causation or prescribes behaviour.
 *
 * Spearman (rank) correlation is used throughout: it measures monotonic
 * association without assuming normality, is robust to outliers (spend and
 * volume days are heavy-tailed), and reduces to a rank point-biserial for
 * the binary variables (training day).
 */

/** Paired days required before a pair is tested at all. Below this the pair
 * reports "not enough data yet" — a documented floor, not a magic number. */
export const MIN_PAIRED_OBSERVATIONS = 30;

/** False-discovery rate for the Benjamini–Hochberg correction: a finding
 * surfaces only when its q-value is at or under this. */
export const CORRELATION_FDR = 0.05;

/** How far back the analysis reads. Bounded — the daily path never scans
 * unbounded history — and long enough for seasonal habits to accumulate the
 * observation floor. */
export const CORRELATION_WINDOW_DAYS = 180;

/**
 * A pair is only informative when its values actually vary. When one value
 * accounts for more than this share of either side (say, 47 zero-task days
 * against a single active one), rank correlation degenerates — the single
 * deviating day can read as ρ = ±1 with an absurd p — so such a pair is
 * treated as carrying no evidence at all.
 */
export const MAX_DOMINANT_SHARE = 0.9;

// --- the candidate set --------------------------------------------------------

export type VariableKind = "continuous" | "binary";

export interface CorrelationVariable {
  key: string;
  /** Sentence-position name ("day score", "sleep"). */
  label: string;
  /** Where the underlying data lives, so every insight can link to it. */
  href: string;
  kind: VariableKind;
  /** For binary variables: what 1 and 0 mean, as "<x> days". */
  groups?: { high: string; low: string };
  format: (value: number) => string;
  extract: (fact: DailyFact) => number | null;
}

const hours = (value: number) => `${round(value, 1)} h`;
const count = (value: number) => `${round(value, 1)}`;
const minutes = (value: number) => `${Math.round(value)} min`;
const percent = (value: number) => `${Math.round(value * 100)}%`;
const points = (value: number) => `${Math.round(value)}`;
const kg = (value: number) => `${round(value, 0)} kg`;
const ml = (value: number) => `${Math.round(value)} ml`;
const bpm = (value: number) => `${round(value, 1)} bpm`;

/**
 * Every variable the candidate pairs may reference. Null from `extract`
 * means "not measured that day" and drops the day from the pair.
 */
export const CORRELATION_VARIABLES = {
  sleepHours: {
    key: "sleepHours",
    label: "sleep",
    href: "/health",
    kind: "continuous",
    format: hours,
    extract: (fact) => fact.sleepHours,
  },
  score: {
    key: "score",
    label: "day score",
    href: "/calendar",
    kind: "continuous",
    format: points,
    extract: (fact) => fact.score,
  },
  workoutVolume: {
    key: "workoutVolume",
    label: "training volume",
    href: "/workouts",
    kind: "continuous",
    format: kg,
    // Volume is a performance measure, so it only exists on days that had a
    // workout — a rest day is "not measured", not "lifted zero".
    extract: (fact) => (fact.workoutCount > 0 ? fact.workoutVolumeKg : null),
  },
  trainingDay: {
    key: "trainingDay",
    label: "training days",
    href: "/workouts",
    kind: "binary",
    groups: { high: "training", low: "rest" },
    format: count,
    extract: (fact) =>
      fact.dayType === "training" ? 1 : fact.dayType === "rest" ? 0 : null,
  },
  habitRate: {
    key: "habitRate",
    label: "habit completion",
    href: "/habits",
    kind: "continuous",
    format: percent,
    // No habits due = nothing to complete — unknown, not 0%.
    extract: (fact) => (fact.habitsDue > 0 ? fact.habitsDone / fact.habitsDue : null),
  },
  plannedMinutes: {
    key: "plannedMinutes",
    label: "planned time",
    href: "/planner",
    kind: "continuous",
    format: minutes,
    // A day with no timed blocks genuinely carried zero planned load.
    extract: (fact) => fact.plannedMinutes,
  },
  tasksCompleted: {
    key: "tasksCompleted",
    label: "tasks completed",
    href: "/tasks",
    kind: "continuous",
    format: count,
    extract: (fact) => fact.tasksCompleted,
  },
  targetAdherence: {
    key: "targetAdherence",
    label: "nutrition-target adherence",
    href: "/nutrition",
    kind: "continuous",
    format: percent,
    extract: (fact) => fact.targetAdherence,
  },
  steps: {
    key: "steps",
    label: "steps",
    href: "/health",
    kind: "continuous",
    format: count,
    extract: (fact) => fact.steps,
  },
  activeCalories: {
    key: "activeCalories",
    label: "active calories",
    href: "/health",
    kind: "continuous",
    format: count,
    extract: (fact) => fact.activeCalories,
  },
  hydration: {
    key: "hydration",
    label: "water logged",
    href: "/nutrition",
    kind: "continuous",
    format: ml,
    extract: (fact) => fact.hydrationMl,
  },
  restingHr: {
    key: "restingHr",
    label: "resting heart rate",
    href: "/health",
    kind: "continuous",
    format: bpm,
    extract: (fact) => fact.restingHr,
  },
} as const satisfies Record<string, CorrelationVariable>;

export type CorrelationVariableKey = keyof typeof CORRELATION_VARIABLES;

export interface CorrelationCandidate {
  id: string;
  /** The context variable. */
  x: CorrelationVariableKey;
  /** The outcome-side variable (naming only — the statistic is symmetric). */
  y: CorrelationVariableKey;
  /** Days of lag on x: 1 = yesterday's x against today's y. */
  lag?: number;
}

/**
 * THE candidate set — every association the app will ever test, in one
 * place. Each entry says why it is plausible enough to spend a comparison
 * on; the Benjamini–Hochberg correction runs across however many of these
 * reach the observation floor.
 */
export const CORRELATION_CANDIDATES: readonly CorrelationCandidate[] = [
  // Sleep is credited to the morning it ends, so same-day pairs read
  // "last night's sleep vs today".
  { id: "sleep-score", x: "sleepHours", y: "score" },
  { id: "sleep-volume", x: "sleepHours", y: "workoutVolume" },
  { id: "sleep-habits", x: "sleepHours", y: "habitRate" },
  // Does training move the rest of the day?
  { id: "training-habits", x: "trainingDay", y: "habitRate" },
  { id: "training-score", x: "trainingDay", y: "score" },
  // Planner load vs what actually got done.
  { id: "load-tasks", x: "plannedMinutes", y: "tasksCompleted" },
  { id: "load-score", x: "plannedMinutes", y: "score" },
  // Nutrition adherence vs the energy proxies the fact layer carries.
  { id: "adherence-steps", x: "targetAdherence", y: "steps" },
  { id: "adherence-active", x: "targetAdherence", y: "activeCalories" },
  { id: "hydration-score", x: "hydration", y: "score" },
  // Next-morning effects: yesterday's activity vs tonight's recovery.
  { id: "steps-sleep-next", x: "steps", y: "sleepHours", lag: 1 },
  { id: "training-sleep-next", x: "trainingDay", y: "sleepHours", lag: 1 },
  { id: "training-rhr-next", x: "trainingDay", y: "restingHr", lag: 1 },
];

// --- results ------------------------------------------------------------------

export type CorrelationStrength = "weak" | "moderate" | "strong";

/** How the paired sample splits, for the descriptive sentence. Both halves
 * come from the same paired observations the statistic used. */
export type CorrelationSplit =
  | {
      kind: "binary";
      highLabel: string;
      lowLabel: string;
      highMean: number;
      lowMean: number;
      highDays: number;
      lowDays: number;
    }
  | {
      kind: "median";
      threshold: number;
      highMean: number;
      lowMean: number;
      highDays: number;
      lowDays: number;
    };

export interface CorrelationFinding {
  id: string;
  x: CorrelationVariableKey;
  y: CorrelationVariableKey;
  lag: number;
  n: number;
  /** Spearman's ρ — the effect size. */
  rho: number;
  p: number;
  /** Benjamini–Hochberg adjusted. */
  q: number;
  direction: "positive" | "negative";
  strength: CorrelationStrength;
  split: CorrelationSplit;
}

export interface PendingPair {
  id: string;
  x: CorrelationVariableKey;
  y: CorrelationVariableKey;
  lag: number;
  n: number;
  needed: number;
}

export interface CorrelationReport {
  /** Significant findings only, strongest first. */
  findings: CorrelationFinding[];
  /** Pairs below the observation floor — the honest "not yet" state. */
  pending: PendingPair[];
  /** Pairs that reached the floor and were tested (the correction's m). */
  tested: number;
  from: DayKey;
  to: DayKey;
  windowDays: number;
}

// --- the engine ---------------------------------------------------------------

export function computeCorrelations(
  facts: DailyFact[],
  window: { from: DayKey; to: DayKey },
): CorrelationReport {
  const byDate = new Map(facts.map((fact) => [fact.date, fact]));

  interface Tested {
    candidate: CorrelationCandidate;
    xs: number[];
    ys: number[];
    rho: number;
    p: number;
  }
  const tested: Tested[] = [];
  const pending: PendingPair[] = [];

  for (const candidate of CORRELATION_CANDIDATES) {
    const xVariable = CORRELATION_VARIABLES[candidate.x];
    const yVariable = CORRELATION_VARIABLES[candidate.y];
    const lag = candidate.lag ?? 0;
    const xs: number[] = [];
    const ys: number[] = [];
    for (const fact of facts) {
      const xFact = lag === 0 ? fact : byDate.get(shiftDay(fact.date, -lag));
      if (!xFact) continue;
      const x = xVariable.extract(xFact);
      const y = yVariable.extract(fact);
      // Either side missing drops the day — missing stays missing.
      if (x === null || y === null) continue;
      xs.push(x);
      ys.push(y);
    }

    if (xs.length < MIN_PAIRED_OBSERVATIONS) {
      pending.push({
        id: candidate.id,
        x: candidate.x,
        y: candidate.y,
        lag,
        n: xs.length,
        needed: MIN_PAIRED_OBSERVATIONS - xs.length,
      });
      continue;
    }

    // A near-constant side carries no evidence (see MAX_DOMINANT_SHARE);
    // the pair stays in the tested set at p = 1 — counted by the correction,
    // never surfaced.
    const { rho, p } =
      dominantShare(xs) > MAX_DOMINANT_SHARE || dominantShare(ys) > MAX_DOMINANT_SHARE
        ? { rho: 0, p: 1 }
        : spearman(xs, ys);
    tested.push({ candidate, xs, ys, rho, p });
  }

  const qValues = benjaminiHochberg(tested.map((entry) => entry.p));

  const findings: CorrelationFinding[] = [];
  for (let index = 0; index < tested.length; index += 1) {
    const { candidate, xs, ys, rho, p } = tested[index];
    const q = qValues[index];
    // Fails significance → suppressed outright, never hedged.
    if (q > CORRELATION_FDR) continue;
    const xVariable = CORRELATION_VARIABLES[candidate.x];
    findings.push({
      id: candidate.id,
      x: candidate.x,
      y: candidate.y,
      lag: candidate.lag ?? 0,
      n: xs.length,
      rho: round(rho, 2),
      p,
      q,
      direction: rho >= 0 ? "positive" : "negative",
      strength: strengthOf(rho),
      split: splitOf(xVariable, xs, ys),
    });
  }

  findings.sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho));

  return {
    findings,
    pending,
    tested: tested.length,
    from: window.from,
    to: window.to,
    windowDays: CORRELATION_WINDOW_DAYS,
  };
}

function strengthOf(rho: number): CorrelationStrength {
  const size = Math.abs(rho);
  if (size >= 0.6) return "strong";
  if (size >= 0.35) return "moderate";
  return "weak";
}

/** Descriptive group means over the SAME pairs the statistic used. */
function splitOf(
  xVariable: CorrelationVariable,
  xs: number[],
  ys: number[],
): CorrelationSplit {
  if (xVariable.kind === "binary") {
    const high = ys.filter((_, index) => xs[index] === 1);
    const low = ys.filter((_, index) => xs[index] !== 1);
    return {
      kind: "binary",
      highLabel: xVariable.groups?.high ?? "yes",
      lowLabel: xVariable.groups?.low ?? "no",
      highMean: average(high),
      lowMean: average(low),
      highDays: high.length,
      lowDays: low.length,
    };
  }
  const threshold = median(xs);
  const high = ys.filter((_, index) => xs[index] >= threshold);
  const low = ys.filter((_, index) => xs[index] < threshold);
  // With every x below the median equal to it (heavy ties), "low" can be
  // empty; the description layer falls back to the correlation line alone.
  return {
    kind: "median",
    threshold,
    highMean: average(high),
    lowMean: low.length > 0 ? average(low) : Number.NaN,
    highDays: high.length,
    lowDays: low.length,
  };
}

/** The share of the sample taken by its most common value. */
function dominantShare(values: number[]): number {
  if (values.length === 0) return 1;
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Math.max(...counts.values()) / values.length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

// --- statistics ---------------------------------------------------------------

/**
 * Spearman rank correlation with average-rank tie handling; the p-value is
 * the standard two-tailed t approximation on n − 2 degrees of freedom (the
 * same approximation scipy uses). Degenerate inputs (n < 3, or a constant
 * series) report ρ = 0, p = 1 — no variation is no evidence.
 */
export function spearman(xs: number[], ys: number[]): { rho: number; p: number; n: number } {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return { rho: 0, p: 1, n };
  const rx = ranks(xs.slice(0, n));
  const ry = ranks(ys.slice(0, n));
  const rho = pearson(rx, ry);
  if (!Number.isFinite(rho)) return { rho: 0, p: 1, n };
  const clamped = Math.max(-0.999999, Math.min(0.999999, rho));
  const t = clamped * Math.sqrt((n - 2) / (1 - clamped * clamped));
  const p = twoTailedTProbability(Math.abs(t), n - 2);
  return { rho, p, n };
}

/** Average ranks (1-based); ties share the mean of their positions. */
function ranks(values: number[]): number[] {
  const order = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value);
  const result = new Array<number>(values.length);
  let position = 0;
  while (position < order.length) {
    let end = position;
    while (end + 1 < order.length && order[end + 1].value === order[position].value) end += 1;
    const rank = (position + end) / 2 + 1;
    for (let index = position; index <= end; index += 1) result[order[index].index] = rank;
    position = end + 1;
  }
  return result;
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  const meanX = average(xs);
  const meanY = average(ys);
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (let index = 0; index < n; index += 1) {
    const dx = xs[index] - meanX;
    const dy = ys[index] - meanY;
    covariance += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }
  if (varianceX === 0 || varianceY === 0) return Number.NaN;
  return covariance / Math.sqrt(varianceX * varianceY);
}

/** P(|T| ≥ t) for Student's t with `df` degrees of freedom, via the
 * regularized incomplete beta function: 2-tailed p = I_{df/(df+t²)}(df/2, ½). */
export function twoTailedTProbability(t: number, df: number): number {
  if (df <= 0) return 1;
  const x = df / (df + t * t);
  return Math.min(1, regularizedIncompleteBeta(x, df / 2, 0.5));
}

/**
 * Regularized incomplete beta I_x(a, b) by the standard continued-fraction
 * expansion (Numerical Recipes' betacf, modified Lentz). Accurate to ~1e-10
 * over the arguments the t-distribution produces.
 */
export function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const logBeta =
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const front = Math.exp(logBeta);
  // The continued fraction converges fastest for x < (a+1)/(a+b+2); use the
  // symmetry I_x(a,b) = 1 − I_{1−x}(b,a) on the other side.
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betaContinuedFraction(x, a, b)) / a;
  }
  return 1 - (Math.exp(logBeta) * betaContinuedFraction(1 - x, b, a)) / b;
}

function betaContinuedFraction(x: number, a: number, b: number): number {
  const EPSILON = 1e-12;
  const TINY = 1e-30;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let result = d;
  for (let m = 1; m <= 200; m += 1) {
    // Even step.
    let numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1 + numerator * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + numerator / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    result *= d * c;
    // Odd step.
    numerator = (-(a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + numerator * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + numerator / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    result *= delta;
    if (Math.abs(delta - 1) < EPSILON) break;
  }
  return result;
}

/** Lanczos log-gamma (g = 7, n = 9), the standard double-precision fit. */
function logGamma(z: number): number {
  const COEFFICIENTS = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    // Reflection for the small arguments the t-CDF can produce (a = ½).
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  const shifted = z - 1;
  let sum = COEFFICIENTS[0];
  for (let index = 1; index < COEFFICIENTS.length; index += 1) {
    sum += COEFFICIENTS[index] / (shifted + index);
  }
  const t = shifted + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(sum);
}

/**
 * Benjamini–Hochberg adjusted p-values (q-values), preserving input order.
 * q_i = min over j ranked at or above i of p_(j) · m / j, capped at 1.
 */
export function benjaminiHochberg(pValues: number[]): number[] {
  const m = pValues.length;
  if (m === 0) return [];
  const order = pValues
    .map((p, index) => ({ p, index }))
    .sort((a, b) => a.p - b.p);
  const adjusted = new Array<number>(m);
  let running = 1;
  for (let rank = m; rank >= 1; rank -= 1) {
    const { p, index } = order[rank - 1];
    running = Math.min(running, (p * m) / rank);
    adjusted[index] = running;
  }
  return adjusted;
}

// --- description helpers (correlational language ONLY) ------------------------

/** "moved together" / "moved in opposite directions" — never causal verbs. */
export function directionPhrase(finding: CorrelationFinding): string {
  return finding.direction === "positive" ? "moved together" : "moved in opposite directions";
}

/** The headline: "Sleep and day score moved together (next day)". */
export function describeFinding(finding: CorrelationFinding): string {
  const x = CORRELATION_VARIABLES[finding.x];
  const y = CORRELATION_VARIABLES[finding.y];
  const lagNote = finding.lag > 0 ? " the next day" : "";
  return `${capitalize(x.label)} and ${y.label}${lagNote} ${directionPhrase(finding)}`;
}

/**
 * The descriptive sentence: group means over the same paired days, stated
 * as what the numbers were — never what the user should do.
 */
export function describeSplit(finding: CorrelationFinding): string | null {
  const x = CORRELATION_VARIABLES[finding.x];
  const y = CORRELATION_VARIABLES[finding.y];
  const split = finding.split;
  const when = finding.lag > 0 ? "following" : "on";
  if (split.kind === "binary") {
    return `Your ${y.label} averaged ${y.format(split.highMean)} ${when} ${split.highLabel} days (${split.highDays}) and ${y.format(split.lowMean)} ${when} ${split.lowLabel} days (${split.lowDays}).`;
  }
  if (split.lowDays === 0 || !Number.isFinite(split.lowMean)) return null;
  return `${capitalize(when)} days ${finding.lag > 0 ? "after" : "with"} ${x.label} at ${x.format(split.threshold)} or more (${split.highDays}), your ${y.label} averaged ${y.format(split.highMean)}; below that (${split.lowDays}), ${y.format(split.lowMean)}.`;
}

/** "ρ = +0.42 (moderate) · 58 paired days · last 180 days". */
export function describeEvidence(finding: CorrelationFinding, windowDays: number): string {
  const sign = finding.rho >= 0 ? "+" : "−";
  return `ρ = ${sign}${Math.abs(finding.rho).toFixed(2)} (${finding.strength}) · ${finding.n} paired days · last ${windowDays} days`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
