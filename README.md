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

That's it. There is no account, no login and no cloud service to configure.

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
* **Routines**: saved multi-item templates you can stamp onto any day in one click.
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

* Daily, specific-weekday, or N-times-per-week recurrence.
* Three states per day: **done**, **skipped** (a deliberate rest day — neutral for streaks) and
  **missed**.
* Streaks, longest streak, 90-day completion rate, weekly progress.
* 28-day dot strip per habit — **click any dot to fix a day you forgot to log**.
* Categories (health, productivity, learning, hygiene, mindfulness, personal) and time-of-day
  attachment (morning / afternoon / evening / before bed / anytime).

### 5. Calendar — `/calendar`

* Six-month consistency heatmap, filterable by planner, habits, nutrition or workouts.
* Month grid with per-day score, completion counts, calories and training minutes.
* Current streak, longest streak, days tracked and "perfect days".

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
      recurrence.ts  streaks.ts  nutrition.ts  workouts.ts  scoring.ts
      quick-add.ts   insights.ts
    data/foods.ts        # the bundled food database
  server/
    queries.ts           # read model — what pages call
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

**The day score.** One 0–100 number drives the heatmap, the dashboard ring and the weekly review.
It weights planner completion 35%, habits 35%, nutrition 15% and training 15% — and only counts the
dimensions that actually have data that day, so a day with no meals logged isn't punished for it.
Calorie accuracy scores *both* over- and under-eating, since a goal you blow past isn't a goal you
hit. See `lib/logic/scoring.ts`.

---

## Data model

`User`, `Tag`, `ScheduleItem`, `ScheduleItemTag`, `ScheduleTemplate`, `Habit`, `HabitLog`,
`FoodItem`, `Meal`, `MealEntry`, `MealTemplate`, `MealTemplateItem`, `Workout`, `WorkoutSet`,
`WorkoutTemplate`, `HealthMetric`, `Goal`, `CalendarDaySummary`, `JournalEntry`, `Reminder`,
`FavoriteItem`.

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
6. **The seeded profile is fictional** and exists purely to make the app look real on first run.
   Reset it from Settings when you're ready to use it for yourself.

---

## Testing

```bash
npm test
```

102 tests across six suites, covering the logic that would be expensive to get wrong: recurrence
expansion and matching, streak rules (including that a "skip" is neutral and an unlogged *today*
doesn't break a streak), nutrition serving maths, day scoring, the natural-language quick-add
parser, and day-key/time handling including a DST boundary.

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
