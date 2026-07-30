# Health imports: what leaves your device, and what never does

Health data is the most sensitive thing this app touches, so the import was
built around one rule: **the raw export file never leaves your device.** This
page explains exactly what travels, what doesn't, and what you can undo.

## The short answer

When you import an Apple Health export (or a CSV) on the hosted site, the
file is opened and read **on your own device, inside your browser** — in a
Web Worker, a background thread that keeps the page responsive. The file
itself is never uploaded. Only the *result* of that reading — normalised
daily summary rows — is sent to the server, into your account.

## Step by step

1. **You pick the file** on the Health page (**Import health data**). Apple
   Health's `export.zip` or `export.xml`, or a CSV in the documented format
   (template at `/health-template.csv`).
2. **Your browser parses it, on-device.** The status line says so while it
   happens: "Reading the file on this device…". Unzipping, XML scanning and
   CSV parsing all run locally.
3. **Only summary rows upload**, in small, bounded chunks (at most 2,000 rows
   and roughly 800 KB per chunk), into an **import session** that the server
   created for your signed-in account. The session id is server-generated and
   tied to you — a browser cannot choose whose session it uploads into, and
   database-backed tests assert that another account can neither add to,
   finalize, confirm nor cancel your session.
4. **The server re-checks everything.** Every row is validated again on
   arrival (known metric types, sane dates, bounded values), and every
   deduplication fingerprint is recomputed from the row's actual content — a
   tampered upload cannot lie about what it contains. A CSV import cannot
   claim its rows were "measured by Apple Health".
5. **The preview writes nothing.** You see what was found — categories,
   counts, date range, what is already present — while your health tables are
   untouched.
6. **You choose what to bring in**, per category, and confirm. The write is
   one transaction, recorded as an **import batch**.

## What a "summary row" actually is

Not raw sensor samples. Rows are rolled up to **one row per day, per metric,
per source device** — for example: *steps, 2026-03-14, iPhone, 9,412*. Sleep
keeps its stages, heart rate keeps the day's range, weight readings stay
individual. Workouts in the export import as real workout records. Record
types the app doesn't support (audiograms, ECGs, and so on) are **counted and
skipped on your device** — they are never uploaded at all.

## Cancelling, and what happens to an abandoned import

* **Cancel at any stage** discards the staged rows — the session and its
  chunks are deleted from the server.
* **An abandoned session expires on its own** after two hours and is swept
  away. Staged rows are staging, not data: nothing reaches your health
  records except through the confirm step.
* **An interrupted upload writes nothing partial.** If you close the page
  mid-upload, the staged remainder simply expires; restart by picking the
  file again. (Re-importing is always safe — see below.)

## Removing an import later

Every confirmed import is a **batch**, listed in the Health page's import
history. Removing a batch:

1. shows a preview of exactly what would be deleted, per category;
2. deletes precisely that batch's rows and the workouts it created;
3. leaves your manual entries and every other batch untouched;
4. recalculates every derived number (day scores, calendar, insights) for the
   affected days.

Re-importing the same file later is a no-op for anything already present:
every record carries a stable fingerprint, so a repeat import writes zero new
rows, and a later, larger export adds only what is genuinely new.

## Nothing health-shaped in the logs

* The import code never logs row contents.
* The database query log (when explicitly enabled with
  `PRISMA_LOG_QUERIES=1`) records query text and duration **only** —
  parameters are never logged, so no value, date or device name can end up in
  a server log.
* Errors are logged under a short reference id with the error message only —
  never the payload that caused them.
* A committed test walks the health modules and asserts they contain no
  network call, and the food-search interface is structurally sealed so no
  health field can ride along on a food lookup.

## The honest limits

* The parsed plan lives in the page's memory during upload, so an in-flight
  upload does not survive leaving the page — you re-pick the file, and
  nothing partial was written.
* Multi-year exports parse in under a second and import in a few seconds
  (measured — see [`performance-measurement.md`](performance-measurement.md)),
  but the browser does hold the file's bytes in memory while parsing; an
  extraordinarily large export is bounded by your device's memory, not the
  server's.
