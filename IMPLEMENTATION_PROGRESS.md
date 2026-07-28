# Personal OS — Preview 3 Upgrade: Implementation Progress

> Living document. Updated after every completed phase. If you are resuming this
> work in a new session, **read this file first**, then run
> `git status && git log --oneline -10 && npm test`.

**Branch:** `claude/personal-os-preview-3-y6pmoe`

> Note on branch naming: the task text asked for `feature/personal-os-preview-3`.
> The session's environment mandates development and pushes on
> `claude/personal-os-preview-3-y6pmoe`, and pushing anywhere else is prohibited.
> All work therefore lives on the designated branch, which serves the same
> purpose (an isolated feature branch off `main`).

**Last stable commit:** _see `git log` — updated per phase below._

---

## Phase checklist

| #  | Phase                                              | Status |
|----|----------------------------------------------------|--------|
| 0  | Repository audit + safety                          | ✅ done |
| 1  | Database & migration design                        | ⬜ not started |
| 2  | Central date & schedule engine                     | ⬜ not started |
| 3  | Scheduled goals                                    | ⬜ not started |
| 4  | Scheduled habits                                   | ⬜ not started |
| 5  | Explainable day-score engine                       | ⬜ not started |
| 6  | Calendar & insights corrections                    | ⬜ not started |
| 7  | Planner duplicate prevention & recurrence          | ⬜ not started |
| 8  | Dashboard / Today / Planner separation             | ⬜ not started |
| 9  | Nutrition provider architecture & food search      | ⬜ not started |
| 10 | Workout session system                             | ⬜ not started |
| 11 | Health imports & health metrics                    | ⬜ not started |
| 12 | Demo-data separation & onboarding                  | ⬜ not started |
| 13 | Reminders                                          | ⬜ not started |
| 14 | Search & command palette                           | ⬜ not started |
| 15 | Backup & import updates                            | ⬜ not started |
| 16 | Accessibility, responsiveness, performance         | ⬜ not started |
| 17 | Full testing & polish                              | ⬜ not started |

**Current phase:** 1 — Database & migration design

---

## Phase 0 — Repository audit

### Stack

| Concern | Finding |
|---|---|
| Framework | Next.js `15.5.22`, App Router, React `19.2.0` |
| Language | TypeScript 5.9, `strict: true` |
| Package manager | npm (package-lock.json committed) |
| Database | SQLite via Prisma `6.19.3` (`prisma/dev.db`, gitignored) |
| ORM | Prisma Client |
| Migration system | **None — `prisma db push` only.** No `prisma/migrations/` directory exists. |
| Seed | `prisma/seed.ts` run through `tsx` (`npm run db:seed`) |
| Date library | `date-fns` v4 |
| Timezone handling | Calendar days as `YYYY-MM-DD` "day keys" (`src/lib/date.ts`); `Date` objects only at the edges, normalised to local noon in `fromDayKey` so DST can't shift a day. `User.timezone` is stored but **never actually used** for conversion — everything runs in server/browser local time. |
| State management | Server Components + server actions; `zustand` store (`src/store/ui-store.ts`) for UI-only state |
| Forms | Controlled React state, no form library |
| Validation | `zod` v3 (`src/lib/validation.ts`) — every server action validates through a schema |
| Styling | Tailwind CSS 3.4 + CSS variables, `next-themes` for dark mode |
| Components | Radix UI primitives wrapped in `src/components/ui/*` (shadcn-style), `class-variance-authority`, `lucide-react` icons |
| Charts | `recharts` v3 (`src/components/shared/charts.tsx`) |
| Testing | `vitest` v4, node environment, `tests/**/*.test.ts` (6 files, 102 tests) |
| API routes | **None.** All mutations are `"use server"` server actions in `src/server/actions/*`. |
| Env handling | `scripts/ensure-env.mjs` writes a default `.env` pre-dev/build; only `DATABASE_URL` is used |
| Error handling | `ActionResult<T>` discriminated union (`{ok:true,data}` / `{ok:false,error,fieldErrors}`) returned from every action; `sonner` toasts in the client |
| Backup | `src/server/actions/backup.ts` + `src/lib/backup-format.ts` — JSON export/import |
| Import | Backup JSON restore only. `importHealthMetrics` exists as a server action but **has no UI** (fake-adjacent: reachable only from code). |
| Notifications | `src/components/shared/reminder-watcher.tsx` — browser Notification API polling |
| Keyboard shortcuts | `src/components/layout/keyboard-shortcuts.tsx` |
| Search | `searchEverything` in `src/server/queries.ts` + `cmdk` command palette |

### Existing models

`User`, `Tag`, `ScheduleItemTag`, `ScheduleItem`, `ScheduleTemplate`, `Habit`,
`HabitLog`, `FoodItem`, `Meal`, `MealEntry`, `MealTemplate`, `MealTemplateItem`,
`Workout`, `WorkoutSet`, `WorkoutTemplate`, `HealthMetric`, `Goal`,
`CalendarDaySummary`, `JournalEntry`, `Reminder`, `FavoriteItem`.

### Duplicated / conflicting logic found

This is the core problem the upgrade has to fix. Today, "does this apply on this
date?" and "what is the score?" are answered in several independent places:

1. **`isHabitDue`** (`src/lib/logic/recurrence.ts:176`) — the only shared
   applies-on-date function, and it is *habit-only*. Goals have no equivalent.
   Called from `summaries.ts`, `queries.ts`, `streaks.ts`.
2. **`matchesRule` / `expandRule`** (`src/lib/logic/recurrence.ts`) — a second,
   unrelated applies-on-date implementation for planner items.
3. **`scoreDay`** (`src/lib/logic/scoring.ts:33`) — the day-score formula.
4. **A duplicate of the day-score formula inlined in `prisma/seed.ts:830-885`** —
   hardcoded weights `0.35/0.35/0.15/0.15` copied by hand. Seeded history and
   live recomputation can drift apart.
5. **Completion counting** — `recomputeDay` (`src/server/summaries.ts:35-58`)
   computes planned/completed/habitsDue/habitsDone, and `getDayOverview`
   (`src/server/queries.ts:412-427`) recomputes the same numbers independently
   from a different query. They can disagree.
6. **Streaks** — `computeStreaks` (`src/lib/logic/streaks.ts`) is the single
   implementation, but it walks *calendar* days filtered by `isHabitDue`, and
   treats a `weekly` habit as due every single day.

### Concrete correctness bugs confirmed by reading the code

| Bug | Location | Effect |
|---|---|---|
| **Goals have no schedule at all.** `Goal` has only `period` (daily/weekly/monthly). There is no weekday selection, no start/end date, no rest-day concept. | `prisma/schema.prisma` `model Goal` | "Workout Mon/Tue/Thu/Fri" is unrepresentable. Every daily goal is evaluated on all 7 days, so Wednesday reads as a failure. |
| **`weekly` habits are "due" every day.** | `recurrence.ts:189-192` | A "3× per week" habit shows 4 missed days a week and its streak breaks constantly. This is the `3 of 7` bug. |
| **Weekly progress ignores the habit's own target denominator in the UI path** and `dayHabitCompletion` counts weekly habits as due daily. | `streaks.ts:129-146` | Weekly habits pollute the daily denominator. |
| **`skipped` is treated as an excuse.** Spec wants `skipped` to break a streak and a separate `excused` state that does not. There is no `excused` status. | `streaks.ts:63-65`, `enums.ts:123` | Users can silently protect a streak by skipping. |
| **Score divides by *all* planner items**, including future/optional ones, and returns `0` (not "no data") when nothing applies. | `scoring.ts:33-63` | An untracked day scores 0 and drags averages down. `heatLevel` partially compensates via `hasData`. |
| **No score explanation anywhere.** The number is opaque. | — | Acceptance criterion unmet. |
| **`applyScheduleTemplate` has no duplicate protection.** | `planner.ts:351-408` | Applying a routine twice silently doubles the day. |
| **`Goal` has `@@unique([userId, domain, metric, period])`.** | schema | Two workout goals (e.g. "workout on Mon/Tue/Thu/Fri" *and* "4 workouts per week") cannot coexist. Must be relaxed. |
| **Timezone is stored but unused.** `today()` uses server/browser local time. | `date.ts:45` | A user whose configured timezone differs from the host's sees the wrong "today". |
| **`workoutMinuteGoal = weeklyWorkoutGoal * 45 / 7`** — a made-up constant. | `summaries.ts:73`, `seed.ts:833` | Training score is derived from an invented 45-minute assumption rather than a real goal. |

### Safety steps performed

* Confirmed repository: `/home/user/Daily-Schedule`, remote `ompatel50/daily-schedule`.
* Working tree was **clean** at session start; nothing was stashed, reset or discarded.
* Branch: `claude/personal-os-preview-3-y6pmoe` (already checked out, tracking origin).
* `npm install` → OK. `npx prisma generate && npx prisma db push` → OK.
* `npm run db:seed` → OK (663 schedule items, 8 habits, 390 habit logs, 172 meals,
  48 workouts, 595 metrics, 92 foods).
* **Development database backup taken** before any schema change:
  `prisma/dev.db` → `<scratchpad>/dev.db.baseline`.
  *Restore procedure:* stop the dev server, then
  `cp <scratchpad>/dev.db.baseline prisma/dev.db`.
  A portable copy of this procedure for real users is the in-app backup
  (Settings → Backup), which exports JSON rather than the binary DB.
* `prisma/dev.db` is gitignored (`*.db`, `prisma/dev.db*`) — verified it is not staged.
* No `.env`, API key, or health export is tracked.

### Baseline check results (before any change)

```
npm run typecheck   → PASS (no output)
npm test            → PASS (6 files, 102 tests)
```

---

## Architectural decisions

1. **No `prisma migrate`; keep `prisma db push` + an idempotent data-backfill
   script.** The project has never had a migrations directory and the DB is a
   local SQLite file. Introducing `prisma migrate` would require a baseline
   migration and risks `migrate dev` offering to reset a user's real database.
   Instead: schema changes are **additive only** (new tables, new nullable/
   defaulted columns), applied with `npm run db:push`, followed by
   `npm run db:migrate` which runs re-runnable backfills in `prisma/migrations-data/`.
   Every backfill checks for its own prior output before writing, so running it
   twice is a no-op.

2. **One polymorphic schedule system rather than per-entity schedule tables.**
   The spec sketches `GoalSchedule`/`GoalScheduleVersion`/`GoalScheduleDay`/
   `GoalDateOverride` plus habit twins — eight tables that would need two
   parallel copies of identical logic. Instead there are three:
   `ScheduleRule` (effective-dated version, owned by `ownerType`+`ownerId`),
   `ScheduleRuleDay` (one row per selected weekday — no comma-separated lists),
   and `ScheduleOverride` (one row per date-specific exception). Goals, habits
   and later workouts share them, which is what makes a *single* authoritative
   engine possible.

3. **Effective-dated schedule versions.** Changing a schedule closes the current
   `ScheduleRule` (`effectiveTo = yesterday`) and opens a new one from today.
   Historical dates keep resolving against the rule that was in force then, so
   old scores and streaks do not silently change.

4. **Legacy habit recurrence columns (`frequency`, `weekdays`, `targetPerWeek`)
   are kept but demoted to derived mirrors.** `ScheduleRule` is authoritative for
   all reads. The habit save path writes both so existing backup files still
   restore and the raw DB stays readable. They are never read by the engine.

---

## Database migrations created

_None yet — Phase 1._

## Commands run

```
npm install
npx prisma generate
npx prisma db push
npm run db:seed
npm run typecheck      # PASS
npm test               # PASS 102/102
```

## Tests passing

Baseline: `tests/date.test.ts`, `tests/nutrition.test.ts`, `tests/quick-add.test.ts`,
`tests/recurrence.test.ts`, `tests/scoring.test.ts`, `tests/streaks.test.ts` — 102 tests.

## Tests failing

None.

## Known problems

See "Concrete correctness bugs" above — all are the subject of this upgrade and
none have been fixed yet.

---

## Exact next step

Phase 1: add `ScheduleRule`, `ScheduleRuleDay`, `ScheduleOverride`, `SeedBatch`,
`SeedRecord` to `prisma/schema.prisma`; extend `Goal` (description, category,
targetMax, comparison, source, sourceRef, startDate, endDate, archivedAt) and
relax its over-tight unique constraint; add `startDate`-compatible fields to
`Habit`. Then write `prisma/migrations-data/001-schedules.ts` to backfill a
`ScheduleRule` for every existing goal (every-day, effective from the goal's
`createdAt` date) and every existing habit (from its legacy recurrence columns),
and wire `npm run db:migrate`.
