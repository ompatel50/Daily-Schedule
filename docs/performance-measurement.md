# Performance: how the numbers were measured, and how to repeat them

The performance figures quoted in `IMPLEMENTATION_PROGRESS.md` (and copied
below) are measurements, not estimates. This page records the method exactly,
so the numbers can be re-taken after any change and compared honestly.

## The method

All measurements were taken:

* **against the production build** (`npm run build && npm start`) — never the
  dev server, whose numbers mean nothing;
* **in a real browser**, driven by Playwright;
* **with the privacy-safe query log** — `PRISMA_LOG_QUERIES=1` makes the
  server print each database query's SQL shape and duration. It deliberately
  logs query text only, never parameters, so no personal value can reach a
  log (see `src/lib/prisma.ts`).

Three kinds of numbers were collected:

1. **Queries per navigation** — count the query lines the server logs between
   a route request starting and finishing. This is the number that matters
   most for a hosted deployment: every query is an app-to-database round-trip,
   so query counts translate directly into latency once a network sits
   between them. (The measurements below were taken against a local database;
   the milliseconds are local, the *counts* carry.)
2. **First-load JS per route** — read straight from the table `next build`
   prints.
3. **Warm client-side navigation** — with the app open, time from clicking a
   sidebar tab to the content area being updated, via Playwright.

## Repeat it yourself

1. ```bash
   npm run build          # note the first-load JS table it prints
   PRISMA_LOG_QUERIES=1 npm start
   ```
2. Sign in, then visit each route once (cold), and again by clicking tabs
   (warm). Count the query lines logged for each navigation.
3. For timing, the e2e suite (`npm run test:e2e`, see
   [`local-development.md`](local-development.md)) drives the same
   navigations reproducibly; Playwright reports per-test timings.
4. Compare against the tables below. Regressions announce themselves as
   query-count jumps long before they are felt as milliseconds.

## The results (Phase 23 — copied from IMPLEMENTATION_PROGRESS.md)

Queries per navigation and first-load JS, before → after the performance
phase. The measurement window includes the reminder feed, which before was
blocking navigation and now loads after paint:

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
before → 47–67 ms after**, with a loading skeleton appearing immediately
inside the persistent shell. Server render time stayed 35–85 ms per route on
the local setup.

What produced the gains, in one line each: request-level memoisation of the
per-day computations (the same goal evaluation no longer runs twice per
render); the reminder feed moved off the render path; unbounded reads
windowed; a per-series N+1 on planner open replaced with one grouped query;
charts, the command palette and the quick-add dialog moved out of every
route's first load.

## Health import measurements (Phase 22)

Same method — production build, real browser, synthetic Apple Health exports
generated at three sizes. First import into an empty account:

| Export | File | Parse (on-device worker) | Upload | Server preview | Confirm (write + rebuild) | Days recomputed |
|---|---|---|---|---|---|---|
| 1 month (~1.2 k records) | 0.2 MB | 0.1 s | 0.1 s | 0.1 s | 1.0 s | 42 |
| 1 year (~15 k records) | 2.5 MB | 0.2 s | 0.2 s | 0.5 s | 1.9 s | 377 |
| 3 years (~45 k records) | 7.5 MB | 0.4 s | 0.4 s | 0.6 s | 4.9 s | 1,107 |

A second import of the same files wrote **0 new rows** at every size — the
deduplication holds end to end.

One number in that table is a lesson worth keeping: the 3-year parse
originally took **95.3 seconds**. Measuring exposed an accidentally
quadratic scan in the XML parser; fixing it brought the same parse to
**0.4 seconds** with identical output. That is why this page exists — the
numbers were only found because they were measured, and they stay honest only
if they are re-measured the same way.

## Caveats, stated plainly

* The local-database milliseconds above are a floor, not a promise: a hosted
  deployment adds a network round-trip per query, which is exactly why the
  database should sit in the same region as the app
  ([`deployment-guide.md`](deployment-guide.md), step 2) and why query counts
  are the durable metric.
* Timings vary run to run and machine to machine; treat small differences as
  noise and query-count changes as signal.
