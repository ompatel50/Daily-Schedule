import { type DayKey, weekdayOf } from "@/lib/date";
import {
  CORRELATION_FDR,
  CORRELATION_WINDOW_DAYS,
  MAX_DOMINANT_SHARE,
  MIN_PAIRED_OBSERVATIONS,
  type CorrelationStrength,
  benjaminiHochberg,
  dominantShare,
  median,
  spearman,
  strengthOf,
} from "@/lib/logic/correlations";
import type { DailyFact } from "@/lib/logic/daily-facts";
import { average } from "@/lib/utils";

/**
 * Spending triggers — the finance-specific correlation pass, built on the
 * same daily fact layer and held to the SAME statistical bar as the general
 * correlation insights (30-pair floor, Spearman ρ as effect size,
 * Benjamini–Hochberg across everything tested, no imputation, dominance
 * guard). See src/lib/logic/correlations.ts for those rules; this module
 * reuses its statistics rather than re-deriving them.
 *
 * What is specific here:
 *
 *  * **Category level, not just totals.** Spend in each qualifying category
 *    is tested separately — dining moving with the weekend says something
 *    the total hides. Categories qualify by activity (see the constants),
 *    so the tested set stays explicit and bounded rather than category ×
 *    context exploding.
 *  * **A tracked-history gate.** A zero-spend day is only a real
 *    observation for someone who actually records money here. Until the
 *    window holds `SPENDING_TRACKED_MIN_DAYS` days with any transaction,
 *    the report is `untracked` and nothing is computed — the all-zero
 *    caveat documented in daily-facts.ts, enforced.
 *  * **Documented omissions.** Time-of-day is not a context: the ledger
 *    stores dates, and an entry's timestamp measures when it was typed in,
 *    not when the money moved. "Travel days" have no signal either — no
 *    schema field marks one — so neither is tested rather than proxied
 *    badly.
 *  * **Descriptive and neutral.** The description helpers report what the
 *    numbers were, in correlational language. No moralising about
 *    spending, no savings advice — this app is not a financial advisor,
 *    and nothing rendered from here may present it as one.
 */

/** Days with at least one transaction required before spending analysis
 * treats a quiet day as "spent nothing" rather than "doesn't track money". */
export const SPENDING_TRACKED_MIN_DAYS = 10;

/** A category joins the tested set once it has spending on this many days
 * in the window — and never on fewer than the dominance guard allows (a
 * series that is > `MAX_DOMINANT_SHARE` zeros carries no evidence, so
 * qualifying it would only waste a comparison). See `qualifyingFloor`. */
export const SPENDING_CATEGORY_MIN_ACTIVE_DAYS = 8;

/** At most this many categories are tested (by total spend, descending),
 * keeping the comparison count bounded and the correction meaningful. */
export const SPENDING_CATEGORY_LIMIT = 5;

// --- contexts -----------------------------------------------------------------

export interface SpendingContext {
  key: string;
  /** Sentence-position name. */
  label: string;
  href: string;
  kind: "continuous" | "binary";
  groups?: { high: string; low: string };
  format: (value: number) => string;
  extract: (fact: DailyFact) => number | null;
}

/**
 * THE context set — every day-level circumstance spending is tested
 * against, in one place.
 */
export const SPENDING_CONTEXTS = {
  density: {
    key: "density",
    label: "planned time",
    href: "/planner",
    kind: "continuous",
    format: (value: number) => `${Math.round(value)} min`,
    extract: (fact) => fact.plannedMinutes,
  },
  trainingDay: {
    key: "trainingDay",
    label: "training days",
    href: "/workouts",
    kind: "binary",
    groups: { high: "training", low: "rest" },
    format: (value: number) => `${value}`,
    extract: (fact) =>
      fact.dayType === "training" ? 1 : fact.dayType === "rest" ? 0 : null,
  },
  sleep: {
    key: "sleep",
    label: "sleep",
    href: "/health",
    kind: "continuous",
    format: (value: number) => `${Math.round(value * 10) / 10} h`,
    extract: (fact) => fact.sleepHours,
  },
  weekend: {
    key: "weekend",
    label: "weekends",
    href: "/calendar",
    kind: "binary",
    groups: { high: "weekend", low: "weekday" },
    format: (value: number) => `${value}`,
    extract: (fact) => {
      const weekday = weekdayOf(fact.date);
      return weekday === 0 || weekday === 6 ? 1 : 0;
    },
  },
  mealsLogged: {
    key: "mealsLogged",
    label: "days with meals logged",
    href: "/nutrition",
    kind: "binary",
    groups: { high: "meals-logged", low: "no-meals-logged" },
    format: (value: number) => `${value}`,
    extract: (fact) => (fact.mealCount > 0 ? 1 : 0),
  },
} as const satisfies Record<string, SpendingContext>;

export type SpendingContextKey = keyof typeof SPENDING_CONTEXTS;

// --- report shapes ------------------------------------------------------------

export interface SpendingTarget {
  key: string;
  /** "all spending" or one category. */
  category: string | null;
  label: string;
}

export type SpendingSplit =
  | {
      kind: "binary";
      highLabel: string;
      lowLabel: string;
      highMeanCents: number;
      lowMeanCents: number;
      highDays: number;
      lowDays: number;
    }
  | {
      kind: "median";
      threshold: number;
      highMeanCents: number;
      lowMeanCents: number;
      highDays: number;
      lowDays: number;
    };

export interface SpendingFinding {
  context: SpendingContextKey;
  target: SpendingTarget;
  n: number;
  rho: number;
  p: number;
  q: number;
  direction: "positive" | "negative";
  strength: CorrelationStrength;
  split: SpendingSplit;
}

export interface SpendingReport {
  /** True when the window lacks enough ledger days to analyse at all. */
  untracked: boolean;
  /** Days in the window with at least one transaction. */
  trackedDays: number;
  findings: SpendingFinding[];
  /** Context × target pairs still short of the observation floor. */
  pending: Array<{ context: SpendingContextKey; target: SpendingTarget; n: number; needed: number }>;
  /** Pairs tested — the correction's m. */
  tested: number;
  /** Category labels that qualified for testing this window. */
  categories: string[];
  from: DayKey;
  to: DayKey;
  windowDays: number;
}

// --- the engine ---------------------------------------------------------------

export function computeSpendingReport(
  facts: DailyFact[],
  window: { from: DayKey; to: DayKey },
): SpendingReport {
  const base = {
    from: window.from,
    to: window.to,
    windowDays: CORRELATION_WINDOW_DAYS,
  };

  const trackedDays = facts.filter((fact) => fact.transactionCount > 0).length;
  if (trackedDays < SPENDING_TRACKED_MIN_DAYS) {
    return {
      ...base,
      untracked: true,
      trackedDays,
      findings: [],
      pending: [],
      tested: 0,
      categories: [],
    };
  }

  // Qualifying categories: active often enough, largest spend first.
  const activeDays = new Map<string, number>();
  const totals = new Map<string, number>();
  for (const fact of facts) {
    for (const [category, cents] of Object.entries(fact.spendByCategory)) {
      if (cents <= 0) continue;
      activeDays.set(category, (activeDays.get(category) ?? 0) + 1);
      totals.set(category, (totals.get(category) ?? 0) + cents);
    }
  }
  const floor = qualifyingFloor(facts.length);
  const categories = [...activeDays.entries()]
    .filter(([, days]) => days >= floor)
    .sort((a, b) => (totals.get(b[0]) ?? 0) - (totals.get(a[0]) ?? 0))
    .slice(0, SPENDING_CATEGORY_LIMIT)
    .map(([category]) => category);

  const targets: Array<SpendingTarget & { extract: (fact: DailyFact) => number }> = [
    {
      key: "total",
      category: null,
      label: "spending",
      extract: (fact) => fact.spendCents,
    },
    ...categories.map((category) => ({
      key: `category:${category}`,
      category,
      label: `${category} spend`,
      extract: (fact: DailyFact) => fact.spendByCategory[category] ?? 0,
    })),
  ];

  interface Tested {
    context: SpendingContextKey;
    target: SpendingTarget;
    xs: number[];
    ys: number[];
    rho: number;
    p: number;
  }
  const tested: Tested[] = [];
  const pending: SpendingReport["pending"] = [];

  for (const contextKey of Object.keys(SPENDING_CONTEXTS) as SpendingContextKey[]) {
    const context = SPENDING_CONTEXTS[contextKey];
    for (const target of targets) {
      const xs: number[] = [];
      const ys: number[] = [];
      for (const fact of facts) {
        const x = context.extract(fact);
        if (x === null) continue; // missing context stays missing
        xs.push(x);
        ys.push(target.extract(fact));
      }
      if (xs.length < MIN_PAIRED_OBSERVATIONS) {
        pending.push({
          context: contextKey,
          target: { key: target.key, category: target.category, label: target.label },
          n: xs.length,
          needed: MIN_PAIRED_OBSERVATIONS - xs.length,
        });
        continue;
      }
      const { rho, p } =
        dominantShare(xs) > MAX_DOMINANT_SHARE || dominantShare(ys) > MAX_DOMINANT_SHARE
          ? { rho: 0, p: 1 }
          : spearman(xs, ys);
      tested.push({
        context: contextKey,
        target: { key: target.key, category: target.category, label: target.label },
        xs,
        ys,
        rho,
        p,
      });
    }
  }

  const qValues = benjaminiHochberg(tested.map((entry) => entry.p));
  const findings: SpendingFinding[] = [];
  for (let index = 0; index < tested.length; index += 1) {
    const entry = tested[index];
    const q = qValues[index];
    if (q > CORRELATION_FDR) continue; // suppressed, never hedged
    findings.push({
      context: entry.context,
      target: entry.target,
      n: entry.xs.length,
      rho: Math.round(entry.rho * 100) / 100,
      p: entry.p,
      q,
      direction: entry.rho >= 0 ? "positive" : "negative",
      strength: strengthOf(entry.rho),
      split: splitOf(SPENDING_CONTEXTS[entry.context], entry.xs, entry.ys),
    });
  }
  findings.sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho));

  return {
    ...base,
    untracked: false,
    trackedDays,
    findings,
    pending,
    tested: tested.length,
    categories,
  };
}

/**
 * Active days a category needs before it is tested: the fixed minimum, or
 * enough that its zero days stay inside the dominance guard — whichever is
 * larger. Keeps the qualification and the guard from contradicting each
 * other (a category that qualifies but could never pass the guard would
 * only dilute the correction).
 */
export function qualifyingFloor(factDays: number): number {
  return Math.max(
    SPENDING_CATEGORY_MIN_ACTIVE_DAYS,
    Math.ceil(factDays * (1 - MAX_DOMINANT_SHARE)),
  );
}

function splitOf(context: SpendingContext, xs: number[], ys: number[]): SpendingSplit {
  if (context.kind === "binary") {
    const high = ys.filter((_, index) => xs[index] === 1);
    const low = ys.filter((_, index) => xs[index] !== 1);
    return {
      kind: "binary",
      highLabel: context.groups?.high ?? "yes",
      lowLabel: context.groups?.low ?? "no",
      highMeanCents: average(high),
      lowMeanCents: average(low),
      highDays: high.length,
      lowDays: low.length,
    };
  }
  const threshold = median(xs);
  const high = ys.filter((_, index) => xs[index] >= threshold);
  const low = ys.filter((_, index) => xs[index] < threshold);
  return {
    kind: "median",
    threshold,
    highMeanCents: average(high),
    lowMeanCents: low.length > 0 ? average(low) : Number.NaN,
    highDays: high.length,
    lowDays: low.length,
  };
}

// --- description helpers (neutral, correlational, never advisory) -------------

/** "Dining spend and weekends moved together". */
export function describeSpendingFinding(finding: SpendingFinding): string {
  const context = SPENDING_CONTEXTS[finding.context];
  const label = finding.target.label;
  const capitalized = label.charAt(0).toUpperCase() + label.slice(1);
  return `${capitalized} and ${context.label} ${
    finding.direction === "positive" ? "moved together" : "moved in opposite directions"
  }`;
}

/** Group means in currency — what the numbers were, nothing more. */
export function describeSpendingSplit(
  finding: SpendingFinding,
  formatMoney: (cents: number) => string,
): string | null {
  const context = SPENDING_CONTEXTS[finding.context];
  const split = finding.split;
  if (split.kind === "binary") {
    return `Your ${finding.target.label} averaged ${formatMoney(split.highMeanCents)} on ${split.highLabel} days (${split.highDays}) and ${formatMoney(split.lowMeanCents)} on ${split.lowLabel} days (${split.lowDays}).`;
  }
  if (split.lowDays === 0 || !Number.isFinite(split.lowMeanCents)) return null;
  return `On days with ${context.label} at ${context.format(split.threshold)} or more (${split.highDays}), your ${finding.target.label} averaged ${formatMoney(split.highMeanCents)}; below that (${split.lowDays}), ${formatMoney(split.lowMeanCents)}.`;
}

/** "ρ = −0.38 (moderate) · 85 paired days · last 180 days". */
export function describeSpendingEvidence(finding: SpendingFinding, windowDays: number): string {
  const sign = finding.rho >= 0 ? "+" : "−";
  return `ρ = ${sign}${Math.abs(finding.rho).toFixed(2)} (${finding.strength}) · ${finding.n} paired days · last ${windowDays} days`;
}
