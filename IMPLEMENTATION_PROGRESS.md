# Personal OS — Preview 3 Upgrade: Implementation Progress

> Living document. Updated after every completed phase. If you are resuming this
> work in a new session, **read this file first**, then run
> `git log --oneline -12 && npm test`.

**Branch:** `claude/personal-os-phase-8-or6v6y` (restarted from `main` after PR #5 merged; the session's branch name is fixed and now carries Phase 9)

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

**Last stable commit:** Phase 9 — food providers, real servings, snapshotted entries (see the Phase 9 section).

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
| 10 | Workout session system                             | ⬜ not started |
| 11 | Health imports & health metrics                    | ⬜ not started |
| 12 | Demo-data separation & onboarding                  | ⬜ not started |
| 13 | Reminders                                          | ⬜ not started |
| 14 | Search & command palette                           | ⬜ not started |
| 15 | Backup & import updates                            | ⬜ not started |
| 16 | Accessibility, responsiveness, performance         | ⬜ not started |
| 17 | Full testing & polish                              | ⬜ not started |

**Current phase:** 10 — Workout session system (**not started**)

**The task's stated highest-priority milestone is complete** (central schedule
engine, scheduled goals, scheduled habits, rest-day behaviour, streaks, day
score, calendar/insights consistency). Phase 7 closed the last outstanding bug
from the Phase 0 audit, Phase 8 has given Dashboard, Today and Planner one job
each, and Phase 9 has replaced the bundled-only food table with a provider
architecture. Everything from Phase 10 on is still outstanding and the app
remains on its pre-upgrade implementations for those areas — see "What is NOT
done" below, which is deliberately explicit so nothing reads as finished when it
is not.

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
npm test                  # PASS 421/421
npm run build             # PASS
npm run start             # all 11 routes 200, no server errors
```

## Tests passing

421 tests across 15 files. 341 of them are new and cover business behaviour, not
rendering:

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
| 11 — Nutrition recalculation (Phase 9) | ✅ Editing, moving, duplicating and deleting an entry each move the day's totals, the goal progress and the day score, all through the one `recomputeDay` path. Verified numerically in a browser. |
| 8 — Demo data removal | ❌ Not addressed yet — Phase 12. |
| 9 — Backup round-trip | ⚠️ **Partly.** Export verified in a real browser: format v2 with `scheduleRules=15`, `scheduleRuleDays=21`, a checksum, the app version and the user's timezone. A full export→modify→restore-into-a-clean-database round trip has **not** been executed end to end. |

### Browser verification (Playwright + Chromium)

Driven against the running production build.

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
2. ~~Backups do not yet include the new tables.~~ **Fixed** — backup format v2
   covers `ScheduleRule`, `ScheduleRuleDay`, `ScheduleOverride`, `GoalEntry`,
   `SeedBatch` and `SeedRecord`, with metadata and a checksum. Still outstanding
   from Phase 15: the *import UI* does not yet show the preview that
   `previewBackup()` now returns, there is no automatic pre-import backup, and
   the restore is not wrapped in a single transaction. A full
   export→modify→restore round trip has not been executed end to end.
3. ~~Routine/template application still duplicates.~~ **Fixed in Phase 7.**
   Still outstanding in this area: the four-way choice exists only on the
   **routine bar**; the command palette has no routine-apply entry to route
   through it. Overlap warnings are shown on the **day list** only — the
   timeline, week grid and month grid do not surface them yet. And
   `moveScheduleItem` still has no conflict check of its own, so dragging an
   item onto an occupied slot succeeds silently and only shows the warning
   afterwards.
4. **`SeedBatch`/`SeedRecord` exist but nothing writes to them**, so "remove demo
   data" is not yet possible.
5. **Reminders are not schedule-aware yet** — `reminder-watcher.tsx` still fires
   from the old `Reminder` table. The `reminderEnabled`/`reminderMinute` fields
   on `ScheduleRule` are written by the editor but **not yet consumed**.
6. ~~Nutrition still searches only the bundled local food table.~~ **Fixed in
   Phase 9** — provider architecture, USDA and Open Food Facts, local caching,
   offline behaviour. **But no live provider request has ever been made** (the
   sandbox blocks both hosts with a 403 at the CONNECT stage), so the normalisers
   are verified against captured fixtures only. Also still outstanding in this
   area: there is no barcode *scanner*, only barcode-as-a-search-term; no
   background refresh of stale cached foods; no per-provider result quota, so a
   generous USDA response can crowd out Open Food Facts within the 25-result cap;
   and `getFoodShortcuts` still returns at most 12 recents.
7. Workouts have no in-progress session model — starting a template still
   behaves as before.
8. No Apple Health / CSV import UI. `importHealthMetrics` exists as a server
   action with no interface.
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
11. **The host-clock fix is partial.** `isToday` / `isPast` / `isFuture` /
    `relativeDayLabel` now accept a reference day, and the Dashboard, Today,
    Planner, Calendar and the topbar pass the user's. Still on the host clock:
    `consistency-heatmap.tsx`, `quick-add-dialog.tsx`, `template-bar.tsx`,
    `workout-manager.tsx`, `habit-dialog.tsx` (new-habit start date) and the
    `ui-store` default context date. None of them decide a score; they mislabel
    a day for the hours the two zones disagree. Finishing this belongs with the
    accessibility/polish work in Phase 16/17.
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

## Exact next step

**Phase 9 — nutrition provider architecture & food search.** Nothing from it
has been started. `searchFoods` in `src/server/queries.ts` still searches only
the bundled table plus the user's custom foods; there is no provider
abstraction, no USDA or Open Food Facts client, and `USDA_FDC_API_KEY` is not
referenced anywhere in the repository.

Resume with:

```
cd /home/user/Daily-Schedule
git log --oneline -12
npm install && npx prisma generate
npm run db:push && npm run db:migrate && npm run db:seed   # dev.db is gitignored
npm test && npm run typecheck && npm run build
```
