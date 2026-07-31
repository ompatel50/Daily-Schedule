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

## Health import measurements (Phase A.1 — server-side streaming)

Method: the real parser (`parseAppleHealthArchive`) against synthetic Apple
Health archives generated at five sizes, on the same machine as the numbers
above. Each archive is a genuine ZIP with a real `export.xml`, including the
internal DTD subset a real export carries.

| Export | Records | Archive | `export.xml` | Parse | Rows written | Heap growth |
|---|---|---|---|---|---|---|
| 1 month | 1,238 | 0.03 MB | 0.3 MB | 0.03 s | 180 | ~0 MB |
| 1 year | 15,057 | 0.1 MB | 2 MB | 0.10 s | 2,190 | 9 MB |
| 3 years | 45,169 | 0.3 MB | 7 MB | 0.25 s | 6,570 | ~0 MB |
| 10 years | 223,563 | 1.3 MB | 37 MB | 1.26 s | 21,900 | 19 MB |
| 10 years, sample-heavy | **1,099,563** | 7.0 MB | **181 MB** | **5.45 s** | 21,900 | **22 MB** |

The last two rows are the point. Between them the record count grows **5×**
and the XML grows **5×**, while the rows written stay identical (same days,
same metrics, same devices) and **heap growth stays flat at ~20 MB**. That is
the streaming accumulator working as designed: memory is proportional to
distinct days × metrics × devices, not to the size of the file. The obvious
alternative — collect every sample, then roll up — would have needed hundreds
of megabytes for the last row and would keep growing with the export.

Parse time is linear in records (~200 k records/second), so an export twice
this size costs twice the seconds and the same memory.

A second import of the same archive writes **0 new rows** at every size — the
deduplication holds end to end, and the preview says so before anything is
written.

### What replaced the on-device parser, and why

Phase 22 parsed exports in a browser Web Worker and measured 0.4 s for a
3-year file. Those numbers were real, but the approach capped an import at
what the user's device could hold in memory and required the server to trust
rows a client had produced. Parsing now happens on the server against a
streamed file. The measurable trade:

* **Better:** a 181 MB `export.xml` is parsed in 22 MB of heap; the browser
  version had to hold the decompressed file *and* every parsed sample.
* **Same:** end-to-end wall clock for realistic exports — the parse was never
  the slow part; the transactional write and the day-summary rebuild are.
* **Worse:** the file crosses the network once. That is the cost of not
  trusting the client and of supporting exports a phone cannot parse.

One number from Phase 22 is a lesson worth keeping regardless: the 3-year
parse originally took **95.3 seconds** because of an accidentally quadratic
scan in the XML parser; measuring exposed it and the fix brought the same
parse to well under a second with identical output. That is why this page
exists — the numbers were only found because they were measured, and they stay
honest only if they are re-measured the same way.

## Health dashboard and import history (Phase A.2)

Everything the Health section added in this phase is bounded by construction
rather than by a limit that happens to be big enough.

| Surface | Cost |
| --- | --- |
| Health overview | Nine queries in one `Promise.all` (was eight plus a sequential ninth — the import count was awaited after the batch, adding an avoidable round trip). Rows are partitioned by type **once** and reused across ~25 metrics; the previous shape re-filtered the whole 30-day row set per metric. |
| Import dashboard | Five queries: one bounded list (100 rows), one count, one `groupBy` on status, one `aggregate` for the sums, one count of staged sessions. The totals are aggregates over *every* batch, so an account with hundreds of imports pays the same as one with three. |
| Import history search | Filtered in the browser over the list the page already fetched. A round trip per keystroke would be both slower and a query per keystroke against the health tables. |
| Integrity checks | Six aggregates — two `groupBy`s and four counts. Not one materialises a row, which is why the panel costs the same for 400 readings and 4,000,000. The trade: a min/max says a metric *holds* an impossible value without saying how many, so the check counts metrics rather than claiming a row count it never measured. |
| Smart merge | No new queries in the hot path. The existing fingerprint lookup selects four more columns on the same scan, plus one bounded lookup of the batches those rows belong to — bounded by the number of distinct past imports touching the plan's date range. |

Every one of these is served by indexes that already existed
(`(userId, date)`, `(userId, type, date)`, `(userId, createdAt)`,
`(userId, status)`, `(batchId)`). This phase added two columns and no index.

## Caveats, stated plainly

* The local-database milliseconds above are a floor, not a promise: a hosted
  deployment adds a network round-trip per query, which is exactly why the
  database should sit in the same region as the app
  ([`deployment-guide.md`](deployment-guide.md), step 2) and why query counts
  are the durable metric.
* Timings vary run to run and machine to machine; treat small differences as
  noise and query-count changes as signal.
