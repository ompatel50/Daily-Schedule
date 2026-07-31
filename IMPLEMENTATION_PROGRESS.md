# Personal OS — Preview 3 Upgrade: Implementation Progress

> Living document. Updated after every completed phase. If you are resuming this
> work in a new session, **read this file first**, then run
> `git log --oneline -12 && npm test`.

**Branch:** `claude/personal-os-preview-3-upgrade-msj3sz` (this session's assigned branch, started from `main` after PR #6 merged; carries Phase 11 onward)

> Note on branch naming: the task text asked for `feature/personal-os-preview-3`.
> The session environment mandates development and pushes on a
> session-assigned `claude/…` branch, and pushing anywhere else is prohibited.
> All work therefore lives on the designated branch, which serves the same
> purpose (an isolated feature branch off `main`). Phases 0–6 and 15a were done
> on `claude/personal-os-preview-3-y6pmoe` (PR #3, merge commit `f8391d0`);
> Phase 7 and the first part of Phase 8 on
> `claude/personal-os-preview-3-upgrade-1gw0gt` (PR #4, merge commit `d92670e`);
> the rest of Phase 8 on `claude/personal-os-phase-8-or6v6y` (PR #5, merge
> commit `01bc4a8`). All have been merged into `main`. Phase 9 restarts that
> same branch from the merged `main`, because a merged pull request cannot
> track new work.

**Last stable commit:** Phase 10 — the live workout session (see the Phase 10 section).

---

## Phase checklist

| #  | Phase                                              | Status |
|----|----------------------------------------------------|--------|
| 0  | Repository audit + safety                          | ✅ done |
| 1  | Database & migration design                        | ✅ done |
| 2  | Central date & schedule engine                     | ✅ done |
| 3  | Scheduled goals                                    | ✅ done |
| 4  | Scheduled habits                                   | ✅ done |
| 5  | Explainable day-score engine                       | ✅ done |
| 6  | Calendar & insights corrections                    | ✅ done |
| 7  | Planner duplicate prevention & recurrence          | ✅ done |
| 15a| Backup coverage for the new tables (pulled forward) | ✅ done |
| 8  | Dashboard / Today / Planner separation             | ✅ done |
| 9  | Nutrition provider architecture & food search      | ✅ done (providers built + tested against fixtures; **no live API call was possible** — see below) |
| 10 | Workout session system                             | ✅ done |
| 11 | Health imports & health metrics                    | ✅ done |
| 12 | Demo-data separation & onboarding                  | ✅ done |
| 13 | Reminders                                          | ✅ done |
| 14 | Search & command palette                           | ✅ done |
| 15 | Backup & import updates                            | ✅ done |
| 16 | Accessibility, responsiveness, performance         | ✅ done |
| 17 | Full testing & polish                              | ✅ done |

**Current phase:** — the Preview 3 master upgrade checklist is **complete**.
See "What remains deliberately open" at the end of this file for the honest
list of known limits and deferred improvements.

**The task's stated highest-priority milestone is complete** (central schedule
engine, scheduled goals, scheduled habits, rest-day behaviour, streaks, day
score, calendar/insights consistency). Phase 7 closed the last outstanding bug
from the Phase 0 audit, Phase 8 has given Dashboard, Today and Planner one job
each, Phase 9 has replaced the bundled-only food table with a provider
architecture, Phase 10 has given workouts a real session, and Phase 11 has
built the private health-metric system: one aggregation module, a `/health`
page, and a staged Apple Health / CSV import with fingerprint dedup and
removable batches. Everything from Phase 12 on is still outstanding and the
app remains on its pre-upgrade implementations for those areas — see "What is
NOT done" below, which is deliberately explicit so nothing reads as finished
when it is not.

---

## Phase 0 — Repository audit

### Stack

| Concern | Finding |
|---|---|
| Framework | Next.js `15.5.22`, App Router, React `19.2.0` |
| Language | TypeScript 5.9, `strict: true` |
| Package manager | npm |
| Database | SQLite via Prisma `6.19.3` (`prisma/dev.db`, gitignored) |
| Migration system | **None — `prisma db push` only.** No `prisma/migrations/` directory. |
| Seed | `prisma/seed.ts` via `tsx` |
| Date library | `date-fns` v4 |
| State | Server Components + server actions; `zustand` for UI-only state |
| Validation | `zod` v3 (`src/lib/validation.ts`) |
| Styling | Tailwind 3.4 + CSS variables, `next-themes` |
| Components | Radix primitives wrapped shadcn-style in `src/components/ui/*` |
| Charts | `recharts` v3 |
| Testing | `vitest` v4, node env, `tests/**/*.test.ts` |
| API routes | **None.** All mutations are server actions. |
| Backup | `src/server/actions/backup.ts` + `src/lib/backup-format.ts` (JSON) |
| Notifications | `src/components/shared/reminder-watcher.tsx` (browser Notification API) |

### Duplicated logic found (the core problem)

1. `isHabitDue` — habit-only applies-on-date. **Removed in Phase 4.**
2. `matchesRule`/`expandRule` — planner-item recurrence. Still present, still used
   by the planner (a genuinely different problem: materialised occurrences).
3. `scoreDay` — the day-score formula. **Removed in Phase 5.**
4. **A hand-copied duplicate of the score formula inlined in `prisma/seed.ts`.**
   **Removed in Phase 5** — the seed now calls the real `rebuildSummaries`.
5. Completion counting duplicated between `recomputeDay` and `getDayOverview`.
   **Unified in Phase 5.**
6. `computeStreaks` — walked calendar days, treated weekly habits as daily.
   **Removed in Phase 4.**
7. `scoreTone` — the score's colour bands, hand-copied into the dashboard, Today
   and the calendar day detail. **Two removed in Phase 8 (first part), the third
   in Phase 8 (this part);** one definition now lives in
   `src/components/shared/day-score-card.tsx`.
8. The editable day list itself — Today and `/planner?view=day` rendered the same
   `DaySchedule` with no reason to prefer either. **Resolved in Phase 8:** still
   one component, now with a declared posture per surface.

### Bugs confirmed by reading the code, and their status

| Bug | Status |
|---|---|
| Goals had no schedule at all — "workout Mon/Tue/Thu/Fri" unrepresentable | ✅ fixed (Phase 3) |
| `weekly` habits were "due" every day → the `3 of 7` bug | ✅ fixed (Phase 4) |
| `skipped` silently protected a streak; no `excused` state existed | ✅ fixed (Phase 4) |
| Score divided by all planner items and returned 0 for an untracked day | ✅ fixed (Phase 5) |
| No score explanation anywhere | ✅ fixed (Phase 5) |
| `Goal` unique on `(userId, domain, metric, period)` blocked two workout goals | ✅ fixed (Phase 1) |
| Timezone stored but never used; `today()` used the host clock | ✅ fixed **server-side** (Phase 6); the display/navigation helpers were still on the host clock and are fixed for Dashboard / Today / Planner / Calendar / topbar in Phase 8 — see "What is NOT done" #11 for the rest |
| `workoutMinuteGoal = weeklyGoal * 45 / 7` — an invented constant | ✅ removed (Phase 5) |
| `applyScheduleTemplate` had no duplicate protection | ✅ fixed (Phase 7) |
| Today, the Dashboard and the Planner were three views of the same editable day | ✅ fixed (Phase 8) |
| The Today page rendered the title "Yesterday" when the host and user timezones disagreed | ✅ fixed (Phase 8) |

### Safety steps performed

* Repository confirmed: `/home/user/Daily-Schedule`, remote `ompatel50/daily-schedule`.
* Working tree was **clean** at session start; nothing stashed, reset or discarded.
* **Development database backup taken before any schema change:**
  `prisma/dev.db` → `<scratchpad>/dev.db.baseline`.
  *Restore:* stop the dev server, then `cp <scratchpad>/dev.db.baseline prisma/dev.db`.
  The portable equivalent for real users is Settings → Backup (JSON export).
* Schema changes verified non-destructive against the seeded database: all 7
  goals, 8 habits, 390 habit logs, 663 schedule items, 172 meals and 48 workouts
  survived `prisma db push`.
* **Phase 7 repeated this before touching the schema again:** `prisma/dev.db` →
  `<scratchpad>/dev.db.phase7-baseline`, row counts recorded before and after
  `prisma db push --accept-data-loss`, and confirmed identical across all ten
  tables checked. No force-push or history rewrite in this session either.
* `prisma/dev.db` is gitignored and confirmed not staged. No `.env`, key, or
  health export is tracked.
* No force-push, no history rewrite, no destructive git command was run.

---

## Architectural decisions

1. **No `prisma migrate`; `prisma db push` + an idempotent data-backfill script.**
   The project never had a migrations directory and the DB is a local SQLite file
   the user owns; `migrate dev` would risk offering to reset it. Schema changes
   are **additive only** (new tables, new nullable/defaulted columns), applied
   with `npm run db:push`, followed by `npm run db:migrate` which runs re-runnable
   backfills from `prisma/migrations-data/`. Verified idempotent: the second run
   reports "nothing to do".

2. **One polymorphic schedule system, not per-entity schedule tables.** The spec
   sketched eight tables (`GoalSchedule`, `GoalScheduleVersion`, … plus habit
   twins). That would need two parallel copies of identical logic — the exact
   duplication this upgrade exists to remove. Instead: `ScheduleRule`,
   `ScheduleRuleDay`, `ScheduleOverride`, keyed by `(ownerType, ownerId)`.

3. **Effective-dated schedule versions.** Editing a schedule closes the current
   rule (`effectiveTo` = the day before) and opens a new one. A past date keeps
   resolving against the rule that was actually in force then, so historical
   scores and streaks do not silently change. "Recalculate all history" exists but
   must be chosen explicitly and says what it will do.

4. **Legacy habit recurrence columns are demoted to derived mirrors.**
   `Habit.frequency` / `weekdays` / `targetPerWeek` are still written on save so
   pre-upgrade backups still restore and the raw DB stays readable, but nothing
   reads them for scheduling.

5. **Nutrition, training and health are scored *as goals*, not as separate score
   categories.** In this app they already are goals ("160 g protein", "45 workout
   minutes"). A separate category would count the same record twice, which the
   spec explicitly forbids. Score categories are therefore planner / habits /
   goals.

6. **`server-only` moved from the computation modules to the app-facing surface.**
   The guard now sits on `src/server/queries.ts` and `src/server/actions/*`, which
   are what pages import. `facts` / `schedule` / `goals` / `habits` / `day-score` /
   `summaries` are a shared computation layer, so the seed script can call the
   *real* aggregation instead of maintaining a transcription of it.

7. **`score` is `null`, not `0`, when nothing applied.** `CalendarDaySummary`
   carries `scoreApplicable` next to `score` so that distinction survives the
   cache; every average filters on it.

8. **Routine idempotency is a database constraint, not just a check.** (Phase 7)
   Every row a routine writes carries `sourceKey` — `<application ordinal>:<row
   index>` — and `ScheduleItem` is unique on
   `(userId, date, templateId, sourceKey)`. The action reads the day first and
   decides what to do; the constraint is the last line of defence for a
   double-submit that races that read. Because SQLite treats NULLs as distinct
   in a unique index, ordinary non-routine items (`templateId` null) are
   completely unaffected — verified directly against the database.

   A **deliberate** second copy is still possible: it takes the next ordinal, so
   `2:0`, `2:1`, … never collide with the first application. This is why the key
   is an ordinal-plus-index rather than a plain row hash — "no accidental
   doubles" and "the user may double it on purpose" are different requirements
   and both had to hold.

9. **Overlap detection warns; it never blocks.** (Phase 7) Double-booking is
   sometimes deliberate, and a badge that fires on back-to-back meetings gets
   ignored within a day. All-day items, items without a real duration,
   zero-length items, endpoint-touching ranges and skipped items are all
   excluded. A *completed* item still counts, because it did occupy the time.

10. **Surface responsibilities are data, not prose.** (Phase 8) The split
    between Dashboard, Today and Planner is declared once in
    `src/lib/logic/surfaces.ts` — an ownership table plus a per-surface
    capability record — and read by the pages, the day list, the row menu, the
    edit dialog, the sidebar and the command palette. A design decision written
    only in a document drifts the first time someone adds a button; one the
    components read, and that a test asserts is unambiguous, does not.

11. **One day list with two postures, not two day lists.** (Phase 8) Today and
    the Planner render the same `DaySchedule` against the same server actions;
    a `surface` prop selects which affordances it offers. Forking it would have
    been the shortest path and would have recreated exactly the duplication this
    upgrade exists to remove. The same flag (`seriesActions`) rides through
    `ScheduleRow` and `ScheduleItemDialog`.

12. **A summary may repeat a fact; it may not repeat an interaction.**
    (Phase 8) Three surfaces describing the same day will name some of the same
    numbers — that is what a summary is. The rule applied instead: only one
    surface may let you *change* a given thing, and where a fact appears twice
    it appears at a different altitude with a link to its owner. Hence the
    dashboard's tiles moved to a rolling week with today as the hint, and its
    habit checklist became a read-only list.

13. **The host clock is a fallback, not a source of truth.** (Phase 8) The
    day-relative helpers in `src/lib/date.ts` take the reference day as an
    argument; the surfaces pass the day the server resolved from the user's
    timezone. The host clock remains the default only so the change did not have
    to touch every component at once — see "What is NOT done" for what still
    reads it.

14. **A provider is an interface, and the boundary is the privacy boundary.**
    (Phase 9) `ProviderSearchOptions` has no field through which a meal, a goal,
    a weight or a user id could travel — the privacy property is structural
    rather than a rule someone has to remember. Provider payloads are treated as
    untrusted input in the other direction and clamped by
    `sanitizeNormalizedFood` before anything is persisted.

15. **`null` is the honest answer for a conversion that needs a constant we do
    not have.** (Phase 9) Returning 0, or quietly assuming water's density,
    would produce a number nobody could defend from a UI that looked confident.
    `baseAmountsFor` returns `null`, `canConvert` reports it, the unit is not
    offered, and the action refuses it. Grams are always available where the
    food can be weighed at all, because a scale needs no food-specific constant.

16. **A logged entry is a value, not a view of a food.** (Phase 9) The macros
    were already denormalised; Phase 9 froze the rest — name, basis, serving,
    grams, micronutrients. The test that matters is that a snapshot does not
    move when the food is corrected afterwards.

---

## Database changes

Applied with `prisma db push` (additive only):

**New models**
* `ScheduleRule` — effective-dated schedule version, `(ownerType, ownerId)`.
* `ScheduleRuleDay` — one row per selected weekday (no comma-separated lists).
* `ScheduleOverride` — one-date exception: `rest | excused | activate | cancel | reschedule`.
* `GoalEntry` — manual goal outcome for one date (`done | skipped | excused`).
* `SeedBatch` / `SeedRecord` — demo-data identification by relationship. **Models
  exist; not yet wired to the seed — Phase 12.**

**Changed models**
* `Goal` — added `description`, `targetMax`, `source`, `sourceRef`, `startDate`,
  `endDate`, `archivedAt`, `entries`. **Dropped** the unique constraint on
  `(userId, domain, metric, period)` (replaced with a plain index).
* `User` — added `scoreWeights`, `scoreOptionalTasks`, `onboardingState`,
  and relations to the new tables.
* `CalendarDaySummary` — added `scoreApplicable`, `scoreCompleted`, `scoreMissed`,
  `scorePending`, `scoreExcluded`.
* `Habit` / `HabitLog` — no column changes; documentation only (legacy mirror
  columns, and `excused` added to the accepted `HabitLog.status` values).
* `ScheduleItem` — added `sourceKey` (nullable) and a unique constraint on
  `(userId, date, templateId, sourceKey)`. **Phase 7.** Applied with
  `prisma db push --accept-data-loss`; the flag is required only because Prisma
  warns generically about adding any unique constraint. Verified non-destructive
  on the seeded database — 652 schedule items, 3 routines, 8 habits, 391 habit
  logs, 6 goals, 199 meals, 47 workouts, 14 schedule rules, 28 item tags and 85
  day summaries were identical before and after.

**Data migrations created**
* `prisma/migrations-data/001-schedules.ts` — gives every existing goal an
  every-day rule effective from its creation date (which is how they already
  behaved, so no score changes), and recovers each habit's real recurrence from
  its legacy columns. On the seeded database: 7 goal rules + 8 habit rules
  created, Mon/Wed/Fri and Mon–Fri habits kept their weekdays, the 3×/week habit
  became `times_per_week`. Second run: no-op.
* `prisma/migrations-data/002-template-source-keys.ts` — **Phase 7.** Gives
  routine-applied rows written before the column existed a `sourceKey` of
  `1:<row index>`, grouped by `(user, date, routine)` and ordered by
  `sortOrder`, so a later deliberate copy gets ordinal 2 instead of colliding.
  The seeded database has no routine-applied rows, so it reports "nothing to
  do"; tested separately against six hand-made pre-upgrade rows across two days
  — all six were keyed `1:0 1:1 1:2` per day, and the second run was a no-op.

---

## Files added

```
prisma/migrate-data.ts                        data-migration runner
prisma/migrations-data/001-schedules.ts       schedule backfill
src/lib/logic/schedule.ts                     THE schedule engine (pure)
src/lib/logic/goals.ts                        goal evaluation (pure)
src/lib/logic/day-score.ts                    day score + explanation (pure)
src/server/schedule.ts                        schedule persistence & versioning
src/server/facts.ts                           per-day measurement from real records
src/server/goals.ts                           goal orchestration
src/server/habits.ts                          habit read model
src/server/day-score.ts                       score assembly
src/server/insights.ts                        weekly review
src/server/actions/goals.ts                   goal + override actions
src/components/shared/weekday-picker.tsx      accessible M T W T F S S buttons
src/components/shared/schedule-editor.tsx     shared schedule form
src/components/shared/score-explanation.tsx   "why this score?" panel
src/components/settings/goal-dialog.tsx       full goal editor
src/components/calendar/day-detail.tsx        calendar date detail
tests/schedule.test.ts                        68 tests
tests/goals.test.ts                           23 tests
tests/habits.test.ts                          17 tests
tests/day-score.test.ts                       25 tests

Phase 7:
prisma/migrations-data/002-template-source-keys.ts   sourceKey backfill
src/lib/logic/planner.ts                      routine identity + overlaps (pure)
tests/planner.test.ts                         28 tests

Phase 8:
src/components/shared/day-score-card.tsx      the one day-score card + scoreTone
src/lib/logic/surfaces.ts                     who owns what (pure)
tests/surfaces.test.ts                        17 tests
```

## Files removed

```
src/lib/logic/streaks.ts    superseded by the schedule engine
tests/streaks.test.ts       coverage subsumed by schedule/habit suites
```

`isHabitDue` was removed from `src/lib/logic/recurrence.ts`; `scoreDay` and
`calorieAccuracy` were removed from `src/lib/logic/scoring.ts`.

---

## Commands run

```
npm install
npx prisma generate
npx prisma db push --accept-data-loss   # additive; verified no data loss
npm run db:migrate        # twice — second run is a no-op
npm run db:seed           # twice — planner data does not duplicate
npm run typecheck         # PASS
npm test                  # PASS 483/483
npm run build             # PASS
npm run start             # all 11 routes 200, no server errors
```

## Tests passing

554 tests across 18 files. 474 of them are new to this upgrade and cover
business behaviour, not rendering:

* `tests/health.test.ts` (33) — **Phase 11.** The metric registry covering
  every declared type; unit conversion in and out (kg/lb/g, l/ml/fl oz,
  kJ→kcal, min→h, mi→km) with null — never a guess — for an inexpressible
  unit; cumulative metrics summing within a device and taking the fullest
  device across sources (phone + watch never added together); manual daily
  totals not double-counting with imports; latest-wins weight with legacy
  pound rows converted before comparing; heart-rate min/avg/max; sleep stages
  summing asleep+core+deep+REM and never in-bed or awake, the in-bed
  fallback, and a manual total competing as its own source; interval union
  (overlap, touching, inverted, empty); series charting null not zero for an
  unlogged day; source labels with only Apple Health marked measured;
  manual-entry schema validation; and the privacy pair — no health module
  contains a network call, and the provider search options carry no field a
  health record could travel through.
* `tests/health-import.test.ts` (38) — **Phase 11.** Apple identifier
  mapping; the timestamp format keeping the day as written; XML parsing
  (sources, devices, escaped entities, metadata children, percent-as-fraction
  body fat, unsupported types counted not fatal, invalid records counted with
  warnings, sleep-across-midnight assigned to the waking day, workouts from
  tag attributes and from WorkoutStatistics children); strict CSV parsing
  (quoting, required columns named when missing, `3/4/2026` and `2026-02-30`
  refused, negative and non-numeric values, unsupported units, unknown types
  as unsupported, end-before-start, a CSV forbidden from claiming
  `apple_health`); rollup determinism (per-day-per-device rows, unit
  conversion, HR range, weight rows kept individual, sleep stage unions);
  fingerprints (same file → identical set, overlapping export → same
  identities with fuller values plus only new days, same value at two times →
  two records, externalId preferred, in-file duplicates collapsing, the
  manual namespace); workout duplicate judgement; the ZIP reader (deflate and
  stored entries, missing export.xml, non-zip input) against archives built
  in the test; and file-type detection by magic bytes and content.

* `tests/schedule.test.ts` (68) — every schedule mode; both week starts; DST;
  leap year; month and year boundaries; all five override kinds; effective-dated
  versions; every streak rule; overdue detection; timezone day-key derivation.
* `tests/goals.test.ts` (23) — all five comparisons; partial credit; completion
  sources; the Mon/Tue/Thu/Fri workout goal being neutral on Wednesday; weekly
  goals reporting 3 of 4 / 75% / 1 to go and not failing mid-week.
* `tests/habits.test.ts` (17) — weekday habits excluding the weekend; missed and
  skipped breaking a streak; excused and rest days not; future never missed;
  reminders suppressed on inactive dates.
* `tests/day-score.test.ts` (25) — only applicable items in the denominator;
  rest days excluded; empty day scores null not zero; no divide-by-zero; partial
  progress capped; category and overall totals agreeing; weight validation.
* `tests/backup.test.ts` (12) — format validation, checksums, older/newer format
  handling, and an assertion that export and import both cover every table in
  `BACKUP_TABLES` (so adding a table cannot silently skip one side).
* `tests/planner.test.ts` (28) — source-key round-tripping and rejection of
  malformed keys; ordinals starting at 1, following the highest already present,
  and treating unkeyed pre-upgrade rows as a first application; applying a
  routine to an empty day writing every row; applying it again writing nothing
  and asking instead; keep / replace / duplicate each doing exactly one thing;
  deliberate copies stacking without ever re-using a key; a cleared day
  re-applying cleanly. Plus overlap detection: real overlaps and containment
  found, endpoint-touching and separated blocks not, all-day / zero-length /
  no-duration / skipped items excluded, completed items still counted, one item
  clashing with several, and an empty or single-item day finding nothing.
* `tests/surfaces.test.ts` (17) — **Phase 8.** Every responsibility owned by
  exactly one surface; none unclaimed; none declared outside the known list;
  the three surfaces' owned sets disjoint and together total; execution on
  Today and structure on the Planner; the dashboard owning neither. Plus the
  capability split: every planning affordance true on the planner and false on
  Today, every execution affordance true on Today, completion deliberately kept
  on both, and the two lists together covering each capability exactly once.
  Plus hand-offs: the date travelling to the owning surface, omitted when
  absent, never attached to the dashboard, and the sidebar copy for all three
  surfaces matching the purpose declared in the ownership table.
* `tests/food.test.ts` (84) — **Phase 9.** USDA normalisation (generic vs
  branded, both nutrient row shapes, micronutrients kept, a household measure
  with no weight treated as a label, records with no name or no calories
  dropped); Open Food Facts normalisation (sodium g→mg, micronutrients g→mg,
  kilojoule fallback, salt÷2.5 when sodium is absent, density derived only from
  a serving stated in both ml and grams, sparse records kept but marked, empty
  stubs dropped); serving conversion (per-100 g, per-serving, mass-unit exactness,
  portions with no known weight, **volume rejected without a density**, volume
  allowed once one exists, an explicit assertion that 1 g/ml is never the
  fallback, and that every offered option is one `canConvert` accepts);
  nutrient maths and **historical snapshots** (quantity edits, unit changes,
  and a snapshot staying put when the food is later corrected); completeness;
  identity (two foods with the same name are never merged); ranking (favourites
  and recents first, exact local next, generic over branded, shorter names on
  ties, stable otherwise); sanitising hostile payloads; custom-food validation
  (required name, positive serving, non-negative and finite nutrients, all four
  bases); logging validation; and meal-template application through the
  planner's shared `planTemplateApplication`.
* `tests/food-providers.test.ts` (40) — **Phase 9.** Registry order and
  coverage; the missing-key path (`not_configured`, **no request attempted**, a
  hint naming the variable, whitespace treated as absent); USDA success, and
  failures for 401/403, 429 with `retry-after`, 5xx, a thrown network error, an
  abort, a malformed body, and unusable rows dropped without failing the search;
  ids validated before a request is made; Open Food Facts search, barcode
  lookup, missing product, empty-stub filtering, partial-record completeness,
  rate limits and outages; fallback in both directions (each provider still
  answers when the other cannot); and failure classification never putting a URL
  or body into a user-facing message. Plus the privacy assertions: only the
  query and the key are sent, no cookies, no referrer, GET with no body, and
  Open Food Facts is only ever read.
* `tests/food-lookup.test.ts` (21) — **Phase 9.** The lookup order end to end
  with the database mocked: a well-stocked local answer never calls out;
  a thin one consults both providers; favourites, recents and cached foods are
  flagged and ranked; a provider result already held locally does not appear
  twice and the local row wins; a provider failure removes only its own results;
  the missing key surfaces as status rather than an error; `localOnly` (offline)
  skips every provider and still returns favourites and cached foods; an
  identical repeat search is served from the memo instead of a second
  round-trip; the cache upserts on `(provider, externalId)` and a refresh does
  not overwrite `retrievedAt`; and **no outbound URL contains the user id or any
  personal keyword.**
* `tests/session.test.ts` (62) — **Phase 10.** The status set and its metadata,
  including that `in_progress` does **not** count as trained and `abandoned`
  does; the transition table (abandon only from a live session, reopening
  allowed, never back to `planned`, unknown statuses rejected); progress
  (done/remaining/percent, the next outstanding set, 0% rather than NaN for an
  empty session, the last tick taken by clock rather than position so
  out-of-order sets still drive the rest timer); grouping by exercise; elapsed
  time (to a stamp, to now, never negative, clamped for a session left open
  overnight, NaN-free on an unparseable date); the recorded duration (real
  elapsed, floored at one minute when something was done, not floored when
  nothing was); the rest timer (counts down, stops at zero, no timer without a
  configured rest, and identical for identical inputs — the property that makes
  it survive a reload); planned-versus-actual outcomes; seeding a session from a
  template (targets not results, per-exercise numbering, nameless exercises
  skipped, absurd set counts clamped, missing targets left null rather than
  zeroed, negatives rejected) and from a past workout; the default rest being
  null rather than a guess; **volume counting only what was ticked**, including
  the over-reporting regression; and the session validation schemas.
* `tests/date.test.ts` (+6) — **Phase 8.** Relative-day labels and
  past/today/future resolved against a **supplied** reference day rather than
  the host clock, including the exact regression (host on 2026-07-29, user on
  2026-07-28) that had the Today page titled "Yesterday"; a day being neither
  past nor future on itself; and month and year boundaries.

## Tests failing

None.

---

## Manual verification performed

Run against the seeded database with `npm run build && npm run start`.

| Scenario | Result |
|---|---|
| 1 — Workout weekdays | ✅ The seeded Mon/Tue/Thu/Fri training goal renders "Not scheduled today" on Wednesday, is absent from the score denominator (it appears under exclusions with reason `rest_day`/`not_scheduled`), and does not break the streak. Asserted in `tests/goals.test.ts` as well. |
| 2 — Weekday habit | ✅ "Plan tomorrow" (Mon–Fri) shows "Not scheduled today" on the weekend and stays out of the denominator. |
| 3 — Weekly goal | ✅ The 4×/week goal renders "N of 4 · N% · N to go", never "of 7", and is not failed before the week ends. |
| 4 — Routine duplication | ✅ **Fixed and confirmed end to end in a real browser.** Applying "Sunday reset" to an empty day wrote 4 rows (`1:0 1:1 1:2 1:3`). Applying it again wrote **nothing** and opened an "Already applied" dialog offering all four choices. Keep → still 4 rows. Add another copy → 8 rows (`… 2:0 2:1 2:2 2:3`). Replace → back to 4 rows keyed from `1:0`. Row counts were read from the database after each step, not from the screen. Zero console errors throughout. |
| 5 — Food search | ❌ Not addressed yet — Phase 9. |
| 6 — Workout session | ❌ Not addressed yet — Phase 10. |
| 7 — Score consistency | ✅ Dashboard, Today and the calendar detail render byte-identical explanations for the same date. Re-confirmed after the Phase 8 rework: on 2026-07-28 all three read `94` and `94% — 15 of 18 applicable opportunities met, weighting 3 categories equally. 6 items were excluded and are listed below.` Insights reports the same window in scheduled opportunities. |
| 10 — Surface separation (Phase 8) | ✅ Each of the three surfaces offers only what it owns, verified in a real browser — see the Phase 8 table under browser verification. |
| 12 — Session lifecycle (Phase 10) | ✅ Start → tick → edit → add → untick → finish, verified in a browser with the numbers checked at each step. An open session leaves the day score untouched; finishing moves it. |
| 11 — Nutrition recalculation (Phase 9) | ✅ Editing, moving, duplicating and deleting an entry each move the day's totals, the goal progress and the day score, all through the one `recomputeDay` path. Verified numerically in a browser. |
| 8 — Demo data removal | ❌ Not addressed yet — Phase 12. |
| 9 — Backup round-trip | ⚠️ **Partly.** Export verified in a real browser: format v2 with `scheduleRules=15`, `scheduleRuleDays=21`, a checksum, the app version and the user's timezone. A full export→modify→restore-into-a-clean-database round trip has **not** been executed end to end. |

### Browser verification (Playwright + Chromium)

Driven against the running production build.

**Phase 10 additions** — all 9 checked routes returned 200 with **zero console
errors, zero warnings and zero uncaught page errors** after the hydration fix.
Run against the production build, driving a full session lifecycle.

* **Before starting**: no session card; templates read "Starts a live session —
  tick sets off as you go"; 5 Start buttons enabled.
* **After starting** a template: the panel appears — "Lower body · In progress ·
  0m elapsed", **18 outstanding sets** each showing "target 5 × 110 kg", "0 of 18
  sets", "nothing logged yet". Discard offered (nothing done yet), Finish
  offered, and every template Start button **disabled**.
* **The session is not in the history list** — one place to act on it, per the
  Phase 8 rule.
* **An open session does not count**: Today's Training tile read `1h` while the
  session was live, unchanged from before it started.
* **After ticking one set**: "1 of 18 sets", "550 kg moved", and the rest timer
  showing "2:58 Resting after Back squat". Discard is **gone**, replaced by
  "Stop early".
* **Editing a set before ticking** it records the real number and the row reads
  **"beat target"**.
* **Adding an exercise mid-session** ("Face pull") appears in the panel.
* **Unticking** a completed set changes the progress back.
* **Finishing**: the panel disappears, Start re-enables, and the workout appears
  at the top of the history — "Lower body · Strength · Today · 1m · 8 kcal · 19
  sets · 7,992 kg volume".
* **The day then changes**: Today's Training tile went `1h` → `47m`, through the
  same `recomputeDay` every other write uses.
* **0 px horizontal overflow** on `/workouts` at 900 px and 1280 px.

**Phase 9 additions** — all 9 checked routes returned 200 with **zero console
errors, zero warnings and zero uncaught page errors** across every check below.
Run against the production build.

* **Local food search still works**: typing "chicken" returns bundled results
  with source and kind badges on every row ("Chicken burrito bowl · Generic ·
  Bundled · 640 kcal · P 45 · C 65 · F 20 · per serving").
* **The missing-key state is understandable**: "USDA FoodData Central is not set
  up. Add USDA_FDC_API_KEY to .env to search it. Local results are unaffected."
* **Provider failure does not break the page**: because the sandbox blocks both
  hosts, the real failure path ran — "USDA is unavailable" with a Retry button,
  and a fully working local result list underneath.
* **Empty state**: "No matches for "zzzzqqqq". Add it as a custom food and it'll
  be searchable from now on."
* **Serving options are only ever convertible ones**: a per-serving food with an
  opaque portion offers exactly `["1 bowl"]`; a weighable food offers
  `["grams", "ounces"]`. This check is what caught the bug described above.
* **Logging works and totals update**: calories 1,662 → 2,302 after logging.
* **Editing the quantity recalculates**: 2,302 → 2,378.
* **Duplicate is explicit and adds a row**: 10 entries → 11, calories → 2,579.
* **Moving between meals keeps the day total**: a Dinner section appeared and
  the total stayed at 2,579.
* **Moving to another day reduces the source day**: 2,579 → 2,518.
* **Deleting recalculates**: entry removed, calories → 2,356.
* **Favourites** toggle from a result row and the Favourites section appears.
* **Meal templates**: first apply added 4 entries (9 → 13); applying the same
  template again added **nothing** and showed the four-way dialog — "Standard
  breakfast has already put 4 items on this day. Nothing has been changed yet."
* **The day score reflects nutrition**: 94 → 95 after logging, through the same
  `recomputeDay` path as every other write.
* **0 px horizontal overflow** on `/nutrition` at both 900 px and 1280 px.
* **No secret in the client bundle**: neither `USDA_FDC_API_KEY`,
  `api.nal.usda.gov` nor `world.openfoodfacts.org` appears anywhere under
  `.next/static/`.

**Phase 8 additions** — all 11 routes returned 200 with **zero console errors,
zero console warnings and zero uncaught page errors** across every check below.

*Separation, observed rather than assumed:*

| Check | Dashboard | Today | Planner |
|---|---|---|---|
| Interactive checkboxes | **0** | 10 | present |
| Row action menus | **0** | present | present |
| "New item" buttons | **0** | **0** | 1 |
| Timeline / time grid | none | **none** | present |
| Routine bar | none | **none** | 1 |
| Overlap row badges (2026-07-15) | — | **0** | **2** |
| Overlap day banner (2026-07-15) | — | **0** | "1 overlapping pair of blocks on this day" |
| View tabs | — | **none** | Day / Week / Month |

* **Series scopes on a recurring item** (2026-07-28, seeded weekly series):
  planner row menu offers `Edit · Push to tomorrow · Skip · Delete · Delete this
  and future · Delete whole series`; Today's offers `Edit · Push to tomorrow ·
  Skip · Delete` — the two series scopes are absent. The planner's edit dialog
  renders the "Apply changes to" selector and the `Delete…` dropdown; Today's
  renders neither, just a plain `Delete`.
* **Hand-offs land where they claim**, each click followed to its final URL:
  Today "Plan this day" → `/planner?date=2026-07-28`; planner "Open in Today"
  from 2026-07-31 → `/today?date=2026-07-31` titled "Friday" (the date
  survives); dashboard schedule tile, "Tick them off in Today" and "Open today"
  → `/today`; calendar detail "Open in Today" → `/today?date=2026-07-28`.
* **Execution still works**: ticking an item on Today flipped it
  `checked → unchecked` and back through the real server action; quick add opens
  from Today; the planner's new-item dialog still offers the full repeat editor.
* **Score agreement across surfaces, same date (2026-07-28):** dashboard ring
  `94`, Today ring `94`, and Today's explanation is byte-identical to the
  calendar day detail's — `94% — 15 of 18 applicable opportunities met,
  weighting 3 categories equally. 6 items were excluded and are listed below.`
* **Timezone fix confirmed**: with the user in `America/New_York` and the host
  on UTC, the Today page title went from **"Yesterday"** to **"Today"**, the
  topbar from "Wednesday, July 29" to "Tuesday, July 28" on all three surfaces,
  and the DateNav "Today" button is now disabled on the user's today and
  navigates to `/today` (not the host's tomorrow) from another date.
* **0px horizontal overflow** on `/`, `/today` and `/planner` at both 900px and
  1280px viewports.

**Phase 7 additions:**

* Scenario 4 above — the full apply / keep / duplicate / replace cycle, with the
  database inspected after every step.
* The unique constraint was exercised directly against the database: inserting
  key `1:0` twice for the same `(user, date, routine)` is **rejected with
  P2002**, key `2:0` is accepted, and two *identical* non-routine items still
  insert fine (the constraint does not reach them).
* Overlap warnings: a day with Deep work 09:00–11:00, Standup 10:00–10:15,
  Lunch 11:00–12:00 and an all-day item renders exactly **2** warnings —
  "Overlaps Standup" and "Overlaps Deep work". Lunch, which merely touches Deep
  work's end, is **not** flagged; the all-day item is **not** flagged.
* The recurring-item row menu offers Edit, Push to tomorrow, Skip, Delete,
  Delete this and future, Delete whole series. The edit dialog offers all three
  edit scopes and all three delete scopes — six in total.
* An "All items in the series" rename was applied to the seeded weekly series:
  **all 17 rows** were renamed, the row count was unchanged, and every date was
  preserved (2026-07-29 … 2026-11-22) — a series edit must never collapse the
  series onto one day.
* `npm run db:seed` run twice: schedule items stayed at 652, not 1304.

**Carried over from Phases 0–6:**

* All nine routes load with **zero console errors and zero console warnings**,
  and no uncaught page errors.
* Creating a Mon/Tue/Thu/Fri goal through the real UI: the schedule preview and
  the saved row both read "Mon, Tue, Thu, Fri".
* **Scenario 1 confirmed in the browser** — on Wednesday 2026-07-29 that goal
  appears in the calendar detail under "Rest day for:", and does *not* render as
  "Missed".
* The weekday picker exposes distinct accessible names for both ambiguous
  initials (Tuesday/Thursday, Saturday/Sunday each resolve uniquely).
* The score explanation dialog renders its categories, exclusions and formula;
  focus moves into it on open, stays trapped across 12 tabs, Escape closes it,
  and focus returns to the "Why this score?" trigger.
* Today has **0px horizontal overflow** at a 900px viewport.
* Backup export produces format v2 with the scheduling tables populated.

---

## Known problems / what is NOT done

These are stated plainly so nothing reads as finished when it is not:

1. **`npm run lint` does not work in this repository, and did not before this
   upgrade either.** `next lint` prompts interactively to configure ESLint —
   there is no ESLint config committed. Linting has therefore **not** been run.
   Setting it up is a judgement call left for Phase 16/17 because a fresh strict
   config will flag pre-existing code across the whole repo.
2. ~~Backups do not yet include the new tables / the import has no preview,
   no pre-import backup and no transaction.~~ **Fixed — Phase 15 complete.**
   Format v3 covers every table including `HealthImportBatch` and
   `ReminderDelivery`; the import UI shows the `previewBackup()` inspection
   (version, warnings, per-table counts) before anything is written; a backup
   of the current data auto-downloads on confirm and a copy is written to the
   OS temp dir; the restore runs in one transaction that rolls back entirely
   on a fatal failure (row-level constraint failures are still skipped —
   partial recovery of a damaged file beats none); and the full
   export→damage→restore round trip has now been executed end to end in a
   real browser — see the Phase 15 section.
3. ~~Routine/template application still duplicates.~~ **Fixed in Phase 7.**
   Still outstanding in this area: the four-way choice exists only on the
   **routine bar**; the command palette has no routine-apply entry to route
   through it. Overlap warnings are shown on the **day list** only — the
   timeline, week grid and month grid do not surface them yet. And
   `moveScheduleItem` still has no conflict check of its own, so dragging an
   item onto an occupied slot succeeds silently and only shows the warning
   afterwards.
4. ~~`SeedBatch`/`SeedRecord` exist but nothing writes to them.~~ **Fixed in
   Phase 12** — the seed registers every record it creates; removal deletes
   exactly the registered set. One documented nuance: logging a manual value
   for a day+metric the demo also covers **upserts onto the demo row** (that
   is what the manual fingerprint is for), so the edited value is still part
   of the batch and leaves with it. A record is "yours" when you *created* it,
   not when you edited a demo one.
5. ~~Reminders are not schedule-aware yet.~~ **Fixed in Phase 13** — see the
   Phase 13 section. `reminderEnabled`/`reminderMinute` are now consumed for
   both habits and goals. Remaining honest limits: reminders still only fire
   while a tab is open (stated in Settings; a local-first app with no server
   cannot do better), and the rest-timer-reaches-zero notification from the
   Phase 10 wishlist is still not built.
6. ~~Nutrition still searches only the bundled local food table.~~ **Fixed in
   Phase 9** — provider architecture, USDA and Open Food Facts, local caching,
   offline behaviour. **But no live provider request has ever been made** (the
   sandbox blocks both hosts with a 403 at the CONNECT stage), so the normalisers
   are verified against captured fixtures only. Also still outstanding in this
   area: there is no barcode *scanner*, only barcode-as-a-search-term; no
   background refresh of stale cached foods; no per-provider result quota, so a
   generous USDA response can crowd out Open Food Facts within the 25-result cap;
   and `getFoodShortcuts` still returns at most 12 recents.
7. ~~Workouts have no in-progress session model.~~ **Fixed in Phase 10** —
   starting a template opens a live session with outstanding sets, a derived rest
   timer and a real elapsed duration. Still outstanding in this area: no
   automatic progression suggestion (last time's numbers become the target, but
   nothing proposes adding weight), no superset or circuit grouping, no
   per-exercise rest override in the UI (the action exists —
   `setSessionRest` — but nothing calls it), and no notification when the rest
   timer reaches zero.
8. ~~No Apple Health / CSV import UI.~~ **Fixed in Phase 11** — a `/health`
   page with a staged import (preview → category selection → confirm),
   fingerprint dedup, removable batches and one central aggregation module.
   Still outstanding in this area, stated plainly:
   * The **database-level** import behaviours (transaction rollback on a fatal
     write, batch removal recomputation, preview-writes-nothing) are verified
     in a real browser with the database inspected after each step — see the
     Phase 11 verification — but, like the rest of the project, the committed
     suite is pure and does not open a database. The same Phase 7 caveat
     applies until Phase 17's integration suite exists.
   * `rebuildSummaries` after an import walks every day in the imported range
     sequentially. A multi-year first import takes noticeably long (minutes,
     not seconds) — one-time, but worth batching in Phase 16.
   * Sleep-stage intervals are union-merged **within one import file**; two
     different exports each contributing partial stage records for the same
     night resolve per-file and the fuller file's day wins, rather than a
     cross-batch union of raw intervals (raw samples are deliberately not
     retained).
   * The importer does not stream: the export is held in memory while parsed
     (capped at 400 MB, and `serverActions.bodySizeLimit` raised to match).
9. `getDayScores` over a range calls `getDayScore` per day, which is several
   queries per day. Fine for a month; it should be batched before anything asks
   for a year. Not yet a user-visible problem.
10. **`getDayOverview` is still called by both `/` and `/today`.** The Phase 8
    audit listed this as a cost worth removing. It was **not** removed: the
    dashboard genuinely needs the habit views, the score and the day's records,
    and the only ways to make it cheaper are a second read model (which is the
    duplication this upgrade exists to delete) or request-level caching, which
    does not help across two separate page loads anyway. The separation is now
    about responsibility, not query count. Left as a deliberate non-goal.
11. ~~The host-clock fix is partial.~~ **Finished in Phase 16.** The app shell
    now syncs the server-resolved today into the UI store on every render
    (`UISync` → `ui-store.todayKey`), and the last host-clock readers —
    quick add (context date and labels), the command palette's quick-add
    entry, the workout manager (repeat-session date and history labels), the
    new-habit start date and the consistency heatmap's today ring — all read
    it. The host clock remains only as the pre-sync fallback inside the store
    and the `lib/date` helpers' default parameter.
12. **There is still no rendering test.** The Phase 8 separation is enforced by
    `tests/surfaces.test.ts` at the level of the ownership *declaration* — if a
    future edit adds `conflicts` to Today's `owns`, or flips a planning
    capability on, the suite fails. It cannot catch a component that ignores the
    declaration and renders the button anyway; that was checked in a browser and
    recorded above. A component-level suite belongs in Phase 17 with the
    database-backed integration tests.

---

## Phase 7 — what was asked, and what was delivered

The five items the previous session left as the exact next step, each with its
status stated plainly:

| # | Asked for | Status |
|---|---|---|
| 1 | Idempotency key on routine application, unique on `(userId, date, templateId, sourceKey)` | ✅ done — `sourceKey` is `<ordinal>:<row index>`, not a bare row index, so a deliberate second copy remains possible |
| 2 | A result the UI turns into the four-way choice (keep / replace / add another / cancel) | ✅ done — `status: "duplicate"` writes nothing; all four choices verified in a browser |
| 3 | Full six-way scope for edit and delete, plus skip and reschedule for one occurrence | ✅ done — see the note below on skip/reschedule |
| 4 | Conflict detection, visible not blocking, no all-day or endpoint-touching false positives | ⚠️ **partly** — the detection is done and correct, but it is surfaced on the **day list only**. The timeline, week grid and month grid do not show it yet. |
| 5 | Tests for all of the above | ✅ done — 28 tests in `tests/planner.test.ts`; the seed-re-run and database-constraint checks were run as verifications rather than committed tests (see the caveat below) |

**On skip and reschedule for a single occurrence (item 3):** both already
existed and already did the right thing — `setScheduleItemStatus(id,
"skipped")` sets status per row, and `moveScheduleItem` moves one occurrence and
marks it `isException` so a later series edit cannot drag it back. Adding
separate `skipOccurrence` / `rescheduleOccurrence` actions would have duplicated
them, which is the exact problem this upgrade exists to remove. What *was*
missing was the UI: "Delete this and future" is now on the row menu, and the
edit dialog exposes all three edit scopes and all three delete scopes.

**Caveat on test coverage.** The committed suite is pure — no database, no
fixtures — matching the rest of the project. So "a seed re-run does not
duplicate planner data" and "the unique constraint rejects a duplicate key" are
**not** committed tests; they were verified by running them against the real
database and are recorded above under browser verification. A regression in
either would not be caught by `npm test` today. Adding a database-backed
integration suite is a real gap and belongs in Phase 17.

---

## Phase 8 — audit, and the part that is done

### What the three surfaces actually render (audited, not assumed)

Before → after. The "after" column is what the browser actually renders now,
checked with Playwright rather than assumed.

| | `/` dashboard | `/today` | `/planner` |
|---|---|---|---|
| Stat grid **was** | 4 cards (schedule, habits, calories, workouts/wk) | 4 cards (schedule, habits, calories, training) — 3 of 4 the same metric | none |
| Stat grid **now** | 4 cards, **rolling 7 days**, today as the hint, each a link out | unchanged — today's counts, which Today owns | none |
| Day list **was** | read-only preview, next 5 | **editable** `DaySchedule` | **editable** `DaySchedule` — identical |
| Day list **now** | read-only preview, links to Today | `DaySchedule surface="today"` — execution posture | `DaySchedule surface="planner"` — full |
| Timeline | none | ~~tab~~ **removed** | side panel (sole owner) |
| Conflicts | none | ~~row badges~~ **removed** | row badges **+ day banner** |
| Series scopes | none | ~~6 in menu + dialog~~ **removed** | all 6 (unchanged) |
| Day score card | ring + 3 mini stats | ring + explanation line | none |
| Habits | ~~`HabitChecklist`, capped at 8~~ → **read-only list** | `HabitChecklist`, all | none |
| Also | 2 charts, quick actions, health rows | meals, workouts, journal, protein | week/month grids, routines |

### Duplication confirmed and removed (first part of the phase)

1. **`scoreTone` was copy-pasted verbatim** into `src/app/page.tsx` and
   `src/app/today/page.tsx` — two definitions of the score's colour bands, the
   exact drift risk this upgrade exists to remove. Now defined once in
   `src/components/shared/day-score-card.tsx`.
2. **The day-score card markup was duplicated** — ring, null-vs-zero handling,
   `ScoreExplanation` trigger. Now one `DayScoreCard`; a surface chooses only
   its `sublabel` and its footer (mini stats on the dashboard, the explanation
   line on Today).
3. **`scoreMessage` in `src/app/today/page.tsx` was dead code** — defined,
   never called, and carrying a stale assumption (`planned === 0 && score === 0`)
   from before Phase 5 made an untracked day score `null` rather than `0`.
   Deleted.

Verified after the change: 9/9 routes return 200, the dashboard and Today
render the **same** ring value for the same date (94%), the "Why this score?"
trigger is present on both, and there are zero console errors or warnings.

A **third** copy of `scoreTone` survived that pass, inlined in
`src/components/calendar/day-detail.tsx`. It is removed in the second part
below.

### The decision, recorded

The previous session left the split "proposed, to be confirmed". It is now
decided and implemented, and it lives in code rather than only in prose:
`src/lib/logic/surfaces.ts` is the one declaration of who owns what, and
`tests/surfaces.test.ts` fails if two surfaces ever claim the same job.

| Surface | Owns | Does **not** do |
|---|---|---|
| **Dashboard** `/` | The day at a glance, recent trends, getting to the right screen | Nothing that changes the day. No checkboxes, no row menus, no new-item dialog. |
| **Today** `/today` | Working through today, logging what happened (meals, habits, journal, training) | Structured creation, recurrence, series scopes, time blocking, overlap warnings, week/month. |
| **Planner** `/planner` | Building and shaping the schedule, recurrence and series, routines, overlaps, the timeline, week and month | Meals, journal, habit ticking — the execution surface owns those. |

**The principle applied.** Three surfaces that all describe the same day will
always mention some of the same facts; a summary that refused to name a number
would be useless. What confuses people is duplicated **depth** and duplicated
**interaction** — two screens that both let you restructure the day, two lists
to keep in sync, two stat grids of the same four numbers with no reason to
prefer either. Those are what Phase 8 removed. Where the same fact does appear
twice it is now stated at a different altitude and links to its owner.

### What changed, surface by surface

**Dashboard** — read-only, and now genuinely a command center:

* The four stat tiles were the same three metrics Today shows. They now read
  **rolling 7 days** with today as the hint (`44/54` · "8 of 10 done today"),
  and each tile is a **link** to the surface that owns it. Every number comes
  from `getWindowStats` / `getDayOverview` — the same services as before.
* The habit checklist is gone. It was a second, **truncated** copy of Today's
  (capped at 8, so habits nine and up were unreachable) and it meant the same
  habit could be ticked in two places. It is now a read-only status list with
  "Tick them off in Today".
* "What's next" points at **Today**, not the planner; its empty state points at
  the **planner**, because an empty day is a planning problem.
* Result: the dashboard renders **zero** checkboxes, **zero** row menus and
  **zero** new-item buttons. Quick add and the command palette stay — capture
  and navigation are the command center's job.

**Today** — the one place you finish a day:

* The List/Timeline tabs are gone. The timeline was byte-identical to the
  planner's side panel; time blocking belongs to the planner and Today now
  links there ("Plan this day", and a "Planner →" action on the section).
* The day list keeps completion, skip, push-to-tomorrow, quick capture,
  backlog reordering and rollover. It **loses** structured creation, overlap
  warnings and the two series-delete scopes.
* Editing an item from Today always means *this occurrence*. The edit dialog
  hides the scope selector and the repeat editor and says where to go instead,
  rather than silently narrowing a scope the form appears to offer.

**Planner** — structure, and now the sole owner of conflicts:

* Keeps everything: new item, recurrence, all three edit and delete scopes,
  routines, the timeline, week and month.
* Gained a day-level overlap banner ("1 overlapping pair of blocks on this
  day"), computed with the **same** `findConflicts` the row badges use. Now
  that Today no longer shows overlaps, the planner surfaces them at the top
  rather than only as a badge you have to scroll to find.
* The header states the split in words: "Shape schedules, routines, recurrence
  and time blocks. Working through the day happens in Today."

**Shared, not forked.** `DaySchedule` is still **one** component rendered by
both surfaces against the same server actions. A `surface` prop selects a
posture from `DAY_LIST_CAPABILITIES`; there is no second implementation and no
copied branch logic. `ScheduleRow` and `ScheduleItemDialog` take the same
`seriesActions` flag. The sidebar and command-palette wording for all three
surfaces is read from `SURFACE_ROLES`, so the navigation cannot describe a
screen as doing something it no longer does.

### A third copy of the score colour bands, removed

`src/components/calendar/day-detail.tsx` still had the 80/50 colour ladder
hand-inlined — a third copy, missed when the dashboard and Today were unified.
It now calls the shared `scoreTone`. This is the completion of the earlier
de-duplication, not a repeat of it.

### The host-clock bug this uncovered

Browser verification found the Today page titled **"Yesterday"**. Phase 6 fixed
the *server* path (`getToday()` resolves the user's timezone), but the display
and navigation helpers in `src/lib/date.ts` still read the host clock. With the
seeded user in `America/New_York` and the host on UTC, the app was a day apart
from itself for several hours a day.

This became load-bearing in Phase 8 because the new hand-offs carry a date:
`DateNav` stripped `?date=` whenever the target matched the *host* today, so
"Plan this day" and the "Today" button could land on a different day than the
one you left.

Fixed by giving `isToday` / `isPast` / `isFuture` / `relativeDayLabel` an
optional reference day (host clock still the default, so no caller broke) and
threading the server-resolved day into the components where the three surfaces
would otherwise disagree: `DateNav`, `DaySchedule`, `Timeline`, `WeekGrid`,
`MonthGrid`, the Today page title, the calendar's date nav, and the topbar —
which was insisting it was Wednesday above a page correctly showing Tuesday.

**Deliberately not fixed here** (pre-existing, outside the separation, and
listed under "What is NOT done"): `consistency-heatmap`, `quick-add-dialog`,
`template-bar`, `workout-manager`, `habit-dialog` and the `ui-store` default
still use the host clock.

---

## Phase 9 — nutrition provider architecture & food search

### Provider verification status — read this first

**No live provider call was made, because this environment cannot make one.**
Both hosts are blocked by the sandbox's network policy:

```
$ curl https://api.nal.usda.gov/fdc/v1/foods/search?query=apple&api_key=DEMO_KEY
curl: (56) CONNECT tunnel failed, response 403
$ curl https://world.openfoodfacts.org/api/v2/search?page_size=1
curl: (56) CONNECT tunnel failed, response 403
```

So: the provider layer, the normalisers, the caching, the failure states and the
tests are complete and verified against captured fixtures, and **the request and
response handling has never been exercised against the real services.** The
shapes in `tests/fixtures/` are modelled on the documented and observed API
responses, but a live run could still turn up a field this code reads
differently. That is stated here rather than glossed, and it is the one part of
Phase 9 a person with network access should confirm before trusting it.

What *was* verified in a browser is the failure path itself — because the
blocked network exercises it for real. Searching in the running production build
produces "USDA is unavailable", a Retry button, and a fully working local result
list underneath. That is exactly the degradation the phase is supposed to have.

### The lookup order

One place decides it — `src/server/food.ts`:

1. local foods (bundled + your own) ─┐
2. favourites                        │ all rows already in the database:
3. recent foods                      │ one query, then flagged from the
4. cached external foods            ─┘ usage records
5. USDA FoodData Central — generic ingredients
6. Open Food Facts — branded, packaged products
7. "add it as a custom food" — always available in the UI

Steps 1–4 never touch the network, which is the whole offline story: anything
you have used before is local by the time you use it again. Steps 5 and 6 run
only when the local answer came up thin (fewer than 6 hits), run concurrently,
and are individually allowed to fail.

### Architecture

* `src/lib/logic/food.ts` — the `NormalizedFood` record, the USDA and Open Food
  Facts normalisers, ranking, identity, and `sanitizeNormalizedFood`. Pure.
* `src/lib/logic/servings.ts` — units, serving options, and which conversions
  are valid. Pure.
* `src/server/providers/` — `types.ts` (the `FoodProvider` contract),
  `usda.ts`, `openfoodfacts.ts`, `index.ts` (the registry and its order).
* `src/server/food.ts` — the lookup order above, the local cache
  (`cacheFood` / `getCachedFood` / `materializeFood`), and the view mapping.
* `src/server/actions/food-search.ts` — the single client entry point.

The UI never sees a provider shape. Adding a third source is a new file plus a
registry entry, not a change to any component.

### The rules this phase is actually about

**A conversion happens only when it is mathematically valid.** Grams to ounces
is arithmetic. Millilitres to grams needs a density, and a cup of flour and a
cup of honey differ by more than 2×. Where the density is unknown,
`baseAmountsFor` returns `null`, the unit is not offered, and the server action
refuses it. Nothing anywhere assumes 1 g/ml. The only place a density comes from
is an Open Food Facts product whose serving is stated in *both* ml and grams.

Browser verification caught a real bug here: the log dialog was offering grams
for "1 bowl" of soup — a portion with no declared weight — which would have
produced a unit the Log button then refused. `servingOptionsFor` now offers
weight only when the food can actually be weighed, with a test asserting that
every option it returns is one `canConvert` accepts.

**A logged entry is a snapshot, not a view.** `MealEntry` gained
`foodNameAtLog`, `basisAtLog`, `servingSizeAtLog`, `servingUnitAtLog`,
`gramsAtLog` and `extraNutrientsAtLog` alongside the macros it already stored.
A provider refresh, a renamed custom food or a corrected serving size changes
the food going forward and never moves a total already recorded. Copying a meal
or a day carries the original snapshot rather than recomputing.

**Identity is provider + the provider's id, never the name.**
`@@unique([provider, externalId])`. Re-selecting the same USDA food updates the
cached copy instead of creating a second row; two foods with similar names are
never merged. Local and custom foods carry a null `externalId`, and SQLite
treats NULLs as distinct, so the constraint never applies to them.

**Accidental duplication is rejected by the database.** A save carries a
client-generated `idempotencyKey`, unique per `(mealId, idempotencyKey)`. A
double-click, a retried submit and an optimistic replay collide and become a
no-op that reports `duplicate: true` rather than an error. Deliberate
duplication is a separate menu action with a fresh key.

**Meal templates reuse the planner's logic rather than copying it.**
`planTemplateApplication` was made generic over the row type; nutrition passes
meal-template items through the same function, the same `sourceKey` scheme
(`<ordinal>:<index>`) and the same four-way choice. There is one implementation
of "apply a saved set of rows without doubling it", and the planner's existing
tests still cover it.

### Privacy

Only a search term or a public barcode leaves the machine, and only when local
results are thin. Requests carry no cookies and no referrer. There is no field
in `ProviderSearchOptions` through which a meal, goal, weight or user id could
travel, and `tests/food-lookup.test.ts` asserts that no outbound URL contains
the user id or any personal keyword.

The USDA key is read inside a `server-only` module. Verified against the built
output: neither `USDA_FDC_API_KEY`, `api.nal.usda.gov` nor
`world.openfoodfacts.org` appears anywhere in `.next/static/`. No error path
echoes a URL either, because the USDA URL carries the key as a query parameter —
`classifyHttpStatus` writes its own message from the status code alone.

### Database changes (additive; no data was lost)

`FoodItem` gained `description`, `provider`, `externalId`, `barcode`, `kind`,
`source`, `retrievedAt`, `refreshedAt`, `extraNutrients`, `servingOptions`,
`completeness`, `cached`, a `@@unique([provider, externalId])` and an index on
`barcode`. `basis` now also accepts `per_package` and `per_item`.

`MealEntry` gained `foodNameAtLog`, `basisAtLog`, `servingSizeAtLog`,
`servingUnitAtLog`, `gramsAtLog`, `extraNutrientsAtLog`, `idempotencyKey`,
`templateId`, `sourceKey`, and the two unique indexes described above.

Row counts before and after `prisma db push` were identical across all 15
tables (92 foods, 199 meals, 491 entries, 652 schedule items, …), and the same
counts were confirmed again after restoring the pre-verification snapshot.

### Environment variables

`USDA_FDC_API_KEY` — optional, server-side only, documented in `.env.example`
and the README. Absent, the app says so in the results panel with the signup
link and carries on. Open Food Facts needs no configuration.

---

## Phase 10 — the live workout session

### The problem

`startWorkoutFromTemplate` wrote a **finished** workout the moment you tapped
Start: status `completed`, every set marked done, duration taken from the
template's estimate. That is a reasonable way to log something you already did,
and useless while you are actually training. There was no such thing as a set
you had not done yet, no real elapsed time, and no way to put the phone down and
come back.

### What a session is

A `Workout` with `status: "in_progress"`, real `startedAt` / `completedAt`
stamps, and sets that start incomplete and carry the plan separately from the
outcome. The state machine lives in `src/lib/logic/session.ts`, pure and fully
tested; `src/server/actions/session.ts` is the only thing that writes.

| Status | Counts as trained | Notes |
|---|---|---|
| `planned` | no | On the schedule, not started |
| `in_progress` | **no** | A live session. Not counted until it ends. |
| `completed` | yes | Finished |
| `abandoned` | **yes** | Stopped early — it happened, and the ticked sets say how much |
| `skipped` | no | Deliberately not done |

Transitions are declared, not implicit: a session can only be abandoned from
`in_progress`, a finished workout can be reopened, and nothing returns to
`planned` once real sets exist.

### The decisions worth stating

**An open session is not training.** `in_progress` has
`countsAsTrained: false`, and its planner row stays `planned` — which is what
"work outstanding" means everywhere else. Otherwise a warm-up you abandoned
would inflate the day score for as long as the tab stayed open.

**Duration is measured, not typed.** Finishing computes it from the real
`startedAt`→`completedAt` gap, clamped at both ends: never negative if the clock
moves backwards, and never beyond 12 hours, so a session left open overnight
cannot claim fourteen hours of training. A session that did *something* floors at
one minute, because rounding a real workout to 0 would read as "no workout" to
every other surface.

**The rest timer is derived, not stored.** It is a function of (last tick, rest
length, now). There is no ticking state to lose, so it survives a reload, a
backgrounded tab and a navigation. Rest length comes from the plan, and is
`null` rather than a made-up 90 seconds when no plan declares one.

**The plan and the outcome are separate columns.** `targetReps` /
`targetWeightKg` next to `reps` / `weightKg`, so "target 5 × 110 kg" and "beat
target" both stay legible after the fact instead of the plan being overwritten by
what happened.

**Sets left outstanding stay outstanding.** Finishing does not tick them.
Marking them done would make the record claim work that was not performed;
`totalVolume` already ignores incomplete sets, so the numbers stay honest.

**One session at a time.** Starting another returns the open one's id with
`resumed: true` rather than erroring — the UI offers to resume, and the template
buttons disable while a session is live.

**Discarding is only available before anything is ticked.** Once a set is done,
the option becomes "stop early", and the server refuses to discard. A stray tap
should not be able to erase work.

### Two bugs browser verification caught

1. **A hydration mismatch (React error #418).** The session panel seeded its
   clock with `useState(() => new Date())`, so the server's HTML and the first
   client render disagreed about the elapsed minutes. Fixed by starting the clock
   as `null` and filling it in from an effect — the same pattern the planner's
   timeline already used for its "now" line. Console is clean now.
2. **The history list over-reported volume.** It totalled
   `sets.map(set => ({ ...set, completed: true }))` — harmless while every logged
   set was complete by construction, and a straight overstatement once a session
   could be finished with work left undone. It now carries each set's real flag.
   Observed in the browser as 8,542 kg → 7,992 kg for the same workout, and
   pinned by a test asserting 500 vs 1500 for a session that did one set of three.

### Database changes (additive; no data was lost)

`Workout` gained `startedAt`, `completedAt` and `restSecDefault`, and its
`status` now documents `in_progress` and `abandoned`.

`WorkoutSet` gained `targetReps`, `targetWeightKg` and `completedAt`.
`completed` still defaults `true`, which is what every row written before this
phase relied on — a workout logged after the fact is complete on arrival, and a
session creates its sets with `false`.

Row counts identical across all 15 tables before and after `prisma db push`
(47 workouts, 652 schedule items, …), and confirmed again after restoring the
pre-verification snapshot.

---

## Phase 11 — health metrics & private health imports

### What was built

There is no pretend live watch sync — a desktop browser cannot subscribe to
HealthKit. What actually works, and what was built, is a **local-file import**:
Apple Health `export.zip` / `export.xml`, or a documented CSV, parsed on this
machine, previewed before anything is written, deduplicated by fingerprint,
and removable again batch by batch.

**One aggregation module** — `src/lib/logic/health.ts` — now decides what a
day's number is for every metric, everywhere: goal facts (`server/facts.ts`),
the day-summary cache (`recomputeDay`), the dashboard, `/health`, Insights and
Settings all call it. The per-metric rules are documented in the module header
(cumulative = sum within one app/device then best device wins; weight/fat/BP =
latest; resting HR/HRV = average; heart rate = average with min–max; sleep =
stage-aware). Two pre-existing first-row-wins bugs died in the process:
`recomputeDay` and the dashboard both used `metrics.find(type)`, which was
only correct while a day could never carry more than one row per type.

**Schema** (additive, `prisma db push`, row counts verified identical across
all tables before and after): `HealthMetric` gained `subtype` (sleep stages),
`startAt`/`endAt`, `minValue`/`maxValue`, `sourceApp`/`sourceDevice`,
`sampleCount`, `fingerprint`, `batchId`; the old
`(userId, date, type, source)` unique — one row per day per type per source,
which sample-level imports make wrong — was **replaced** by
`(userId, fingerprint)`, nullable so uncontrolled rows never collide. New
model `HealthImportBatch` (counts and safe metadata only — no raw export is
ever stored). `Workout` gained `importBatchId` so batch removal can take its
workouts with it. Data migration `003-health-fingerprints` stamps every
pre-upgrade row `source|type|date` (collision-free by the old constraint, and
byte-identical to the manual-entry fingerprint for manual rows); verified
idempotent, second run "nothing to do".

**Dedup is the fingerprint**: Apple rows roll up deterministically to one row
per (day, device[, stage]), so re-importing the same file reproduces the same
fingerprints and upserts onto itself — verified in the browser: second import
of the same file wrote **0** new rows. An overlapping later export updates the
fuller days in place (same fingerprint, larger value — asserted in tests) and
adds only genuinely new days. Two same-value weight readings at different
times keep distinct fingerprints; a CSV `externalId` is preferred as identity
when present. Manual entry upserts on `manual|type|date` — logging again
replaces the day's value and can never touch an imported row.

**Workouts import as real workouts** (`source: apple_health`, status
completed) and feed the existing goal/score paths. An import row that looks
like a workout the user logged by hand (same day, duration within 25%, time
within 45 min or absent) is **skipped and reported, never merged** —
`isLikelyDuplicateWorkout` in `lib/logic/health-import/workout-dup.ts`, kept
pure and tested.

**Sleep**: stage records (in_bed/asleep/awake/core/deep/rem from all the
HealthKit values) are union-merged per (day, device, stage) at import — the
merge is `mergeIntervals`, tested against overlap — and an interval crossing
midnight belongs to the day it **ends**. Time asleep = asleep+core+deep+REM;
in-bed and awake never count toward it; a source with only in-bed records
falls back to in-bed time; manual entries are plain totals.

**Units**: one conversion table in the aggregation module (kg/lb/g, ml/l/fl
oz, kcal/kJ, h/min, km/mi/m…). New rows are stored canonical (kg, ml, kcal,
h, km); legacy rows keep their stored unit and are converted at aggregation,
which is what makes the seeded pounds data and imported kilograms agree.
Display conversion (`toDisplay`) puts weight and distance back into the
user's unit system.

**Privacy**: health files are parsed locally, staged as a temp JSON between
preview and confirm (deleted on confirm/cancel, swept after two hours), and
never leave the machine. A test walks every health module and asserts there
is no `fetch(`/socket use at all, and `SEARCH_OPTION_KEYS` — a type-asserted
runtime mirror of the food-provider options — proves structurally that no
health field can ride along on a food search.

### Files added

```
src/lib/logic/health.ts                        THE aggregation module (pure)
src/lib/logic/health-import/types.ts           pipeline shapes (pure)
src/lib/logic/health-import/apple-xml.ts       Apple Health scanning parser (pure)
src/lib/logic/health-import/csv.ts             strict CSV parser (pure)
src/lib/logic/health-import/rollup.ts          rollup + fingerprints (pure)
src/lib/logic/health-import/workout-dup.ts     workout duplicate rule (pure)
src/server/health.ts                           health read model
src/server/health-import.ts                    staging, preview, confirm, removal
src/server/health-import/zip.ts                minimal ZIP reader (node:zlib)
src/server/actions/health-import.ts            the import server actions
src/app/health/page.tsx                        the Health page
src/components/health/import-wizard.tsx        staged import dialog
src/components/health/import-history.tsx       batches + removal
prisma/migrations-data/003-health-fingerprints.ts
public/health-template.csv                     synthetic CSV template
tests/health.test.ts                           33 tests
tests/health-import.test.ts                    38 tests
tests/fixtures/apple-health.ts                 synthetic export fixtures
```

`metric-entry.tsx` grew a `withDetails` posture (date/time/notes) instead of a
second manual-entry implementation. `HEALTH_METRIC_TYPES` gained `heart_rate`
and `distance_km`. The legacy `importHealthMetrics` bulk action (no callers,
no UI) was deleted. Backup format bumped to v3: `healthImportBatches` is in
`BACKUP_TABLES`, restored before the metric rows that reference it; v1/v2
files still restore (the fingerprint migration covers their metric rows).

### Phase 11 verification

`npm test` 554/554 (71 new), `npm run typecheck` clean, `npm run build` clean
(12 routes, `/health` at 8.9 kB). Browser verification (Playwright against the
production build) — **44/44 checks passed**:

* all 10 routes 200, **zero console errors/warnings, zero page errors**
* manual entry writes the day's value and logging again **replaces** it
  (row count unchanged, value moved 12,345 → 13,000)
* CSV preview shows categories, counts and the date range and **writes
  nothing** (row count checked during the open preview)
* confirm wrote exactly the 4 selected rows; the deselected category
  (body weight) was not written
* the day summary recomputed through the aggregation module (12,036 =
  max(seeded manual, imported CSV) for that day, read from the database)
* re-importing the same file: preview says "already present", outcome says
  0 new, row count delta 0
* Apple XML import: workouts category shown, unsupported types reported and
  skipped, workout row created with `source=apple_health` + batch id,
  heart-rate day row created
* batch removal: preview showed counts; removal deleted exactly the batch's
  rows **and** its workout, preserved manual entries and the other batch,
  and recomputed summaries
* invalid file rejected with a readable message; nothing imported
* 0 px horizontal overflow at 900 px and 1280 px

Two real bugs browser verification caught and fixed: a hydration mismatch
(React #418) from `Badge` (a `div`) nested inside `<p>` elements, plus
`toLocaleString()` rendering differently on server and client (timestamps are
now formatted server-side); and the seed not clearing `HealthImportBatch`,
which left ghost batches after a reseed.

---

## Phase 12 — demo-data separation & onboarding

### The design

**One generator, two callers.** The 900-line seed body moved verbatim from
`prisma/seed.ts` into `prisma/demo-data.ts` as `seedDemoData(prisma, {userId?})`;
the CLI (`npm run db:seed`) is now a thin wrapper, and the in-app "Start with
sample data" action calls the *same* function — a second generator would be
the exact duplication this upgrade exists to remove.

**Registration by enumeration, not id-plumbing.** The generator is the only
writer for its user during a run (the wipe just emptied the tables — a no-op
on the in-app path, which requires an empty account), so "everything the user
owns at the end" is exactly "everything this run created". `recordSeedBatch`
enumerates 20 models and registers 2,858 records in one `SeedBatch` — sparing
900 lines of per-create id collection. The bundled food table is deliberately
**not** registered: foods are shared reference data (`userId: null`), and
removing the demo must not empty the food search.

**Removal deletes only what was registered**, children before parents
(`DEMO_MODEL_ORDER`, exported and tested against the FK graph), chunked, with
the batch row deleted last so a crash mid-way leaves removal re-runnable.
Afterwards the demo span — anchored on the batch's creation date, not on
today, so removing months-old sample data recomputes the right days — is
rebuilt through the same `rebuildSummaries` every other write uses.

**Load is only offered while the account is empty.** Sample data is a
starting point, not something to mix into a life already being tracked; the
guard (plus the refuse-if-batch-exists check) is also what makes the action
idempotent. `npm run setup:empty` is the CLI equivalent of choosing "start
empty". The user row is never overwritten by any path — the CLI upsert only
ever creates, and the in-app path passes the existing user through untouched
(asserted in the browser: name, timezone and unit system identical after an
in-app load).

**The onboarding checklist is state on the user, ticked by hand.**
`User.onboardingState` (existing, previously unused) holds `{dismissed,
done[]}` behind a defensive parser; steps are ticked by the user rather than
inferred, because "has a meal row" cannot distinguish demo data from a real
first log. The card is dismissible from the dashboard and restorable from
Settings → Sample data.

### Files

```
prisma/demo-data.ts                          the generator + batch registration
prisma/seed.ts                               now a thin CLI wrapper
src/lib/logic/onboarding.ts                  checklist state (pure)
src/server/demo.ts                           status / load / removal
src/server/actions/demo.ts                   the demo + onboarding actions
src/components/dashboard/onboarding-card.tsx
src/components/settings/demo-panel.tsx
tests/onboarding.test.ts                     8 tests
```

### Phase 12 verification

`npm test` 562/562 (8 new), typecheck and build clean. Seed idempotency
re-verified: two consecutive `db:seed` runs leave 1 batch, 2,858 seed records,
662 schedule items. Browser verification (Playwright, production build) —
**27/27 checks**: checklist shows, a tick persists across reloads, dismissal
hides it, Settings restores it with ticks intact; the demo panel reports the
loaded batch; a genuinely new record (a distance metric the seed never
writes) is created **unregistered**; removal preview lists per-model counts;
removal deletes all 662 planner items, all habits and every registered row
while the real record survives; batch and registry end empty; summaries
recompute to zero planner data; load is refused while the real record exists,
offered once the account is truly empty; the in-app load re-seeds the full
dataset with user settings untouched; 0 px overflow at 900 px; zero console
errors and zero page errors. (A first run of that suite caught the same
Badge-inside-`<p>` hydration mistake in the new demo panel that Phase 11 had
made — fixed the same way.)

---

## Phase 13 — schedule-aware reminders

### The design

**All the knowledge is server-side, in one place.** The watcher used to be
handed raw `Reminder` rows and knew nothing about schedules. It is now a dumb
poller fed by `getReminderFeed()` (`src/server/reminders.ts`), which resolves
today through the same schedule engine, habit views and goal evaluations
everything else uses; the yes/no decision itself is pure —
`src/lib/logic/reminders.ts` — and returns a *reason* when silent
(`rest_day | not_scheduled | excused | canceled | completed | inactive |
disabled | delivered | no_time | future | already_fired`), so the tests
assert why a reminder stayed quiet, not merely that it did.

**What never fires:** anything on a rest day or an unscheduled/excused/
cancelled date (engine statuses map 1:1 to suppressions); archived habits
and disabled rules; a habit already done or a goal already met today; a
times-per-week item once the weekly target is reached (before that it
reminds on any available day); a classic reminder attached to a planner item
that is done (completed) or skipped (cancelled); and any occurrence already
delivered.

**Exactly-once is a database key, not a component ref.** New
`ReminderDelivery` table, unique on `(userId, key)` with keys like
`habit:<id>:<date>` / `goal:<id>:<date>` / `reminder:<id>:<instant>`. The
watcher records a delivery when it fires; a second tab racing the first hits
the unique constraint and does nothing. Rows older than 7 days are swept
opportunistically. The table rides in backup format v3.

**`reminderEnabled`/`reminderMinute` on `ScheduleRule` are finally consumed**
— for habits *and* goals — with the rule's scheduled time as fallback and
silence (`no_time`) when nothing says when. Fire times are local wall-clock
strings (`YYYY-MM-DDTHH:mm:00`): in a local-first app the browser's clock IS
the user's clock.

**The tab-open-all-day case:** the watcher refreshes the feed every 5 minutes
and on window focus, so a habit ticked in another tab stops nagging without a
reload. The in-app toast is the fallback wherever browser notifications are
unavailable, denied or unsupported — stated in Settings rather than papered
over. `markReminderFired` and `getReminders` were deleted (superseded).
Stale occurrences (>60 min past) are dropped for the day rather than
surfacing hours late.

### Files

```
src/lib/logic/reminders.ts        the decision (pure)
src/server/reminders.ts           the feed + the delivery ledger
src/server/actions/reminders.ts   watcher's two actions
tests/reminders.test.ts           24 tests
```

### Phase 13 verification

`npm test` 586/586 (24 new), typecheck and build clean. Browser verification
(Playwright, production build, user timezone aligned with the browser clock
as it is on a real machine) — **14/14 checks**: a due classic reminder and a
due habit reminder both fire as toasts; a reminder attached to a done planner
item, a habit not scheduled today, a habit already done and an archived habit
all stay silent (asserted on the delivery ledger, not just the screen —
exactly two rows exist and they are the two allowed occurrences); the
one-shot reminder is disabled with `lastFiredAt` set after firing; a reload
re-delivers nothing; zero console errors and zero page errors. Verification
caught a real defect: the watcher's first check raced the Toaster's mount
during hydration and could swallow the visible toast — the first check now
waits a beat.

---

## Phase 14 — global search & command palette

The palette (⌘K / Ctrl-K / `/`) already existed with navigation, quick
actions and a five-entity search. Phase 14 finished the job rather than
rebuilding it:

* **Hit building is pure and tested** — `src/lib/logic/search.ts` turns
  matching rows into grouped, render-ready hits; the server action feeds it
  rows plus the user's resolved today. That removed a host-clock bug: the
  palette's "Today/Yesterday" labels were computed against the server's
  clock and could disagree with every page around them (known-problems #11
  applied to search too).
* **Four more entities are searchable** — goals, routines (schedule
  templates), workout templates and meal templates, alongside planner items,
  habits, workouts, foods and journal entries. Each hit deep-links to the
  surface that owns the entity, honouring the Phase 8 ownership table
  (a routine hit goes to the planner, where applying it runs through the
  four-way duplicate guard; a goal hit goes to Settings).
* **Quick actions grew** log-health-data and import-health-data entries;
  keyboard accessibility was verified end to end rather than assumed (the
  palette is cmdk: typeahead, arrows, Enter, Escape).

Files: `src/lib/logic/search.ts` (pure), rewritten
`src/server/actions/search.ts`, widened `searchEverything`, palette edits,
`tests/search.test.ts` (6 tests).

**Verification:** 592/592 tests, typecheck and build clean. Browser
(Playwright, production build) — **14/14**: Ctrl-K opens with focus in the
input; actions and navigation visible before typing; "Sunday" finds the
seeded routine under *Routines*; "protein" finds the goal with its target in
the subtitle; "Lower body" matches workouts and templates; ArrowDown+Enter
navigates to the owning surface; `/` opens; Escape closes; zero console
errors and zero page errors.

---

## Phase 15 — backup & import updates

Format v3 already carried every new table (asserted both ways by the backup
suite). This phase closed the four items the original Phase 15 list left
open:

* **The import shows what it will do before doing it.** Choosing a file now
  runs `previewBackup()` and opens a dialog with the file's version warnings
  and per-table record counts; nothing is written until the user confirms,
  and cancel imports nothing (verified against the database while the dialog
  was open).
* **A pre-import backup happens automatically.** Confirming first downloads
  a `pre-import-backup-<date>.json` of the *current* data, and the server
  writes a second copy to the OS temp directory (`personal-os-backups/`) —
  so even a replace import always leaves a way back.
* **The restore is one transaction.** A fatal failure mid-restore rolls the
  whole import back with a clear message instead of leaving half a backup
  applied. Row-level constraint failures inside are still skipped — partial
  recovery of a damaged file beats none — and the deliberate distinction is
  documented in the code. `backfillMissingSchedules` runs inside the
  transaction; summary rebuilding stays outside (derived data, idempotent).
* **The round trip has now actually been run.** Export through the real UI →
  delete 50 planner items, mangle a habit's name, delete every hydration
  metric → import the file back through the real UI. Every table count
  matched the pre-damage state exactly and the mangled record was restored
  by id.

**Verification:** 593/593 tests (the backup suite gained the
transaction/snapshot assertions), typecheck and build clean. Browser
(Playwright, production build) — **17/17**: v3 export with the new tables
and exact row counts; preview-writes-nothing; auto-downloaded pre-import
backup; full round trip byte-equal on counts; a foreign file and a
newer-version file both refused before anything happens; zero console
errors and zero page errors.

---

## Phase 16 — accessibility, responsiveness, performance

### Accessibility: audited with axe, not assumed

`axe-core` (dev dependency) now drives a WCAG 2.0 A+AA audit across all ten
routes against the production build. Start of phase: **20 violation groups**,
including critical ones. End of phase: **zero serious/critical/moderate/minor
violations on every route.** What the audit caught, and the fixes:

* **Unlabelled form controls** (critical): eight Radix selects in Settings
  and two in the backup panel had visual `<Label>`s with no association —
  every select now has an `id` + `htmlFor`.
* **182 nameless links** on the calendar: heatmap day squares were bare
  colour swatches; each now carries an aria-label with the date and score
  ("Tuesday, July 28, 2026 — score 94 of 100").
* **Invalid `aria-controls`** (critical): the planner and calendar use Tabs
  as segmented controls with panels rendered elsewhere; mounted hidden
  `TabsContent` stubs keep every trigger pointing at a real element.
* **Nameless progress bars**: every bar in the app sits next to the number
  it visualises, so `Progress` is now `aria-hidden` by default (opt back in
  with `aria-hidden={false}` + a label where no text equivalent exists).
* **Contrast**: light-mode `--muted-foreground` darkened 47%→40% lightness
  (one variable fixing dozens of nodes); category/habit/workout chips and
  status text moved from `*-600` to `*-700`/`*-800` in light mode (dark mode
  untouched); the completed-row de-emphasis changed from opacity-60/50 —
  which dragged its text below 4.5:1 — to opacity-90 (+`grayscale` for
  skipped), keeping the visual distinction without the illegibility; the
  timeline's done/skipped blocks likewise.
* **Reduced motion**: a `prefers-reduced-motion` block collapses fades,
  slides and transitions to near-instant, keeping a slow spinner rotation so
  "busy" stays distinguishable from "stuck". Render verified under the
  preference.

Pre-existing and re-verified rather than new: dialog focus trapping, the
palette's full keyboard path, `g`-chord navigation, and per-control focus
rings. The audit ran in light mode; dark mode shares the structural fixes
and its `*-400-on-dark` chip text was left as is.

### The host clock is finally out of the client

`UISync` pushes the server-resolved today into the UI store on every shell
render; quick add, the palette, the workout manager, the habit dialog and
the heatmap's today ring read it (known-problems #11 closed).

### Performance

* `getDayScores` — the known per-day N+1 — turned out to have **no callers**
  (everything reads the `CalendarDaySummary` cache); deleted rather than
  optimised.
* The audit confirmed no route ships more than ~320 kB first-load JS and the
  per-domain reads are already batched (Phase 5/8 work); no new indexes were
  justified beyond those added with the Phase 11 schema.
* Still deliberately not done: batching `rebuildSummaries` for multi-year
  imports (noted in known-problems #8) — one-time cost, would need a
  restructuring of `recomputeDay` that Phase 17 regression coverage should
  precede.

### Verification

593/593 tests, typecheck and build clean. Playwright: axe 0 violations on
10/10 routes; 0 px horizontal overflow at 768 px and 1024 px on all ten
routes; zero console errors/warnings and zero page errors throughout;
reduced-motion render check passes.

---

## Phase 17 — full regression & polish

Run in this order, all against the production build, all passing:

* **Automated tests:** 593/593 across 21 files. **Type check:** clean.
  **Build:** clean, 12 routes.
* **Every route** returns 200 with **zero console errors/warnings and zero
  uncaught page errors**; the production server log is clean.
* **Cross-feature chain, end to end in a browser:** a CSV of 15,000 steps
  imported for today flows through the aggregation module into the day
  summary (verified in the database), onto the dashboard, and the batch's
  removal restores the summary to its pre-import value exactly. One
  assertion in the first draft of this check looked for the steps goal on
  Today; it renders on Settings — its owning surface under the Phase 8
  split — which is correct behaviour, and the check was corrected.
* **Migrations:** `npm run db:migrate` re-run — all three data migrations
  report "nothing to do".
* **Backup round trip:** executed end to end in Phase 15 (export → damage →
  restore, byte-equal counts) and the format re-asserted by the suite.
* **Privacy review:** no `.env`, database file, ZIP or health export is
  tracked; the client bundle contains no provider key, no provider host and
  no health-import server code; the health modules contain no network call
  (asserted by a committed test); provider search options are structurally
  sealed (`SEARCH_OPTION_KEYS`).
* **Diff review:** 6 commits, 79 files, ~8.7k insertions over `main`, all
  accounted for by Phases 11–17; no temporary or verification scripts live
  in the repo (they stayed in the session scratchpad).
* **Dead code:** `getDayScores` (uncalled N+1), `useDateParam` (uncalled),
  and the legacy `importHealthMetrics`/`markReminderFired` actions were
  removed in their phases; a final sweep found no further orphans.

## What remains deliberately open

Stated plainly, so nothing reads as finished when it is not:

1. **Linting is still not configured** (`next lint` was already broken and
   deprecated by Next 15 before this upgrade; setting up a fresh strict
   ESLint config flags pre-existing code repo-wide). A judgement call,
   documented since Phase 0 — not an accident.
2. **No live food-provider request has ever been made** — this environment's
   network policy blocks both hosts. The normalisers are fixture-verified;
   one live search per provider should be confirmed by a person with
   network access (Phase 9 section has the details).
3. **`setSessionRest` still has no UI** — a session's rest length comes from
   its template (Phase 10 wishlist).
4. **The committed suite is pure** — database-backed behaviours (unique
   constraints, transaction rollback, batch removal) are browser-verified
   and recorded here per phase, not enforced by `npm test`. An integration
   suite stays the natural next investment.
5. **`rebuildSummaries` over a multi-year health import is O(days)** —
   minutes, once, on a first big import (Phase 11 section).
6. Smaller wishlist items are listed in "Known problems / what is NOT done"
   above (per-provider result quotas, barcode scanning, rest-timer
   notification, superset grouping, timeline conflict badges on week/month
   grids, drag-onto-occupied-slot pre-check).

## Resuming later

```
cd /home/user/Daily-Schedule
git log --oneline -12
npm install && npx prisma generate
npm run db:push && npm run db:migrate && npm run db:seed   # dev.db is gitignored
npm test && npm run typecheck && npm run build
```

---

# Hosted-website upgrade: Phases 18 onward

> Started 2026-07-30 on branch `claude/personal-os-hosted-perf-98w4ix`, created
> from `main` at `f5b4fe1` (the merge of PR #7 — the completed Preview 3
> upgrade). Objective: convert the local-only SQLite app into a secure private
> hosted website (Auth.js + Google sign-in + email allowlist, PostgreSQL with
> real migrations, Vercel-deployable), make navigation substantially faster,
> and complete the deliberately deferred improvements above.

## Phase checklist (18+)

| #  | Phase                                             | Status |
|----|---------------------------------------------------|--------|
| 18 | Permanent pre-web safety checkpoint               | ✅ done |
| 19 | Production PostgreSQL foundation                  | ✅ done |
| 20 | Authentication and user isolation                 | ✅ done |
| 21 | Local backup → hosted-account migration           | ✅ done |
| 22 | Hosted health-import architecture                 | ✅ done |
| 23 | Navigation and route performance                  | ✅ done |
| 24 | Deferred feature improvements                     | ✅ done |
| 25 | Production security                               | ✅ done |
| 26 | Deployment and production configuration           | ✅ done (deployment itself is the remaining human credential step) |
| 27 | CI and complete verification                      | ✅ done |
| 28 | Documentation and release handoff                 | ✅ done |

---

## Phase 18 — permanent pre-web safety checkpoint

### THE PRE-WEB CHECKPOINT — read this before ever touching history

**The complete, working, local-first SQLite Personal OS (Phases 0–17 + 15a) is
commit `f5b4fe1d950abf56cc11ae97d2750ac714d365fb`** — the `main` merge commit
of PR #7. To return to the pre-web version:

```
git checkout f5b4fe1d950abf56cc11ae97d2750ac714d365fb
```

* An annotated tag `preview3-complete-before-web` was created locally at that
  commit. **Pushing tags is blocked by this environment's git proxy (HTTP
  403)**, so the tag exists locally but not on GitHub; the commit hash above is
  therefore recorded here, in the pull-request description and in the
  deployment documentation, exactly as the task prescribes for that case. The
  user (or any session with tag-push rights) can recreate and push it with:
  `git tag -a preview3-complete-before-web f5b4fe1 -m "Preview 3 complete" && git push origin preview3-complete-before-web`
* That checkpoint must never be moved, deleted or replaced. No history rewrite,
  no force-push.

### Baseline recorded at that commit (verified in this session)

* `npm install` — clean. Node v22.22.2, npm 10.9.7.
* `npm run setup` — prisma generate + db push + all 3 data migrations + seed:
  clean (662 schedule items, 8 habits, 390 habit logs, 172 meals, 48 workouts,
  593 health metrics, 92 foods, 2,858 seed records).
* `npm test` — **593/593 pass** (21 files).
* `npm run typecheck` — clean.
* `npm run build` — clean; 12 routes. First-load JS: `/` 286 kB, `/calendar`
  168 kB, `/habits` 314 kB, `/health` 297 kB, `/insights` 289 kB, `/nutrition`
  321 kB, `/planner` 215 kB, `/settings` 188 kB, `/today` 215 kB, `/workouts`
  310 kB; shared chunk 102 kB.
* `npm audit` — 3 high-severity advisories, all inside `next 15.5.22`'s own
  dependency tree (`postcss`, `sharp`/libvips CVEs). `npm audit fix --force`
  would downgrade to `next@9.3.3` and was **not** run; the individual review
  happens in Phase 27 as the task prescribes.
* Known limitations at baseline: the "What remains deliberately open" list
  above (no ESLint config, no live provider call ever made from this sandbox,
  no DB-backed integration suite, `rebuildSummaries` O(days), the smaller
  wishlist items).

### Database safety

* **This cloud environment started with no database at all** — `prisma/dev.db`
  is gitignored and the clone was fresh. The only SQLite database here is the
  demo-seeded one created by this session's baseline run. It contains only
  synthetic seed data; the user's real database exists solely on their own
  machine (separately copied by the user, per the task). No cloud copy of real
  user data exists, and none is claimed.
* The full safety drill was still executed against the seeded database so the
  procedure itself is verified:
  * Copied `prisma/dev.db` → scratchpad `db-safety-20260730T042218Z/dev.db.checkpoint`
    (outside the repository). Size 2,011,136 bytes, SHA-256
    `269f4641338c99c69daca7a3e2357314fe6609496ba59d070b05e0d960f18e3b`.
  * The copy opens under a fresh Prisma client; per-table row counts recorded
    (`table-counts.json`): 662 scheduleItem, 431 mealEntry, 464 workoutSet,
    593 healthMetric, 390 habitLog, 172 meal, 92 foodItem, 85
    calendarDaySummary, … (29 tables).
  * A backup was exported through the application's **real**
    `exportBackup()` service, validated by the same `inspectBackup()` the
    import UI uses, and its checksum re-verified independently
    (`checksumOf` over the data payload matched `meta.checksum`). File SHA-256
    `baac9096d28c07bb0da10b8166293bfd10fc320e34a113172db85af0589be787`.
  * That export was restored via the real `importBackup()` into a **separate
    disposable database** (fresh schema, empty user) — never over the source —
    and every comparable table count matched the export's `recordCounts`
    exactly. dev.db was never written during the drill.
* **Git tracking verification:** `git ls-files` contains no `.env`, no SQLite
  database file, no backup JSON, no health export or ZIP, no OAuth credential,
  no API key, no journal and no personal health record. (The only pattern
  matches are source files: `journal-card.tsx`, `health-import/zip.ts`.)

### Notes for later phases, found during Phase 18

* `importBackup()` upserts rows **by their original ids** and re-points them at
  the current user. Safe single-user; in a hosted multi-user database this is a
  cross-account overwrite vector (a crafted backup carrying another user's
  record ids would update that user's rows). Phase 21 must remap ids /
  verify ownership before update. Child tables without a `userId` column
  (`mealEntries`, `workoutSets`, `mealTemplateItems`, `scheduleItemTags`)
  additionally attach by parent id from the file and need parent-ownership
  validation.
* `importBackup()` writes a pre-import snapshot to the **OS temp directory** —
  fine locally, unusable as a durable safety net on serverless. Phase 21
  keeps the browser download as the guaranteed path.
* `getCurrentUser()` in `src/lib/db.ts` is the single seam every action uses
  (`findFirst` on User, creating one if missing) — exactly where the
  authenticated session lookup slots in during Phase 20.

---

## Phase 19 — production PostgreSQL foundation

### What changed

* **`prisma/schema.prisma` is now PostgreSQL** (`provider = "postgresql"`,
  plus `directUrl = env("DIRECT_DATABASE_URL")` so production can put a
  pooler on `DATABASE_URL` while migrations connect directly). The schema was
  already provider-portable by design (TEXT enums, YYYY-MM-DD day strings, no
  raw SQL anywhere — confirmed by a full audit); the deliberate conversion
  work was in the details below. The SQLite version remains recoverable at
  the Phase 18 checkpoint; per the task, there is one clean PostgreSQL
  architecture rather than a dynamic provider switch.
* **A real migration history exists**: `prisma/migrations/20260730044027_init/`
  (855 lines), created with `prisma migrate dev` against local PostgreSQL 16.
  Production applies it with `npm run db:migrate:deploy` (`prisma migrate
  deploy`); `prisma db push` is gone from the scripts.
* **One deliberate constraint change**: `Workout`'s unique index
  `(source, externalId)` became `(userId, source, externalId)` — the old
  global one would have let two *accounts* importing the same Apple Health
  export collide. The health-import duplicate check
  (`src/server/health-import.ts`) now filters by `userId` too.
* **SQLite→Postgres behaviour fixes** (from a dedicated conversion audit, all
  sites enumerated in the scratch report):
  * `searchEverything` uses `mode: "insensitive"` on all nine `contains`
    filters — SQLite's LIKE was case-insensitive, Postgres's is not, and
    search would silently have become case-sensitive. (`FoodItem.searchKey`
    sites stay exact-match: that column is lowercase-normalised on both
    sides by construction.)
  * Null ordering pinned where SQLite and Postgres disagree, preserving the
    UI's existing order: planner `startMinute asc` → `nulls: "first"`
    (untimed items stay on top), workouts `time desc` → `nulls: "last"`,
    favourites `lastUsedAt desc` → `nulls: "last"`, open-session
    `startedAt desc` → `nulls: "last"`.
  * All six nullable-composite unique indexes rely on `NULLS DISTINCT` —
    the Postgres default, verified directly against the database (two null
    `externalId` workout rows insert fine). The schema documents that these
    must never be switched to `NULLS NOT DISTINCT`.
* **Scripts and local development**:
  * `docker-compose.yml` — PostgreSQL 16 with a persistent volume; an init
    script also creates `personal_os_test` so integration tests never touch
    dev data. Documented alternative: any own PostgreSQL via `.env`.
  * `npm run db:migrate` (migrate dev) / `db:migrate:deploy` /
    `db:migrate:status` / `db:backfill` (the idempotent TypeScript data
    backfills, renamed from the old `db:migrate`) / `db:reset` (now
    `prisma migrate reset`, gated by `scripts/guard-local-db.mjs` which
    refuses non-local hosts unless `DANGEROUSLY_ALLOW_REMOTE_DB=1`).
  * `scripts/ensure-env.mjs` no-ops when `DATABASE_URL` is already set, so
    hosted/CI builds are never sabotaged by a copied `.env`.
  * `prisma/seed.ts` refuses non-local database hosts (`SEED_ALLOW_REMOTE=1`
    to override for a disposable remote dev DB) — demo data can never be
    seeded into production by accident; the in-app sample-data path stays
    the only production route and only works into an empty account.
  * `.env.example` documents `DATABASE_URL` + `DIRECT_DATABASE_URL`.
* README quick start / commands / stack table updated (full docs rewrite is
  Phase 28).

### Verification

* `prisma migrate deploy` onto a **clean disposable database** — applies
  cleanly; `prisma migrate diff --from-migrations --to-schema-datamodel` —
  **no difference** (migrations ≡ schema).
* `npm run db:backfill` against the seeded Postgres DB — all three report
  "nothing to do" (idempotency preserved on PG).
* `npm run db:seed` on Postgres — identical counts to the SQLite baseline
  (662 schedule items, 390 habit logs, 172 meals, 48 workouts, 593 metrics,
  92 foods, 2,858 seed records).
* `npm test` 593/593 · `npm run typecheck` clean · `npm run build` clean
  (route sizes unchanged from baseline).
* Production server on PostgreSQL: **all 10 routes return 200, server log
  clean** (dashboard 0.63 s first hit, 0.15–0.35 s elsewhere, server render
  time only).
* The type checker caught one real error during conversion (a widened
  `QueryMode` on the pre-built `where` in `searchFoods`) — resolved by
  keeping that site exact-match, which it already was semantically.

### Deliberately deferred within this area

* `importBackup`'s per-row `catch {}` inside one interactive transaction is
  **incompatible with Postgres** (the first failed statement aborts the
  transaction; "partial recovery" would become "total failure"). The import
  is being rewritten wholesale in Phase 21 (ownership remapping + id
  minting); restructuring it twice would be waste. Until Phase 21 lands, a
  damaged backup file rolls back entirely rather than partially restoring —
  strictly safer, never lossier.
* Region colocation (database next to the app) is a deployment-time
  decision documented in the Phase 26 deployment guide.
* Auth.js tables arrive as a second migration in Phase 20.

---

## Phase 20 — authentication and user isolation

### Architecture

* **Auth.js (next-auth v5 beta 32) + Google OAuth + Prisma adapter**, JWT
  sessions (30-day max), **no session table** and **no stored OAuth tokens**:
  a wrapped adapter strips access/refresh/id tokens before the Account row is
  written — the app never calls Google after sign-in, so the tokens would be
  pure liability at rest. Migration `20260730044542_auth` adds `Account` and
  `User.emailVerified`/`image`.
* **Server-side email allowlist** (`ALLOWED_EMAILS`): enforced in the
  `signIn` callback (a Google-authenticated unknown email is refused), it
  **fails closed** when unset, and it is re-checked on *every authenticated
  request* in `getCurrentUser` — removing an email locks that account out on
  its next request, not when the JWT expires. No public registration exists.
* **Three defense layers, only the deepest trusted**: edge middleware
  (`src/middleware.ts`, JWT check, redirects to /signin), the `(app)` route
  group layout (`requireCurrentUser`), and — the real enforcement — every
  server query/action resolving the user from the session.
* **The seam did the heavy lifting**: `getCurrentUser` in `src/lib/db.ts`
  (the one function all ~141 call sites use) now re-exports
  `requireCurrentUser` from `src/server/auth/current-user.ts` — session →
  allowlist re-check → User row, wrapped in React `cache()` (one DB lookup
  per request instead of ~10), redirecting to /signin when absent. Server
  actions therefore verify authentication independently of middleware by
  construction. Central helpers: `getSession` / `getCurrentUser` /
  `requireSession` / `requireCurrentUser` / `requireOwnedRecord`.
* **Sign-in page** (`/signin`, outside the app shell): Google button, safe
  error messages (denied ≠ technical detail), and — local development only —
  a `DANGEROUSLY_ENABLE_DEV_LOGIN=1`-gated passwordless door that still
  enforces the allowlist and is ignored on Vercel; it exists so development
  and automated browser tests work without Google credentials. Sign-out
  lives in the topbar account menu (`signOutAction`).
* **First sign-in** creates the app user via the adapter (name falls back to
  the email local part; timezone stays the schema default until Settings).
  No demo data is written; the existing empty-account onboarding (sample
  data offer) applies untouched, and later sign-ins never overwrite
  settings.
* The circular import db.ts ↔ auth (a webpack TDZ crash) was broken by
  extracting `src/lib/prisma.ts`; `src/lib/db.ts` stays the compat surface.

### Ownership audit — found and fixed

A full audit (91 action + ~70 query functions, report in the session
scratchpad) found the query layer and compute layer already correctly
user-scoped, and these defects, all fixed:

* **8 update-by-id mutations** took a client id with no `userId` filter — 5
  of them would also have *stolen* the row (stamping `userId` in data):
  `saveHabit`, `saveWorkout` (which also wiped the victim's sets),
  `saveWorkoutTemplate`, `saveScheduleTemplate`, `saveReminder`,
  `saveFoodItem`, `saveGoalWithSchedule`, `saveGoal`. All now filter
  `{ id, userId }` (P2025 = not found).
* `saveFoodItem` could rewrite **global bundled foods** (`userId: null`)
  shared by every account — now scoped to `{ userId, isCustom: true }`.
* `clearDateOverride` deleted by `(ownerType, ownerId, date)` with no user —
  now takes and filters `userId`.
* `deleteFoodItem` counted other users' meal entries (leak + veto) — now
  counts only the caller's.
* Health-import staging **cancel** didn't verify token ownership —
  `discardStaged(userId, token)` now loads and checks the staged owner.
* Client-supplied reference ids are verified: planner `habitId`/`tagIds`
  and goal `sourceRef` must belong to the caller.
* The health-import workout dupe-check and `Workout` unique index were
  already made per-user in Phase 19.

### Verification

* **Browser (Playwright, production build): 13/13** — signed-out `/` and
  deep routes redirect to /signin; the sign-in page carries no app shell and
  no data; a non-allowlisted email is refused with a safe message
  (`?error=CredentialsSignin` — surfaced via the canonical AuthError-catch
  pattern); an allowlisted sign-in lands on the dashboard with an **empty**
  account (no demo data); zero console errors; sign-out returns to /signin
  and re-gates every route; a second account sees nothing of the first's
  data. (`AUTH_TRUST_HOST` documented for self-hosted deployments — its
  absence was caught live as an UntrustedHost 500.)
* **Cross-user integration tests: 20/20 on real PostgreSQL** — a new
  database-backed suite (`npm run test:integration`, disposable
  `personal_os_test` DB, migrations applied from zero each run, stubbed
  session chooses the signed-in user). Every major domain: habits,
  workouts, templates, planner items, routines, tags, bundled + custom
  foods, goals, schedule overrides, reminders, search scoping — each
  verifying both the refusal *and* that the victim's row is unchanged.
  Also: unauthenticated actions/queries redirect instead of running, and
  search case-insensitivity under Postgres is pinned by a test.
* Unit tests 593/593 (auth stubs added to the vitest config; integration
  suite excluded from the unit run) · typecheck clean · build clean
  (`/signin` route + 87.5 kB middleware).

### Notes

* `.env.example` documents `AUTH_SECRET`, `AUTH_GOOGLE_ID`,
  `AUTH_GOOGLE_SECRET`, `ALLOWED_EMAILS`, `AUTH_TRUST_HOST`,
  `DANGEROUSLY_ENABLE_DEV_LOGIN`. No real values are committed.
* `Account` is deliberately **not** in `BACKUP_TABLES`: sign-in linkage is
  not user data, and a backup restored into a different account must never
  carry the original's Google binding.
* The backup import's cross-user id hazard is Phase 21's core work, next.

---

## Phase 21 — local backup → hosted-account migration

### The rewrite (`src/server/backup-restore.ts`)

The local app restored a backup by **upserting rows under the file's own
primary keys** — correct single-user, and a cross-account overwrite vector in
a shared database (a crafted file carrying a victim's cuids would rewrite
their rows and re-point them at the importer). It also swallowed per-row
errors *inside* one transaction, which PostgreSQL turns into "first failure
aborts everything after it". Both are gone; the import was rewritten
around four rules:

1. **No id from the file is ever trusted.** Every imported row gets a
   deterministic new id — `hash(userId | oldId)` — so a file structurally
   cannot address another account's rows, every internal relationship
   survives (all references remapped with the same function, including the
   polymorphic `ScheduleRule.ownerId`, `Goal.sourceRef`, favourites'
   `refId`-by-kind, seed-record targets, series parents, and even the ids
   embedded inside `ReminderDelivery.key`), and re-importing the same file
   is still idempotent (same input → same ids → skipped as duplicates).
2. **References resolve strictly inside the file.** A child pointing at a
   parent that didn't travel with it is dropped (required link) or unlinked
   (optional link) and counted — never attached to a row in the database.
3. **Validation happens before the transaction.** Rows are sanitised
   against the Prisma schema itself (DMMF-derived column whitelist + type
   checks + DateTime coercion); damaged rows are dropped and reported
   up front — the Postgres-compatible replacement for in-transaction
   `catch {}` row skipping.
4. **Writes are batched `createMany … skipDuplicates`** in true FK order
   (the legacy order wrote schedule items before the meals they reference —
   masked on SQLite by the old error swallowing) inside one transaction:
   a real mid-flight failure rolls back everything; merge-mode collisions
   with the account's own data are skipped without poisoning the
   transaction. Series items write parents before children.

Shared reference data is the one deliberate exception: bundled foods
(`userId: null`) that already exist are reused by identity and **never
modified** (a file claiming a bundled id with poisoned values changes
nothing); provider-cached foods are matched by `(provider, externalId)` —
the same shared-cache behaviour a live search has; anything else becomes the
importer's own copy.

Also new:
* **A safe subset of the exported User row is applied** to the account
  (name, timezone, units, week start, day window, score settings —
  never email/id/image), so day keys keep meaning what they meant locally.
  The old import silently dropped all of it.
* **The tmpdir pre-import snapshot is gone** (a serverless temp dir does not
  survive the request); the automatic **browser download before confirm is
  the recovery path**, and the dialog says so.
* **A post-import verification report downloads automatically**: mode, file
  version, per-table in-file/created/skipped/dropped, totals, and per-table
  row counts now in the account.
* Summary rebuild now spans the earliest date across schedule items, meals,
  habit logs, metrics and workouts (was: schedule items only).

### Verification

* **Integration (real PostgreSQL): 14 new tests, 34/34 total** — full-graph
  import into an empty account asserting every relationship by remapped id;
  re-import creates nothing; replace clears first / merge keeps existing;
  preview writes nothing; checksum + older-version warnings; future version
  refused before writing; **a file carrying another user's real ids leaves
  their rows untouched** (the importer gets an inert copy); **a child row
  aimed at another user's parent is dropped, not attached**; existing
  bundled foods are reused and never modified; int4-overflow mid-import
  rolls the whole import back; a damaged row is dropped and reported while
  the rest imports; a v2 file gets every-day schedules backfilled; hosted
  export round-trips into another account with both accounts intact.
* **Browser (production build): 7/7** — Settings → Backup: export downloads
  a valid v3 file; choosing a synthetic file opens the preview (nothing
  written); confirming downloads the pre-import backup **and** the
  verification report, imports 3 records, and the imported habit renders in
  the app; zero console errors.
* Unit tests 594/594 (backup-format suite updated: the "covers every table"
  assertions now check the restore engine, plus a new assertion that every
  imported row is remapped) · typecheck clean · build clean.

Deliberately not done: optional private object storage for oversized
backups (a browser download remains the required recovery method; noted for
Phase 26 docs — Vercel's ~4.5 MB request cap bounds single-request imports,
which comfortably fits this app's real backups today).

---

## Phase 22 — hosted health-import architecture

### The architecture

The local importer sent the raw export (up to 400 MB) through one server
action and staged the parsed plan in the OS temp directory — both fatal on
serverless (per-request body caps, no shared disk between invocations).
The hosted architecture inverts it: **the raw Apple Health export never
leaves the user's device.**

* **Parsing runs in the browser, in a Web Worker**
  (`src/components/health/import-worker.ts`): ZIP extraction
  (`zip-browser.ts`, a `DataView` + `DecompressionStream("deflate-raw")`
  port of the minimal reader — Node 18+ has the same API, so the unit tests
  exercise the exact browser code), the XML scanner, the strict CSV parser
  and the rollup were already pure/browser-portable and now run off the
  main thread. File-type detection moved to a pure module (`detect.ts`).
* **Only normalised rows travel**, in bounded sequence-numbered chunks
  (≤2,000 rows and ≤800 KB each), into a **database-backed import session**
  (`HealthImportSession`/`HealthImportChunk`, migration
  `20260730052646`): serverless-safe, multi-instance-safe, expiring after
  two hours with opportunistic sweeps.
* **Session security** (`src/server/health-import-session.ts`): the server
  creates the session id tied to the authenticated user — the browser
  cannot choose an owner; chunks only attach to the owner's own
  `uploading` session; the unique `(sessionId, seq)` makes duplicate
  submissions no-ops; **finalize revalidates every row** (zod: known
  metric/workout types, day-key format, finite bounded values, bounded
  strings) and **recomputes every fingerprint from row content** — a
  tampered fingerprint is ignored; **provenance is enforced** (an XML/ZIP
  session's rows must claim `apple_health`; a CSV session's rows only the
  CSV source set — a CSV can no more forge "measured by Apple Health"
  than it could before). The validated plan is staged on the session row,
  chunks deleted, and the existing preview/confirm/cancel pipeline works
  on top unchanged: preview writes no health rows, confirm is one
  transaction with the failure-batch record, cancel deletes the session
  (owner-checked).
* `serverActions.bodySizeLimit` dropped **400 MB → 16 MB** (the largest
  remaining action payload is a backup JSON; health chunks are <1 MB).
* **Summary rebuilding is no longer a sequential full-span walk**:
  `rebuildSummariesForDates` recomputes exactly the days an import or
  batch removal touched, each widened ±6 days (a day's score can depend on
  its week under either week-start convention — identical results to the
  full-range rebuild), with bounded concurrency (8 days at a time);
  `rebuildSummaries` (seed/backup restore) shares the same engine.
* Wizard UX: live stage line ("Reading the file on this device…" →
  "Uploading summary rows n/m…" → "Checking against your existing
  records…"), same preview dialog, cancel at any stage discards the
  session. An interrupted upload's staged data expires server-side.

### A real performance bug found by measuring

The first measured run showed parse time going **superlinear** (9.2 s for
1 year → 95.3 s for 3 years in the worker; worse under Node). Cause: the
XML scanner re-ran `indexOf("<Workout ", cursor)` on every record — for a
workout-free export that walks the rest of the file once per record,
O(n²). Fixed by caching next-occurrence positions (results identical;
the whole suite still passes). **3-year parse: 95.3 s → 0.4 s.**

### Measured (production build, real browser, synthetic exports)

First import into an empty account — after the fix:

| Export | File | Parse (worker) | Upload | Server preview | Confirm (write + rebuild) | Days recomputed |
|---|---|---|---|---|---|---|
| 1 month (~1.2 k records) | 0.2 MB | 0.1 s | 0.1 s | 0.1 s | 1.0 s | 42 |
| 1 year (~15 k records) | 2.5 MB | 0.2 s | 0.2 s | 0.5 s | 1.9 s | 377 |
| 3 years (~45 k records) | 7.5 MB | 0.4 s | 0.4 s | 0.6 s | 4.9 s | 1,107 |

First-run row counts written: 180 / 2,190 / 6,570. A second import of the
same files through the same UI wrote **0 new rows** at every size — the
fingerprint dedup holds end to end in the hosted pipeline. Zero console
errors in every run. Peak memory stays bounded by the file's bytes plus
the normalised plan (the 7.5 MB export produced a ~6-8 MB plan in worker
memory; no 400 MB server buffering anywhere).

### Verification

* **Integration (real PostgreSQL): 12 new tests, 46/46 total** — chunks
  cannot attach to another user's session; another user cannot finalize,
  confirm or cancel a session; duplicate chunk submission is a no-op;
  out-of-range sequence numbers and malformed rows are rejected; finalize
  refuses an incomplete upload; forged fingerprints are recomputed away;
  a CSV session cannot smuggle `apple_health` provenance; preview writes
  nothing and confirm writes exactly the selection (summaries included);
  same-rows re-import reports duplicates and writes nothing; cancel
  removes staged data; expired sessions are swept; batch removal deletes
  the batch's rows and recomputes exactly the touched days.
* Unit tests 594/594 (ZIP suite now exercises the browser implementation,
  async; detection suite moved to the pure module) · typecheck clean ·
  build clean.
* Browser: the three-size measurement runs above (which also re-verified
  preview→confirm→outcome and the re-import dedup end to end).

Honest limits: an in-flight *upload* does not survive leaving the page
(the parsed plan lives in the page's memory; the server session simply
expires) — an interrupted import is restarted by re-picking the file,
and nothing partial is ever written. The optional object-storage fallback
was not needed: browser parsing handled the multi-year case comfortably.

---

## Phase 23 — navigation and route performance

All numbers are measured against the production build in a real browser
(Playwright), with a privacy-safe query counter (`PRISMA_LOG_QUERIES=1`
logs query text and duration only — **never parameters**, so no personal
value can reach a log). Local database — on a hosted deployment every
query costs a network round-trip, which is exactly why the query counts
matter more than the local milliseconds.

### Query-layer fixes (from a dedicated per-route audit)

* **Request-level memoisation** (React `cache()`, options normalised to
  primitives so equivalent calls share a key): `getCurrentUser` (Phase 20;
  ~10 lookups per render → 1), `evaluateGoalsForDate` (the day overview and
  the day score each ran the full ~10-query goal evaluation — now one run
  serves both), `getHabitViews`, `getDayScore`, and `loadSchedules`
  (habit views and the score loaded the same schedules twice; the id list
  is sorted/joined so array identity doesn't defeat the memo).
* **The reminder feed no longer blocks navigation.** The app shell awaited
  `getReminderFeed()` (~15 queries of schedule resolution) on every render
  of every page; the watcher now fetches it client-side right after mount.
  Same reminders, zero navigation cost.
* **`goalEntry.findMany` was unbounded** — every render fetched a
  lifetime of manual goal entries. Now windowed to 400 days back plus the
  evaluation week (habits already cap their logs at ~90 days).
* **Planner opened with an N+1 write**: `extendSeriesFor` ran a
  `findFirst` per recurring series on every planner GET, on the host
  clock. One `groupBy` now answers "how far is each series materialised?"
  and the caller passes the user's resolved today.
* **Workouts fetched the same rows twice** (`getRecentWorkouts(25)` +
  90-day history, both with sets): the recent list is now sliced from the
  history fetch, falling back only for sparse histories. **Insights**
  fetched goals it explicitly never used (`void goals`) — removed.

### Client/bundle fixes

* **Recharts is out of the first load.** `charts.tsx` is now a lazy facade
  (`next/dynamic`, skeleton placeholder) over the unchanged
  implementations; six routes stop shipping ~120 kB of chart code they
  didn't need to paint.
* **The command palette and quick-add dialog load after hydration**
  (`shell-extras.tsx`) instead of inside every route's bundle. Keyboard
  shortcuts stay eager (tiny, must listen immediately).
* **`(app)/loading.tsx`**: clicking a primary tab now instantly swaps the
  content area to a skeleton inside the persistent shell (sidebar/topbar
  never unmount) instead of holding the old page. **`(app)/error.tsx`**:
  a quiet route-level error boundary — no stack, no paths, just a retry
  and the digest for log correlation.
* `outputFileTracingRoot` pinned to the project (the workspace-root
  warning caused by a stray parent-directory lockfile on the user's
  machine; nothing outside the repo is touched).

### Before → after

Queries per navigation (measurement window includes the reminder feed —
which before was blocking and now fires after paint):

| Route | Queries before | Queries after | First-load JS before → after |
|---|---|---|---|
| Dashboard | 42 | 30 | 286 kB → **163 kB** |
| Today | 28 | 16 | 216 → 217 kB |
| Planner | 11 | 8 | 216 → 217 kB |
| Habits | 14 | 7 | 315 → **190 kB** |
| Calendar | 11 | 8 | 169 → 170 kB |
| Nutrition | 13 | 10 | 323 → **198 kB** |
| Workouts | 15 | 12 | 311 → **187 kB** |
| Health | 10 | 7 | 300 → **174 kB** |
| Insights | 26 | 14 | 290 → **165 kB** |
| Settings | 24 | 21 | 189 → 190 kB |

Warm client-side navigation (click a tab → content updated): **80–154 ms
before → 47–67 ms after**, with the skeleton appearing immediately.
Server render time stayed 35–85 ms locally on every route. Verified after
the changes: all 10 routes render with **zero console errors**, charts
appear on the six chart routes, and the deferred palette opens.

Deliberately unchanged: `getDemoStatus`'s 10 parallel counts feed real
displayed numbers (the sample-data panel) and cost one round-trip;
per-action `revalidatePath("/", "layout")` stays — with the render this
cheap, scoping invalidation per-action across 91 actions is risk without
measurable reward.

---

## Phase 24 — deferred feature improvements

> Note on process: PR #8 (Phases 18 through the Web Push commit) was merged
> into `main` by the owner mid-session. The branch was restarted from the
> merged `main` per the session rules; Phase 24's remaining work continues
> on the same branch name under a new PR.

### Background reminders — Web Push + PWA (built by hand; committed in PR #8)

See the `Phase 24 (reminders)` commit: `PushSubscription` model, a
CRON_SECRET-protected `/api/reminders/run` endpoint, a runner that
evaluates the SAME schedule-aware feed per user in that user's timezone
and claims the exactly-once `ReminderDelivery` key before pushing (push
and open tabs can never double-deliver; every suppression rule applies by
construction), a push-and-click-only service worker (no caching by
design), manifest + icons, and a Settings panel with per-device
enable/disable/revoke and honest unsupported/unconfigured states. 10
integration tests cover endpoint auth, ownership, exactly-once across
runs and channels, dead-subscription cleanup and schedule-aware
suppression. **Honest limit:** real delivery needs HTTPS + a reachable
push service — unavailable in this sandbox; verified to the transport
boundary with the transport mocked, exact setup steps in the docs.

### Food search + barcode (parallel workstream, reviewed & verified)

Per-provider quotas with fair round-robin blending (a generous USDA
response can no longer crowd out Open Food Facts; the crowd-out
regression is pinned by a test: 20 USDA + 2 OFF at limit 10 → 8/2);
local/favourites/recents/cache always rank first. Background refresh of
stale cached provider foods (30-day threshold, ≤4 per sweep, 1-hour
retry throttle, never blocks or fails a search, never touches MealEntry
snapshots — the test's prisma mock has no mealEntry delegate, so a
violation throws). Recents pager (bounded pages of 12, capped offset).
Barcode scanning via the native `BarcodeDetector` + camera preview —
camera starts only on explicit click and always stops on close; denial
and unsupported-browser states; manual digit entry always available and
running the same OFF lookup path; no image ever leaves the device and
the UI says so. `scripts/smoke-food-providers.mjs` is the live smoke
test for a networked machine — **no live provider call succeeded from
this sandbox (CONNECT 403), and none is claimed**; the script was run
here and fails gracefully and honestly.

### Workout sessions (parallel workstream, reviewed & verified)

Session default-rest editor (wiring the previously-UI-less
`setSessionRest`, verified ownership-scoped) and per-exercise rest
override (stored on the exercise's sets; timer precedence: set rest over
session default). Rest-timer completion cue: always an in-app
toast/aria-live announcement, browser Notification only when permission
was already granted, an enable affordance otherwise — the timer stays
derived (no stored ticking state). Progression suggestions from the
user's own last completed performance (+2.5 kg only when every set hit
target at uniform weight, otherwise repeat; none for bodyweight/duration
work or missing data), labelled as estimates with an explicit
not-professional-advice disclaimer, applied only on explicit
confirmation and only to outstanding sets. Superset/circuit grouping in
templates (additive `group` key), round-robin set interleaving, blocks
in the panel, group-aware rest (none inside a round, full rest when the
round completes, out-of-order ticking handled), a new template editor
dialog (none existed), byte-for-byte backward compatibility for
ungrouped templates pinned by tests. tests/session.test.ts: 62 → 98.

### Planner conflicts (parallel workstream, reviewed & verified)

Conflict indicators on the timeline (amber edge + triangle + tooltip +
sr-only label), week view (column header count + marked cards) and month
view (dot with accessible label) — all computed by the one existing
`findConflicts`. `moveScheduleItem` now pre-checks: a move that would
overlap returns `status: "conflict"` writing nothing, and the UI offers
a nonblocking "Move anyway" toast (drag reverts optimistically; a second
call with `confirm: true` proceeds — deliberate double-booking is one
extra click, never blocked). No-op moves and untimed/all-day moves are
never intercepted; endpoint-touching/zero-length false-positive
protections re-asserted. tests/planner.test.ts: 28 → 41. Browser-verified
after integration: indicators visible in all three views with zero
console errors.

### PostgreSQL integration tests (parallel workstream)

Seven new files: the three data backfills proven idempotent by full-row
snapshots; routine idempotency end to end (duplicate detection, ordinal
2 on deliberate re-apply, P2002 on forced duplicates); meal idempotency
by key; reminder exactly-once ledger (cross-user same-key allowed,
replay never advances twice, 7-day sweep scoped to the caller); NULLS
DISTINCT tripwires for every nullable unique the app relies on;
overlapping health-export re-import updating shared days in place with
manual rows byte-identical throughout; and current-user/allowlist
behaviour incl. live revocation. **Integration total: 85 tests, 11
files, all passing** via `npm run test:integration`.

### E2E/rendering suite (parallel workstream)

Committed Playwright suite (`playwright.config.ts`, `tests/e2e/`,
`npm run test:e2e`; chromium from the preinstalled browsers, no
downloads; storage-state sign-in via the dev form). Covers: signed-out
redirects, unauthorized-email refusal, shell + sign-out, surface
postures (read-only dashboard vs interactive Today vs planner
affordances), the loading skeleton (made deterministic by holding the
RSC response), dialog focus trapping, 404 handling, health source
labels, live session start/discard, responsive overflow at 900/1280 px,
and reduced-motion. **After integration: 25 passed, 1 skipped** — the
skip is a deliberate `test.fixme` documenting a real gap (controlled
Radix dialogs without a `DialogTrigger` drop focus to `<body>` on close;
listed as follow-up). The suite also surfaced a real app bug: a
focus-triggered reminder-feed refresh can abort an in-flight toggle
action's response on /today (documented in the spec; workaround in
place there).

### ESLint

ESLint 9 flat config (`eslint.config.mjs`): `next/core-web-vitals` +
`next/typescript` via the compat bridge, an `_`-prefix convention for
deliberately unused values, and a scoped service-worker override —
no rule disabled repo-wide. `npm run lint` is noninteractive and
**passes with zero problems** after fixing all 16 genuine findings
(dead imports/variables across 12 files, an accumulated-but-never-read
counter, a `require()` in tailwind.config, a stale eslint-disable).
Lint joins CI in Phase 27.

### Verification (integrated tree)

`npm run lint` clean · typecheck clean · **unit 673/673** ·
**integration 85/85** · **e2e 25 passed / 1 documented skip** · build
clean · targeted browser pass over the new features (planner conflict
indicators in all three views, template dialog with grouping, barcode
dialog with manual fallback and on-device copy) — zero console errors.

---

## Phase 25 — production security

* **Headers** (next.config, verified live on the running server):
  a same-origin Content Security Policy (`default-src 'self'`; inline
  script/style allowed for Next hydration and Tailwind — documented, with
  nonce-based CSP noted as a possible hardening step; `worker-src 'self'
  blob:` for the health-import worker; `frame-ancestors 'none'`;
  `form-action 'self'`; `object-src 'none'`), `X-Content-Type-Options:
  nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy:
  strict-origin-when-cross-origin`, `Permissions-Policy` denying
  everything except same-origin camera (the barcode scanner), and
  production-only `Strict-Transport-Security` (2 years,
  includeSubDomains). Dynamic pages already carry `Cache-Control:
  private, no-cache, no-store` — verified. **The full e2e suite passes
  under the CSP** (auth, dialogs, charts, camera dialog unaffected).
* **Error handling**: raw error text no longer reaches a browser — the
  two passthrough sites (backup import failure, health-import batch
  error) now log server-side under a short reference id
  (`src/server/safe-error.ts`, message text only, never payloads) and
  send the user only the reference. `global-error.tsx` added as the
  static last-resort boundary; `(app)/error.tsx` was Phase 23.
* **Health endpoint**: `/api/health` — `SELECT 1` against the database,
  `{status: "ok"}` or 503, nothing else revealed; public for uptime
  monitors.
* **Upload/import protection** (mostly established in earlier phases,
  now completed): authentication + ownership everywhere, 16 MB action
  body ceiling, bounded sequence-numbered chunks with server
  revalidation, zod type validation, transaction boundaries with
  timeouts, and a new cap of 3 concurrent uploading import sessions per
  user. Rate limiting beyond that is deliberately platform-level: this
  is a private allowlisted app whose only authenticated users are the
  owner's own accounts (documented in the security guide).
* **Privacy**: no third-party analytics of any kind; the client-bundle
  scan finds no secret names, no database URL, no provider hosts and no
  tracking hosts (only library-documentation URLs inside vendored code).
  Prisma's optional query log stays parameter-free by construction.
* **Cookies**: Auth.js issues `__Secure-`-prefixed, HttpOnly, SameSite
  Lax session cookies on HTTPS automatically — appropriate for the OAuth
  redirect flow.

Verified: headers present on live responses, `/api/health` ok, the cron
endpoint fails closed (503 unconfigured / 401 wrong secret), e2e 25
passed / 1 documented skip under the CSP, lint and typecheck clean.

---

## Phase 27 — CI, dependency audit, final acceptance

### GitHub Actions (`.github/workflows/ci.yml`)

Two jobs, no secrets anywhere (all values are deliberately fake; nothing
is exposed to pull requests):

* **checks** — npm ci, prisma generate, ESLint, type check, unit tests,
  the full PostgreSQL integration suite against a disposable service
  container, migration validation (`migrate deploy` from empty **and**
  `migrate diff --exit-code` proving migrations ≡ schema), production
  build.
* **e2e** — migrations, build, server start (waiting on `/api/health`),
  the Playwright suite with the dev sign-in enabled; failure traces
  uploaded as artifacts. The one spec needing a pre-seeded Apple Health
  batch is skipped in CI via `CI_SKIP_SEEDED` (visible in the config,
  not silently).

### Dependency audit — reviewed individually, no forced fix

`npm audit`: 13 findings (12 high, 1 moderate), reducing to **two root
causes, neither reachable in this app's production runtime**:

1. **`brace-expansion` DoS** (unbounded expansion → OOM) via `minimatch`
   under the ESLint tool-chain — **development-only**; it never ships and
   only runs on developer machines/CI against our own glob patterns.
   `npm audit fix` (non-forced) changes nothing; forcing a cross-major
   override risks breaking the linter for zero production gain.
2. **`postcss` (XSS in stringified output; sourceMappingURL file read)
   and `sharp`/libvips CVEs vendored inside `next@15.5.22`** — postcss
   runs at build time against this repo's own CSS only, and sharp is
   `next/image`'s optimizer, which this app never uses (no `next/image`
   anywhere — verified). **No patched 15.x exists** (15.5.22 is the
   newest 15); the only "fix" is the next major (16.x), a breaking
   upgrade this hardening pass deliberately does not take.
   `npm audit fix --force` would install a broken downgrade and was not
   run.

**Residual risk statement:** no production code path reaches any of the
flagged code. Revisit trigger: the Next 16 upgrade, or a 15.x patch
release. (Full details: this section + `npm audit` output.)

### Final acceptance suite (all actually executed, in order)

* ESLint **clean** · type check **clean** · unit **673/673** ·
  PostgreSQL integration **85/85** · Playwright e2e **25 passed /
  1 documented fixme** · production build **clean**.
* Production migrations applied to a **freshly created empty database**
  + data backfills run cleanly on top.
* **axe WCAG 2 A+AA: 0 violations on all 11 routes** — the audit caught
  one real regression (the timeline "now" chip, white on red-500 at
  10 px = 3.76:1), fixed to red-600.
* **Zero browser-console errors on all 10 app routes** — this sweep
  caught one real hydration bug (the new push panel read `window` during
  render), fixed by deciding support after mount.
* Secret-leak scan over tracked files: clean. Tracked-file scan: no
  `.env`, database, backup JSON, health export, key or credential
  tracked. Client-bundle scan (Phase 25): no secrets, no third-party
  hosts.
* Cross-user security: the 20-test isolation suite plus ownership tests
  across backup, health sessions and push — all green (part of the 85).
* Live USDA / Open Food Facts: **not run — impossible from this sandbox**
  (both hosts blocked at CONNECT); `scripts/smoke-food-providers.mjs` is
  the one-command check for a networked machine.
* Web Push end-to-end delivery: **not run — needs HTTPS + a reachable
  push service**; verified to the transport boundary with the transport
  mocked.

---

## Phase 26 + 28 — deployment configuration, documentation, handoff

**Deployment status, stated plainly: no deployment was performed and none
is claimed.** This environment holds no Vercel credentials (verified),
so the deliverable is a demonstrably deployment-ready repository plus the
exact human path:

* `vercel.json` (cron for the reminder runner), a `vercel-build` script
  that applies committed migrations on every deploy through
  `DIRECT_DATABASE_URL`, `.env.example` documenting every variable by
  name, `/api/health` for uptime checks, CI green on every push.
* `docs/deployment-guide.md` is the master runbook: create the Vercel
  project → create a colocated managed PostgreSQL database → set the
  environment variables → deploy a **preview** → run the smoke checklist
  (sign-in, unauthorized-email rejection, every route, backup
  export/preview, synthetic imports, sign-out) → deploy production →
  verify HTTPS, the allowlist, and that no demo data loaded.

**Documentation** (written for a nontechnical owner, in `docs/`):
deployment guide, Google OAuth setup (exact redirect URIs), local
development, **migrating from the local app** (export → preview →
pre-import backup → import → verification report → count confirmation →
failed-import recovery → returning to the pre-web SQLite version by
checkpoint hash), backup & recovery, health-import privacy, Web Push
setup, security & privacy (including the three access off-switches and
secret rotation), troubleshooting, and performance measurement. README
gained a Guides table and had its stale claims corrected surgically.

### Session epilogue — honest wrap-up

* PR #8 (Phases 18–23 + Web Push) was merged to `main` by the owner
  mid-session; the remaining phases (24 completion, 25–28) live on the
  restarted branch under PR #9.
* Everything in the completion checklist is done except the two items
  that physically require the outside world, both stated wherever they
  appear: a live food-provider request (network-blocked here; one-command
  smoke script provided) and real push delivery over HTTPS (transport
  verified with a mock; setup guide provided). Deployment itself is the
  human credential step, with the runbook written.

---

## Phase 29 — private password sign-in, no Google Cloud, no credit card

The hosted app's Google OAuth sign-in is gone. Sign-in is now an email +
password held by this app alone, chosen so the entire hosted stack —
authentication included — runs with **no Google Cloud project, no OAuth
client, no billing account, no credit card and no paid trial anywhere**.

**The pre-web checkpoint is untouched:** the complete local SQLite app
remains commit `f5b4fe1d950abf56cc11ae97d2750ac714d365fb` (local tag
`preview3-complete-before-web`).

### What replaced Google

* **Hashing** — Node's built-in scrypt (no new dependency): N=2^16, r=8,
  64-byte keys, 16-byte random salts, NFKC-normalized input, stored as
  self-describing `scrypt$logN$r$p$salt$hash` so cost can be raised later
  and old hashes upgrade transparently on the next successful sign-in.
  Verify-time parameter caps stop a tampered row from allocating
  unbounded memory. One implementation (`scripts/lib/password-hash.mjs`)
  is shared verbatim by the app, the recovery CLI and the seeds.
* **Policy** (`src/server/auth/credentials.ts`) — every failure (unknown
  email, wrong password, not allowlisted, locked) returns the identical
  result and burns a real scrypt verification against a dummy hash, so
  neither the response nor its timing says whether an account exists.
  Five consecutive failures lock the account 15 minutes; the lock refuses
  even the correct password (else it would be a guessing oracle); an
  expired lock forgives the whole counter, so a lockout can never decay
  into "one wrong guess re-locks forever". `ALLOWED_EMAILS` still gates
  authorization, fails closed, and is re-checked on every request.
* **Sessions** — stateless JWTs now carry the account's `tokenVersion`;
  `getCurrentUser` compares it against the row on every request at zero
  extra queries. Password change and "Sign out everywhere" bump the
  version — every other device is out immediately. Google-era tokens
  carry no version claim and the migration bumped existing rows to 1, so
  **every pre-upgrade session is dead by construction** (rotating
  `AUTH_SECRET` at cutover is documented as belt-and-braces).
* **Bootstrap** — a one-time `/setup` page, live only while
  `AUTH_SETUP_TOKEN` (≥ 32 chars, enforced) is set AND no account has a
  password. Constant-time token compare, 1s delay on rejection, a
  transactional re-check so concurrent submissions cannot both win, and
  password rules (≥ 12 chars, not built around the email's local part).
  It attaches the password to an existing row with the same email, so a
  Google-era deployment keeps all its data. Completing setup closes the
  page everywhere; docs say to delete the token afterwards.
* **Recovery** — `scripts/reset-password.mjs` (also
  `npm run auth:reset-password`): direct-database password reset with a
  hidden prompt, same shared hash code, clears lockout, bumps
  tokenVersion. There is deliberately no email-based reset — this app
  sends no email; recovery proof is database access.
* **Exposure hardening** — the Prisma client omits `passwordHash`
  globally (runtime and types, via the shared `prisma/db-client.ts`
  factory); exactly two call sites opt back in. Backup exports carry
  profile fields only — no email, no hash, no lockout/session state —
  and the restore side already whitelisted. `CRON_SECRET` comparison is
  now constant-time. Settings gained a "Sign-in & security" panel:
  change password, sign out everywhere, last sign-in / last failed
  attempt ("was that me?").

### Free-tier corrections found by audit

* `vercel.json`'s `*/5` cron **failed the entire deploy on Vercel
  Hobby** (daily-only there) — it now ships a daily schedule, and the
  docs make a free external scheduler (cron-job.org, no card, custom
  Authorization header, 10–15 min cadence) the primary path for timely
  push reminders, sized to stay inside Neon's free compute allowance.
* The deployment guide now recommends creating the database directly at
  neon.tech (free, no card) and pasting connection strings by hand,
  because the Vercel Marketplace storage flow can demand a payment
  method. The repo is public, so GitHub Actions CI minutes are free.

### Removed outright

Google provider, `@auth/prisma-adapter`, the `Account` table,
`User.emailVerified`/`image`, the `DANGEROUSLY_ENABLE_DEV_LOGIN`
passwordless backdoor (local dev now signs in with the seeded
`you@local` / `local-dev-password`, e2e via `npm run seed:e2e`), and the
`AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET` variables.

## Phase 30 — public self-serve accounts: sign-up, recovery codes, multi-user hardening

The owner-only model is retired. Anybody can now open the site, create an
account at `/signup`, and use the app immediately — no allowlist, no setup
token, no operator involvement — while every account stays fully isolated
to its own rows. Statements above about `ALLOWED_EMAILS`, `/setup`,
`AUTH_SETUP_TOKEN` and "no public registration" describe the superseded
Phase 29 model and are historical.

### Added

* **Public sign-up** (`/signup`, `src/server/auth/signup.ts`) — email +
  optional display name + password twice; same policy as everywhere
  (≥ 12 chars, ≤ 200, not built around the email's local part); duplicate
  emails refused via the unique constraint (racing submissions included)
  and NEVER by attaching a password to an existing row — that would be an
  account takeover of legacy passwordless rows. On success the browser is
  signed in and the one-time recovery codes are displayed.
* **Recovery codes** (`RecoveryCode` table,
  `src/server/auth/recovery.ts` + `recovery-codes.ts`) — the free,
  email-less "forgot password": 8 one-time codes per account (16 chars
  from a 31-symbol unambiguous alphabet ≈ 79 bits), stored as SHA-256
  hashes only, shown exactly once. `/forgot-password` redeems one: burns
  the code (guarded update — two concurrent redemptions cannot both win),
  replaces the password, clears lockout, bumps `tokenVersion` (every
  session everywhere dies). Wrong email / wrong code / used code are one
  indistinguishable refusal. Settings → Sign-in & security shows the
  remaining count and regenerates a batch (current password required).
* **Database-backed rate limiting** (`RateLimitBucket` table,
  `src/server/auth/rate-limit.ts`) — fixed-window counters shared across
  serverless instances, keyed by an HMAC of the client address
  (AUTH_SECRET-keyed; raw IPs never stored). Applied to sign-up (8/hour
  per client + a honeypot field), sign-in (60/hour per client, in front
  of the scrypt work), and recovery (10/hour per client and 5/hour per
  named account). `SIGNUPS_DISABLED=1` is the optional admin switch that
  pauses new registrations without touching existing accounts.
* **Migration `20260730210000_public_signup`** — additive only
  (RecoveryCode + RateLimitBucket); safe on a live deployment,
  reversible by dropping the two tables.

### Removed

* `src/server/auth/allowlist.ts`, `src/server/auth/setup.ts`,
  `src/app/setup/page.tsx`, the `ALLOWED_EMAILS` and `AUTH_SETUP_TOKEN`
  environment variables, and every enforcement point (sign-in,
  per-request `getCurrentUser`, CI env, tests, docs). Password policy
  helpers moved to `src/server/auth/policy.ts`.
  `scripts/reset-password.mjs` survives as the operator's break-glass
  path (documented as such; it can also rescue legacy passwordless rows).

### Multi-user hardening found by audit (agentic sweep of every query path)

* **Backup restore can no longer write into the shared food cache.** A
  crafted file could previously plant `userId: null` "provider" rows
  (fake macros, hijacked barcodes, `verified: true`) that every account
  would see and that pre-empted real provider fetches forever. Restored
  food rows now always belong to the importer, and rows claiming provider
  identity that don't match a genuine global row lose their `externalId`
  (meal history is untouched — entries carry frozen snapshots).
* **Restore's `(provider, externalId)` reuse now matches global rows
  only** — previously it could attach the importer's meals to ANOTHER
  user's personal food row, rendering foreign content in their meals and
  bricking that user's replace-mode restore on the `MealEntry` Restrict
  FK (or cascading their template items away).
* **`cacheFood` never flips a user-owned row to global or overwrites
  it** — a legacy personal row squatting on the identity slot is moved
  aside (identity stripped, content and owner intact) before the genuine
  provider data claims the slot; `getCachedFood`/`materializeFood`
  lookups are ownership-scoped.
* **Backup export ships only referenced global foods** (via the user's
  meal entries, template rows and favorites) instead of the entire shared
  cache — no more leaking the serverwide lookup history into every
  backup, no unbounded export growth.
* **Reminder cron isolates per-user failures** — one account whose feed
  evaluation throws no longer starves every user after it in the loop
  (counted in the run result as `usersFailed`).
* `saveGoal` verifies habit-`sourceRef` ownership (mirroring
  `saveGoalWithSchedule`); `getFoodShortcuts` re-scopes favorite food
  lookups; `setDateOverride` writes are user-scoped by construction
  instead of by caller discipline; the food search memo documents its
  remote-results-only invariant.

### Tests

Unit: `tests/recovery-codes.test.ts` (policy + code format/normalization/
hashing). Integration: `signup-flow.test.ts` (success + hashed codes,
duplicate/legacy-row refusal, racing duplicates, validation, rate-limit
window), `recovery.test.ts` (redeem/burn-once/revocation/enumeration/rate
limits/regeneration), shared-cache safety in `backup-restore.test.ts`,
export pruning, and the allowlist tests inverted to pin the public model
(any account signs in; revocation is `tokenVersion` only). E2E:
`signup.spec.ts` walks sign-up → recovery codes → dashboard → sign-out →
code-based reset → burned-code refusal → duplicate refusal;
`signed-out.spec.ts` pins the public links. The one-time-owner suites
(`setup-flow.test.ts`) are deleted with their subject.

### Docs

`auth-setup.md` rewritten around public accounts and recovery codes;
deployment guide step 5 is now "create your account at `/signup`";
security-and-privacy rewritten (public accounts, private data; the
`ALLOWED_EMAILS` kill switch is replaced by `SIGNUPS_DISABLED` +
`AUTH_SECRET` rotation + project pause, stated honestly);
troubleshooting, local-development, migrating-from-local, README and
`.env.example` updated to match.

## Phase 31 — Universal OS foundation: finance, tasks & projects, inbox, cross-module backbone

The first expansion phase beyond the health/schedule core: the shared data
model, server layer, search, reminders and dashboard plumbing that the rest
of the universal-OS roadmap builds on. Nothing existing was recreated or
removed; every addition rides the established patterns (user-scoped Prisma
models, pure logic modules under `lib/logic`, `ActionResult` server actions,
bounded read models, the one reminder ledger, backup format versioning).

### Schema (migration `20260731004637_universal_os_foundation` — additive only)

Seven new tables, all `userId`-scoped with cascade deletes and indexed
foreign keys:

* `Project` — grouping + colour + lifecycle (`active | completed |
  archived`). Deleting a project never deletes its tasks (SetNull).
* `Task` — title/notes/priority (planner's scale reused), `status` (`open |
  done | dropped`), optional `dueDate`, optional one-level `parentId`
  subtasks (depth enforced in the action layer), repeats (`repeat`,
  `repeatEvery`, `repeatAnchor`), per-task `reminderEnabled` (default off).
* `FinanceAccount` — type (`checking | savings | cash | credit_card |
  investment | loan | other`; debt types are just accounts whose balance is
  normally negative), display-only ISO currency, `openingBalance`. **No
  stored balance column**: the balance is always `openingBalance +
  sum(transactions)`.
* `FinanceTransaction` — the signed ledger (positive in, negative out),
  category/payee/notes, optional `billId` link, and a reserved
  `(userId, importKey)` unique for a future CSV import's dedup identity.
* `Bill` — bills and subscriptions in one model (`kind`), recurrence
  (`once | weekly | monthly | quarterly | yearly`) generated from an
  immutable `anchorDate`, a single `nextDueDate` pointer that all
  due-detection reads, `settledAt` for finished one-time bills, per-bill
  reminder settings (`reminderEnabled` default ON, `reminderDaysBefore`).
* `SavingsGoal` — target / saved-so-far / optional target date; maintained
  by its own add/withdraw actions, deliberately not derived from the ledger.
* `InboxItem` — title/notes/status (`open | done | archived`). Deliberately
  no priorities, projects or due dates: a catchall queue, not a second task
  system.

### Key design decisions

1. **Tasks are not schedule items.** A `ScheduleItem` occupies a slot in a
   day and feeds the day score; a `Task` is an obligation with an optional
   due date. Separate models mean neither inherits the other's semantics
   (materialised recurrence, scoring, surfaces). Tasks deliberately do NOT
   enter the day score in this phase.
2. **One anchored cadence engine for everything with a moving due date**
   (`src/lib/logic/due.ts`): occurrences are generated from the anchor (the
   first due date), never from the previous occurrence, so "monthly on the
   31st" clamps to Feb 28 and *returns* to the 31st — no drift. Bills and
   repeating tasks share it; it is distinct from `lib/logic/recurrence.ts`
   (planner materialisation) on purpose — a due date is a pointer that
   advances when the obligation is met, not a set of rows.
3. **Completing a repeating task advances it; completing anything else
   closes it.** The advance lands strictly after both the current due date
   and today, so a long-overdue weekly repeater yields ONE next occurrence,
   not a march through every missed week. `dropped` exists as an honest
   "deliberately not doing this".
4. **The ledger is the balance.** "Set balance" computes the delta and
   writes an `adjustment` transaction (excluded from income/spending
   summaries), so the displayed balance can never drift from the recorded
   history, and a future CSV import needs no special path.
5. **Net worth is reported per currency** — never summed across currencies.
6. **Bill payment is atomic**: advancing `nextDueDate` (or settling a
   one-time bill) and writing the ledger row happen in one transaction;
   paying early or late never skips an occurrence because the advance is
   relative to the due date, not the paid date.
7. **Money is `Float` rounded to cents at every boundary** (`moneyRound`),
   matching the schema-wide no-Decimal convention (the restore engine's
   sanitiser accepts only String/Int/Float/Boolean/DateTime).

### Cross-module infrastructure

* **Universal search** — `SEARCH_GROUPS` gained Tasks, Projects, Inbox,
  Bills, Accounts, Transactions and Savings goals; `searchEverything` fans
  out the same bounded (`take 8`), case-insensitive, user-scoped queries per
  entity, and the palette renders the new groups with zero component
  changes. Transactions search by payee/notes and title themselves from the
  category when payee-less; archived accounts say so in the subtitle.
* **Reminder foundation** — one new pure resolver
  (`resolveDueReminder`) covers every "thing with a due date": fires on the
  due day, and at most once during a configurable run-up window (distinct
  `:ahead` ledger key, so the run-up never suppresses the due-day
  reminder). Bills default ON with a 3-day run-up and carry the amount in
  the message; tasks are opt-in, due-day only. Paid, settled, archived,
  done and dropped items are suppressed with the existing reason enum;
  delivery rides the same exactly-once `ReminderDelivery` ledger and the
  unchanged watcher/push runner (both are kind-agnostic). Future types
  (document expiry, low balance, check-ins) are additional feed loads
  reusing the same resolver — that is the "foundation" deliverable.
  The restore engine's delivery-key remap regex learned the new
  `bill:`/`task:` prefixes so re-imported ledgers keep meaning the right
  occurrences.
* **Dashboard command center** — `src/server/command-center.ts` assembles
  one bounded summary (top 5 due-now tasks, overdue/today counts, inbox
  count + latest, net-per-currency, month in/out, ≤3 soonest bills within
  14 days with totals) shared by the dashboard's new read-only **Tasks**
  and **Money** cards. The dashboard stays read-only per the Phase 8
  surface contract — completing a task happens on /tasks.
* **Backup format v4** — all seven tables export, restore (deterministic id
  remap, dangling-required-FK rows dropped, optional links unlinked),
  replace-mode delete, and verification counts. Subtasks get the same
  two-phase parent-first write as series items. `resetAllData` covers the
  new tables via the same replace path.
* **Navigation** — Tasks (`g a`), Inbox (`g b`), Finance (`g f`) join the
  sidebar between Planner and Nutrition; two new theme accents
  (`--domain-task`, `--domain-finance`) declared in both light and dark
  blocks; quick actions gained "New task" and "Capture to inbox".

### New / changed files (foundation layer)

```
prisma/migrations/20260731004637_universal_os_foundation/   7 CREATE TABLE, no drops
src/lib/logic/due.ts            anchored cadence + due bucketing (pure)
src/lib/logic/finance.ts        money, balances, summaries, bill advance (pure)
src/lib/logic/tasks.ts          bucketing, ordering, repeat advance (pure)
src/server/finance.ts           finance read model (memoised, bounded)
src/server/tasks.ts             task board + summary read model
src/server/inbox.ts             inbox read model
src/server/command-center.ts    the one dashboard summary assembly
src/server/actions/finance.ts   accounts / transactions / bills / savings
src/server/actions/tasks.ts     projects / tasks / complete / repeat advance
src/server/actions/inbox.ts     capture / status / delete
src/app/(app)/tasks/  src/app/(app)/inbox/  src/app/(app)/finance/   pages
src/components/tasks/  src/components/inbox/  src/components/finance/  boards + dialogs
tests/due.test.ts  tests/finance-logic.test.ts  tests/tasks-logic.test.ts
tests/integration/life-os.test.ts
```

### Deliberately deferred (recorded so nothing reads as forgotten)

* CSV import for transactions (the `importKey` identity is reserved; no UI).
* Cross-currency totals, budgets-per-category, transfer transactions
  between accounts (a transfer is currently two transactions by hand).
* Task tags/labels, drag reordering, task ↔ planner block linking, tasks in
  the day score, per-task reminder times (fixed 9:00 fire for due-date
  reminders).
* Demo/starter seed data for the new modules (SeedBatch wiring exists;
  nothing seeds finance/tasks yet).
* Low-balance, document-expiry and review-cadence reminders (the resolver
  and feed structure are ready for them).
* Inbox → task/bill one-click conversion.

### A real bug the new tests caught (fixed before merge)

`nextOccurrenceAfter` estimated the occurrence index with 28-day months, so
for a monthly anchor two-plus years in the past the estimate could overshoot
the true index by more than the one step it walked back — and the walk only
moves forward, so it returned e.g. 2026-09-30 for (anchor 2023-01-31, after
2026-07-31) and silently skipped August. Reachable through
`nextDueAfterCompletion` for a monthly repeating task with an old anchor.
Fixed by dividing by each unit's MAXIMUM span (31/92/366 days) so the
estimate can only undershoot; regressions pin decades-past-anchor behaviour
in every unit.

### Verification (all executed in this session, in order)

* `npm run lint` — clean.
* `npm run typecheck` — clean.
* `npm test` — **793/793** (was 705 at session start; +88 across
  `tests/due.test.ts` 18, `tests/finance-logic.test.ts` 36,
  `tests/tasks-logic.test.ts` 24, extended reminder + search suites).
* `npm run test:integration` — **155/155** on real PostgreSQL (was 125;
  +30 in `tests/integration/life-os.test.ts`, plus backup round-trip
  fixtures for all seven new tables in `backup-restore.test.ts`).
* `npm run build` — clean; `/tasks` 198 kB, `/inbox` 179 kB, `/finance`
  first-load in line with existing routes; middleware unchanged.
* Playwright e2e — **32 passed / 1 deliberate skip** (the pre-seeded
  Apple Health spec), including the widened nav assertions and the
  signed-out wall over `/finance`, `/tasks`, `/inbox`.
* **Browser verification (production build, real Chromium): 34/34 checks,
  zero console errors, zero warnings, zero page errors** — sign-in; project
  + task creation and completion; inbox capture → done; account,
  transaction, bill (created due today, marked paid), savings goal; the
  dashboard's Tasks/Money/inbox cards; the palette finding a new account
  under its group; all 12 app routes returning 200; and 0 px horizontal
  overflow at 900 px on all three new pages.
* **Database-checked, not screen-checked**: after the browser's "mark
  paid", the bill row read `anchorDate 2026-07-31 → nextDueDate 2026-08-31`
  (month-end preserved) — and the atomic ledger-write path is asserted by
  integration tests (amount −89.50, billId link, category carried).
* Vercel preview deployment of the branch: **Ready** (built and deployed
  by the repo's existing pipeline).

### Performance notes

* The dashboard gained exactly one bounded summary call
  (`getCommandCenterSummary`: five small indexed queries + the memoised
  account/bill loads shared with any other consumer in the render).
* Search adds seven `take 8` indexed queries to the existing nine — still
  one debounced round-trip per keystroke batch.
* Open tasks are capped at 500 rows per fetch, transactions at 2 000 per
  window, bills at 200, project progress computed from grouped counts —
  no full-table scans anywhere in the new read models.
* The reminder feed adds two bounded loads (bills due within 60 days,
  tasks due today) to the existing three, and the candidate-key ledger
  lookup stays one round trip.

### Exact next step

Phase 32 candidates, in rough order of user value: CSV transaction import
(the `importKey` seat is reserved), inbox → task/bill conversion, budgets
per category with month-over-month views, low-balance + document-expiry
reminder types on the due-reminder foundation, task ↔ planner linking
("schedule this task"), and demo/starter data for the new modules.

## Phase 32 — Finance workflows & life-admin bridges: CSV import, transfers, budgets, inbox → task, low-balance alerts, task → planner

The first expansion on top of the Phase 31 foundation: the practical
workflows the foundation reserved seats for. Nothing from the foundation was
recreated or undone; every addition rides the established patterns
(user-scoped Prisma models, pure logic under `lib/logic`, `ActionResult`
actions, bounded read models, the one reminder ledger, backup versioning).

### Schema (migration `20260731015758_finance_workflows_life_admin` — additive only)

Two new tables and six new columns, all user-scoped, no drops, validated with
`prisma migrate diff` against the committed migrations:

* `Budget` — one monthly spending target per `(userId, category)` (the
  unique key IS the identity; `period` only ever holds `monthly` today so
  other windows can arrive additively).
* `FinanceImportBatch` — one row per CSV import run: file name,
  row/created/skipped/rejected counts, optional account link (SetNull — the
  audit record outlives the account).
* `FinanceTransaction.transferGroupId` — both legs of a transfer share one
  id; `importBatchId` (SetNull) + the previously-reserved `importKey` now in
  real use.
* `FinanceAccount.lowBalanceThreshold` — null = no alert.
* `ScheduleItem.taskId` / `InboxItem.taskId` — optional SetNull links for
  "add to planner" and "became a task".

### 1) CSV transaction import

* Pure parser (`src/lib/logic/finance-import.ts`), reusing the health
  importer's RFC-4180 field splitter: header alias detection (date, signed
  amount OR debit/credit split OR amount + type column, description,
  category, notes, currency, account-ignored), `$1,234.56` / `(45.00)` /
  unicode-minus money parsing, strict dates (ISO always; slash dates via an
  auto-detected — and user-flippable — day/month order, never guessed
  silently when ambiguous), per-row rejection messages with line numbers,
  currency-mismatch rejection against the target account, 5 000-row / 1 MB
  caps.
* Import identity: `v1|<accountId>|<date>|<amount>|<payee>|<n>` where `n`
  counts identical rows within the file — so re-importing a file (or an
  overlapping export window) skips row-for-row, while two genuinely
  identical purchases in one file both import. Category/notes deliberately
  excluded so recategorising never duplicates. Backed by the existing
  `(userId, importKey)` unique.
* Preview action parses and reports (new / already-imported / invalid,
  detected mapping, sample rows) writing NOTHING; commit re-parses the same
  input and writes batch + rows in ONE transaction (`createMany
  skipDuplicates` backstops racing tabs). Duplicate lookups chunked at 500
  keys per query.
* Dialog on the finance page: account picker, file picker, mapping chips,
  day-first toggle (shown only when relevant), sample table, rejected-row
  list, then a created/skipped/rejected report. Template CSV at
  `/finance-import-template.csv`.

### 2) Account transfers

* `transferBetweenAccounts`: two linked legs (−amount / +amount, category
  `transfer`, payees "Transfer to/from X") written atomically with a shared
  `transferGroupId`. Same currency enforced with a clear message
  (cross-currency = record two manual transactions, documented); archived
  accounts refused; both accounts ownership-checked.
* `summarizeTransactions`, `spendingByCategory` and budget maths exclude
  bookkeeping categories (`adjustment`, `transfer`) via one shared
  `isBookkeepingCategory` helper — transfers move balances, never totals.
* Deleting either leg deletes the pair; editing a leg through
  `saveTransaction` is refused (delete-and-redo is the edit path — a
  half-edited transfer cannot exist); hand-made `transfer`-category rows are
  refused; the category picker never offers `transfer`.
* Transaction rows show a Transfer badge, muted amount, and a
  "Delete both legs" confirm instead of Edit.

### 3) Per-category budgets

* `budgetProgress` (pure): spent per category over the caller's window
  (spending only — income never offsets, bookkeeping never counts),
  remaining floored at zero, uncapped percent, `over` flag; sorted
  over-first then by percent.
* Actions: `saveBudget` (P2002 → "You already have a X budget"), 
  `deleteBudget`. Category validated against `BUDGETABLE_CATEGORIES`
  (spending categories only — no income, no bookkeeping).
* Finance page: Budgets card with progress bars, red over-budget states and
  "Over by $X" chips — computed from the month fetch already in hand, zero
  extra ledger queries. Dashboard Money card: "N of M budgets over — worst
  at P%" callout via `getFinanceSummary().budgets`.
* Future budget-threshold reminders: the low-balance shape (threshold check
  + coarse-window ledger key) is the documented template; not implemented.

### 4) Inbox → task conversion

* `convertInboxItemToTask`: one transaction claims the item with a guarded
  `updateMany(taskId: null)` (two racing tabs → one task), creates the task
  (title/notes prefilled from the capture, due date / priority / project
  from the dialog, project ownership verified), archives the item and links
  it. `taskId` is the double-conversion guard; deleting the task SetNulls it
  and the item can convert again.
* Inbox rows: "Make a task" button → prefilled dialog; converted items show
  a "Became a task" badge in history. The inbox stays capture-first.

### 5) Low-balance reminders

* `resolveLowBalanceReminder` (pure) on the due-reminder foundation:
  archived → inactive, no threshold → disabled, at-or-above → not_scheduled,
  else an occurrence keyed `low_balance:<accountId>:<weekStart>` — the WEEK
  in the key makes it fire at most once per week per account instead of a
  daily nag; a new week re-arms it. Fires at the shared 9:00 due-reminder
  minute; message carries formatted balance and threshold in the account's
  currency.
* Feed: one bounded load of threshold-bearing accounts (+ one groupBy for
  just their ledger sums, only when any exist); same delivery ledger, same
  kind-agnostic watcher and push runner. Restore's delivery-key remap regex
  learned the `low_balance:` prefix.
* UI: optional "Low balance alert" field on the account dialog (empty =
  off, explicit null clears on edit); a quiet "Low" badge on account rows
  while under.

### 6) Task → planner linking (the optional goal — it fit cleanly)

* `scheduleTaskOnPlanner`: creates an ORDINARY planner block (all-day, or
  start time + 1 h) carrying the task's title/priority and a `taskId` link.
  No scheduling logic rides the link: completing either side never touches
  the other, one task can block several days, deleting the task unlinks the
  block (SetNull), open tasks only.
* Task rows: "Add to planner…" menu item + a "Planned · Aug 14" chip for the
  next planned block (3 linked items loaded per task, bounded).

### Cross-module updates

* **Search**: new Budgets group (matched on category key, which the labels
  derive from); transfer legs already reachable via payee text. 17 groups.
* **Backup v5**: `budgets` + `financeImportBatches` export/restore/replace/
  verify; tasks & projects moved AHEAD of schedule items in restore order
  (the new `taskId` FK requires it); `transferGroupId` remapped with the
  same id function on both legs (pairs survive, file values never collide
  with live groups); the account id EMBEDDED in `importKey` remapped with
  the account itself — so a CSV re-imported after a restore computes the
  exact same keys and still dedups row-for-row; inbox/schedule-item task
  links remapped or dropped like every optional link. v1–v4 files restore
  unchanged.
* **Dashboard**: Money card over-budget callout; everything else untouched.

### Adversarial review round (7 findings confirmed by independent verifiers, all fixed before merge)

A 14-agent review pass (7 focused reviewers over the diff, one skeptic per
finding; 0 findings refuted) caught, and this session fixed:

1. **Restore did not remap the account id embedded in `importKey`** — after
   any backup restore, re-importing an overlapping CSV would have
   double-counted the whole window silently. Fixed by remapping the key's
   account segment exactly like the delivery keys; pinned by a new
   import → export → replace-restore → re-import integration test.
2. **A negative value in a debit/credit column was sign-flipped into
   income** via `Math.abs` — a reversed deposit would have imported as
   money in. Now rejected per-row with a message, like every other
   contract violation.
3. **A bill could carry the new `transfer` category** — "mark paid" would
   then write a lone pseudo-transfer leg that every summary skips, hiding
   real spending. Bookkeeping categories now refused by `billSchema` and
   absent from the bill dialog.
4. **The finance week card counted future-dated entries** on its
   month-reuse path (and disagreed with its cross-month fallback path).
   Both now compute the same `weekAgo..today` window.
5. **The "Planned" chip vanished once a task had 3+ past planner blocks**
   (unfiltered take-3). The include now filters to upcoming planned blocks
   server-side.
6. Docs claimed restore-then-reimport dedups while the code preserved keys
   verbatim (the flip side of #1) — code now matches the claim.
7. Stale test counts in the README.

### Verification (all executed this session, in order)

* `npm run lint` — clean. `npm run typecheck` — clean.
* `npm test` — **837/837** (was 793; +44: `finance-import.test.ts` 26 new,
  budget/transfer additions in `finance-logic.test.ts`, low-balance suite in
  `reminders.test.ts`, v5 pins in `backup.test.ts`, Budgets in
  `search.test.ts`).
* `npm run test:integration` — **190/190** on real PostgreSQL (was 155;
  +35: `finance-workflows.test.ts` — import preview/commit/idempotency/
  delete-then-reimport/invalid-file/cross-user, transfer atomicity/
  summary-exclusion/pair-delete/edit-refusal/cross-currency/cross-user,
  budget CRUD/uniqueness/category-rules/cross-user/dashboard-summary,
  conversion atomicity/no-duplicates/relink-after-delete/cross-user,
  low-balance feed eligibility + once-per-week dedup + user scoping,
  task→planner + unlink-on-delete + cross-user, search coverage; plus v5
  round-trip fixtures in `backup-restore.test.ts`).
* `npm run build` — clean; `/finance` 206 kB, `/inbox` 194 kB, `/tasks`
  199 kB first-load, in line with the foundation.
* Playwright e2e — **32 passed / 1 deliberate skip** (pre-seeded Apple
  Health spec), identical to baseline.
* **Browser verification (production build, real Chromium): 34/34 checks,
  zero console errors/warnings/page errors/failed requests** (the one
  filtered artifact is the pre-existing Vercel Analytics loader 404 that
  only occurs outside the Vercel platform): sign-in; account creation with
  a threshold; CSV preview (3 new / 1 invalid, mapping chips, per-row
  errors) → commit (3 created) → re-import previews 3 duplicates with the
  commit button disabled; transfer with visible linked legs; over-budget
  and under-budget budget cards; the "Low" badge after the balance crossed
  under; capture → convert → "Became a task"; the task on /tasks with an
  "Add to planner" flow and chip; the block on the planner day; dashboard
  Money over-budget line and Tasks open count; palette finding "Dining
  budget" and "Transfer to Verify Savings"; all 12 routes 200.
* **Database-checked, not screen-checked**: after the browser run — 4
  transfer legs all `category=transfer` with non-null shared groups;
  `lowBalanceThreshold 100` on the right account; the batch row
  `bank.csv 4/3/0/1`; the converted item `archived` + linked to a task with
  `dueDate 2026-08-15, priority high`; the planner block `2026-08-14,
  allDay, linked`.

### Performance notes

* Budgets ride the month window the finance page already fetches — zero new
  ledger queries on the page; the dashboard summary adds one indexed
  `budget.findMany` (≤100 rows).
* The reminder feed adds one indexed account load filtered to
  threshold-bearing rows and one grouped ledger sum for exactly those
  accounts, skipped entirely when none exist.
* Import duplicate-lookups chunk at 500 keys; commit is one transaction;
  the parser is bounded at 5 000 rows / 1 MB before any work happens.
* Search adds one `take 8` indexed query (budgets) — 17 bounded queries per
  keystroke batch, still one round trip.

### Deliberately not implemented (recorded so nothing reads as forgotten)

* Cross-currency transfers (refused with a message; two manual transactions
  is the documented workaround).
* Budget periods beyond monthly (column exists; validation allows only
  `monthly`), budget rollover, budget-threshold reminders (shape documented
  on the low-balance resolver).
* Editing a transfer in place (delete-and-redo is the safe path offered).
* Routing an `account` CSV column to multiple accounts (one import targets
  one account; the column is ignored and documented as such).
* Import undo ("delete everything batch X created" — the batch link makes
  this a future one-liner).
* Task ↔ planner status sync (deliberate: the block is an ordinary planner
  item, not a task mirror).
* Demo/starter seed data for the new modules (unchanged from Phase 31).

### Exact next step

Phase 33 candidates, in rough order of user value: import undo via the
batch link, document-expiry reminders on the due-reminder foundation,
budget-threshold reminders using the low-balance shape, weekly budget
periods, demo/starter data for finance/tasks/inbox, and task tags/labels.

## Phase 33 — Cleanup & follow-up completion: import undo, document expiry, budget thresholds, weekly budgets, demo data, task tags

The six items Phase 32 recorded as its exact next step, finished — nothing new
invented alongside them. Every addition rides the established patterns
(user-scoped Prisma models, pure logic under `lib/logic`, `ActionResult`
actions, bounded read models, the one reminder ledger, backup versioning), and
nothing from the foundation or from Phase 32 was recreated or undone.

### Schema (migration `20260731040537_phase3_undo_documents_budgets_tags` — additive only)

Two new tables and five new columns, all user-scoped, no drops, no rewrites of
existing rows:

* `TaskTag` — the join that puts tasks on the existing `Tag` vocabulary
  (`@@id([taskId, tagId])`, index on `tagId`), the same shape
  `ScheduleItemTag` already had. Both ends are user-scoped, so a join row can
  never bridge two accounts.
* `LifeDocument` — name, kind, optional issuer, `expiryDate`, notes,
  `reminderEnabled` / `reminderDaysBefore`, `archivedAt`. Indexed on
  `(userId, expiryDate)` and `(userId, archivedAt)`. No file storage: it
  records *when* something runs out, not the thing itself.
* `Budget.alertThresholdPercent` (nullable) + an index on
  `(userId, alertThresholdPercent)`; `Budget.period` now genuinely holds
  `monthly | weekly` (the column already existed, validation only allowed
  `monthly`). The `(userId, category)` unique is unchanged — the category is
  still the whole identity, and the period is a property of that one budget
  rather than a second axis.
* `FinanceImportBatch.undoneAt` / `undoneCount` / `keptCount` — the undo stamp.

`prisma validate` clean; the migration applied from zero on the disposable
test database on every integration run, and against the dev database.

### 1) Import undo via the batch link

* **The rule, decided rather than guessed.** Undo removes only rows that
  `importBatchId` still links to the batch **and** that still say what the
  import wrote. "Still says" is decided by rebuilding the import key from the
  row's *current* account, date, amount and payee (reusing the occurrence the
  stored key ends with) and comparing — so re-categorising or annotating a row
  leaves it removable (category and notes are outside the import identity
  exactly as they are for duplicate detection), while changing its date,
  amount, payee or account keeps it. A row since linked to a bill payment or a
  transfer is kept too: removing it would corrupt the record it is now part
  of. A row with no key, or a key in an unrecognised format, is kept — undo
  never deletes what it cannot positively identify.
* **Never deletes the audit record.** The batch row survives, stamped
  `undoneAt` / `undoneCount` / `keptCount`, and that stamp is what refuses a
  second undo — otherwise a re-run could reach rows a *later* import created.
* **Transactional and scoped.** One `$transaction`: re-read the rows under the
  caller's own id (the preview may be seconds stale), delete only the planned
  ids bounded by `userId` AND `importBatchId`, then stamp the batch. A guessed
  batch id finds nothing.
* **Idempotency preserved.** A removed row takes its `importKey` with it, so
  re-importing the same file recreates exactly what was removed; a kept row
  keeps its key, so its file row is skipped as a duplicate rather than
  double-written.
* **UI.** A "CSV imports" card on `/finance` lists the last 10 runs with file
  name, account, counts and a live remaining-rows count; an undone batch stays
  listed with an "Undone" badge. **Undo** opens a preview — how many rows will
  go, how many will be kept and why, and a sample of what is about to be
  deleted — before anything is removed. The import report inside the dialog
  points at that card.

### 2) Document-expiry reminders

* `LifeDocument` is the smallest model an expiry reminder needs. Kinds: ID &
  travel, insurance, lease & housing, warranty, licence, membership, other.
* Reminders reuse the **existing due-date resolver** rather than growing a
  second engine: `DueReminderKind` gained `"document"`, and a small phrasing
  table words it as an expiry ("Expires in 12 days") instead of a debt ("Bill
  due …"). Same window maths, same `:ahead` key, same ledger.
* Renewal is an edit: moving `expiryDate` forward changes the key, which arms
  the next occurrence on its own — exactly how paying a bill advances the next
  one. Silent when archived, disabled, or already expired (the page carries
  that state; a daily nag would train people to dismiss it).
* Lives on `/inbox`, the app's life-admin surface, as a "Renewals & documents"
  card — no new route, no fourteenth nav item. Each row shows the distance,
  the kind, a "Reminding" badge while today is inside its own run-up window,
  "Expired" once past, and "No reminder" when switched off.
* Searchable by name and issuer; archived rather than deleted by default.

### 3) Budget-threshold reminders

* `alertThresholdPercent` ∈ {50, 75, 90, 100}, or null for no alert. A
  free-form number would let people configure alerts that never fire or fire
  on every purchase.
* Delivery key: `budget:<id>:<periodStart>:<threshold>` — one alert per budget
  per period per threshold. Crossing 75 % says so on the day it happens and
  then stays quiet; the next month (or week) arms it again; changing the
  threshold deliberately arms a new alert, because it is a different question.
* The feed adds at most **one grouped query per period actually in use** (two
  today), each filtered to that period's window, that period's categories and
  money-out rows only — skipped entirely when no budget has a threshold.
* Visible without waiting for a notification: an amber "Past 75 %" badge and an
  amber bar on the budget card, and a one-line dashboard callout when nothing
  is over budget but something is past its line.

### 4) Weekly budget periods

* `budgetPeriodWindow` / `budgetWindows` / `budgetFetchRange` in the pure
  finance module: monthly is the calendar month, weekly is the user's own week
  (their `weekStartsOn` — the same convention every week view and the
  low-balance key already use). An unknown period string falls back to monthly
  rather than blanking the page.
* `budgetProgress` now takes the windows and filters **per budget**, one pass
  per period rather than per budget. The finance page and the dashboard fetch
  **one** ledger slice spanning month ∪ week ∪ rolling-7-days and slice it
  three ways — which actually *removes* the old conditional second query for
  the week card. A week that spills into the next month is measured whole.
* Existing monthly budgets are untouched: same numbers, same sort, same
  over-budget colouring, asserted by the pre-existing tests running through
  the monthly window unchanged.

### 5) Demo data for the new modules

The generator now covers everything: three projects (one completed), 12 tagged
tasks across every due-date bucket with subtasks and a repeating one, five
inbox captures (one already converted into a task), three finance accounts,
~10 weeks of ledger history with salary, standing transfers and category
spending, four bills, two savings goals, three budgets (monthly + weekly, one
with a 75 % alert), **a CSV import batch whose rows are still linked** so undo
has something real to demonstrate, and five documents spanning upcoming,
imminent, reminder-disabled and already-lapsed.

* Every row is registered in the existing `SeedBatch`, so removal deletes
  exactly what was seeded — `DEMO_MODEL_ORDER`, `recordSeedBatch` and
  `DELETE_BY_MODEL` grew the new models, children before parents.
* `countUserRecords` now counts the life-admin modules too: an account with a
  ledger but no planner history is no longer "empty enough" to have demo data
  poured into it.
* Production is unchanged: the CLI seed still refuses non-local databases, and
  the in-app path is still an explicit choice offered only to an empty account.
* **Fixed along the way:** `npm run db:seed` had been broken since the
  password-auth phase — the seed reaches the real aggregation through
  `@/server/summaries`, which imported the client from `@/lib/db`, which
  re-exports `getCurrentUser`, which imports `server-only`, which throws under
  plain `tsx`. The six computation modules now import `@/lib/prisma` directly
  (import specifier only; no behaviour change), which is what that module's own
  header comment always claimed.

### 6) Task tags

* `TaskTag` over the existing `Tag` rows — one vocabulary shared with the
  planner, not a parallel list. Cap of 8 per task, names normalised (trimmed,
  lower-cased, single-spaced, 30 chars), so "Admin" and "admin" can never
  become two tags.
* Created by typing: `taskSchema.tags` takes **names**, the action resolves
  them to the caller's own rows (upsert, so two tabs adding the same new tag
  race down to one row) and syncs the join inside a transaction.
* Filter chips above the task list, counted from rows already in hand (no
  extra query). Stacking narrows (AND), and the filter lives in the URL
  (`/tasks?tag=admin`) so it is linkable — which is what lets a **Tags** search
  hit be a filter rather than a record.
* Deliberately not a second project system: no colours in the task UI, no
  hierarchy, no per-tag pages. Deleting a tag removes its links and leaves
  every task standing.

### Backup format v6

`documents` and `taskTags` added to `BACKUP_TABLES` (tags and tasks both
precede the join, so a link only survives when both ends travelled together),
plus the new budget and import-batch columns, which ride the schema-driven
sanitiser without special cases. A v1–v5 file still restores unchanged.

### Verification (all executed this session, in order)

* `npm run lint` — clean. `npm run typecheck` — clean.
* `npm test` — **903/903** (was 837; +66: `documents.test.ts` 12 new,
  `finance-import.test.ts` +11 undo classification, `reminders.test.ts` +18
  document-expiry and budget-threshold, `finance-logic.test.ts` +14 budget
  windows/periods/thresholds, `tasks-logic.test.ts` +12 tag helpers,
  `search.test.ts` +3, `backup.test.ts` +2 v6 pins).
* `npm run test:integration` — **228/228** on real PostgreSQL (was 190; +38 in
  `phase3-followups.test.ts`: undo scope / kept-edited / kept-linked /
  re-categorise-still-removed / audit stamp / second-undo refusal /
  re-import-after-undo / kept-row-not-duplicated / cross-user denial; document
  CRUD, feed eligibility, dedup, renewal re-arming, cross-user denial, search;
  budget weekly vs monthly windows, month-boundary spill, monthly regression,
  threshold once-per-period, weekly keying, threshold clearing,
  income/transfer exclusion, cross-user; task tag creation/reuse/replacement/
  cap/deletion/two-user separation/search; a v6 backup round-trip landing
  documents and tag links in the *importing* account; demo data seeding and
  removing every new module without touching another account).
* `npm run build` — clean; `/finance` 208 kB, `/tasks` 200 kB, `/inbox` 198 kB
  first-load (from 206 / 199 / 194), middleware unchanged.
* Playwright e2e — **32 passed / 1 skipped** in the documented no-fixture mode
  (`CI_SKIP_SEEDED=1`), identical to the Phase-32 baseline. Without that flag
  the pre-seeded Apple Health spec fails, as it has since it was written: the
  demo seed has never produced a `HealthImportBatch`, which is why the flag
  exists.
* **Browser verification (production build, real Chromium): 30/30 checks, zero
  page errors, zero real failed requests** — tag entry normalising "Verify
  Alpha" → `#verify alpha`, chips on the task row, chip-click filtering putting
  `?tag=` in the URL, stacked tags emptying the list (AND), a linkable tag URL
  filtering on load, the palette finding the tag under **Tags**; the Renewals &
  documents card, a new document reading "Expires in 12 days" with a
  "Reminding" badge, the demo warranty reading "Expired", renewing pushing it
  out of the window; a weekly budget with its period badge, window dates and
  "alerts at 50 %", and the "Past 75 %" badge appearing after a purchase
  crossed the line; CSV preview → commit → the batch in history → editing one
  imported row → the undo preview correctly offering "2 will be removed, 1 will
  be kept (edited since the import)" → the removal leaving the edited row
  standing and the batch marked Undone; all 13 routes 200; 0 px horizontal
  overflow at 900 px on `/tasks`, `/inbox`, `/finance`.
* The only console noise is the pre-existing `/_vercel/insights/script.js` 404
  that occurs whenever the app runs outside the Vercel platform; all 29
  "failed" requests are `net::ERR_ABORTED` prefetches cancelled by the script
  navigating faster than Next can prefetch.

### Performance notes

* The finance page and the dashboard now issue **one** ledger query instead of
  one-or-two: the union of month, current week and rolling-7-days is fetched
  once and sliced. Adding weekly budgets cost zero queries.
* `budgetProgress` walks the ledger once per *period* in play, not once per
  budget — a hundred budgets cost the same two passes as two do.
* The reminder feed adds two bounded loads (documents inside a 365-day horizon,
  `take 200`; threshold-bearing budgets, `take 100`) and at most one grouped
  spending query per period, all skipped when nothing is configured.
* Import undo re-reads at most 5 000 rows (the parser's own cap), plans in
  memory, and deletes in chunks of 500 inside one transaction.
* Tag facets are computed from the open-task rows already loaded; the tag
  filter is client-side over that bounded list. Search adds two `take 8`
  indexed queries (documents, tags) — 19 per keystroke batch, still one round
  trip.

### Deliberately not implemented (recorded so nothing reads as forgotten)

* **Undo of an undo.** Rolling a batch back is one-way; the safe path back is
  re-importing the file, which is exactly what the removed rows' freed import
  keys allow.
* **Per-row undo.** Undo is batch-shaped. Deleting a single imported row is
  already the transaction row menu's job.
* **Document attachments.** No file storage, no document numbers — the model
  records dates, deliberately.
* **Per-document reminder times** (all due-date reminders still fire at 09:00
  local) and **multiple thresholds per budget** (one threshold, one alert).
* **Budget rollover** between periods, and periods beyond monthly/weekly.
* **Tag colours in the task UI, tag rename, per-tag pages.** Tags carry a
  colour column (shared with the planner) that the task chips ignore; renaming
  is not offered because it would silently rewrite planner history too.
* **Tags on inbox items.** The inbox is a catchall queue on purpose; adding a
  second axis to it would start the second-task-system slide.
* **Demo data on hosted sign-up.** Still an explicit, empty-account-only
  choice — never automatic.

### Exact next step

Phase 34 candidates, in rough order of user value: a documents surface of its
own once the inbox card outgrows one section (with kind filtering and an
archive view), tag rename/merge with a preview of what else it touches,
per-item reminder times on the due-date foundation, budget rollover, and a
"needs attention" digest that folds overdue bills, expiring documents,
over-budget categories and low balances into one dashboard block.

---

## Phase A.1 — Apple Health integration & the Health hub

The Health page became a Health **section**, and the importer became a real
server-side pipeline for the official Apple Health archive. Everything rides
the established patterns (user-scoped Prisma models, pure logic under
`lib/logic`, `ActionResult` actions, bounded read models, one aggregation
module, backup versioning); nothing from the foundation or from Phases 31–33
was recreated or undone.

### The one architectural change, and why

**Parsing moved from the browser to the server.** Phase 22 parsed exports in a
Web Worker and uploaded only the resulting rows. That was a real privacy win
and it is what the previous docs described — but it had two costs that this
phase could not carry:

* the server had to **trust numbers a client produced** (it re-validated them,
  but it could not re-derive them), and
* an export was capped at what the user's device could hold in memory, which
  is exactly wrong for the multi-gigabyte exports this phase exists to support.

So the file is now streamed to the server, parsed there in bounded memory, and
deleted. The user-facing flow is unchanged and better: same preview-before-write
philosophy, same batch history, plus a real undo. `docs/health-import-privacy.md`
was rewritten to describe the new model honestly rather than left describing the
old one.

The Web Worker, the browser ZIP reader and the browser XML parser were removed
with it; the chunk-staging table they filled is now filled by the *server* with
the parsed plan, so staging, expiry and ownership all kept their tested
semantics.

### Schema (migration `20260731061657_health_module_apple_import` — additive only)

One new table and eleven new columns. No drops, no rewrites:

* `HealthRecord` — the non-numeric side of an export: `kind`
  (`ecg | medication | clinical | workout_route`), day, instants, title,
  subtitle, an optional single value + unit, and a bounded display-only
  `detail` JSON. Unique `(userId, fingerprint)`, indexed on
  `(userId, kind, date)`, `(userId, date)` and `(batchId)`. One table rather
  than four keeps ownership, backup, undo and search identical for every kind
  — the same reasoning that keeps enum-like columns TEXT everywhere else.
  Sleep and mindfulness sessions are deliberately **not** here: they are
  already intervals in `HealthMetric`, and storing the same night twice would
  be two sources of truth.
* `HealthImportBatch` gained `errors`, `recordsImported`, `recordsDuplicate`,
  `startedAt`, `finishedAt`, `durationMs`, `xmlBytes` (BigInt — an unzipped
  export exceeds what an Int holds), `ignoredFiles`, and the undo stamp
  `undoneAt` / `undoneCount` / `keptCount` — the same shape finance import
  batches already carry. Plus an index on `(userId, status)`.

`prisma migrate diff` reports no drift; the migration applies from zero on the
disposable test database on every integration run.

### 1) The metric vocabulary: 14 → 55

`HEALTH_METRIC_TYPES` grew to cover activity (flights, exercise minutes, stand
hours, cycling and swimming distance), body (height, BMI, lean mass, waist),
heart (walking HR, VO₂ max), respiratory (rate, blood oxygen, peak flow, FVC,
FEV1), nutrition (energy, seven macros, six minerals, seven vitamins, caffeine),
vitals (glucose, temperature) and mindfulness. The original fourteen keep their
keys, so every existing row, backup and goal `sourceRef` still resolves.

Each type carries a **group** (`activity | sleep | heart | body | respiratory |
nutrition | vitals | mind`), which is what drives the sub-pages, the import
preview's grouping and the search router — a metric added to the list appears
everywhere without a second edit.

New unit families came with them: length, gram/milligram/microgram, litre,
flow, glucose, VO₂ and temperature. **Temperature is the one affine
conversion** — °F is `(v − 32) × 5⁄9`, not a multiplier — and is handled
explicitly rather than bolted into the factor table. Two committed tests now
assert that every metric can read *its own* canonical unit and that every
metric round-trips through the display unit its entry form labels — the class
of bug where a stored row becomes silently unreadable, or "175" is stored as a
different quantity than it was typed as.

### 2) The parser: streaming, and hardened

`src/lib/logic/health-import/` gained three modules and lost two:

* **`xml-scanner.ts`** — an incremental, bounded XML scanner. Not a DOM parser
  (which would materialise the document) and not a general SAX parser (whose
  entity, namespace and DTD machinery is precisely what makes XML parsers
  dangerous). It has no entity table beyond the five predefined ones, cannot
  be told to fetch anything, and caps element size, prologue size, nesting
  depth and attribute count. An entity declaration or an external DTD is a hard
  refusal — the file is not read at all — while the several-kilobyte internal
  DTD subset that **every real export carries** is skipped normally. That
  distinction was found by testing against a real-shaped prologue; refusing all
  internal subsets would have refused every genuine Apple export.
* **`apple-stream.ts`** — the accumulator. The rollup happens *during* the
  scan: each record folds straight into a bucket keyed by (metric, day, source
  app), so memory is proportional to **distinct days × metrics × devices**, not
  to the number of samples. Collecting samples first and rolling up after —
  the obvious pipeline, and the one the browser version used — needs memory
  proportional to the file, which for a ten-year export is a crash.
* **`apple-members.ts`** — the archive's other files. An ECG's header is read
  and the scan stops at the blank line before the voltages; a route's distance
  is accumulated from consecutive points *while streaming* and the coordinates
  are discarded.
* `apple-xml.ts` and `zip-browser.ts` (browser-only) were removed.

Server-side, `src/server/apple-health/` adds a streaming ZIP reader (central
directory, ZIP64 sizes, stored + deflate, per-entry byte budgets, encrypted
entries refused, traversal-shaped names refused) and the orchestration that
pushes `export.xml` through the scanner a megabyte at a time with a
`StringDecoder`, so multi-byte characters straddling read boundaries survive.

Also handled, because a real export contains them: `<Correlation>` wrappers
(blood pressure, paired by instant — a half-recorded reading is dropped and
counted rather than reported as half), `<ActivitySummary>` ring totals
(attributed to their own source group so they can never be summed with the
watch's own records for the same day), `<WorkoutStatistics>` children,
`<WorkoutRoute>`, `<ClinicalRecord>`, and category records whose value is a
state rather than a number (stand hours count only hours recorded as *stood*).

### 3) The import pipeline

Upload is a **route handler**, not a server action: an action buffers its whole
body and caps it at a few megabytes. The request body streams to a scratch path
with the size counted as it arrives (`Content-Length` is a claim, not a fact),
the type is decided from the bytes rather than the name, and the temp directory
is removed in a `finally` on every path.

Staging writes the parsed plan into the session's chunk rows in bounded batches
and keeps only the summary on the session row, so a decade-long export stages
without a 60 MB blob in a column. Preview → confirm → history is unchanged in
shape. Confirm writes in one transaction, batched 500 rows per statement, and
recomputes exactly the days that changed.

Duplicate detection uses **one bounded range scan** for an Apple import — every
Apple fingerprint embeds the row's own date, so a single query finds every
possible collision however large the plan — and per-fingerprint lookups for
CSV, where the row count is small and a row's date may have changed since last
time.

One behaviour was corrected during testing: confirming a category whose every
row is already present used to fail with "Nothing was selected". That is what a
safe re-import looks like, so it now succeeds and records a zero-write batch;
only a genuinely empty selection is refused.

### 4) Undo, on the finance philosophy

`src/lib/logic/health-import/undo.ts` is pure and decides one thing: what an
undo does with each row the batch created.

* **remove** — untouched since the import wrote it.
* **keep_edited** — written to after the import finished. Nothing else in the
  app touches an imported health row (summary rebuilds write to summaries), so
  a later `updatedAt` means the user. A one-second grace stops an import
  classifying its own writes as edits.
* **keep_linked** — an imported workout that now has sets, or that a planner
  block points at. Deleting it would take that work with it.

The preview shows all three counts before anything is deleted. Deletes are
keyed on batch id **and** user id; a row a later import refreshed already moved
to that later batch; manual entries never had a batch id; and the batch is
stamped `undoneAt` so a second undo is a no-op rather than a way to reach rows
a later import wrote onto the same fingerprints.

### 5) The section

Eleven routes under one layout — Overview, Activity, Sleep, Heart, Body,
Nutrition, Workouts, Vitals, Trends, Import, History — each taking
`?range=7d|30d|90d|1y|all`, resolved server-side, so a view is shareable and
bookmarkable. "All time" asks for the account's earliest health day rather than
guessing, capped at ten years.

Every group page is one component, so six pages cannot drift apart in layout,
empty-state wording or how a range is applied. A day with no reading is a
**gap, never a zero** — averages skip empty days and charts leave them blank.
Sleep gets a per-night table with its stages; Vitals carries the non-numeric
records; Nutrition says in as many words that it is the *imported* figures and
that meals logged in `/nutrition` are deliberately kept separate.

### 6) Search, backup, demo data

* **Search.** A health metric hit is one entry per metric you actually have
  readings for — "Body weight · 412 readings · 178.4 lb yesterday" → the chart
  — not one hit per row; a decade of steps is one useful result, not ten
  thousand identical ones. Matching happens in memory against the fixed
  vocabulary and the database is asked one grouped question. Health records
  (ECGs, medications, clinical records) match by title, subtitle and kind.
* **Backup v7** carries `healthRecords`, ordered after `healthImportBatches` so
  a record keeps its batch link. `sanitizeRow` learned `BigInt` (JSON has none,
  so `xmlBytes` travels as a number) — without it a v7 batch row would have
  been silently dropped on restore.
* **Demo data** now writes an Apple-Health-shaped import: 70 days of
  device-attributed rows across activity, heart, respiratory, nutrition and
  staged sleep, five imported workouts, ECG/medication/clinical/route records,
  and a batch that can be undone. Fingerprints are built with the real
  `fingerprintFor`, so re-seeding is idempotent for the same reason a re-import
  is, and the demo exercises the real undo path against real-shaped rows.

### A real bug this phase found and fixed

Clicking a Health tab did nothing, about **40 % of the time** (measured: 7 of
15 trials on a fresh load). The click fired, Next's `<Link>` called
`preventDefault`, and then no `pushState` happened at all — no error, no
navigation, and clicking again did not help.

The cause: `(app)/loading.tsx` is a Suspense boundary for segments *below the
app shell*, which is why the sidebar was unaffected (0 of 16 trials). Health
tabs change a segment one level deeper, below `health/layout.tsx`, which that
boundary does not wrap — so React had to finish rendering the destination
before it could commit the transition, and a slow render lost the navigation
outright. Adding `src/app/(app)/health/loading.tsx` took it to **0 of 30**, and
tab switches now commit instantly behind a skeleton, which is the behaviour the
shell already documented for its primary tabs.

Worth recording because the first three hypotheses were all wrong (prefetch
storms, an overflow scroll container, a hydration race) and each was disproved
by measurement rather than argument.

### Testing

| Suite | Before | After |
| --- | --- | --- |
| Unit (`npm test`) | 903 | **968** |
| Integration (`npm run test:integration`) | 228 | **244** |
| Browser (`npm run test:e2e`) | 35 | **45** |

New coverage: the XML scanner's structure and its hostile-input refusals
(entity declarations, external DTDs, mismatched tags, oversized elements,
depth); the whole Apple vocabulary including affine temperature, fractional
percentages, blood-pressure pairing and ring totals; ECG and route parsing
asserting **no voltage and no coordinate survives**; the ZIP reader against
malformed directories, encrypted entries, traversal names and a decompression
bomb; a 60,000-record export asserting it folds to 400 rows in bounded heap;
the undo classification; and, database-backed, the whole path — stage, confirm,
re-import, incremental import, workout duplicate skipping, ownership from four
angles, expiry, undo with kept rows, and history.

The browser suite gained a full import round trip that **builds its own export
archive**, so it runs against any database including CI's empty one and cleans
up after itself by undoing what it created, plus the malformed-archive,
malformed-XML and entity-declaration refusals.

### Browser verification

Signed in against the production build with a synthetic 30-day export
(~700 records, 9 metric types, workouts with routes, blood-pressure
correlations, a medication and an ECG): import page → upload → preview showing
every expected category → confirm → the data present on Overview, Activity,
Sleep, Heart, Body, Nutrition, Workouts, Vitals and Trends → all five ranges →
universal search finding both "Body weight" and the medication by name →
re-import reporting everything already present and writing nothing → undo
preview → undo → the medication gone and the batch marked Undone. All 26 steps
pass, and the Health nav click-through is stable across repeated runs.

The only console noise is the pre-existing `/_vercel/insights/script.js` 404
that occurs whenever the app runs outside the Vercel platform.

### Performance notes

* Parsing is proportional to distinct days, not to samples: 60,000 records fold
  to 400 rows with heap growth in the low tens of megabytes (committed test).
* Everything a stranger controls is bounded: 2 GB upload (declared *and*
  actual), 6 GB decompressed XML enforced as bytes are produced, 256 KB per
  element, 64 KB prologue, depth 64, 256 attributes, 500 k accumulators,
  250 k point readings, 100 k workouts and records, 5 000 ECG/route files,
  32 MB per member, 64 MB per CSV. Hitting a cap is reported, never silent.
* Writes batch 500 rows per statement inside one transaction; the confirm for a
  multi-year import is a handful of round trips, not one per row.
* Duplicate detection for an Apple import is one range scan regardless of plan
  size.
* Reads are bounded by an explicit day window and metric list, over
  `(userId, type, date)`, `(userId, date)` and `(batchId)` indexes. A group page
  is one query for all of its metrics.
* Search adds one grouped query plus one bounded record query per keystroke
  batch, and matches metric names in memory against the fixed vocabulary.

### Deliberately not implemented (recorded so nothing reads as forgotten)

* **ECG waveforms, GPS routes on a map, raw clinical documents.** Read for
  their summary and dropped. Drawing an ECG or mapping a run is a different
  product, and holding that data is the highest-risk, lowest-value part of an
  export.
* **Live HealthKit sync.** A browser cannot subscribe to HealthKit. The export
  file is what actually works, and the app says so rather than implying
  otherwise.
* **Merging imported nutrition with logged meals.** They are two records of the
  same days; merging would double-count every meal. Kept on separate pages with
  the reason stated in the UI.
* **Basal body temperature**, and any other identifier whose meaning differs
  from the metric it would be folded into. Unmapped types are counted and
  listed, never guessed at.
* **Per-row undo** and **undo of an undo.** Undo is batch-shaped; the way back
  from an undo is re-importing the file, which the freed fingerprints allow.
* **Health goals on the new metrics.** The goal system already reads any metric
  through `getLatestMetricValues`; surfacing the new ones in the goal picker is
  a UI change, not a data one.
* **Clinical-record detail views.** The summary is listed; there is nothing
  further stored to show.

### Exact next step

Candidates in rough order of user value: health goals over the new metrics
(VO₂ max, blood oxygen, exercise minutes) using the existing goal engine; a
correlations view over the trend series the module already computes (sleep vs
resting HR, exercise vs HRV); nutrition reconciliation that *shows* imported
and logged figures side by side without merging them; per-metric detail pages
with the raw reading list and per-source breakdown; and folding health signals
into the "needs attention" digest Phase 33 left open.

---

## Phase A.2 — Health cleanup, import automation, and polish

Two halves: finish what Phase A.1 left open, then build the automation layer
that makes the import platform feel like a permanent part of the app rather
than a feature that was added once. No AI, deliberately — that is the next
phase, and nothing here anticipates it.

### Part 1 — cleanup

#### 1) The deployment limit, properly closed

Phase A.1 had already fixed the immediate cause (`maxDuration = 800`, above the
Hobby ceiling, which Vercel validates **at deploy time** and refuses the whole
deployment for). What it had not done was stop it happening again, or deal with
the *other* platform limit the app was quietly lying about.

* **A committed guard.** `tests/deploy-config.test.ts` walks every file under
  `src/app`, extracts any `maxDuration` export, and holds it to
  `MAX_FUNCTION_SECONDS` (60 — the highest value every plan accepts). It also
  asserts `vercel.json`'s crons stay inside the free plan's once-a-day cadence.
  This class of mistake is invisible to lint, types, tests and the production
  build; now it is a red test instead of a failed deploy.
* **A real finding from that work.** The first attempt made the route import
  the constant instead of repeating the number. Next.js statically analyses
  route segment config and **failed the build outright** — `Invalid segment
  configuration export detected`. So the literal stays, and the test asserts
  the literal matches the constant. Worth recording because "extract the magic
  number into a shared constant" is normally unambiguously right.
* **The upload limit is now true.** The app advertised and enforced 2 GB. On
  Vercel, a request body above ~4.5 MB is rejected by the platform before the
  function runs, with a 413 the app never sees and cannot phrase — so a user
  waited for a large upload only to get an opaque platform error.
  `resolveUploadLimit()` returns what the deployment can actually keep: 2 GB
  self-hosted, the platform cap when `VERCEL` is set, and `HEALTH_MAX_UPLOAD_MB`
  when an operator knows better (never above the app's own ceiling). The import
  page states it up front and the refusal says the platform is the reason and
  self-hosting lifts it.
* A smaller bug fell out: the size formatter rounded to whole gigabytes, so any
  cap below half a gigabyte printed as "larger than the **0 GB** limit".

#### 2) The sign-up limiter flake

Sign-up is fenced at 8 attempts per client per hour. The browser suite spends
two of them per run (the journey, plus the duplicate-email check). Behind no
proxy, `clientRateLimitKey` finds no forwarding header and every run resolves to
the same `signup:unknown` bucket — so the **fourth run within an hour failed**,
the suite tripping the application's own abuse protection because the test
environment made every run look like one persistent client.

Fixed entirely on the test side; the protection is untouched and is still
asserted directly by `tests/integration/signup-flow.test.ts`.

* Playwright assigns one synthetic `x-forwarded-for` per run, in the runner
  process so every worker inherits it — the same mechanism the config already
  used for the browser path. Each run is now its own client, which is what
  separate runs genuinely are.
* `seed:e2e` prunes the throwaway `@e2e.local` accounts the journey creates and
  clears the four fence buckets in the disposable database. Running it after
  this session's work reported **24 stale accounts and 98 counters** — the
  accumulation was real, not theoretical.

#### 3) Browser determinism

* **Cross-spec interference, removed at the source.** Spec files run in
  parallel across workers, and the import round trip (a month of readings, a
  summary rebuild, then an undo) shared the `alice` account with the manual
  health-entry check. Individually correct, jointly a race. The import spec now
  owns `importer@example.com` and nothing else touches it.
* **The undo assertion no longer races a toast.** It asserts durable state —
  the batch row's own "Undone …" line and the disappearance of its undo button
  — instead of a notification that dismisses itself.
* **A clean console is now an assertion**, with the failing URL captured
  alongside the message (a failed resource load reports a generic "404" and
  puts the URL in the location, so matching on text alone can neither exclude
  the known-noisy Vercel request nor tell a reader what failed).
* Sign-out navigations, which are a server round trip and can coincide with the
  import spec's large write in the other worker, were given a timeout matched to
  a loaded server. Observed twice in ~12 full runs; never reproducible in 20
  stress repeats of the flow alone, which is what points at contention rather
  than a race. What is asserted did not change.

### Part 2 — automation and polish

#### 4) Smart merge — the one behaviour with real teeth

A fingerprint is a stable *identity*, not a claim of ownership. The old
pipeline overwrote any row whose fingerprint matched, whoever had touched it —
so a weight you corrected by hand was silently replaced by the next import, and
the file is the authority while your correction is not in it. Undo already drew
this line (`keep_edited`); re-import did not, which meant undo protected an edit
that the next import destroyed.

`src/lib/logic/health-import/merge.ts` is pure and decides one thing per row:
**create · merge · unchanged · protected**, with `protected` covering both "you
edited it after the import finished" and "no import wrote it at all". It shares
`UNDO_GRACE_MS` with undo, deliberately — a row protected from re-import but
removable by undo would be a contradiction the user could observe, and a test
asserts the two constants are the same.

Three properties that matter more than the happy path:

* **Ownership is re-read inside the confirm transaction**, never carried from
  the preview. A staged import can sit for two hours; a row edited in that
  window is protected on the strength of what is true when the write happens.
* **Ambiguity means hands off.** A row whose `batchId` does not resolve to one
  of *this user's* batches — a partial restore, a hand-edited database — is
  protected. Refusing to write is recoverable; overwriting is not.
* **Every protected row is reported**, in the preview's warnings, on the result
  screen and on the batch. A skip the user is not told about is
  indistinguishable from data loss.

The preview and the write run the same function, so the preview is a promise
rather than an estimate.

#### 5) Integrity checks

Seven read-only checks over what imports leave behind, in **six aggregate
queries** — two `groupBy`s and four counts, not one of which materialises a row.
That is why the panel costs the same for 400 readings and 4,000,000.

The trade is stated rather than hidden: a min/max says a metric *holds* an
impossible reading without saying how many, so the implausible-value check
counts **metrics**, not rows. Bounds are deliberately absurd rather than
clinical, and a committed test holds them to an ordinary healthy range for every
bounded metric — a 34 bpm resting heart rate is a well-trained athlete, and a
check that flags real data teaches you to ignore the panel.

Nothing is repaired. The app never silently rewrites a stored reading on the
strength of a heuristic; the findings tell you which page to open.

#### 6) The import dashboard and searchable history

`/health/imports` became the place the state of every import lives: last
successful import and its recency against the user's own today, runs split by
outcome, readings written / merged / kept as yours, a staged-import callout, the
integrity panel, and a searchable, status-filtered history. The totals are
**aggregates over every batch**, not sums of the visible page — otherwise an
account with hundreds of imports is shown a number that silently means "of the
most recent hundred", and the list says so when it is capped.

**Version awareness**: every batch records `formatVersion`. A batch from
pipeline v1 says so in the history, because its "0 kept as yours" is a fact
about the importer of the day rather than a promise about the data — and a
future change now has something to migrate *from* instead of inferring an old
batch's semantics from its dates.

#### 7) Two real bugs found by looking

* **A hydration mismatch that swallowed clicks.** `Badge` renders a `<div>`;
  the integrity card put one inside a `<p>`. The parser hoists it, the DOM stops
  matching what the server sent, React discards the tree and re-renders — and a
  click landing in that window is lost. It presented as *the undo button not
  opening its dialog*, deterministically, with no error anywhere except a
  minified React #418 on that one page. Fixed twice over: `Badge` now renders a
  `span` rather than a `div` (its base class was already `inline-flex`, so the
  two are visually identical and the mistake becomes impossible everywhere
  rather than guarded against in one place), and a dedicated spec asserts every
  page in the section hydrates cleanly — for an empty account *and* the seeded
  one, in its own file so CI's empty database does not skip it.
* **Demo data that lied about itself.** The seeded import's rows were stamped
  `now()` while the batch's `finishedAt` was two days earlier, so undo
  classified all 1,682 readings as user-edited and the preview offered to remove
  **nothing** while claiming the user had personally corrected every one. The
  batch's `createdAt` also disagreed with its own timings by two days. Both
  fixed; the demo undo now reports 1,682 readings, 5 workouts and 5 records.

#### 8) Polish, demo data, performance

* Overview: headline tiles carry a direction-of-travel delta coloured by the
  metric's own `goodDirection` (a falling resting heart rate is good news), a
  quick-link row, history depth and 30-day coverage in the header, and an import
  card that reads "2 days ago" instead of a UTC-sliced date that was off by one
  either side of midnight.
* Group pages render panels only for metrics that have readings, and list the
  rest in one line. Nutrition covers twenty-odd metrics; a page of identical
  "nothing recorded" cards buried the four that had data.
* `SectionCard` descriptions wrap instead of truncating — a sentence cut off
  mid-word tells the reader less than nothing. Metric labels likewise.
* Demo data gained an earlier CSV import (a smart scale, stamped
  `formatVersion: 1` so the history's version note is demonstrable) and a failed
  import that owns no rows, which is exactly what a rolled-back import is. Three
  batches is also what makes the search box and status filters judgeable.
* Performance: the overview's import count was a sequential await *after* a
  `Promise.all` — one avoidable round trip on the section's busiest page — and
  rows were re-filtered by type once per metric across ~25 metrics. Both fixed;
  no new index was needed.

### Schema

Migration `20260731200000_health_import_merge_integrity` — additive only, two
columns on `HealthImportBatch`, both with defaults:

* `protectedRows` — readings a re-import deliberately left alone. Existing
  batches default to 0, which is exactly what they did: the old pipeline
  overwrote instead of protecting, so it protected nothing.
* `formatVersion` — which pipeline wrote the batch. Existing rows default to 1.

No index was added; the existing `(userId, createdAt)` and `(userId, status)`
serve every new query. `prisma migrate diff` reports no drift and the migrations
apply from zero on every integration run.

**Backup v8** carries both. It adds no tables — the bump exists so an older app
*refuses* a v8 file rather than restoring it silently without the merge
accounting. A v1–v7 file restores unchanged, and its defaults are the truth
about those older records rather than placeholders.

### Testing

| Suite | Before | After |
| --- | --- | --- |
| Unit (`npm test`) | 968 | **1,011** |
| Integration (`npm run test:integration`) | 244 | **263** |
| Browser (`npm run test:e2e`) | 45 | **49** |

New coverage: the merge rule in every branch (including the grace period, the
shared-boundary invariant with undo, and the legacy `createdAt` fallback); every
integrity rule plus the negative case that ordinary healthy data is never
flagged; the deployment-config guard; database-backed smart merge (protect,
merge, re-read-at-confirm, foreign batch, and a protected row still being kept
by undo); the dashboard's aggregates, recency buckets, truncation and
cross-account isolation; integrity against real rows and across accounts; and
the v8 backup round trip plus a v7 restore.

### Verification

* Typecheck, lint, unit, integration, migration drift check and production
  build: all pass.
* Browser: **four consecutive full runs, 0 failed** (one pre-existing documented
  `fixme`). CI green on the first push: lint/types/tests/build/migrations,
  browser tests, and the Vercel preview deployment — which is the deployment
  limit fixed, confirmed on the real hosting stack rather than argued about. Health pages verified at 1280px and 720px with no
  horizontal overflow, and no console errors beyond the pre-existing
  `/_vercel/insights/script.js` 404 that every non-Vercel deployment produces.

### Deliberately not implemented

* **Field-level merge, or "prefer the higher value".** The first version is
  conservative on purpose: a row is the import's or it is yours.
* **Per-row conflict resolution.** A prompt per conflicting reading is a
  different product; the batch-level report is what a user can actually act on.
* **Repairing what the integrity checks find.** Read-only by design — the app
  does not rewrite a stored reading on a heuristic.
* **An exact row count for implausible values.** It would cost a scan on a page
  that must stay cheap; the check counts metrics and says so.
* **Server-side history search.** Filtering a bounded list in the browser is
  faster than a query per keystroke against the health tables.

### Exact next step

The AI assistant phase. Everything it would read from is now in place and
stable: bounded read models per module, one aggregation path, a health platform
that reports its own state honestly, and an import pipeline whose behaviour is
described rather than guessed at.

Non-AI candidates that remain open, in rough order of value: health goals over
the new metrics (VO₂ max, blood oxygen, exercise minutes) through the existing
goal engine; a correlations view over the trend series the module already
computes; nutrition reconciliation showing imported and logged figures side by
side without merging them; per-metric detail pages with the raw reading list;
and folding health signals into the "needs attention" digest Phase 33 left open.

---

## Phase A.3 — Apple Health large-file import: the upload, restructured

The AI assistant phase is still next. This phase exists because the Health
module had a defect that made it unusable on the deployment it was built for,
and shipping an assistant on top of an importer that cannot import would have
been building on sand.

### The bug, stated plainly

On the hosted deployment every Apple Health import failed with:

```
413 FUNCTION_PAYLOAD_TOO_LARGE
```

Not slowly, not sometimes — always, and before a single line of this
repository's code ran. Vercel refuses a request body above ~4.5 MB **at the
edge**. The importer POSTed the entire `export.zip` to `/api/health/import` as
one body. A real Apple Health export is one to three orders of magnitude larger
than that cap.

Everything downstream of the transport was already correct and stays untouched:
the streaming ZIP reader, the bounded XML scanner, the per-day rollup, duplicate
detection, the merge rules, preview, undo, history, integrity checks. The file
simply never reached them.

Two details are worth recording, because they are why this survived a phase
that was explicitly about deployment limits:

* **The app could not see the failure.** A platform-edge rejection never
  reaches the function, so there was nothing to catch, phrase, log or retry.
  Phase A.2 did the honest thing available at the time — it detected `VERCEL`
  and *advertised* 4.5 MB as the limit, so the user was told the truth up front
  instead of hitting an opaque 413. That was accurate and useless: the truth it
  told was "this deployment cannot import your Apple Health export."
* **The browser reported it as a network blip.** The client called
  `response.json()` unguarded; the edge answers HTML, so every such failure
  surfaced as "The upload did not complete." That is now handled explicitly
  (`readJson`), with a test.

### The fix: stop making the file size and the request size the same number

```
before   browser ──────── the whole export.zip ────────► /api/health/import ──► parse
                          (one request; refused at the edge above 4.5 MB)

after    browser ──► POST   /api/health/import           open a session
                 ──► PUT    /api/health/import/part × n  4 MB each, retried individually
                 ──► POST   /api/health/import/finalize  reassemble → parse → stage → preview
```

| | Before | After |
| --- | --- | --- |
| Requests per import | 1 | 1 open + *n* parts + 1 finalize |
| Largest request | the whole archive | **4 MB** (`UPLOAD_PART_BYTES`) |
| Hosted ceiling | 4.5 MB (the request cap) | **256 MB** (`VERCEL_STAGED_UPLOAD_BYTES`) |
| Self-hosted ceiling | 2 GB | 2 GB (unchanged) |
| A dropped connection | the whole upload again | that one part again |

`UPLOAD_PART_BYTES` sits half a megabyte below the platform cap on purpose: the
cap counts the whole request, and a part travels with headers and a query string
beside it. `tests/deploy-config.test.ts` asserts that relationship, because a
part size raised above the cap would fail *only* in production — which is
exactly how the original bug reached a deployed app.

### Why the parts live in the database

Two requests to a serverless platform are not guaranteed to reach the same
machine, so appending to a local file across requests silently loses data. The
account's own database is the one place both requests can see; it needs no
extra service, credential or paid tier; and it inherits the ownership model
everything else here already has.

The bytes are transient in exactly the way the old scratch file was: every part
is deleted inside the same invocation that reads it, on every path including a
parse failure. An abandoned upload expires after an hour, is swept whenever
another upload is opened, and again by the daily cron (folded into the existing
reminders tick rather than spending the free plan's second cron slot).

Rejected alternatives, and why: **Vercel Blob** (a new service and credential
for a self-hosting-first app, and another place health data lives);
**client-side parsing** (deliberately undone in Phase A.1 — it means trusting
numbers a browser produced); **streaming the body past the cap** (undocumented
platform behaviour is precisely the brittle workaround this phase was told not
to build).

### Schema (migration `20260731212757_health_upload_staging` — additive only)

Two new tables, no column changed, nothing dropped:

* **`HealthUploadSession`** — one in-flight upload: owner, base filename,
  declared size (a claim, used only to size the upload), server-counted
  `receivedBytes`/`receivedParts`, `totalParts`, `partBytes`, status, expiry.
* **`HealthUploadPart`** — one slice, as `BYTEA`. Unique on `(sessionId, seq)`,
  which is what makes a retried part *replace* rather than duplicate.

Neither table appears in backups, and neither should: they hold a file that
exists for minutes. `prisma migrate diff` reports no drift and the migrations
apply from zero on every integration run.

### What is never trusted

* The declared file size only *sizes* the upload. What binds is what the server
  counted, recomputed from the stored rows before the parse.
* A part index outside `[0, totalParts)` is refused, and `(session, seq)` is
  unique — so the most a client can store is `totalParts × partBytes`, a bound
  that holds under concurrency however the client behaves.
* Every query resolves the session by `(id, userId)`. Another account's id does
  not resolve at all rather than being refused, so there is nothing to probe.
* The archive's type is still decided from its bytes, never from its name.

### A gap the browser found

Verifying this by hand surfaced something the tests had not: a tab closed
between "open the session" and "send the first part" left a zero-byte session
holding one of the account's two upload slots for fifteen minutes. Two of those
and the account could not import at all — a self-inflicted lockout with no
bytes stored to show for it.

Two changes closed it, both tested: the client's abandon request now uses
`keepalive`, so it outlives the closing document (paired with a `pagehide`
listener, since unmount does not run when a tab is closed); and a session with
zero parts after two minutes is treated as dead and cleared, separately from
the fifteen-minute idle rule that protects an upload genuinely in flight.

### UI

The import page now shows named stages — **Staging → Upload → Parsing →
Preview → Import → Summary** — with a progress bar, a byte count and a part
counter while the archive is going up, and a Cancel button that actually
cancels (aborting in flight *and* deleting the staged parts). This is not
decoration: uploading a large export takes minutes and parsing it takes
seconds, and one undifferentiated spinner leaves a user unable to tell a slow
upload from a stuck one.

### Testing

| Suite | Before | After |
| --- | --- | --- |
| Unit (`npm test`) | 1,011 | **1,033** |
| Integration (`npm run test:integration`) | 263 | **292** |
| Browser (`npm run test:e2e`) | 49 | 49 (rewritten to assert the transport) |

New coverage: the browser upload client against a fake server (slicing,
**no request ever carrying more than one part**, byte-exact reassembly, retry
of a transient failure, no retry of a refusal the server meant, cancellation,
`keepalive` on abandon, and an HTML platform rejection still read as a readable
message); the server session module against real PostgreSQL (staged success,
a multi-megabyte archive in bounded parts, incomplete upload refused with
nothing staged, idempotent re-send, every ownership rule, both eviction rules,
sweep, expiry, and that duplicate detection, history and undo are unchanged
through the staged path); and the deployment-config invariants that keep a part
below the platform cap.

The browser suite's archive is now deliberately **larger than a single request
may carry**, and the test asserts the transport itself — one session, several
parts, one finalize, and no 413 anywhere — rather than only that the import
worked.

### Verification

* Typecheck, lint, unit, integration and production build: all pass.
* Browser: full suite **49 passed, 0 failed** (1 pre-existing documented
  `fixme`). The health-import spec passed on four consecutive runs.
* Manual large-file check, three consecutive runs: a **24 MB** archive →
  1 open + 7 parts + 1 finalize, every response 200, **no 413**, preview
  shown, import confirmed, readings visible on `/health/activity`, history
  entry written, undo removed it, zero leftover upload sessions, and no console
  errors beyond the `/_vercel/insights/script.js` 404 every non-Vercel
  deployment produces. A **64 MB** archive completed the same round trip in 17
  parts. (Above ~50 MB Playwright's own CDP file transfer intermittently
  delivers an empty `input.files` — a harness limit, not an app one — so the
  repeatable check is pinned below it.)

### Performance notes

* Parsing is untouched: the same streaming reader, the same bounds, the same
  per-day accumulators. A 24 MB archive's parse still reports as sub-second.
* Reassembly reads four parts per round trip, streamed straight to disk, so
  peak memory is a few megabytes whatever the export weighs.
* The archive crosses the wire twice (up in parts, down once to be parsed).
  That is inherent to staging on a platform with no shared scratch, and it is
  bounded by the same 60 s invocation the parse already had.
* Cleanup is a single indexed `deleteMany` on `expiresAt`. Cleanup that costs
  anything is cleanup that gets turned off.

### Deliberately not implemented

* **A resumable upload.** A half-finished upload is not something a user should
  have to reason about; picking the file again is one click and always correct.
* **Blob or object-storage drivers.** The store sits behind a small module
  boundary so one could be added, but adding a service and a credential to fix
  a problem the database already fixes is not an improvement.
* **Staging the backup import the same way.** It has the identical defect and
  the identical fix, and it is a separate change with its own restore-safety
  surface. Recorded in `docs/troubleshooting.md` as the obvious next candidate.
* **Parallel parsing, or parsing parts as they arrive.** Inflate state cannot
  span invocations, and the ZIP central directory is at the end of the file.

### Exact next step

**The AI assistant phase.** The reason this phase came first is now closed: the
import path works on the deployment it ships to, end to end, and is asserted to
keep working by tests that fail in CI rather than in production.

The non-AI candidates from Phase A.2 remain open and unchanged: health goals
over the new metrics through the existing goal engine; a correlations view over
the trend series; nutrition reconciliation; per-metric detail pages; folding
health signals into the "needs attention" digest. Staged upload for the
**backup** import is now on that list too.
