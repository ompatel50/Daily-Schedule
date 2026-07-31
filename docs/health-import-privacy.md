# Health imports: what is stored, what is dropped, and what you can undo

Health data is the most sensitive thing this app touches. This page explains exactly what
happens to an Apple Health export you import, what is deliberately never stored, and how to take
an import back.

For the full reference — every supported record type, the duplicate rules, the performance
limits — see [`health-module.md`](health-module.md).

## The short answer

Your export is uploaded to **your own instance of this app**, parsed there, and deleted. Only
the summarised rows you preview and confirm are saved, into your account. The most sensitive
parts of the archive — ECG voltage traces, GPS coordinates, raw clinical documents — are read
for their summary and then dropped; they are never stored.

> **A note on an earlier version.** This app used to parse health exports in the browser and
> upload only the resulting rows. That kept the file off the server, but it meant the server had
> to trust numbers a client had produced, and it capped importable exports at what a phone or
> laptop could hold in memory. Parsing now happens on the server: the file is streamed rather
> than buffered, so a multi-gigabyte export works; every record is read by code you can audit in
> this repository; and nothing depends on trusting the browser. The file itself is transient —
> see below.

## Step by step

1. **You pick the file** at `/health/import`. Apple Health's `export.zip` or `export.xml`, or a
   CSV in the documented format (template at `/health-template.csv`).
2. **It uploads to your server**, streamed straight to a scratch path — never held in memory, so
   the size of your export is not limited by anyone's RAM. An unauthenticated request is refused
   before a single byte is read.
3. **The server parses it.** The ZIP directory is read, `export.xml` is streamed through a
   scanner a megabyte at a time, and records are folded into per-day summaries as they go.
4. **The upload is deleted.** In a `finally`, on every path — success, refusal, or crash.
5. **The preview writes nothing.** You see what was found — categories, counts, date range, what
   is already present, what was skipped and why — while your health tables are untouched.
6. **You choose what to bring in**, per category, and confirm. The write is one transaction,
   recorded as an **import batch**.

Cancel at any point and the staged rows are deleted. An abandoned import expires on its own
after two hours. Nothing reaches your health records except through the confirm step.

## What a "summary row" actually is

Not raw sensor samples. Rows are rolled up to **one row per day, per metric, per source device**
— for example: *steps, 2026-03-14, Apple Watch, 9,412*. Sleep keeps its stages, heart rate keeps
the day's range, individual weight readings stay individual, and workouts import as real workout
records.

## What is never stored

| In the archive | What this app keeps |
| --- | --- |
| `electrocardiograms/*.csv` — a 30-second voltage trace | The classification, average heart rate, symptoms and date. **No voltage sample.** |
| `workout-routes/*.gpx` — every GPS point of a run | The point count, total distance and time span. **No coordinate.** The distance is computed while streaming and the coordinates are discarded. |
| `clinical-records/*.json` — FHIR payloads: diagnoses, lab values, notes | Nothing. Only the index entry in `export.xml` is read, giving a name, a provider and a date. |
| `export_cda.xml` | Nothing. It duplicates data already read. |
| Record types this app does not track | Nothing. They are counted, listed in the preview, and skipped. |

A committed test asserts that a parsed ECG contains none of its sample values and that a parsed
route contains none of its coordinates.

## Where it goes, and who can see it

* Every health row carries your user id. Every query in the Health module is scoped by it.
* Every server action resolves the user from the session cookie; none of them accepts a user id
  from the caller, so there is no parameter to tamper with.
* Database-backed tests assert that a second account can neither preview, confirm, cancel nor
  undo your import, and that importing writes no row owned by anyone else.
* Two accounts importing the same export get their own independent copies; neither can see the
  other's.

## Nothing leaves your instance

* The import code makes **no network calls at all** — a committed test walks the health modules
  and asserts there is no `fetch`, no socket import, no HTTP client.
* No third-party analytics, error reporter or sync service receives health data.
* The database query log (only when explicitly enabled with `PRISMA_LOG_QUERIES=1`) records
  query text and duration **only** — parameters are never logged, so no value, date or device
  name can reach a server log.
* Errors are logged under a short reference id with the message only, never the payload.

## A file a stranger could have crafted

An import is one of the few places the app reads a complex file, so the parser is written for
hostile input:

* **Entity attacks (XXE, billion laughs) have nothing to work with.** The scanner resolves no
  entities at all. A document that *declares* one — or points at an external DTD — is refused
  outright rather than read with a meaning the file did not intend. (A real export's DTD, which
  declares only elements and attributes, is skipped normally.)
* **Zip bombs stop at a budget.** Decompression is capped as the bytes are produced, so an
  archive claiming to expand to 100 GB fails the import rather than the host.
* **Sizes are bounded everywhere** — the upload, the decompressed XML, one element, the
  prologue, nesting depth, attribute count, and how many member files are read.
* **Archive paths are never used as paths.** Nothing is written to disk from an archive, and a
  name containing `..` or an absolute path is refused outright.
* **The file type is decided from the bytes**, never from the name or the content type the
  browser claimed.

## Re-importing, and undoing

**Re-importing is always safe.** Every record carries a stable fingerprint derived from its
content, so importing the same export twice writes nothing new, and a later, larger export adds
only what is genuinely new. You never have to remember what you imported last.

**Every import can be undone**, from `/health/imports`. The undo:

1. shows a preview of exactly what it would delete, per category — **and what it would keep**;
2. deletes that batch's rows, its workouts and its records, and nothing else;
3. keeps anything you have edited since the import, and any imported workout you have since
   added sets to or scheduled from — deleting those would throw away your own work;
4. leaves manual entries and every other batch untouched by construction;
5. recalculates every derived number (day scores, calendar, insights, goals) for the affected
   days;
6. happens once — a second undo is a no-op, not a way to reach rows a later import wrote.

## The honest limits

* **Your server sees the file.** That is the trade for parsing something a browser cannot hold.
  If you self-host, that server is yours. If you deploy to a provider, the file exists on their
  disk for the duration of the parse and is then deleted — the app cannot make a stronger
  promise than that, and does not pretend to.
* **A very large export takes minutes**, most of it streaming and parsing. The import page shows
  progress; the batch records how long it actually took.
* **A hosting platform's own limits bind before this app's do.** Vercel caps request body size
  and execution time per plan; a self-hosted deployment has neither cap. The app detects this and
  advertises the smaller, truthful number — the import page states what the deployment will
  actually accept, and a refusal says the platform is the reason. `HEALTH_MAX_UPLOAD_MB`
  overrides it when you know your real limit. If an export is larger than the platform allows,
  self-hosting is the answer.
* **A re-import will not overwrite a reading you edited.** It is reported as kept, not written
  over, and counted on the import's own history row. See the merge rules in
  [`health-module.md`](health-module.md).
* **An in-flight upload does not survive leaving the page.** Nothing partial is written; pick
  the file again.
