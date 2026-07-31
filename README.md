# Personal OS

A private personal operating system: **daily planner, habit tracker, nutrition tracker,
workout tracker and health dashboard** in one web app.

It stores everything in a private PostgreSQL database you own, and never sends your data
to anyone else. (The original local-only SQLite version is preserved at commit
`f5b4fe1d950abf56cc11ae97d2750ac714d365fb` — tagged `preview3-complete-before-web` locally; the
hash is the authoritative reference — see `docs/migrating-from-local.md` for how to return to it.)
It is built to answer six questions every day:

* What do I need to do today?
* What did I actually finish?
* What did I eat?
* How did I train?
* How consistent have I been?
* What should I focus on next?

---

## Guides

Step-by-step documentation lives in `docs/`, written to be followed exactly:

| Guide | What it covers |
| --- | --- |
| [`docs/deployment-guide.md`](docs/deployment-guide.md) | Deploying to Vercel with a managed PostgreSQL database — the master guide |
| [`docs/auth-setup.md`](docs/auth-setup.md) | Accounts: public sign-up, sign-in, recovery codes, password reset |
| [`docs/local-development.md`](docs/local-development.md) | Running and testing the app on your own machine |
| [`docs/migrating-from-local.md`](docs/migrating-from-local.md) | Moving your data from the local app to the hosted site — and back |
| [`docs/backup-and-recovery.md`](docs/backup-and-recovery.md) | The backup habit, what the file contains, and recovery |
| [`docs/health-module.md`](docs/health-module.md) | The Health section: supported Apple Health data, duplicate and undo rules, performance |
| [`docs/health-import-privacy.md`](docs/health-import-privacy.md) | What a health import stores, what it drops, and how to undo it |
| [`docs/web-push-setup.md`](docs/web-push-setup.md) | Background reminder notifications (Web Push) |
| [`docs/security-and-privacy.md`](docs/security-and-privacy.md) | Per-account isolation guarantees, rate limits, headers, logs, and the off switches |
| [`docs/troubleshooting.md`](docs/troubleshooting.md) | Symptoms → causes → fixes |
| [`docs/performance-measurement.md`](docs/performance-measurement.md) | How the performance numbers were measured, and how to repeat them |

## Quick start

```bash
npm install
docker compose up -d # start local PostgreSQL 16 (postgres/postgres, personal_os_dev)
npm run setup        # generate Prisma client, apply migrations + backfills, seed sample data
# — or —
npm run setup:empty  # the same, but start with a completely empty app
npm run dev          # http://localhost:3000
```

On first run a `.env` is created for you from `.env.example` (it points at the
docker-compose database). If you already run PostgreSQL yourself, edit
`DATABASE_URL` / `DIRECT_DATABASE_URL` in `.env` instead of using Docker.

The app asks you to sign in — email + password, no Google button. After
`npm run setup`, sign in as **`you@local`** with the password
**`local-dev-password`** (the seed prints this). If you started with
`npm run setup:empty` there is no account yet: create your own at
`/signup` — the same public self-serve flow the hosted site uses, recovery
codes included ([`docs/auth-setup.md`](docs/auth-setup.md)).

`npm run setup` is idempotent — re-running it re-seeds the demo dataset. **Sample data is
explicitly tracked**: every seeded record is registered in a seed batch, so
**Settings → Sample data → Remove sample data** deletes exactly the demo records — anything you
created yourself stays, and scores, streaks, the calendar and insights are recalculated. Starting
empty, the dashboard's optional getting-started checklist offers to load the sample dataset
in-app (only while the account is empty, so demo history can never mix into real records).

### Other commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with hot reload |
| `npm run build` / `npm start` | Production build and server |
| `npm test` | Run the unit test suite (Vitest) |
| `npm run test:integration` | Database-backed tests against the disposable test database |
| `npm run test:e2e` | Playwright browser tests (needs the built server running — see `docs/local-development.md`) |
| `npm run typecheck` | TypeScript, no emit |
| `npm run lint` | ESLint (kept at zero problems; enforced in CI) |
| `npm run db:studio` | Prisma Studio — browse/edit the database directly |
| `npm run db:seed` | Re-seed sample data (refuses to run against a non-local database) |
| `npm run db:migrate` | Create + apply a schema migration locally (`prisma migrate dev`) |
| `npm run db:migrate:deploy` | Apply committed migrations (production-safe, used by deploys) |
| `npm run db:migrate:status` | Show which migrations are applied |
| `npm run db:backfill` | Run the idempotent TypeScript data backfills |
| `npm run db:reset` | Drop everything and re-seed (destructive; guarded to local databases only) |

### Requirements

Node 20+ and a PostgreSQL 16 database — `docker compose up -d` provides one
locally with zero configuration.

---

## The stack, and why

| Choice | Reason |
| --- | --- |
| **Next.js 15 (App Router)** | Server Components let pages query the database directly with no API layer; Server Actions give type-safe mutations without a REST surface. |
| **TypeScript** | Every model, enum and action input is typed end to end. |
| **Prisma + PostgreSQL** | Committed migration history (`prisma/migrations/`), a docker-compose database for local dev, and a managed database in production. The pre-web SQLite version is preserved at tag `preview3-complete-before-web`. |
| **Tailwind CSS + shadcn/ui-style components** | The UI primitives are vendored into `src/components/ui` rather than pulled from a component library, so they're readable and editable. |
| **Recharts** | Charts are wrapped in `src/components/shared/charts.tsx` so every chart shares one visual language. |
| **Zustand** | Client state is *only* UI state (palette open, quick-add open). Domain data always comes from the server, so there's one source of truth. |
| **dnd-kit** | Drag & drop for reordering a day and moving items across days in the week view. |
| **date-fns** | Date maths, wrapped by `src/lib/date.ts` (see the day-key note below). |
| **Vitest** | Fast unit tests for the pure logic modules. |

---

## What's in it

### 1. Planner — `/planner`

The planner **shapes** the schedule; Today **runs** it and the dashboard
**summarises** it. Each of the three owns a distinct job, declared once in
`src/lib/logic/surfaces.ts` — see "Three surfaces, three jobs" below.

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

* **Local-first food search with optional online lookup.** Every search checks, in order: your
  foods, your favourites, your recent foods, anything cached from a previous online lookup, then
  — only if that came up thin — USDA FoodData Central for generic ingredients and Open Food Facts
  for branded products. Anything you pick is cached locally, so the second time it is offline data.
* Log by grams, kilograms, ounces, pounds, millilitres, litres, cups, tablespoons, teaspoons,
  pieces, slices, servings or packages — but only where the conversion is real (see below).
* Calories, protein, carbs, fat, fiber, sugar and sodium up front; saturated fat, cholesterol,
  potassium, calcium, iron and the vitamins kept alongside when a provider supplies them.
* Breakfast / lunch / dinner / snack / custom meal labels.
* Daily totals, macro split donut, 14-day calorie trend, goal progress.
* **Favourites and recents** derived from what you actually log, so repeat meals are one click.
* **Meal templates** — save any logged meal and re-log it later. Applying the same template twice
  by accident writes nothing and asks; doubling a meal on purpose still works.
* Edit the quantity, change the unit, move an entry to another meal or another day, duplicate it
  deliberately, or delete it — each of which recomputes the day, the goals, the score, the calendar
  and Insights through one shared path.

#### Setting up online food search

Both providers are optional. With neither configured the app still searches everything local.

**USDA FoodData Central** (generic foods) needs a free key:

1. Sign up at <https://fdc.nal.usda.gov/api-key-signup.html>
2. Put it in `.env`:
   ```
   USDA_FDC_API_KEY="your-key-here"
   ```
3. Restart the dev server.

The key is read inside a `server-only` module and is never sent to the browser — do not prefix it
with `NEXT_PUBLIC_`, and do not commit it. Without it, search still works and the results panel says
USDA is not set up, with the signup link.

**Open Food Facts** (branded products) needs no key and is on by default. It is used read-only over
its public v2 API, identified by a descriptive `User-Agent` that names this app rather than you.
The app never writes, uploads or contributes anything to it.

#### What leaves your machine

Only a search term or a public barcode, and only when local results are thin. Requests are sent
with no cookies and no referrer. Your meals, meal history, goals, health metrics, schedule, habits,
workouts and notes are never part of a provider request — there is no field in the provider
interface through which they could travel, and `tests/food-lookup.test.ts` asserts it.

#### Known provider limitations

* **USDA publishes no densities.** A food from USDA cannot be logged in cups or millilitres, only
  by weight or by its declared serving.
* **Open Food Facts is community data and often partial.** Records below a usable threshold are
  dropped; the rest carry a completeness score and show a "partial data" hint. A nutrient that was
  never published is missing, not zero.
* **Open Food Facts states sodium in grams and sometimes only kilojoules.** Both are converted on
  the way in; if you compare against the OFF website the raw numbers will look different.
* Branded coverage differs between the two: USDA's branded set is US-centric, OFF is broader but
  less consistent.

### 3. Workouts — `/workouts`

**Live sessions.** Starting a template opens a session rather than writing a finished workout: sets
begin outstanding, you tick them off as you go, and the duration recorded at the end is real elapsed
time rather than a number typed in advance. The plan (`3 × 8 @ 60 kg`) is kept next to what actually
happened, so "beat target" and "target 5 × 110 kg" stay legible afterwards.

* One session at a time — starting another offers to resume the open one instead.
* A rest timer that counts down from the last set you ticked. It is *derived* from stored stamps, not
  held in memory, so reloading the page or locking your phone mid-set loses nothing.
* Add a set or a whole exercise mid-session; untick a mis-tap without losing what you typed.
* Finish (counts it), **stop early** (keeps what you did — three of eight sets is true and worth
  recording), or discard (only while nothing has been ticked; after that the server refuses).
* A finished or stopped session can be reopened to fix a forgotten set, and the elapsed clock resumes
  from the original start rather than resetting.
* Sets left outstanding stay outstanding. Volume and the day score count what was done, never what
  was planned.

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

### 5. Health — `/health`

A full Health **section**, not a page: an overview plus Activity, Sleep, Heart, Body,
Nutrition, Workouts, Vitals, Trends, Import and Import history, each on its own route so a view
is shareable and the back button means something. The overview leads with today's headline
numbers and their direction of travel, then one card per area, last night's sleep, recent
workouts, the health records you hold and the state of your imports. Its data comes from manual entry and from
**Apple Health exports**, which are parsed **on the server** and previewed before anything is
saved. There is no pretend "live watch sync" — a browser cannot subscribe to HealthKit; what
actually works is importing the export file, and that is what this is.

**Metrics** — 55 types across eight areas:

| Area | Metrics |
|---|---|
| Activity | Steps, walking + running distance, cycling distance, swimming distance, flights climbed, active calories, resting calories, exercise minutes, stand hours |
| Sleep | Time asleep and time in bed, broken into core / deep / REM / awake stages |
| Heart | Heart rate (with the day's range), resting heart rate, walking heart rate, HRV, VO₂ max |
| Body | Weight, height, BMI, body fat, lean body mass, waist circumference |
| Respiratory | Respiratory rate, blood oxygen, peak expiratory flow, forced vital capacity, FEV1 |
| Nutrition | Energy, protein, fat, saturated fat, carbohydrates, fibre, sugar, cholesterol, sodium, potassium, calcium, iron, magnesium, zinc, caffeine, water, vitamins A/C/D/E/B6/B12 and folate |
| Vitals | Blood pressure (systolic + diastolic), blood glucose, body temperature |
| Mind | Mindful minutes, plus mood and energy from the journal |

Beyond the numbers, an export's **non-numeric records** are kept as summaries: ECGs
(classification and average rate), medications, clinical records from a connected provider, and
workout-route metadata. Their bodies are deliberately not stored — see *Privacy* below.

**Every value knows where it came from** — Manual, Apple Health, CSV import, From workouts,
Calculated or Estimated — and the UI shows that label. Estimated or hand-typed data is never
presented as a device measurement.

**One aggregation module** (`src/lib/logic/health.ts`) decides what a day's number is, everywhere:

| Metric | Rule |
|---|---|
| Steps, calories, hydration, distance, nutrition, exercise and stand time | Sum within one app/device, then the fullest device wins — a phone and a watch counting the same walk are never added together |
| Sleep | Stage intervals are union-merged; time asleep = asleep+core+deep+REM, never in-bed or awake; a night crossing midnight belongs to the morning you woke up |
| Body weight, body fat, BMI, blood pressure, glucose, temperature, VO₂ max | The day's latest reading |
| Resting HR, walking HR, HRV, respiratory rate, blood oxygen | The day's average |
| Heart rate | Average with the day's min–max range preserved |

Days with no reading are **gaps, never zeros**: "didn't wear the watch" and "walked no steps"
are different facts, so averages skip empty days and charts leave them blank.

**Trends** cover steps, weight, heart rate, resting heart rate, sleep, exercise, calories,
water, body fat and VO₂ max over 7 days, 30 days, 90 days, 1 year or all time. The range lives
in the URL (`/health/trends?range=90d`), so it is shareable and bookmarkable.

**Importing Apple Health**: in the Health app, profile picture → *Export All Health Data* → move
`export.zip` to the device you are using → `/health/import` → *Import health data*. The file is
streamed to the server, parsed there, and the preview shows what was found (categories, counts,
date range, what is already present) while your health tables are still untouched. You choose
what to bring in, per category, and only confirmation writes anything.

Self-hosted, the importer accepts up to 2 GB. On a hosting platform the platform's own request
limit binds first and the app says so up front rather than promising a size it cannot accept —
on Vercel that is 4.5 MB, overridable with `HEALTH_MAX_UPLOAD_MB` when you know your real limit.

Raw sensor samples are rolled up to one row per day per device, workouts import as real
workouts, and anything that looks like a workout you already logged by hand is **skipped and
reported, never merged**. Unsupported record types (audiograms, headphone audio levels, …) are
counted and skipped, not fatal. A damaged member file inside the archive costs you that file,
not the import.

**Re-importing is safe.** Every record carries a stable fingerprint; importing the same file
again is a no-op, and a later, larger export only adds what is genuinely new (a fuller day
updates in place, and moves to the newer batch). Each import is a **batch you can undo** — with
a preview of exactly what would be deleted *and what would be kept* — leaving manual entries,
other batches and anything you have edited since untouched. Every derived number (goals, day
scores, calendar, insights) is recalculated afterwards.

**A reading you have edited stays yours.** A fingerprint is an identity, not a claim of
ownership: a re-import refreshes rows it wrote itself, and refuses to write over one you entered
by hand or corrected afterwards. Every such row is *reported* — in the preview, on the result
screen and on the batch in the history — because a skip you are not told about is
indistinguishable from data loss. The preview shows added / merged / already present / kept as
yours per category before anything is written, and the same code produces the preview and the
write, so the preview is a promise rather than an estimate. Ownership is re-read at confirmation
time, so a row edited while an import sat staged is still protected.

**`/health/imports` is where the state of every import lives**: how long ago the last successful
one ran, how many have run and how they ended, how many readings were written, merged and kept
as yours, and a searchable, filterable history with each run's counts, duration, source, day
span, warnings and errors. A batch also records which version of the importer wrote it, so the
history can say when a run predates the merge rules above. Alongside it, a panel of read-only
**integrity checks** looks for the quiet failures — a metric this app has no rules for, a unit
nothing can read back, an impossible value, a reading dated in the future — all as bounded
aggregates that cost the same for four hundred readings as for four million.

**CSV format** (template at `/health-template.csv`): header row with `metricType,value,date`
required; `unit,startTime,endTime,subtype,source,externalId,notes` optional. Dates must be
`YYYY-MM-DD` and timestamps ISO 8601 — ambiguous formats like `3/4/2026` are refused rather than
guessed. `source` may be `csv`, `manual`, `estimated` or `calculated`; claiming `apple_health`
from a CSV is refused. Units convert automatically where they can (`l`→ml, `lb`→kg, `mi`→km,
`kJ`→kcal, `min`→h, `degF`→°C); an unconvertible unit fails that row with a per-row message.

**Privacy**: the upload is transient — streamed to a scratch path, parsed, and deleted before
the preview appears, on every path including failures. Records are written against your account
and every query is scoped to it. ECG voltage traces, GPS coordinates and raw clinical documents
are read for their summary and then dropped, never stored. Nothing is sent to any third party,
and a committed test asserts the health modules contain no network call at all. Full detail in
[`docs/health-import-privacy.md`](docs/health-import-privacy.md) and
[`docs/health-module.md`](docs/health-module.md).

### 6. Calendar — `/calendar`

* Six-month consistency heatmap, filterable by planner, habits, nutrition or workouts. Days with
  nothing scheduled are skipped rather than drawn as zeros.
* Month grid with seven explicit day states — completed, partial, missed, rest day, planned, open
  day, no data — each with an icon, a border treatment and a text label, so it reads correctly in
  greyscale and to a screen reader. A legend names all seven.
* Click any date for a full detail panel: the day score with its explanation, habits and goals with
  their resolved status, rest-day items listed separately, nutrition, training, health metrics
  (labelled with their source) and notes.
* Current streak, longest streak, scored days and "perfect days" — rest days excluded from all four.

### 7. Insights — `/insights`

* **Weekly review**: plain-language observations comparing the last 7 days to the week before —
  what improved, what slipped, which habit is your most reliable and which is falling off.
* **Focus next**: a single recommendation.
* Health trends: body weight with a 7-day average, steps against goal, sleep and resting heart
  rate.
* Manual health metric entry.

### 8. Today — `/today`

The screen you work from. Your day as a checklist you tick off, the habits due today, what you
ate, what you trained, the day score with its explanation, and a note. One-line quick add is here
because capture should never be a trip; building the structure of a day — times, categories,
recurrence, routines — is the planner's job, and Today links straight to it.

### 9. Dashboard — `/`

The home screen, and deliberately **read-only**: how the last seven days are going with today as
the hint, a day score ring, what's next, tasks due now with an inbox count, 30-day consistency,
weekly training load, habit status, health highlights, a money card (net balance, this month's
in/out, bills due soon) and quick actions. Every tile links to the screen that owns it. You cannot
tick anything off from here — that happens in Today (day items) or Tasks (tasks).

### Three surfaces, three jobs

Dashboard, Today and Planner all talk about the same day, so they name some of the same numbers.
What they never do is offer the same *interaction* twice:

| | Dashboard `/` | Today `/today` | Planner `/planner` |
|---|---|---|---|
| Summarises the day | ✅ | | |
| Recent trends | ✅ | | |
| Routes you to the right screen | ✅ | | |
| Tick items off, skip, push to tomorrow | | ✅ | ✅ |
| Meals, journal, habit ticking | | ✅ | |
| New item with times, category, recurrence | | | ✅ |
| Series scopes (this / this and future / all) | | | ✅ |
| Routines | | | ✅ |
| Overlap warnings | | | ✅ |
| Timeline, week and month | | | ✅ |

Today and the planner render the **same** day-list component against the same server actions —
a `surface` prop chooses which affordances it offers, so there is no second implementation to
drift. The ownership table is in `src/lib/logic/surfaces.ts`, and `tests/surfaces.test.ts` fails
if two surfaces ever claim the same job.

### 10. Tasks & projects — `/tasks`

Obligations rather than time blocks — deliberately separate from the planner, which owns the
shape of a day. A task has a title, notes, a priority, an optional due date and an optional
project; one level of subtasks; and an opt-in reminder on its due date.

* **Today / Upcoming / Overdue**: open tasks bucketed by due date (overdue, due today, next
  seven days, later, someday), each bucket ordered priority-first.
* **Repeating tasks** come back on their own: completing one advances its due date to the next
  occurrence instead of closing it. Occurrences generate from the date the repeat was configured
  against, so "monthly on the 31st" clamps to short months and returns to the 31st — it never
  drifts. Completing a long-overdue repeater yields one next occurrence in the future, not a
  march through every missed week.
* **Projects** group tasks with a colour, a progress bar and a lifecycle (active / completed /
  archived). Deleting a project never deletes its tasks.
* **Drop** is distinct from done: a deliberate "not doing this" that closes the task without
  pretending it happened.
* **Tags** are labels, not containers: a task belongs to exactly one project and carries any
  number of tags (up to eight). Type a name in the task dialog to create one — there is no
  separate "manage tags" step — and it joins the same vocabulary the planner already uses, so
  `#admin` on a task and `#admin` on a planner block are one tag. The tag strip above the list
  filters it, stacking tags narrows (AND, never OR), and the filter lives in the URL
  (`/tasks?tag=admin`), so a filtered list is linkable and the command palette can land straight
  on one. Names are normalised — trimmed, lower-cased, single-spaced — so "Admin" and "admin"
  can never become two tags. Deleting a tag removes its links and leaves every task standing.

* **Add to planner**: any open task can block a day (all-day, or from a start time) — an
  ordinary planner item carrying the task's title and priority, linked back to the task. The two
  stay separate on purpose: completing the block never completes the task and vice versa, one
  task can block several days, and deleting the task merely unlinks the block. There is no
  second scheduling system — the block behaves exactly like one typed into the planner.

### 11. Inbox — `/inbox`

One catchall queue for life admin: things to decide, follow up on, or file later. Capture is a
single text box; an item is open until you mark it done or archive it. Deliberately **not** a
second task system — no projects, no priorities, no due dates. When something in the inbox turns
out to be a real task, **Make a task** converts it in one step: the dialog is prefilled from the
capture, takes a due date / priority / project, and creates the task while archiving the item
with a link to where it went — atomically, so a capture can never become two tasks. If the task
is later deleted, the link clears and the item can be converted again.

### 12. Finance — `/finance`

Manual-first money tracking: no bank sync, no third-party integration, nothing leaves the app.

* **Accounts** with computed balances: the balance is always `opening balance + every
  transaction` — never stored, so it cannot drift from the ledger. "Set balance" records the
  difference as an adjustment transaction. Credit cards and loans are accounts with negative
  balances, which is what makes one net-worth number possible.
* **Transactions**: a signed ledger (positive in, negative out) with categories, payees and
  notes. Monthly and weekly income/spending/net summaries and a spending-by-category breakdown
  derive from it; balance adjustments count in neither income nor spending.
* **Bills & subscriptions**: one model with a `kind` flag. Each carries a recurrence (once /
  weekly / monthly / quarterly / yearly) anchored to its first due date — "monthly on the 31st"
  clamps to short months without drifting — and a single `next due` pointer that everything
  reads. Marking one paid advances the pointer and (when an account is known) writes the payment
  into the ledger atomically. Bills remind by default: on the due day and once in a configurable
  run-up window.
* **Transfers**: first-class money moves between two of your own accounts — one action writes
  two linked ledger rows (out of one, into the other) atomically. Transfer legs carry the
  `transfer` category, which every income/spending/budget summary excludes: moving your own
  money changes balances, never totals. Deleting either leg removes the pair; a leg can't be
  edited alone (delete and redo instead). Same-currency only — a cross-currency transfer would
  need an invented exchange rate, so it's refused with a clear message; record two manual
  transactions for that.
* **CSV import**: upload a bank CSV, preview exactly what would happen, then commit. The
  importer detects common columns (date, amount **or** debit/credit **or** amount + type,
  description, category, notes, currency), shows the mapping, auto-detects — and lets you flip —
  the day/month order of slash dates, validates every row with per-line messages, and refuses
  rows whose currency doesn't match the target account. Every row gets a deterministic import
  identity, so re-importing the same file (or an overlapping export window) skips duplicates
  instead of creating them, while two genuinely identical purchases in one file both import. The
  commit is one transaction — a failure writes nothing — and an audit batch records file name and
  created/skipped/rejected counts. A template lives at `/finance-import-template.csv`.
* **Undo an import**: every import run is listed under **CSV imports** on the finance page with
  an **Undo** button. Undo previews first — how many rows it will remove, how many it will keep
  and why — and then removes *only* the rows that batch created and still owns, in one
  transaction. A row is kept when it has been **edited** since the import (its account, date,
  amount or payee changed) or **linked** to something since (it settles a bill, or it is one leg
  of a transfer); re-categorising or annotating a row is *not* an edit, because category and
  notes sit outside the import identity exactly as they do for duplicate detection. The batch row
  itself is never deleted — it stays in the history marked "Undone", which is also what stops a
  second undo from reaching rows a later import created. Removing a row takes its import identity
  with it, so re-importing the same file afterwards recreates exactly what was removed and still
  skips what was kept.
* **Budgets**: a spending target per category, one budget per category, measured over a
  **monthly or weekly** window. Monthly is the calendar month; weekly is your own week (the same
  `week starts on` convention every week view uses), and each budget card names the days it
  currently covers. Progress bars show spent / remaining against that window; over-budget states
  surface in red on the finance page and as a one-line callout on the dashboard's Money card.
  Income, transfers and adjustments never count against a budget. The finance page and the
  dashboard compute both windows from a **single** ledger fetch, so adding weekly budgets costs
  no extra query.
* **Budget alerts**: a budget can warn at 50 %, 75 %, 90 % or 100 % of its target. Crossing the
  line reminds once — the delivery key is budget + period start + threshold, so the rest of that
  month (or week) stays quiet, the next period arms it again, and changing the threshold
  deliberately arms a new alert. The card shows a "Past 75 %" badge and an amber bar while it is
  over the line but under target. Leave it on "No alert" for a budget you only want to look at.
* **Savings goals**: target, saved-so-far, optional target date. Maintained by its own add /
  withdraw actions rather than derived from the ledger, so goals work even without transaction
  discipline.
* **Low-balance alerts**: give an account an optional threshold and the reminder system says so
  when the computed balance drops below it — at most once per week per account, riding the same
  exactly-once delivery ledger as every other reminder. The account row also shows a quiet "Low"
  badge while it's under. Leave the field empty for no alert.
* Amounts are stored per account currency and never converted; net balance is reported **per
  currency** rather than pretending exchange rates don't exist.

**Renewals & documents** live on `/inbox`, next to the capture queue — the same life-admin
surface. A document is the smallest thing that can carry an expiry reminder: a name, a kind (ID,
insurance, lease, warranty, licence, membership), an optional issuer, the date it runs out, and
how far ahead to warn. There is no file storage and no document numbers — it records *when* a
thing expires, not the thing itself. Each row shows how long is left, whether its reminder is
currently armed, and whether it has already lapsed; renewing is an edit, so moving the date
forward re-arms the reminder on its own, exactly how paying a bill advances the next one.
Archive keeps a lapsed policy on the record without reminding about it.

### 13. Productivity layer

* **Command palette** (`⌘K` / `Ctrl K`) — searches across schedule items, tasks, projects, tags,
  inbox items, documents, bills, accounts, transactions, budgets, savings goals, workouts, foods,
  habits and journal entries, plus actions and navigation. A tag hit *is* a filter: following it
  opens the task list already narrowed to that tag.
* **Keyboard shortcuts**: `N` quick add · `/` search · `?` shortcuts · `G` then a letter to
  navigate · `J`/`K` previous/next day · `T` jump to today.
* **Journal**: a note plus mood and energy on any day (which also feed the health charts).
* **Export/import**: full JSON backup, per-table CSV export, and JSON restore in merge or replace
  mode.
* **Dark mode**, following the system by default.
* **Reminders**: bills and tasks on their due date, habits and goals on their schedule,
  documents before they expire, accounts under a low-balance threshold and budgets past an alert
  threshold — desktop notifications and toasts while the app is open — and, when Web Push is
  configured (`docs/web-push-setup.md`), real push notifications on opted-in devices with **no tab
  open at all**. Either way they are **schedule-aware**: nothing fires on a rest day, for something
  not scheduled today, for an archived habit, for an item already completed / excused / skipped, or
  for a times-per-week habit whose weekly target is already met. Every occurrence is delivered
  exactly once — a ledger keyed per occurrence is shared by open tabs *and* the push runner, so no
  combination of tabs and devices double-delivers — and where browser notifications are blocked or
  unsupported, the in-app toast still appears.

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
      surfaces.ts    # which screen owns which job (dashboard / today / planner)
      food.ts        # the normalised food record + USDA/OFF normalisers
      servings.ts    # units, serving options, and which conversions are valid
      session.ts     # the workout session: statuses, progress, rest, elapsed
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
    food.ts              # food lookup order, provider merge, local cache
    providers/           # one file per food source, behind FoodProvider
      usda.ts            #   USDA FoodData Central (needs USDA_FDC_API_KEY)
      openfoodfacts.ts   #   Open Food Facts (no key, read-only)
    actions/             # server actions (the only place that writes)
      session.ts         #   the live workout session's lifecycle
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

**Screens own jobs, and the ownership is data.** Dashboard, Today and Planner each have exactly one
role, declared in `lib/logic/surfaces.ts` and read by the pages, the day list, the row menu, the
sidebar and the command palette. A split written only in a document drifts the first time someone
adds a button. Note what the rule is *not*: three screens describing the same day will name some of
the same numbers — a summary that refused to would be useless. The rule is that only one screen lets
you **change** a given thing, and a fact shown twice appears at a different altitude with a link to
its owner.

**Food search is local-first, with online lookup as an addition rather than a dependency.** The
original design shipped a bundled table and no API at all, on the grounds that a remote service
would mean data leaving the machine and nothing working offline. Both concerns were right; neither
required doing without a real food database. What resolves them is the direction of the flow: a
query goes out, a food comes back, and *nothing about you* is part of either. Local rows, custom
foods, favourites, recents and cached lookups are always searched first and always work offline, so
a provider being unreachable costs you the long tail and nothing else.

**Providers are an interface, not a coupling.** `server/providers/` holds one file per source
behind a `FoodProvider` contract; everything above it — search, the log dialog, meal totals — reads
the normalised `NormalizedFood` shape from `lib/logic/food.ts`. Adding a third source is a new file
and a registry entry, not a change to any component. Provider payloads are also untrusted input:
they are clamped and stripped by `sanitizeNormalizedFood` before anything is persisted.

**A conversion happens only when it is mathematically valid.** Grams to ounces is arithmetic.
Millilitres to grams is not — a cup of flour and a cup of honey differ by more than 2×. Where the
density is unknown `lib/logic/servings.ts` returns `null` rather than assuming water, the unit is
not offered in the UI, and the server action refuses it. Grams are always available, because a
scale never needs a food-specific constant.

**Nutrition has one canonical basis.** Foods state their nutrients per 100 g, per serving, per
package or per item, with a `basis` column saying which. All serving maths goes through
`lib/logic/servings.ts` and `lib/logic/nutrition.ts`, which prevents the classic "per serving vs
per 100 g" bug.

**A session is only counted once it ends.** An `in_progress` workout does not feed the day score, the
calendar or Insights — a warm-up you abandoned is not training. Its planner row stays `planned`, which
is what "work outstanding" means everywhere else in the app. Finishing derives the duration from real
elapsed time (clamped, so a session left open overnight cannot claim fourteen hours), and stopping
early counts as trained because it happened; how much is a question the ticked sets answer.

**A logged entry is a snapshot, not a view.** Every `MealEntry` freezes the macros, the
micronutrients, the food's name, its basis and the serving it was computed against. Correcting a
custom food, or a provider refreshing its record, changes the food going forward and never moves a
total that has already been recorded. Copying a meal or a day carries the original snapshot rather
than recomputing.

**A food's identity is its provider plus that provider's id.** `@@unique([provider, externalId])`
means re-selecting the same USDA food updates the cached copy instead of creating a second row —
and that two foods with similar names are never merged. USDA's "Chicken breast, raw" and a
supermarket's "Chicken Breast" are different records with different numbers, and stay that way.
Local and custom foods carry a null `externalId`, which the unique index treats as distinct
(the default `NULLS DISTINCT` behaviour), so the constraint never applies to them.

**Accidental duplication is prevented in the database, not by a disabled button.** A save carries a
client-generated `idempotencyKey`, unique per `(mealId, idempotencyKey)`; a double-click, a retried
submit and an optimistic replay all collide and become a no-op. Meal templates reuse the planner's
`sourceKey` scheme — the same `planTemplateApplication` function, so there is one implementation of
"apply a saved set of rows without doubling it". Deliberate duplication is a separate, explicit
action that takes a fresh key.

**Enums are TEXT.** Every enum-like column is stored as text and validated in
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
`SeedRecord` — plus the universal-OS foundation: `Project`, `Task`, `TaskTag`, `FinanceAccount`,
`FinanceTransaction`, `Bill`, `SavingsGoal`, `Budget`, `FinanceImportBatch`, `InboxItem`,
`LifeDocument`.

**Tasks are not schedule items.** A `ScheduleItem` occupies a slot in a day; a `Task` is an
obligation with an optional due date. Keeping them separate means neither inherits the other's
semantics (materialised recurrence, day scores). Task repeats and bill recurrences share one
anchored cadence engine (`lib/logic/due.ts`) — occurrences generate from the first due date, which
is what keeps "monthly on the 31st" from drifting to the 28th forever. `FinanceAccount.balance`
does not exist as a column: the balance is always `openingBalance + sum(transactions)`, and "set
balance" writes an adjustment transaction instead of editing a number.

**Money movement is data, not categories of convenience.** The two legs of a transfer share a
`transferGroupId` and carry the `transfer` category, so summaries exclude them by construction
and deleting one leg always removes both. Imported transactions carry a deterministic `importKey`
(unique per user) so a re-imported file skips instead of duplicating, plus a link to the
`FinanceImportBatch` that created them — the audit trail behind every import, which is also what
makes undo possible: rolling one back stamps `undoneAt` / `undoneCount` / `keptCount` on the batch
rather than deleting it, so an import that happened stays in the history and a second undo is
refused. A `Budget` is one row per `(user, category)` — the category is the identity, and `period`
(monthly | weekly) is a property of that one budget rather than a second axis, so a category can
never mean two contradictory targets; progress is computed from the ledger window the finance page
already loads, never stored, and `alertThresholdPercent` (null = no alert) is all a threshold
reminder needs. `ScheduleItem.taskId` and `InboxItem.taskId` are optional SetNull links — "this
block came from that task", "this capture became that task" — carrying no scheduling behaviour of
their own.

**Tags are one vocabulary, joined twice.** `TaskTag` is the same shape as `ScheduleItemTag` over
the same user-scoped `Tag` rows, so a tag typed on a task is the tag already on a planner block
rather than a parallel list. Both sides of a join are user-scoped, so a join row can never bridge
two accounts, and the action layer verifies both ids before writing one. `LifeDocument` is the
smallest model an expiry reminder needs — name, kind, expiry date, lead time — with no file
storage: renewal is an edit to `expiryDate`, which re-arms the reminder because the delivery key
embeds the date, exactly how `Bill.nextDueDate` behaves.

**Scheduling is three shared tables, not two parallel families.** `ScheduleRule` is one
effective-dated version owned by `(ownerType, ownerId)`; `ScheduleRuleDay` is one row per selected
weekday, so "which goals apply on Wednesday?" is a real query rather than a `LIKE` over a
comma-separated string; `ScheduleOverride` is a one-date exception (rest / excused / activate /
cancel / reschedule) that never edits the repeating schedule. Goals and habits share all three,
which is what makes a single engine possible.

`HealthMetric` is deliberately generic (date + type + value + unit), which is why the Apple
Health phase added forty-one metric types without a migration. It carries a stable `fingerprint`
— and `Workout` carries `(source, externalId)` — which is what makes an **Apple Health export
importable repeatedly and idempotently, without touching anything you entered by hand**: the
same file twice writes nothing, a later export adds only what is new, and a manual entry's
fingerprint (`manual|type|date`) is a shape no import can produce.

`HealthRecord` holds the parts of an export that are not a number-per-day — an ECG's summary, a
medication, a clinical record, a route's metadata — as one table rather than four, so ownership,
backup, undo and search work identically for every kind. Sleep sessions are deliberately not in
it: they are already intervals in `HealthMetric`, and the Sleep page derives each night from
those rows rather than storing it twice.

---

## Assumptions

These were decisions the brief left open. They're all reversible.

1. **Public accounts, private data.** Originally "single user, no auth"; the hosted version is
   now multi-user with public self-serve registration at `/signup` — email + password held by
   the app itself (no Google, no external identity provider, no credit card), password reset by
   one-time recovery codes (the app sends no email), and database-backed rate limits on
   sign-up, sign-in and recovery. Privacy comes from per-account isolation, not a perimeter:
   `getCurrentUser()` in `src/lib/db.ts` — the one seam every query and action goes through —
   resolves the authenticated session, every read and write is scoped to it, and a
   database-backed cross-user test suite asserts the isolation.
2. **No nutrition API.** See above. `FoodItem` rows with `userId = null` are the bundled database;
   your custom foods carry your `userId`.
3. **Reminders fire while a tab is open — and in the background once Web Push is configured.**
   The original local-first app genuinely could not deliver a background notification; the hosted
   version can, via a service worker and a scheduled runner (`docs/web-push-setup.md`), on devices
   that opted in. Without that setup, in-tab reminders remain the honest baseline and the Settings
   page says which situation you are in.
4. **Weights are stored in the unit you read them in**, with the unit recorded per row, so
   converting later is unambiguous. Workout set weights are always kilograms internally.
5. **Recurrence is deliberately simpler than RFC 5545** — daily/weekly/monthly with an interval,
   weekday selection, and an optional end. That covers workouts, meals, habits and routines without
   dragging in an iCalendar implementation.
7. **Your timezone decides what "today" is**, not the machine's clock. It is detected from the
   browser on first run and changeable in Settings. Calendar days are stored as timezone-free
   `YYYY-MM-DD` keys and converted only at the edges.
8. **Schema changes are committed migrations plus idempotent data backfills.** The SQLite era used
   `prisma db push`; the PostgreSQL version has a real migration history (`prisma/migrations/`),
   applied with `npm run db:migrate` locally and `prisma migrate deploy` on every hosted deploy.
   The TypeScript backfills (`npm run db:backfill`) still check for their own prior output, so
   running them twice changes nothing.
6. **The seeded profile is fictional** and exists purely to make the app look real on first run.
   Reset it from Settings when you're ready to use it for yourself.

---

## Testing

```bash
npm test               # unit — pure logic, no database needed
npm run test:integration   # database-backed, against the disposable test database
npm run test:e2e       # Playwright browser suite (against a running production build)
```

Three suites, each doing the job the others can't. The **unit suite** (1,011 tests) covers the pure
logic that would be expensive to get wrong:

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
* **Due dates & repeats** — the anchored cadence engine: "monthly on the 31st" clamping through
  February (leap years included) and returning to the 31st, occurrence estimates that stay
  correct decades past the anchor, and repeat advancement that never marches through missed
  weeks.
* **Finance** — signed-ledger summaries with adjustments excluded, computed balances, bill
  advancement chains, savings progress capping, deterministic money formatting, and budget
  windows: a monthly budget ignoring rows outside its month, a weekly one measuring only its own
  week (including the days that spill into the next month), and both reading one ledger slice
  without borrowing each other's days.
* **Import undo** — the classification behind "remove this row, keep that one": an untouched row
  removed, an edited date/amount/payee/account kept, a re-categorised row still removed, a
  bill-linked or transfer-linked row kept, and an unrecognisable key kept rather than guessed at.
* **Reminders** — document expiry (fires once in the run-up window, once on the day, silent when
  archived / disabled / already expired, re-armed by a renewal) and budget thresholds (fires at
  the line, once per period per threshold, never for a zero target).
* **Health metrics** — the aggregation rules (fullest device wins, sleep stages union-merged,
  in-bed never added to time asleep), and two registry invariants that catch a half-finished
  metric: every type can read *its own* canonical unit, and every type round-trips through the
  display unit its entry form labels.
* **Apple Health parsing** — the XML scanner's structure and its refusals (entity declarations,
  external DTDs, mismatched tags, oversized elements, excessive depth), the full identifier
  mapping including affine Fahrenheit, fractional percentages, blood-pressure pairing and ring
  totals, and — importantly — assertions that a parsed ECG contains **no voltage sample** and a
  parsed route **no coordinate**.
* **Archives** — the ZIP reader against malformed directories, encrypted entries,
  traversal-shaped names and a decompression bomb; plus a 60,000-record export asserting it
  folds to 400 rows in bounded heap, which is the property the whole streaming design exists
  for.
* **Health import undo** — untouched rows removed, edited rows kept, linked rows kept.
* **Health smart merge** — the rule a re-import applies to a reading it has seen before: create,
  merge, skip as unchanged, or protect. Including the two that matter most — a row edited after
  the import finished is protected, and the grace period that stops an import classifying *its
  own* writes as edits — plus an assertion that merge and undo share one boundary instant, since
  a row protected from re-import but removable by undo would be a contradiction the user could
  see.
* **Health integrity rules** — each check against aggregate numbers, and the negative case that
  matters: every bounded metric accepts an ordinary, healthy range (a 34 bpm resting heart rate
  is an athlete, not a fault), because a check that flags real data teaches you to ignore the
  panel.
* **Deployment configuration** — every route's `maxDuration` held to the value every hosting plan
  accepts, `vercel.json`'s cron cadence held to the free plan's, and the upload limit resolving to
  what the deployment can actually keep. This suite exists because a `maxDuration` above the plan
  ceiling fails the *whole deployment* at deploy time, where lint, types, tests and the build
  never see it.
* Plus nutrition serving maths, the natural-language quick-add parser, planner recurrence, and
  day-key/time handling including a DST boundary.

The unit tests are pure — no database, no fixtures, no mocking — because all the logic they cover
lives in `src/lib/logic`.

The **integration suite** (263 tests) runs against a real PostgreSQL — always the disposable
`personal_os_test` database, reset and re-migrated from zero each run — and covers what pure tests
cannot: unique constraints, transaction rollback, backup import isolation, the health import end to end
(stage → preview → confirm → re-import → incremental import → undo, with ownership refused from
four angles and expiry enforced), the reminder exactly-once ledger, password verification with its lockout and
session-revocation rules, public sign-up (validation, duplicate refusal, racing duplicates, the
rate limit), recovery-code redemption (burn-once, session revocation, enumeration resistance),
a cross-user suite asserting that every major operation against another account is refused
*and* leaves the victim's row unchanged, and the life-OS foundation end to end: bill payment
advancing the due pointer with its atomic ledger row, set-balance writing the exact adjustment,
repeating-task completion, subtask depth limits, command-center assembly, and cross-user denial
for every new finance/task/inbox action. The Phase-3 follow-ups have their own suite: import undo
(scope, kept rows, the audit stamp, refusing a second undo, re-importing after one, cross-user
denial), document expiry end to end through the reminder ledger, budget thresholds and weekly
periods against real ledger rows, task tags (creation by typing, vocabulary reuse, replacement on
edit, the per-task cap, tag deletion leaving tasks standing, two users' identical tag names
staying separate), a v7 backup round-trip that lands documents and tag links in the *importing*
account, and a demo-data pass that seeds every new module and then removes exactly what it
seeded. It also covers the health smart merge against real rows — a re-import protecting a
reading edited after the previous import, merging one nobody touched, re-reading ownership at
confirmation time rather than trusting a stale preview — the import dashboard's aggregates and
recency, and the integrity checks (including that one account never sees another's).

The **e2e suite** (48 tests) drives the built app in a real
browser: signed-out redirects, password sign-in, the identical generic refusal for an unknown
email and for a wrong password (so failed attempts reveal nothing about which emails exist), the
full sign-up → recovery-codes → dashboard → sign-out → password-reset journey, surface postures,
dialogs, responsive overflow and reduced motion — plus a complete Apple Health import round trip
that **builds its own export archive** (so it runs against an empty database too), imports it,
checks the data across the section, re-imports it as a no-op, and undoes it again, alongside the
refusals for a non-export, malformed XML and an entity-declaring file. Two guards keep it honest
rather than merely green: the import flow asserts a **clean console** (uncaught errors and
console errors alike, excluding only the Vercel analytics 404 that every non-Vercel deployment
produces), and every page in the Health section is asserted to **hydrate cleanly** — a hydration
mismatch makes React discard the tree and re-render, which silently swallows clicks and is
invisible to types, lint and every other test.

Its browser-test accounts come from `npm run seed:e2e`, which also prunes the throwaway accounts
the sign-up journey creates and resets the rate-limit counters in the disposable database — the
protection itself is untouched and asserted directly by the integration suite, but the counters
are per-client-per-hour and a local server behind no proxy resolved every run to the same bucket,
so a fourth run within the hour used to fail. Each run now also presents itself as its own client,
which is what separate runs genuinely are.

CI (`.github/workflows/ci.yml`) runs lint, typecheck, all three suites,
migration validation and the production build on every push and pull request.

---

## Backing up

Three options, in increasing order of effort:

1. **Settings → Export → Full JSON backup.** Restorable back into the app; re-importing the same
   file twice never creates duplicates.
2. **Settings → Export → CSV**, per table, for spreadsheets.
3. **A database-level backup** — your managed database provider's own backups/point-in-time
   restore, or `pg_dump` if you run PostgreSQL yourself.

What the file contains, merge vs replace, the verification report and every recovery scenario:
[`docs/backup-and-recovery.md`](docs/backup-and-recovery.md).

---

## Deploying

The app is deployable as a public multi-user website: email + password sign-in held by the app
itself (no Google, no OAuth, no external identity provider, no credit card or billing account
anywhere in the stack), public self-serve registration at `/signup` with rate limiting and
recovery-code password reset, fully separated per-account data, a committed PostgreSQL migration
history applied automatically on every deploy, Vercel configuration included (`vercel.json`
schedules the daily background-reminder safety net; a free external scheduler provides the
timely cadence), and a public `/api/health` endpoint for uptime checks. The whole hosted stack
runs on free tiers with no billing account — Vercel Hobby plus Neon's free PostgreSQL — and
anyone can type the URL and create their own account on the live site. The exact step-by-step
path — Vercel project, database, environment variables, a preview deployment with a smoke
checklist, then production — is [`docs/deployment-guide.md`](docs/deployment-guide.md).
