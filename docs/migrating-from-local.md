# Moving your data from the local app to the hosted site

If you used Personal OS as the local desktop app, everything you tracked
lives in a database on that machine. This guide moves it into your hosted
account, safely, with a way back at every step.

The short version: export a JSON backup from the old app, import it on the
hosted site, check the counts. The import is built so that a failure writes
nothing and a mistake is recoverable.

## Before you start

* The old local app still runs on your machine (you only need it for the
  export in step 1).
* The hosted site is deployed and you can sign in
  ([`deployment-guide.md`](deployment-guide.md)).

## Step 1 — Export from the old local app

1. Open the local app and go to **Settings → Backup**.
2. Press **Export JSON**. A file named
   `personal-os-backup-YYYY-MM-DD.json` downloads.
3. Keep this file somewhere safe even after the migration succeeds — it is
   the complete record of your local data.

## Step 2 — Import into your hosted account

1. Sign in to the hosted site and go to **Settings → Backup**.
2. Under **Import**, leave the mode on **Merge** (for a fresh, empty hosted
   account, merge and replace do the same thing; the difference matters only
   when the account already has data — see
   [`backup-and-recovery.md`](backup-and-recovery.md)).
3. Press **Choose file** and pick the backup from step 1.
4. A **preview** opens: the file's name, its total record count, per-table
   counts, and any warnings (for example, an older backup format — which is
   fine and handled). **Nothing has been written yet.** Cancel here and
   nothing ever is.
5. Press **Import backup**. Three things happen, in this order:
   1. **A backup of the hosted account's current data downloads first**
      (`pre-import-backup-YYYY-MM-DD.json`). Keep it — it is the way back if
      anything about the import turns out wrong.
   2. The import runs, as **one database transaction**.
   3. **A verification report downloads after it completes**
      (`import-report-YYYY-MM-DD.json`) — what the file contained, what was
      created, what was skipped as already present, what was dropped as
      unusable, and per-table counts now in the account.

## Everything lands in your account only

This is worth stating precisely, because the hosted database is shared
between the allowlisted accounts:

* Every imported record is given a **brand-new id derived from your
  account**. The ids inside the file are never used as-is. That means a
  backup file — even a deliberately crafted, malicious one — structurally
  cannot modify, overwrite or attach to another account's records: it has no
  way to name them.
* Records that reference each other inside the file (a set inside a workout,
  an entry inside a meal) keep their relationships, because every reference
  is renamed with the same rule.
* Because the new ids are derived deterministically, importing the same file
  twice is harmless — the second run finds everything already present and
  creates nothing.

This isolation is enforced by the import code and pinned by database-backed
tests (a file carrying another user's real ids leaves their rows untouched;
a child row aimed at another user's parent is dropped, never attached).

## Step 3 — Check the counts

1. Open the downloaded `import-report-….json` in any text editor. For each
   table it lists: how many records were **in the file**, how many were
   **created**, **skipped** (already present) and **dropped** (unusable), and
   the row counts **now in the account**. Created + skipped should account
   for the file's records; dropped should be zero for a healthy backup.
2. Spot-check in the app: the calendar heatmap shows your history, a habit's
   streak looks right, an old workout opens with its sets, a meal from months
   ago still has its totals.
3. Your settings travelled too: name, timezone, units, week start and score
   settings are applied from the backup (never your email or sign-in
   details), so "today" and every day key mean what they meant locally.

## If the import fails

* **Nothing was written.** The restore is a single transaction — a failure
  mid-way rolls the whole import back. Your hosted account is exactly as it
  was before you pressed confirm. Retry; if it fails the same way, see
  [`troubleshooting.md`](troubleshooting.md).
* If you ever have reason to distrust the state anyway (you won't get a
  half-imported account from a failure, but you might regret a *successful*
  import), restore the `pre-import-backup-….json` that downloaded before the
  import, using **Replace** mode. That returns the account to the moment
  before the import.
* A report line about "unusable rows skipped" is different from a failure:
  damaged rows in the file are dropped and counted up front, and everything
  else imports. The verification report says exactly how many, per table.

## Size limit

Vercel caps a single request at about **4.5 MB**, which bounds how large a
backup file can be imported in one go on the hosted site. Real backups from
this app are comfortably under that (the multi-week demo dataset exports at a
small fraction of it). If your file is over the cap, the request is refused
before the app even sees it and nothing is written — see
[`troubleshooting.md`](troubleshooting.md) for the options.

## Returning to the pre-web local version

The complete local-first SQLite version (everything up to and including
"Preview 3") is permanently preserved at commit
`f5b4fe1d950abf56cc11ae97d2750ac714d365fb`. A local tag
`preview3-complete-before-web` marks it, but the tag could not be pushed to
GitHub from the environment that created it — **the commit hash is the
authoritative reference.**

To run it again:

```bash
git checkout f5b4fe1d950abf56cc11ae97d2750ac714d365fb
npm install
npm run setup        # that version uses a local SQLite file — no Docker needed
                     # (npm run setup:empty starts without the demo data)
npm run dev
```

Then restore your data into it via **Settings → Backup** with the JSON
export from step 1 — that file is that version's own format, so this is the
proven path back. To return to the current version afterwards:
`git checkout main`.
