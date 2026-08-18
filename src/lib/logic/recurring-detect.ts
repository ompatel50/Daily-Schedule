import { daysBetween, shiftDay, shiftMonth, type DayKey } from "@/lib/date";
import { isBookkeepingCategory } from "@/lib/enums";
import { moneyRound } from "@/lib/logic/finance";

/**
 * Recurring-cost detection — pure. Scans a user's spending history for
 * same-payee, similar-amount, regular-cadence patterns and shapes each one as
 * a "track this as a bill" suggestion, pre-filled for the Bills model.
 *
 * The bar to clear, per payee:
 *   · money out only; never bookkeeping rows, transfer legs, or rows already
 *     settling a bill (those ARE tracked);
 *   · amounts within a tolerance of the payee's median (±15%, floor $2) —
 *     "Netflix went up a dollar" still matches, "the same store twice" not;
 *   · one occurrence per day (a double charge is one event);
 *   · every gap between occurrences inside ONE cadence's tolerance:
 *     weekly 7±2, monthly 28–33±drift (26–36), yearly 365±15;
 *   · at least three occurrences for weekly/monthly, two for yearly (a third
 *     yearly occurrence would mean waiting two years to suggest anything).
 *
 * The caller owns persistence: dismissed payees and payees already covered by
 * a bill are filtered outside. Everything here is arithmetic over rows.
 */

export type RecurringCadence = "weekly" | "monthly" | "yearly";

export interface RecurringCandidateRow {
  accountId: string;
  date: DayKey;
  /** Signed; only negative rows are considered. */
  amount: number;
  payee: string | null;
  category: string;
  billId: string | null;
  transferGroupId: string | null;
}

export interface RecurringSuggestion {
  /** Normalised (trimmed, lowercased) payee — the dismissal key. */
  payeeKey: string;
  /** The payee as most recently written — what the bill gets named. */
  payee: string;
  cadence: RecurringCadence;
  /** The typical charge (median magnitude), positive. */
  amount: number;
  /** Occurrences that matched. */
  count: number;
  lastDate: DayKey;
  /** Where the next occurrence should land — the bill's first due date. */
  nextDueDate: DayKey;
  /** The most recent occurrence's account. */
  accountId: string;
  /** The most common category among the matched rows. */
  category: string;
}

const CADENCES: Array<{
  cadence: RecurringCadence;
  minGap: number;
  maxGap: number;
  minOccurrences: number;
}> = [
  { cadence: "weekly", minGap: 5, maxGap: 9, minOccurrences: 3 },
  { cadence: "monthly", minGap: 26, maxGap: 36, minOccurrences: 3 },
  { cadence: "yearly", minGap: 350, maxGap: 380, minOccurrences: 2 },
];

/** Advance one cadence step, keeping monthly on its day-of-month. */
function stepForward(date: DayKey, cadence: RecurringCadence): DayKey {
  if (cadence === "weekly") return shiftDay(date, 7);
  if (cadence === "monthly") return shiftMonth(date, 1);
  return shiftMonth(date, 12);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * All recurring suggestions in `rows`, strongest first (more occurrences,
 * then bigger amounts). `today` anchors the suggested next due date: it never
 * lands in the past, however stale the history is.
 */
export function detectRecurringCosts(
  rows: RecurringCandidateRow[],
  today: DayKey,
): RecurringSuggestion[] {
  const byPayee = new Map<string, RecurringCandidateRow[]>();
  for (const row of rows) {
    if (row.amount >= 0) continue;
    if (row.billId !== null || row.transferGroupId !== null) continue;
    if (isBookkeepingCategory(row.category)) continue;
    const payee = row.payee?.trim();
    if (!payee) continue;
    const key = payee.toLowerCase();
    const bucket = byPayee.get(key);
    if (bucket) bucket.push(row);
    else byPayee.set(key, [row]);
  }

  const suggestions: RecurringSuggestion[] = [];

  for (const [payeeKey, bucket] of byPayee) {
    if (bucket.length < 2) continue;

    // Similar amounts: keep rows near the payee's median magnitude.
    const magnitudes = bucket.map((row) => Math.abs(row.amount));
    const typical = median(magnitudes);
    const tolerance = Math.max(2, typical * 0.15);
    const similar = bucket.filter((row) => Math.abs(Math.abs(row.amount) - typical) <= tolerance);

    // One occurrence per day, oldest first.
    const byDate = new Map<DayKey, RecurringCandidateRow>();
    for (const row of similar) {
      if (!byDate.has(row.date)) byDate.set(row.date, row);
    }
    const occurrences = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    if (occurrences.length < 2) continue;

    const gaps = occurrences
      .slice(1)
      .map((row, index) => daysBetween(occurrences[index].date, row.date));

    const fit = CADENCES.find(
      ({ minGap, maxGap, minOccurrences }) =>
        occurrences.length >= minOccurrences &&
        gaps.every((gap) => gap >= minGap && gap <= maxGap),
    );
    if (!fit) continue;

    const last = occurrences[occurrences.length - 1];
    let nextDueDate = stepForward(last.date, fit.cadence);
    // A stale history still suggests a FUTURE first due date (bounded walk —
    // even years of staleness converge in a handful of yearly steps).
    for (let step = 0; nextDueDate < today && step < 400; step += 1) {
      nextDueDate = stepForward(nextDueDate, fit.cadence);
    }

    const categoryCounts = new Map<string, number>();
    for (const row of occurrences) {
      categoryCounts.set(row.category, (categoryCounts.get(row.category) ?? 0) + 1);
    }
    const category =
      [...categoryCounts.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
      )[0]?.[0] ?? "other";

    suggestions.push({
      payeeKey,
      payee: last.payee?.trim() ?? payeeKey,
      cadence: fit.cadence,
      amount: moneyRound(typical),
      count: occurrences.length,
      lastDate: last.date,
      nextDueDate,
      accountId: last.accountId,
      category,
    });
  }

  return suggestions.sort(
    (a, b) => b.count - a.count || b.amount - a.amount || a.payeeKey.localeCompare(b.payeeKey),
  );
}
