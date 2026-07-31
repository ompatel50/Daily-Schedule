# Backups and recovery

Your data lives in one PostgreSQL database. Backups exist so that no single
mistake — yours, the app's, or the hosting provider's — can be the end of it.
The habit is one button; this page explains what that button produces and how
to get back from each kind of trouble.

## Make exports a habit

**Settings → Backup → Export JSON** downloads a complete backup of your
account as a single file, named `personal-os-backup-YYYY-MM-DD.json`.

Reasonable moments to export:

1. Before and after any import (the app also does the "before" one for you —
   see below).
2. Before using **Replace** mode or the **Delete all data** button.
3. On a schedule you'll actually keep — monthly is fine for most people.
4. Before trying anything you're unsure about.

Keep the files anywhere you keep files — they are yours, they are plain
JSON, and they need nothing from the app to remain readable.

## What the backup file contains

Everything you own, across every table the app has: planner items and
routines, habits and their logs, meals, food records and meal templates,
workouts, sets and workout templates, health metrics and the record of each
health import batch, goals and their schedules, journal entries, reminders,
favourites, tasks and projects, finance accounts with their transaction
ledger (transfer pairings and CSV import identities included), bills and
subscriptions, savings goals, budgets, CSV import batch records, inbox items
(with their converted-to-task links), and the sample-data registry. It also carries a safe subset of
your settings — name, timezone, units, week start, day window and score
settings — plus a format version and a checksum so a damaged file is
detected rather than half-imported.

What it deliberately does **not** contain:

* no sign-in material at all: not your email, not the password hash, not
  session or lockout state. Your account does have a password now, but it is
  never exported — a backup can be stored or shared without exposing any way
  into your account;
* push notification device registrations (those belong to each device, which
  can simply re-enable).

## Re-import semantics: merge vs replace

The import (**Settings → Backup → Choose file**) offers two modes:

* **Merge** — keeps everything already in the account and adds what the file
  has that the account doesn't. Records that already exist are skipped, not
  overwritten: merge never modifies an existing record.
* **Replace** — deletes the account's current data first, then imports the
  file. This is the "restore to exactly that point in time" mode.

Either way, three protections always apply:

1. **A preview first.** Choosing a file shows its version, warnings and
   per-table counts before anything is written; cancelling writes nothing.
2. **A pre-import backup downloads automatically** when you confirm — even a
   replace import always leaves a local way back.
3. **One transaction.** A failure mid-import rolls the whole thing back;
   there is no half-imported state.

Imports are idempotent (importing the same file twice creates nothing the
second time), and every imported record is re-identified into *your* account
— a file can never touch another account's data. The mechanics are described
in [`migrating-from-local.md`](migrating-from-local.md).

## The verification report

After every import a second file downloads: `import-report-YYYY-MM-DD.json`.
It records the mode, the file's format version, and — per table — how many
records were in the file, created, skipped as already present, and dropped as
unusable, plus the row counts now in the account. Read it after any import
that matters; "created + skipped ≈ in file, dropped = 0" is the healthy
shape.

## CSV exports

**Settings → Backup → CSV export** produces per-table CSVs (schedule, habit
logs, nutrition, workouts, health metrics) for spreadsheets. They are for
looking at your data outside the app — they are **not** restorable backups.
The JSON export is the backup.

## Belt and braces: database-level backups

The JSON export protects your data as *yours* — portable, readable,
restorable through the app into any account. A second, independent layer is
the database itself:

* **Managed database (the normal hosted setup):** the provider you created in
  the deployment guide (Neon, in the recommended free setup) takes its own backups
  and/or offers point-in-time restore — check the provider's dashboard for
  what your plan includes and how far back it reaches. This is the layer that
  saves you if the database itself is lost or corrupted.
* **Self-hosted PostgreSQL:** `pg_dump` on whatever schedule you trust.

Neither replaces the JSON export: a provider restore rolls back the *whole
database* (every account in it) to a point in time, while a JSON import
restores *one account's data* precisely, and works even into a brand-new
database.

## Recovery, scenario by scenario

| What happened | What to do |
|---|---|
| Deleted a few things by accident | Import your most recent export in **Merge** mode — deleted records come back; everything you changed since stays as it is (merge never overwrites existing records). |
| An import you regret (the import itself succeeded) | Import the `pre-import-backup-….json` that downloaded before it, in **Replace** mode. |
| An import failed partway | Nothing was written — the transaction rolled back. Retry, or see [`troubleshooting.md`](troubleshooting.md). |
| Pressed "Delete all data" and regret it | Import your most recent export (either mode — the account is empty). |
| The database itself is gone or unreachable | Provider-level restore from their dashboard; or point the app at a fresh database (migrations apply on deploy) and import your newest JSON export. |
