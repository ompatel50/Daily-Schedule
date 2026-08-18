import type { DayKey } from "@/lib/date";
import { DELIVERY_WINDOW_MS, type ReminderOccurrence } from "@/lib/logic/reminders";

/**
 * The daily digest — one push that makes a once-a-day cron worth having.
 *
 * A hosted deployment's scheduler may fire a single time per day, which the
 * minute-window push runner was never designed for: a 7:30 habit reminder
 * only pushes if the cron happens to land inside its half-hour window. The
 * digest is the honest answer: whatever the run's timing, it summarizes
 * EVERYTHING still ahead in the user's coming operational day — timed
 * reminders with their clock times, due items with their phrasing, threshold
 * alerts — as one notification. Deployments with a frequent external
 * scheduler still get the precise pushes; the digest then simply lists what
 * the morning holds, once.
 *
 * Pure: the runner hands in the schedule-aware feed (already stripped of
 * everything delivered, completed, resting or suppressed) and claims the
 * digest's own ledger key. Nothing here re-decides schedule questions.
 */

/** The ledger key that makes the digest itself exactly-once per day. */
export function digestKey(date: DayKey): string {
  return `digest:${date}`;
}

export interface DailyDigest {
  title: string;
  body: string;
  /** How many occurrences the digest describes (lines may be capped). */
  count: number;
}

/** Body lines beyond this fold into a trailing "…and N more". */
const MAX_LINES = 6;
/** A line longer than this is cut — push payloads are for glancing. */
const MAX_LINE_CHARS = 90;

/** Wall-clock strings carry no zone; instants end in Z or an offset. */
const INSTANT_PATTERN = /[zZ]$|[+-]\d{2}:\d{2}$/;

function clip(line: string): string {
  return line.length <= MAX_LINE_CHARS ? line : `${line.slice(0, MAX_LINE_CHARS - 1)}…`;
}

/** HH:mm of an instant on the user's clock, not the server's. */
function instantTime(fireAtIso: string, timezone: string): string | null {
  const ms = Date.parse(fireAtIso);
  if (Number.isNaN(ms)) return null;
  try {
    return new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: timezone,
    }).format(ms);
  } catch {
    return null;
  }
}

/** The kinds whose fire time is a real clock time worth showing. */
const TIMED_KINDS: ReadonlySet<ReminderOccurrence["kind"]> = new Set([
  "reminder",
  "habit",
  "goal",
]);

export interface DigestInput {
  /** IANA timezone, for rendering instant-typed fire times. */
  timezone: string;
  /** The moment of the run (epoch ms) — bounds which instants belong to today. */
  nowMs: number;
}

/**
 * Build the digest from today's feed, or return null when there is nothing
 * to say — an empty digest is noise, not information.
 *
 * Selection: every wall-clock occurrence belongs — the feed is built for the
 * user's current operational day by construction (including the small-hours
 * items whose fireAt carries the next calendar date). Classic reminders are
 * the exception: they carry a real instant that may sit days ahead — the
 * feed deliberately does not date-filter them — so an instant belongs iff it
 * is still deliverable now or fires within the next 24 hours.
 */
export function buildDailyDigest(
  occurrences: readonly ReminderOccurrence[],
  input: DigestInput,
): DailyDigest | null {
  const dayAheadMs = input.nowMs + 24 * 60 * 60 * 1000;

  const today: { line: string; sortKey: string }[] = [];
  for (const occurrence of occurrences) {
    let time: string | null = null;
    if (INSTANT_PATTERN.test(occurrence.fireAt)) {
      const ms = Date.parse(occurrence.fireAt);
      if (Number.isNaN(ms)) continue;
      if (ms < input.nowMs - DELIVERY_WINDOW_MS || ms > dayAheadMs) continue;
      time = instantTime(occurrence.fireAt, input.timezone);
    } else {
      time = occurrence.fireAt.slice(11, 16);
    }

    // Timed kinds read as an agenda ("07:30 Stretch"); due items and alerts
    // already carry their own phrasing ("Bill due today · $1,200") — a 9:00
    // stamp on those would be an implementation detail, not information.
    const line = TIMED_KINDS.has(occurrence.kind)
      ? clip(`${time ? `${time} ` : ""}${occurrence.title}`)
      : clip(`${occurrence.title} — ${occurrence.message ?? "due today"}`);
    today.push({ line, sortKey: `${TIMED_KINDS.has(occurrence.kind) ? "0" : "1"}:${time ?? "99:99"}` });
  }

  if (today.length === 0) return null;

  // Agenda first in clock order, then due items and alerts.
  today.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  const lines = today.slice(0, MAX_LINES).map((entry) => entry.line);
  if (today.length > MAX_LINES) {
    lines.push(`…and ${today.length - MAX_LINES} more`);
  }

  return {
    title:
      today.length === 1 ? "Your day ahead: 1 reminder" : `Your day ahead: ${today.length} reminders`,
    body: lines.join("\n"),
    count: today.length,
  };
}
