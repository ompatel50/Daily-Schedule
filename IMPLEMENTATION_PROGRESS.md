# Personal OS — Preview 3 Upgrade: Implementation Progress

> Living document. Updated after every completed phase. If you are resuming this
> work in a new session, **read this file first**, then run
> `git log --oneline -12 && npm test`.

**Branch:** `claude/personal-os-preview-3-upgrade-1gw0gt`

> Note on branch naming: the task text asked for `feature/personal-os-preview-3`.
> The session environment mandates development and pushes on a
> session-assigned `claude/…` branch, and pushing anywhere else is prohibited.
> All work therefore lives on the designated branch, which serves the same
> purpose (an isolated feature branch off `main`). Phases 0–6 and 15a were done
> on `claude/personal-os-preview-3-y6pmoe`, which has since been merged into
> `main` (PR #3, merge commit `f8391d0`) and deleted.

**Last stable commit:** `d5789aa` — Phase 7: stop routines duplicating, and
finish the recurrence scopes.

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
| 8  | Dashboard / Today / Planner separation             | ⬜ **next** |
| 9  | Nutrition provider architecture & food search      | ⬜ not started |
| 10 | Workout session system                             | ⬜ not started |
| 11 | Health imports & health metrics                    | ⬜ not started |
| 12 | Demo-data separation & onboarding                  | ⬜ not started |
| 13 | Reminders                                          | ⬜ not started |
| 14 | Search & command palette                           | ⬜ not started |
| 15 | Backup & import updates                            | ⬜ not started |
| 16 | Accessibility, responsiveness, performance         | ⬜ not started |
| 17 | Full testing & polish                              | ⬜ not started |

**Current phase:** 8 — Dashboard / Today / Planner separation

**The task's stated highest-priority milestone is complete** (central schedule
engine, scheduled goals, scheduled habits, rest-day behaviour, streaks, day
score, calendar/insights consistency), and Phase 7 has closed the last
outstanding bug from the Phase 0 audit. Everything from Phase 8 on is still
outstanding and the app remains on its pre-upgrade implementations for those
areas — see "What is NOT done" below, which is deliberately explicit so nothing
reads as finished when it is not.

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

### Bugs confirmed by reading the code, and their status

| Bug | Status |
|---|---|
| Goals had no schedule at all — "workout Mon/Tue/Thu/Fri" unrepresentable | ✅ fixed (Phase 3) |
| `weekly` habits were "due" every day → the `3 of 7` bug | ✅ fixed (Phase 4) |
| `skipped` silently protected a streak; no `excused` state existed | ✅ fixed (Phase 4) |
| Score divided by all planner items and returned 0 for an untracked day | ✅ fixed (Phase 5) |
| No score explanation anywhere | ✅ fixed (Phase 5) |
| `Goal` unique on `(userId, domain, metric, period)` blocked two workout goals | ✅ fixed (Phase 1) |
| Timezone stored but never used; `today()` used the host clock | ✅ fixed (Phase 6) |
| `workoutMinuteGoal = weeklyGoal * 45 / 7` — an invented constant | ✅ removed (Phase 5) |
| `applyScheduleTemplate` had no duplicate protection | ✅ fixed (Phase 7) |

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
npm test                  # PASS 253/253
npm run build             # PASS
npm run start             # all 9 routes 200, no server errors
```

## Tests passing

253 tests across 11 files. 173 of them are new and cover business behaviour, not
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
| 7 — Score consistency | ✅ Dashboard, Today and the calendar detail render byte-identical explanations for the same date (`43% — 7 of 22 applicable opportunities met`, 3 exclusions). Insights reports the same window in scheduled opportunities. |
| 8 — Demo data removal | ❌ Not addressed yet — Phase 12. |
| 9 — Backup round-trip | ⚠️ **Partly.** Export verified in a real browser: format v2 with `scheduleRules=15`, `scheduleRuleDays=21`, a checksum, the app version and the user's timezone. A full export→modify→restore-into-a-clean-database round trip has **not** been executed end to end. |

### Browser verification (Playwright + Chromium)

Driven against the running production build.

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
6. Nutrition still searches only the bundled local food table. No USDA or Open
   Food Facts provider exists, and `USDA_FDC_API_KEY` is not referenced anywhere.
7. Workouts have no in-progress session model — starting a template still
   behaves as before.
8. No Apple Health / CSV import UI. `importHealthMetrics` exists as a server
   action with no interface.
9. `getDayScores` over a range calls `getDayScore` per day, which is several
   queries per day. Fine for a month; it should be batched before anything asks
   for a year. Not yet a user-visible problem.

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

## Exact next step

**Phase 8 — Dashboard / Today / Planner separation.**

The three surfaces currently overlap: `/` (dashboard), `/today` and
`/planner?view=day` all render largely the same day list via the same
`DaySchedule` component, and it is not obvious which one a user should open.
Phase 8 should give each a distinct job — dashboard as an at-a-glance overview
across domains, Today as the single focused "what now" surface, Planner as the
editing and scheduling surface — without duplicating the read models.

Start by reading `src/app/page.tsx`, `src/app/today/page.tsx` and
`src/app/planner/page.tsx` side by side and listing exactly what each renders
today; several sections are the same server query called three times.

Resume with:

```
cd /home/user/Daily-Schedule
git log --oneline -12
npm install && npx prisma generate
npm run db:push && npm run db:migrate && npm run db:seed   # dev.db is gitignored
npm test && npm run typecheck && npm run build
```
