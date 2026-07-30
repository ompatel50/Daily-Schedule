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
| 20 | Authentication and user isolation                 | ⏳ in progress |
| 21 | Local backup → hosted-account migration           | — |
| 22 | Hosted health-import architecture                 | — |
| 23 | Navigation and route performance                  | — |
| 24 | Deferred feature improvements                     | — |
| 25 | Production security                               | — |
| 26 | Deployment and production configuration           | — |
| 27 | CI and complete verification                      | — |
| 28 | Documentation and release handoff                 | — |

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
