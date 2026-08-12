# Planner overlaps and recurring series

How the planner decides two blocks clash, and how repeating items are stored,
edited, and deleted. This is the reference for the semantics; the
implementation lives in `src/lib/logic/planner.ts` (overlaps),
`src/lib/logic/recurrence.ts` (rules), `src/server/series.ts` (generation)
and `src/server/actions/planner.ts` (the scoped writes).

## Overlap semantics

Two concepts, deliberately separate:

**Exact interval overlap** (`spansOverlap`) is the hard correctness rule.
Blocks are half-open intervals `[start, end)`: the start minute is included,
the end minute is excluded. A block ending at 9:00 AM and a block starting at
9:00 AM are back-to-back — they share no minute, and they never overlap.

**A scheduling conflict** (`isSchedulingConflict`) is the user-facing
double-booking *warning*. It is the exact rule plus a small tolerance,
`CONFLICT_TOLERANCE_MINUTES = 1`: an intersection of one minute or less is
treated as a rounding artefact, not a double booking.

| A          | B           | Exact overlap | Warning |
| ---------- | ----------- | ------------- | ------- |
| 9:00–10:00 | 10:00–11:00 | no            | no      |
| 9:00–10:00 | 9:59–11:00  | yes (1 min)   | no      |
| 9:00–10:00 | 9:58–11:00  | yes (2 min)   | yes     |
| 9:00–10:00 | 9:30–10:30  | yes           | yes     |
| identical  | identical   | yes           | yes     |
| contained  | container   | yes           | yes     |

The tolerance affects **classification only**. Stored start/end times are
never modified, nothing is snapped, and no block is ever moved. A documented
consequence: a block whose entire duration is within the tolerance (a
one-minute block inside another) never warns.

Every warning surface uses the same conflict predicate through
`findConflicts` / `conflictsByItem` / `planMove`: the day-view banner and its
pair count, per-row "Overlaps …" badges, timeline conflict styling, the week
grid's per-day counts and card badges, the month grid's day dots, the
move/"push to tomorrow" confirmations, the edit dialog's live preview
(`previewScheduleItemConflicts`), and the assistant's proposal previews.
Warnings inform; they never block — double-booking yourself is allowed.

Rules the predicate applies before comparing minutes:

- all-day items never conflict;
- an item without both a start and an end has no duration to clash with;
- a **zero-duration point item** (`start === end`) occupies no minutes and
  conflicts with nothing, including blocks that touch or span its minute;
- skipped items are explicitly not happening;
- an item never conflicts with itself.

### Overlaps and the operational day

Conflict detection always compares **real timestamps**. The configurable
daily reset (default 4:00 AM — see `docs/operational-day.md`) only groups
items for display: one operational day holds its own date's `[reset, 24:00)`
plus the next date's `[00:00, reset)`. Those two minute ranges are disjoint,
so comparing raw minutes inside one operational day's list is exactly
equivalent to comparing real instants — a 11:00 PM block and a 1:00 AM block
grouped under the same evening can never falsely conflict, and no math ever
subtracts the reset from a timestamp.

## Recurring series

### Architecture

A series is **materialised**: one *parent* row holds the JSON recurrence rule
and doubles as the first occurrence; each further occurrence is a real
`ScheduleItem` row pointing at the parent via `seriesId`. Everything
downstream — completion, drag & drop, day summaries — works on ordinary rows.

Identity is per-slot. Every generated occurrence records the operational day
it was generated *for* in `originalDate` — its **slot**. Edits and moves
change a row's fields or date but never its slot, which is what makes
regeneration idempotent:

- an edited occurrence (`isException`) still occupies its slot → never
  duplicated;
- a moved occurrence still occupies its *original* slot → the vacated day is
  not refilled;
- a deleted occurrence's slot is recorded in the parent's `skipDates` (a JSON
  list of day keys) → never recreated;
- "delete this and future" truncates the parent's rule itself → the tail
  stops existing in the pattern.

### Active range

- **Start date** (required): the parent's own operational day. Nothing is
  generated before it.
- **End date** (optional, `rule.until`): **inclusive**. If the last day
  matches the pattern, that occurrence exists; nothing exists after it. A
  semester class "Mon/Wed/Fri, Aug 24 – Dec 11" has its last meeting *on*
  Friday Dec 11.
- **No end date**: open-ended series stay open-ended. They are bounded by the
  generation horizon, never by an invented far-future date.

Validation: a malformed rule is rejected (not silently dropped), and an end
date before the start date is refused with a field error.

### Bounded generation

`extendSeriesFor` tops every series up to `HORIZON_DAYS` (120) past today on
each planner open. It is idempotent (slot-set difference, minus `skipDates`)
and it only fills slots from today forward — the routine top-up never
backfills the past. Explicit (re)materialisation — creating a series or
splitting one — fills from the anchor forward, with backfill bounded to
`BACKFILL_LIMIT_DAYS` (366) before today so a mistyped ancient start date
cannot write years of rows. There are no unbounded scans and no unbounded
writes anywhere in the pipeline.

### Edit scopes

Editing an occurrence of a series asks how far the change reaches:

- **This occurrence only** — the row becomes an exception: fields detach,
  the slot stays occupied, every other occurrence is untouched, and
  regeneration cannot overwrite the change. Editing the *first* occurrence
  (the parent row) promotes the next occurrence to series parent first, so
  the series' template is not silently rewritten. Recurrence-rule input is
  ignored on this scope — a one-occurrence edit cannot smuggle in a series
  change.
- **This and all future occurrences** — a *series split*. The old series
  stays authoritative through the day before the selected occurrence (its
  rule gains an `until` there; its history is not touched). The selected
  occurrence becomes the parent of a new series anchored on its day, carrying
  the edited fields and the submitted rule. Plain "planned" future rows are
  re-materialised from the new shape; completed, skipped, or
  individually-edited future rows are preserved as exceptions instead of
  destroyed. This scope is also where recurrence itself changes: pattern
  (daily → Mon/Wed/Fri, weekdays → Tue/Thu), interval, extending or
  shortening the end date, bounded → open-ended, open-ended → bounded, or
  removing recurrence from this point forward.
- **All occurrences** — the long-standing whole-series detail edit: title,
  time, category etc. carry to past and future occurrences alike (exceptions
  keep their edits). Rule changes are not accepted on this scope.

**End-date inheritance:** the edit form pre-fills the recurrence controls —
including *Ends* — from the stored rule, so a split inherits the original end
date unless the user explicitly changes it. Changing only the time of a
bounded semester series keeps it bounded; explicitly choosing *Never* is
respected. The assistant path implements the same rule explicitly: an update
that does not mention the end date inherits it.

### Delete scopes

- **Delete this occurrence** — removes the row and records its slot in the
  parent's `skipDates`; regeneration can never bring it back. Deleting the
  *first* occurrence promotes the next occurrence to parent first (the rule
  holder must not take the series down with it).
- **Delete this and all future occurrences** — terminates the series at the
  selected occurrence: the parent's rule is truncated to the day before, and
  every row from that day on is removed. History stays. From the first
  occurrence there is no history to keep, so the whole series goes.
- **Delete the entire series** — the explicit, long-standing whole-history
  option, kept in the in-app chooser only. The assistant never gets it.

Non-recurring items never see a scope question — edit and delete stay one
step.

### The scope chooser

On save or delete of a recurring item the planner asks the scope explicitly:
a bottom sheet on phones (thumb-height options, safe-area padding, the
selected occurrence's date named, destructive styling only for deletion,
Cancel focused first so no destructive default), a compact centred dialog on
desktop. Same wording and semantics on both. If the recurrence rule itself was
changed, only "this and all future" is offered — that is what a rule change
means.

### Conflict preview when editing

The edit dialog checks the proposed time against the target day as you type,
with the same tolerant rule as every other warning — adjacent blocks stay
quiet, real double bookings name the conflicting items, and the save is never
blocked. For "this and all future", only the edited occurrence's day is
checked; the chooser says that future occurrences are not scanned ahead of
time rather than pretending to know.

### Recurrence and the operational day

Rules expand over **operational days** and each occurrence stores its real
calendar date. "Every Monday at 1:00 AM" means Monday *nights*: the rows
store 1:00 AM on Tuesday calendar dates, group under operational Mondays, and
generate on that same operational axis. Timestamps are never rewritten to
force grouping — the reset only affects which day a row displays under.

### Timezones and DST

Recurrence is wall-clock local time. Rules expand over calendar day keys and
occurrences store minutes-from-midnight, so a 10:00 AM class is at 10:00 AM
local before and after a DST transition — no fixed 24-hour UTC durations are
ever added.

## The assistant

The assistant reads recurrence through `get_schedule` (`recurring` flag plus
a one-line pattern/range summary per block) and writes only through staged
proposals:

- `create_planner_block` accepts an explicit `recurrence` object (pattern,
  weekdays, interval, inclusive `endDate` or none); the preview sentence
  spells out the pattern, start and end. A raw stored rule in the payload is
  refused.
- `update_planner_block` / `delete_planner_block` on a recurring block
  **require** `scope: "one"` or `"future"`. Without one the proposal is
  refused with an instruction to ask the user — ambiguous wording can never
  silently mutate a series. Scope `"one"` refuses recurrence changes
  outright; scope `"future"` inherits the end date unless the payload
  explicitly changes it. The whole-history delete scope does not exist for
  the assistant.

The stored payload is the complete write, scope included — what the
confirmation preview describes is exactly what runs.

## Intentional limitations

- The 1-minute tolerance means a genuine sub-2-minute double booking is
  classified as noise. That is the point of the tolerance; the exact-overlap
  primitive remains available where precision matters.
- "This and future" re-materialises plain planned future occurrences; rows
  you completed, skipped, or edited are preserved as exceptions with their
  old details rather than restyled to the new shape.
- A future split replaces future plain occurrences of the old series,
  including days the old pattern had but the new one does not.
- The routine horizon top-up never backfills the past; only an explicit
  create or split materialises history, bounded to a year back.
- `rule.count` ("stop after N occurrences") is supported by the engine but
  not exposed in the UI; end dates are the supported way to bound a series.
- Occurrence rows written before the slot column existed derive their slot
  from their current date; if such a row had been *moved* across days under
  the old code, its original slot is unknown and could refill on
  regeneration. New moves always pin the slot.
