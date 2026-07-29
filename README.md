# Personal OS

A private, local-first personal operating system: **daily planner, habit tracker, nutrition tracker,
workout tracker and health dashboard** in one desktop web app.

It runs on your machine, stores everything in a local SQLite file, and never sends your data
anywhere. It is built to answer six questions every day:

* What do I need to do today?
* What did I actually finish?
* What did I eat?
* How did I train?
* How consistent have I been?
* What should I focus on next?

---

## Quick start

```bash
npm install
npm run setup      # generate Prisma client, create the DB, seed ~10 weeks of sample data
npm run dev        # http://localhost:3000
```

That's it. There is no account, no login and no cloud service to configure. On first run a
`.env` is created for you from `.env.example` (it only sets `DATABASE_URL="file:./dev.db"`).

`npm run setup` is idempotent — re-running it re-seeds the demo dataset. To start from a genuinely
empty app, run `npm run db:push` and then use **Settings → Danger zone → Reset everything**.

### Other commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with hot reload |
| `npm run build` / `npm start` | Production build and server |
| `npm test` | Run the unit test suite (Vitest) |
| `npm run typecheck` | TypeScript, no emit |
| `npm run db:studio` | Prisma Studio — browse/edit the database directly |
| `npm run db:seed` | Re-seed sample data |
| `npm run db:reset` | Drop everything and re-seed (destructive) |

### Requirements

Node 20+. Everything else is npm dependencies — no Docker, no database server.

---

## The stack, and why

| Choice | Reason |
| --- | --- |
| **Next.js 15 (App Router)** | Server Components let pages query SQLite directly with no API layer; Server Actions give type-safe mutations without a REST surface. |
| **TypeScript** | Every model, enum and action input is typed end to end. |
| **Prisma + SQLite** | One file on disk (`prisma/dev.db`). Copy it to back up, delete it to reset. `provider` can be flipped to Postgres later without changing the schema's shape. |
| **Tailwind CSS + shadcn/ui-style components** | The UI primitives are vendored into `src/components/ui` rather than pulled from a component library, so they're readable and editable. |
| **Recharts** | Charts are wrapped in `src/components/shared/charts.tsx` so every chart shares one visual language. |
| **Zustand** | Client state is *only* UI state (palette open, quick-add open). Domain data always comes from the server, so there's one source of truth. |
| **dnd-kit** | Drag & drop for reordering a day and moving items across days in the week view. |
| **date-fns** | Date maths, wrapped by `src/lib/date.ts` (see the day-key note below). |
| **Vitest** | Fast unit tests for the pure logic modules. |

---

## What's in it

### 1. Planner — `/planner`, `/today`

* Day, week and month views (`?view=day|week|month`, `?date=YYYY-MM-DD`).
* Items support title, time block or all-day, category, priority, notes, recurrence, completion
  status and tags.
* **Drag & drop**: reorder untimed items within a day; drag a card onto another column in the week
  view to move it to that day.
* **Timeline**: a proportional day view with a live "now" line and side-by-side layout for
  overlapping blocks.
* **Quick add** (`N` anywhere): one text field that understands natural language —
  `Gym 6:30-7:30pm tomorrow !high #fitness`. A live preview shows exactly what will be created.
* **Routines**: saved multi-item templates you can stamp onto any day in one click. Applying the
  same routine to the same day twice does **not** silently double it — nothing is written and you
  are asked whether to keep what's there, replace it with a fresh copy, add a second copy
  deliberately, or cancel.
* **Recurring items** can be edited or deleted at three scopes each: this occurrence, this and all
  future occurrences, or the entire series. Editing one occurrence detaches it, so a later
  series-wide edit will not overwrite your change. A series edit carries the details across but
  never the date.
* **Overlap warnings**: two blocks competing for the same minutes are flagged on the day list.
  It is a warning, not a block — sometimes double-booking is deliberate. All-day items,
  back-to-back blocks that merely touch, and skipped items are never flagged.
* **Roll over**: push everything unfinished from a past day to the next day.

### 2. Nutrition — `/nutrition`

* Food search over a bundled database of ~90 common foods, plus your own custom foods.
* Log by serving, grams, ml, oz or piece; calories, protein, carbs, fat, fiber, sugar and sodium.
* Breakfast / lunch / dinner / snack / custom meal labels.
* Daily totals, macro split donut, 14-day calorie trend, goal progress.
* **Favourites and recents** derived from what you actually log, so repeat meals are one click.
* **Meal templates** — save any logged meal and re-log it later.

### 3. Workouts — `/workouts`

* Strength, cardio, walking, running, cycling, swimming, yoga, mobility, HIIT, sport and custom.
* Duration, intensity, calories burned, heart rate, distance, RPE, notes, and per-set
  exercise/reps/weight tracking.
* Calories are estimated from MET values × duration × intensity when you don't enter a measured
  value; a measured value always wins.
* **Templates** turn a whole session into one click; **repeat** re-logs any past workout on today.
* Trends: training load, training mix by type, and estimated 1RM personal bests.
* Every workout mirrors onto the planner as a schedule item, so "what's on today" stays one list.

### 4. Habits — `/habits`

* Every day, selected weekdays, N times per week, every N days/weeks, monthly, or one time — all
  through the same schedule engine goals use.
* Statuses per day: **done**, **skipped** (deliberate, and it *does* break the streak),
  **excused** (neutral — no credit, streak survives), **missed**, plus **rest day**,
  **not scheduled** and **future**, which are never failures.
* Streaks count consecutive **scheduled opportunities**, not calendar days: a Mon/Wed/Fri habit
  done six times in a row is a streak of six, and the Tuesdays in between neither extend nor
  break it.
* 90-day completion rate over scheduled days only — a weekday habit is never "missed" on a
  Saturday, and a habit that has not come due yet reads `—` rather than 0%.
* 28-day dot strip per habit, one style per resolved state — **click any dot to fix a day you
  forgot to log**.
* Categories (health, productivity, learning, hygiene, mindfulness, personal) and time-of-day
  attachment (morning / afternoon / evening / before bed / anytime).

### 5. Calendar — `/calendar`

* Six-month consistency heatmap, filterable by planner, habits, nutrition or workouts. Days with
  nothing scheduled are skipped rather than drawn as zeros.
* Month grid with seven explicit day states — completed, partial, missed, rest day, planned, open
  day, no data — each with an icon, a border treatment and a text label, so it reads correctly in
  greyscale and to a screen reader. A legend names all seven.
* Click any date for a full detail panel: the day score with its explanation, habits and goals with
  their resolved status, rest-day items listed separately, nutrition, training, health metrics
  (labelled with their source) and notes.
* Current streak, longest streak, scored days and "perfect days" — rest days excluded from all four.

### 6. Insights — `/insights`

* **Weekly review**: plain-language observations comparing the last 7 days to the week before —
  what improved, what slipped, which habit is your most reliable and which is falling off.
* **Focus next**: a single recommendation.
* Health trends: body weight with a 7-day average, steps against goal, sleep and resting heart
  rate.
* Manual health metric entry.

### 7. Dashboard — `/`

The home screen: today's schedule, habits, calories and training at a glance, a day score ring,
what's next, 30-day consistency, weekly training load, health highlights and quick actions.

### 8. Productivity layer

* **Command palette** (`⌘K` / `Ctrl K`) — searches across schedule items, workouts, foods, habits
  and journal entries, plus actions and navigation.
* **Keyboard shortcuts**: `N` quick add · `/` search · `?` shortcuts · `G` then a letter to
  navigate · `J`/`K` previous/next day · `T` jump to today.
* **Journal**: a note plus mood and energy on any day (which also feed the health charts).
* **Export/import**: full JSON backup, per-table CSV export, and JSON restore in merge or replace
  mode.
* **Dark mode**, following the system by default.
* **Reminders**: desktop notifications and toasts while the app is open.

---

## Architecture

```
prisma/
  schema.prisma          # the data model
  seed.ts                # bundled foods + ~10 weeks of realistic history
src/
  app/                   # one folder per route, all Server Components
  components/
    ui/                  # shadcn-style primitives (button, dialog, select, …)
    layout/              # shell, sidebar, topbar, command palette, shortcuts
    planner/ nutrition/ workouts/ habits/ calendar/ health/ settings/ dashboard/
    shared/              # StatCard, SectionCard, charts, date nav, empty states
  lib/
    date.ts              # day keys and time formatting
    enums.ts             # every "enum" + its display metadata
    validation.ts        # Zod schemas for every server action
    logic/               # pure, testable domain logic
      schedule.ts    # THE schedule engine — one answer to "does this apply today?"
      goals.ts       # goal evaluation and completion sources
      day-score.ts   # the day score *and* its explanation
      recurrence.ts  # planner-item recurrence (materialised occurrences)
      planner.ts     # routine-application identity + overlap detection
      nutrition.ts   workouts.ts   scoring.ts   quick-add.ts   insights.ts
    data/foods.ts        # the bundled food database
  server/
    queries.ts           # read model — what pages call
    schedule.ts          # schedule persistence and effective-dated versioning
    facts.ts             # per-day measurement from records that already exist
    goals.ts habits.ts   # goal and habit read models
    day-score.ts         # assembles the score's inputs
    insights.ts          # the weekly review
    summaries.ts         # the per-day rollup cache
    series.ts            # recurring-item materialisation
    actions/             # server actions (the only place that writes)
tests/                   # Vitest suites for the logic modules
```

The rule the codebase follows: **`lib/logic` is pure**, `server/` touches the database, and
`components/` renders. Anything worth testing lives in `lib/logic`, which is why the test suite
needs no database.

### Key design decisions

**Calendar days are strings, not `Date`s.** A `Date` is an instant, and an instant rendered in a
different timezone can land on a different calendar day. Since the entire product is organised
around "what did I do on this day", days are `YYYY-MM-DD` strings ("day keys") in the database, in
URLs and in props. Conversion to `Date` happens only at the edges, and `fromDayKey` normalises to
local noon so DST transitions can never shift a day.

**Recurring items are materialised.** Creating a weekly item writes one row per occurrence for the
next 120 days, and the horizon is topped up whenever the planner loads. This keeps one code path:
completion, drag & drop, day summaries and the heatmap all work on concrete rows instead of needing
a parallel "virtual occurrence" implementation. Editing or moving one occurrence marks it as an
exception so a later series-wide edit won't overwrite it.

**`CalendarDaySummary` is a cache, not truth.** Every write recomputes the affected day's rollup, so
the heatmap and insights read one small table instead of joining five. It can always be rebuilt from
scratch (`rebuildSummaries`), which is what import and restore do.

**The food database ships with the app.** There is no third-party nutrition API. A remote API would
mean every meal you log leaves your machine, needs an API key, and stops working offline — all of
which contradict "private and local-first". The bundled table covers everyday whole foods and common
staples; anything missing takes about twenty seconds to add as a custom food, and custom foods are
first-class in search from then on.

**Nutrition has one canonical basis.** Foods are stored either per 100 g or per serving, with a
`basis` column saying which. All serving maths goes through `lib/logic/nutrition.ts`, which prevents
the classic "per serving vs per 100 g" bug. Macros are also denormalised onto each logged entry, so
correcting a food's nutrition later never silently rewrites your history.

**Enums are TEXT.** SQLite has no enum type, so every enum-like column is validated in
`lib/enums.ts` and `lib/validation.ts`. This keeps the schema portable: switching `provider` to
`postgres` needs no rewrite.

**One schedule engine.** `lib/logic/schedule.ts` is the single authority on whether something
applies on a date — for goals, habits, streaks, scoring, the calendar and insights. It exists
because that question used to be answered independently in four places that could disagree. It
keeps apart the states people care about: scheduled, times-per-week (flexible), not scheduled,
rest day, excused, cancelled, moved, before start, after end, disabled. **Only the first can ever
become a miss.**

Schedules are **effective-dated**. Changing one closes the current version and opens a new one, so
a date in the past keeps resolving against the rule that was actually in force then and old scores
and streaks do not silently change. "Recalculate all history" exists, but you have to choose it and
it tells you what it will do.

**The day score.** The share of a day's *applicable* opportunities that were met, from
`lib/logic/day-score.ts`. Rest days, unscheduled items, cancelled and excused occurrences, disabled
goals, future dates and optional tasks are excluded — each with a reason you can read — rather than
counted as failures. A day with nothing scheduled scores **null, not zero**: an open day is not a
bad day, and it is never averaged in as one. Missing data is likewise not failure: a protein goal on
a day with no food logged reports "not logged".

Categories are planner, habits and goals, weighted equally by default. Nutrition, training and
health are scored *as goals* rather than as separate categories, because in this app they already
are goals — a separate category would count the same workout twice. Partial credit applies only
where a partial amount is genuinely partial progress: 120 g toward a 160 g protein target is 75%,
while a habit or a task is done or it is not.

Click the score anywhere it appears to see every category, every opportunity, every excluded record
and the formula in words.

---

## Data model

`User`, `Tag`, `ScheduleItem`, `ScheduleItemTag`, `ScheduleTemplate`, `Habit`, `HabitLog`,
`FoodItem`, `Meal`, `MealEntry`, `MealTemplate`, `MealTemplateItem`, `Workout`, `WorkoutSet`,
`WorkoutTemplate`, `HealthMetric`, `Goal`, `GoalEntry`, `ScheduleRule`, `ScheduleRuleDay`,
`ScheduleOverride`, `CalendarDaySummary`, `JournalEntry`, `Reminder`, `FavoriteItem`, `SeedBatch`,
`SeedRecord`.

**Scheduling is three shared tables, not two parallel families.** `ScheduleRule` is one
effective-dated version owned by `(ownerType, ownerId)`; `ScheduleRuleDay` is one row per selected
weekday, so "which goals apply on Wednesday?" is a real query rather than a `LIKE` over a
comma-separated string; `ScheduleOverride` is a one-date exception (rest / excused / activate /
cancel / reschedule) that never edits the repeating schedule. Goals and habits share all three,
which is what makes a single engine possible.

`HealthMetric` is deliberately generic (date + type + value + unit) so new metric types need no
migration. Both `HealthMetric` and `Workout` carry `source` and `externalId` columns with a
uniqueness constraint on the pair, which means an **Apple Health or watch export can be imported
later, repeatedly and idempotently, without touching anything you entered by hand**. The
`importHealthMetrics` server action is already the landing point for exactly that; only the file
parser is missing.

---

## Assumptions

These were decisions the brief left open. They're all reversible.

1. **Single user, no auth.** The app runs on your machine. `getCurrentUser()` in `src/lib/db.ts` is
   the one seam where multi-user support would slot in — every query and action already takes a
   `userId`.
2. **No nutrition API.** See above. `FoodItem` rows with `userId = null` are the bundled database;
   your custom foods carry your `userId`.
3. **Reminders only fire while a tab is open.** A local-first app with no server genuinely cannot
   deliver a background notification. The Settings page says so plainly rather than implying
   otherwise; a service worker could be added later.
4. **Weights are stored in the unit you read them in**, with the unit recorded per row, so
   converting later is unambiguous. Workout set weights are always kilograms internally.
5. **Recurrence is deliberately simpler than RFC 5545** — daily/weekly/monthly with an interval,
   weekday selection, and an optional end. That covers workouts, meals, habits and routines without
   dragging in an iCalendar implementation.
7. **Your timezone decides what "today" is**, not the machine's clock. It is detected from the
   browser on first run and changeable in Settings. Calendar days are stored as timezone-free
   `YYYY-MM-DD` keys and converted only at the edges.
8. **Schema changes use `prisma db push` plus idempotent data backfills** (`npm run db:migrate`)
   rather than `prisma migrate`, because the database is a local file you own and `migrate dev`
   can offer to reset it. Every backfill checks for its own prior output, so running it twice
   changes nothing.
6. **The seeded profile is fictional** and exists purely to make the app look real on first run.
   Reset it from Settings when you're ready to use it for yourself.

---

## Testing

```bash
npm test
```

225 tests across ten suites, covering the logic that would be expensive to get wrong:

* **Scheduling** — every mode, both week-start settings, DST, leap years, month and year
  boundaries, all five override kinds, effective-dated versions, and every streak rule.
* **Goals** — all five comparisons, partial credit, completion sources, and the canonical case:
  a Mon/Tue/Thu/Fri workout goal is neutral on Wednesday, and a 4×/week goal reports "3 of 4, 75%,
  1 to go" rather than "3 of 7" and is not failed before the week ends.
* **Habits** — weekday habits excluding the weekend, missed and skipped breaking a streak while
  excused and rest days do not, future days never counting as missed.
* **Day score** — only applicable items in the denominator, rest days excluded, an empty day
  scoring null rather than zero, partial progress capped, and category totals agreeing with the
  overall total.
* **Backup** — validation, checksums, older/newer format handling, and an assertion that the
  export and import cover every table in `BACKUP_TABLES`.
* **Planner** — applying a routine once writes it, applying it again writes nothing, a deliberate
  second copy still works and never re-uses a key, and overlap detection flags a real clash while
  ignoring all-day items, back-to-back blocks and skipped items.
* Plus nutrition serving maths, the natural-language quick-add parser, planner recurrence, and
  day-key/time handling including a DST boundary.

The tests are pure — no database, no fixtures, no mocking — because all the logic they cover lives
in `src/lib/logic`.

---

## Backing up

Three options, in increasing order of effort:

1. **Settings → Export → Full JSON backup.** Restorable back into the app, matched by id so
   re-importing is never a duplicate.
2. **Settings → Export → CSV**, per table, for spreadsheets.
3. **Copy `prisma/dev.db`.** It's the whole database.

---

## Deploying later

The app is built for local desktop use, but nothing blocks deployment:

* Change `datasource db { provider }` in `prisma/schema.prisma` to `postgresql` and point
  `DATABASE_URL` at a managed database.
* Add authentication and replace the body of `getCurrentUser()`.

No other code needs to change — every query and mutation is already scoped by `userId`.
