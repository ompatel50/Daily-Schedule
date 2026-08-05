# The operational day

Personal OS does not force a day to end at midnight. A **daily reset time**
(default **4:00 AM**, configurable in Settings → Profile & preferences)
defines the *operational day*:

* Wednesday's operational day begins Wednesday at 4:00 AM and ends
  immediately before Thursday at 4:00 AM.
* Thursday at 1:00 AM still belongs to *Wednesday's* schedule.
* Thursday at 4:00 AM starts *Thursday's* schedule.

Two rules make this safe:

1. **Timestamps never change.** An event at Thursday 1:00 AM always displays
   Thursday 1:00 AM. The reset only changes which day it is *grouped* under.
2. **Only genuinely time-of-day data regroups.** Date-only records already
   store the day they belong to; the reset changes which day key *new* writes
   default to, nothing historical.

## The setting

* Stored as `User.dayResetMinute` — minutes after midnight, `240` = 4:00 AM.
* Additive schema change; existing users and restored backups get the 4:00 AM
  default. The value rides along in backups (`exportedUser` +
  `SAFE_PROFILE_FIELDS`), with no backup format bump — an older app restoring
  a newer backup simply ignores the field.
* Valid range: midnight (`0`, the historic behaviour) through 6:00 AM
  (`360`). Bounded so "yesterday" can never swallow a working morning.
* Resolved **in the user's configured timezone**, never the server's.

## One implementation

`src/lib/logic/operational-day.ts` is the single authority:

| Function | Answers |
| --- | --- |
| `operationalDayOf(instant, tz, reset)` | Which operational date is this instant? |
| `currentOperationalDay(tz, reset, now?)` | What is "today"? (`now` injectable for tests) |
| `operationalDayWindow(day, tz, reset)` | The real start/end instants of a day |
| `isBeforeReset(instant, tz, reset)` | Is this the after-midnight tail? |
| `operationalDayOfRecord({date, startMinute}, reset)` | Which day does a planner record belong to? |
| `belongsToOperationalDay` / `operationalDayDates` / `operationalDayWhere` / `operationalRangeWhere` | Query building |
| `calendarDateForOperationalTime(day, minute, reset)` | Write path: where "1:00 AM on day D" is stored |
| `operationalSortMinute(minute, reset)` | Sort/render position on the extended axis (1:00 AM → 1500) |
| `operationalWallClock(day, minute, reset)` | The real wall-clock a reminder minute names |
| `formatResetTime` / `groupedWithDayHint` | Display |

`scheduleSettingsFor(user)` (src/server/schedule.ts) produces
`settings.today` as the operational date, so every read model, server action
and assistant tool that injects `ScheduleSettings` — which is all of them —
agrees on what "today" is. Nothing else may compute it.

DST is handled by resolving wall clocks with the existing two-pass
`wallClockToInstant`: the operational day containing a spring-forward jump is
23 real hours, fall-back is 25, and neighbouring windows always meet exactly.

## What uses the operational day

* **Planner** — grouping, day navigation, day/week/month views, the day
  score, `CalendarDaySummary` rollups, rollover, routines, quick add. Writes
  treat the incoming date as the operational day and store the true calendar
  date (`calendarDateForOperationalTime`); after-midnight rows render with
  "Grouped with Wednesday because your day resets at 4:00 AM."
* **Habits** — logging defaults, due/done/missed status, streaks, weekly
  progress, `get_habit_status`. A habit logged at 1:00 AM lands on the
  previous operational day *unless the user explicitly picked a date*, which
  is always respected.
* **Today / Dashboard / Calendar / Insights** — via `settings.today` and the
  summaries table.
* **Assistant** — the system prompt states the operational date as
  server-resolved fact ("treat it as the current day even in the small
  hours") plus explicit guidance for scheduling after-midnight times; tools
  default their ranges to it. The model never computes "today" itself.
* **Tasks / documents / bills** — "due today" style eligibility.

## What deliberately keeps calendar-day semantics

* **Reminders fire at their real times.** A 1:00 AM reminder fires at
  1:00 AM, dated its true calendar date (`operationalWallClock`) — never
  delayed to the reset. Only date eligibility and grouping are operational.
* **Finance** — transactions are date-only bank records; they never move.
* **Apple Health imports** — every raw timestamp and Apple-computed daily
  aggregate keeps the day Apple assigned it (sleep already belongs to the
  morning you woke up on, Apple's own rule). App-*generated* summaries
  (day scores, calendar rollups) group by operational day.
* **Insights trailing-window facts** (`src/server/facts.ts`) — aggregate
  trends over weeks, where a one-record shift at the boundary is noise.

## Testing

`tests/operational-day.test.ts` pins the boundary with fixed instants and
explicit timezones (midnight/3:59/4:00, New York DST both directions,
Kolkata's half-hour offset, reset changes, reminder wall clocks);
`tests/integration/operational-day.test.ts` pins the storage round trip
against real PostgreSQL. Integration suites resolve "today" via
`scheduleSettingsFor` so a CI run inside the reset window (it happened)
agrees with the app.
