import type { DayKey } from "@/lib/date";
import type { DayStatus } from "@/lib/logic/schedule";

/**
 * The day score, and — just as importantly — the reason it is what it is.
 *
 * One service, consumed by the Dashboard ring, the Today header, the calendar
 * detail and Insights, so those four can never disagree about the same date.
 *
 * ## What the score is
 *
 * The share of the day's *applicable opportunities* that were met. An
 * opportunity is applicable only if the schedule engine says the item really
 * applied on that date. Everything else — rest days, unscheduled items,
 * cancelled and excused occurrences, disabled goals, future dates, optional
 * tasks — is excluded and listed with its reason, rather than quietly counted
 * as a failure.
 *
 * ## What the score is not
 *
 * It is not a number out of thin air. Every category reports the points it
 * earned out of the points it offered, and every excluded record says why it
 * was excluded. A day with nothing scheduled scores `null` ("open day"), not 0.
 */

export const SCORE_CATEGORIES = ["planner", "habits", "goals"] as const;
export type ScoreCategory = (typeof SCORE_CATEGORIES)[number];

export const SCORE_CATEGORY_META: Record<ScoreCategory, { label: string; description: string }> = {
  planner: {
    label: "Planner",
    description: "Required items scheduled on this day",
  },
  habits: {
    label: "Habits",
    description: "Habits whose schedule places them on this day",
  },
  goals: {
    label: "Goals",
    description: "Goals active on this day, including nutrition, training and health targets",
  },
};

/**
 * Nutrition, training and health deliberately do not get their own categories.
 * In this app they *are* goals — "160 g of protein", "45 workout minutes",
 * "10,000 steps" — so scoring them separately would count the same record
 * twice. Anything the user wants scored, they express as a goal.
 */

export type OpportunityKind = "binary" | "partial";

export interface ScoreOpportunity {
  id: string;
  label: string;
  category: ScoreCategory;
  kind: OpportunityKind;
  /** 0–1 credit earned toward this opportunity. */
  credit: number;
  /** True when the opportunity was fully met. */
  met: boolean;
  /** True when it is still open (today, not yet done). */
  pending: boolean;
  status: DayStatus;
  /** One line explaining this row, e.g. "120 of 160 g · 75%". */
  detail: string;
}

export interface ScoreExclusion {
  id: string;
  label: string;
  category: ScoreCategory;
  /** Machine-readable reason so the UI can group them. */
  reason: ExclusionReason;
  /** Human-readable reason, shown verbatim. */
  detail: string;
}

export const EXCLUSION_REASONS = [
  "rest_day",
  "not_scheduled",
  "future",
  "cancelled",
  "excused",
  "disabled",
  "optional",
  "no_data",
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export const EXCLUSION_LABELS: Record<ExclusionReason, string> = {
  rest_day: "Rest day",
  not_scheduled: "Not scheduled",
  future: "Upcoming",
  cancelled: "Cancelled",
  excused: "Excused",
  disabled: "Turned off",
  optional: "Optional",
  no_data: "Not logged",
};

export interface CategoryScore {
  category: ScoreCategory;
  label: string;
  weight: number;
  applicable: number;
  completed: number;
  /** Opportunities with credit strictly between 0 and 1. */
  partial: number;
  missed: number;
  pending: number;
  pointsEarned: number;
  pointsAvailable: number;
  /** 0–100, or null when the category had no applicable opportunity. */
  percent: number | null;
  opportunities: ScoreOpportunity[];
  explanation: string;
}

export interface DayScore {
  date: DayKey;
  /**
   * 0–100, or null when nothing applied. Null means "open day", which is not
   * the same as scoring zero and must never be averaged in as zero.
   */
  score: number | null;
  hasApplicable: boolean;
  categories: CategoryScore[];
  exclusions: ScoreExclusion[];
  totals: {
    applicable: number;
    completed: number;
    partial: number;
    missed: number;
    pending: number;
    excluded: number;
    pointsEarned: number;
    pointsAvailable: number;
  };
  /** How the number was arrived at, in one sentence. */
  explanation: string;
  weights: Record<ScoreCategory, number>;
}

export interface ScoreWeights {
  planner?: number;
  habits?: number;
  goals?: number;
}

export interface ScoreInput {
  date: DayKey;
  opportunities: ScoreOpportunity[];
  exclusions: ScoreExclusion[];
  /**
   * Optional user-configured weights. Omitted or empty means every category
   * that has something applicable is weighted equally — the default, because
   * it needs no explanation beyond that sentence.
   */
  weights?: ScoreWeights | null;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Parse stored weights. Anything malformed falls back to equal weighting
 * rather than producing a silently wrong score.
 */
export function parseScoreWeights(raw: string | null | undefined): ScoreWeights | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    const weights: ScoreWeights = {};
    let any = false;
    for (const category of SCORE_CATEGORIES) {
      const value = Number(parsed[category]);
      if (Number.isFinite(value) && value >= 0) {
        weights[category] = value;
        any = true;
      }
    }
    return any ? weights : null;
  } catch {
    return null;
  }
}

/** Weights must add up to 100 for the explanation to be honest. */
export function validateScoreWeights(weights: ScoreWeights): {
  valid: boolean;
  total: number;
  message: string | null;
} {
  const total = SCORE_CATEGORIES.reduce((sum, category) => sum + (weights[category] ?? 0), 0);
  if (Math.abs(total - 100) < 0.01) return { valid: true, total, message: null };
  return {
    valid: false,
    total,
    message: `Weights add up to ${Math.round(total)}%. They need to total 100%.`,
  };
}

export function computeDayScore(input: ScoreInput): DayScore {
  const byCategory = new Map<ScoreCategory, ScoreOpportunity[]>();
  for (const category of SCORE_CATEGORIES) byCategory.set(category, []);
  for (const opportunity of input.opportunities) {
    byCategory.get(opportunity.category)?.push(opportunity);
  }

  // Only categories with something applicable participate. A category with
  // nothing scheduled must not drag the score down — that is the difference
  // between "you missed it" and "there was nothing to miss".
  const participating = SCORE_CATEGORIES.filter(
    (category) => (byCategory.get(category)?.length ?? 0) > 0,
  );

  const weights = resolveWeights(participating, input.weights ?? null);

  const categories: CategoryScore[] = SCORE_CATEGORIES.map((category) => {
    const opportunities = byCategory.get(category) ?? [];
    const weight = weights[category];

    const completed = opportunities.filter((opportunity) => opportunity.met).length;
    const partial = opportunities.filter(
      (opportunity) => !opportunity.met && opportunity.credit > 0,
    ).length;
    const pending = opportunities.filter(
      (opportunity) => opportunity.pending && !opportunity.met,
    ).length;
    const missed = opportunities.filter(
      (opportunity) => !opportunity.met && !opportunity.pending,
    ).length;

    const earned = opportunities.reduce(
      (total, opportunity) => total + clamp01(opportunity.credit),
      0,
    );
    const available = opportunities.length;
    const percent = available === 0 ? null : Math.round((earned / available) * 100);

    return {
      category,
      label: SCORE_CATEGORY_META[category].label,
      weight,
      applicable: available,
      completed,
      partial,
      missed,
      pending,
      pointsEarned: Math.round(earned * 100) / 100,
      pointsAvailable: available,
      percent,
      opportunities,
      explanation: explainCategory(category, available, completed, partial, pending, percent),
    };
  });

  const hasApplicable = participating.length > 0;

  const weighted = categories.reduce((total, category) => {
    if (category.percent === null) return total;
    return total + (category.percent / 100) * category.weight;
  }, 0);
  const totalWeight = categories.reduce(
    (total, category) => total + (category.percent === null ? 0 : category.weight),
    0,
  );

  const score = !hasApplicable || totalWeight === 0 ? null : Math.round((weighted / totalWeight) * 100);

  const totals = {
    applicable: categories.reduce((sum, category) => sum + category.applicable, 0),
    completed: categories.reduce((sum, category) => sum + category.completed, 0),
    partial: categories.reduce((sum, category) => sum + category.partial, 0),
    missed: categories.reduce((sum, category) => sum + category.missed, 0),
    pending: categories.reduce((sum, category) => sum + category.pending, 0),
    excluded: input.exclusions.length,
    pointsEarned: Math.round(categories.reduce((sum, c) => sum + c.pointsEarned, 0) * 100) / 100,
    pointsAvailable: categories.reduce((sum, category) => sum + category.pointsAvailable, 0),
  };

  return {
    date: input.date,
    score,
    hasApplicable,
    categories,
    exclusions: input.exclusions,
    totals,
    explanation: explainDay(score, totals, categories, input.weights ?? null),
    weights,
  };
}

/**
 * Equal weighting across participating categories by default. If the user has
 * configured weights, they are honoured — but a category with nothing
 * applicable still contributes nothing, so the remaining weights are
 * renormalised rather than silently shrinking the score.
 */
function resolveWeights(
  participating: ScoreCategory[],
  configured: ScoreWeights | null,
): Record<ScoreCategory, number> {
  const weights = {} as Record<ScoreCategory, number>;

  if (configured) {
    for (const category of SCORE_CATEGORIES) weights[category] = configured[category] ?? 0;
    const participatingTotal = participating.reduce(
      (sum, category) => sum + (weights[category] ?? 0),
      0,
    );
    // All configured weight landed on categories with nothing applicable —
    // fall back to equal rather than dividing by zero.
    if (participatingTotal > 0) return weights;
  }

  const share = participating.length === 0 ? 0 : 100 / participating.length;
  for (const category of SCORE_CATEGORIES) {
    weights[category] = participating.includes(category) ? share : 0;
  }
  return weights;
}

function explainCategory(
  category: ScoreCategory,
  applicable: number,
  completed: number,
  partial: number,
  pending: number,
  percent: number | null,
): string {
  if (applicable === 0) {
    return `Nothing applicable — ${SCORE_CATEGORY_META[category].label.toLowerCase()} did not affect this score.`;
  }
  const parts = [`${completed} of ${applicable} met`];
  if (partial > 0) parts.push(`${partial} partly done`);
  if (pending > 0) parts.push(`${pending} still open`);
  return `${parts.join(" · ")} — ${percent}%`;
}

function explainDay(
  score: number | null,
  totals: DayScore["totals"],
  categories: CategoryScore[],
  configured: ScoreWeights | null,
): string {
  if (score === null) {
    return "Nothing was scheduled for this day, so there is no score. An open day is not a zero.";
  }

  const active = categories.filter((category) => category.percent !== null);
  const weighting =
    configured && active.length > 0
      ? "using your configured category weights"
      : active.length === 1
        ? `from ${active[0].label.toLowerCase()} alone`
        : `weighting ${active.length} categories equally`;

  const excluded =
    totals.excluded > 0
      ? ` ${totals.excluded} item${totals.excluded === 1 ? "" : "s"} were excluded and are listed below.`
      : "";

  return `${score}% — ${totals.completed} of ${totals.applicable} applicable opportunities met, ${weighting}.${excluded}`;
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

/**
 * Calendar day states. Colour alone is never the signal — every state also has
 * a label and an icon so the calendar is readable without relying on hue.
 */
export type CalendarDayState =
  | "completed"
  | "partial"
  | "missed"
  | "rest"
  | "future"
  | "open"
  | "no_data";

export const CALENDAR_STATE_META: Record<
  CalendarDayState,
  { label: string; description: string; icon: string }
> = {
  completed: { label: "Completed", description: "Everything scheduled was done", icon: "CheckCircle2" },
  partial: { label: "Partial", description: "Some of what was scheduled was done", icon: "CircleDashed" },
  missed: { label: "Missed", description: "Scheduled work was not done", icon: "AlertCircle" },
  rest: { label: "Rest day", description: "Scheduled as a rest day", icon: "Moon" },
  future: { label: "Planned", description: "Still upcoming — never a failure", icon: "CalendarClock" },
  open: { label: "Open day", description: "Nothing was scheduled", icon: "Circle" },
  no_data: { label: "No data", description: "Nothing recorded", icon: "Minus" },
};

export function calendarStateFor(params: {
  score: number | null;
  applicable: number;
  completed: number;
  isFuture: boolean;
  hasAnyRecord: boolean;
  isRestDay?: boolean;
}): CalendarDayState {
  if (params.isFuture) return "future";
  if (params.applicable === 0) {
    if (params.isRestDay) return "rest";
    return params.hasAnyRecord ? "open" : "no_data";
  }
  if (params.score === null) return "open";
  if (params.score >= 100 || params.completed === params.applicable) return "completed";
  if (params.score <= 0) return "missed";
  return "partial";
}
