# Deployment guide — putting Personal OS on the web

This is the master guide for deploying Personal OS to Vercel with a managed
PostgreSQL database. Follow it top to bottom; every other guide in `docs/` is
linked from the step that needs it.

Two honest notes before anything else:

* **This deployment has not been performed yet.** The coding environment that
  produced this guide had no Vercel or Google credentials, so no project was
  created and no deploy was run from it. Everything on the *app's* side — the
  build script, the migrations, the environment variables, the endpoints — is
  implemented and verified; the dashboard steps below describe the standard
  Vercel and Google flows, whose exact button labels may drift over time.
  This guide is the exact remaining path a person has to walk.
* **The pre-web local version is permanently preserved** at commit
  `f5b4fe1d950abf56cc11ae97d2750ac714d365fb` (local tag
  `preview3-complete-before-web`; pushing tags was blocked from the coding
  environment, so the commit hash is the authoritative reference). Nothing in
  this guide can damage it. How to return to it is in
  [`migrating-from-local.md`](migrating-from-local.md).

## What you need before starting

1. The GitHub account that owns this repository.
2. A Vercel account (the free Hobby plan works; one limit is noted in step 7).
3. A Google OAuth client ID and secret — created by following
   [`google-oauth-setup.md`](google-oauth-setup.md). Do that first and keep the
   two values handy.
4. About 30–45 minutes.

## Step 1 — Create the Vercel project from the GitHub repository

1. Go to <https://vercel.com> and sign in with your GitHub account.
2. Choose **Add New → Project** and import this repository from the list.
3. Vercel detects Next.js automatically. **Leave the build settings alone.**
   The repository's `package.json` contains a `vercel-build` script
   (`prisma generate && prisma migrate deploy && next build`), and Vercel runs
   that script instead of the plain build whenever it exists — that is what
   applies database migrations on every deploy. There is nothing to configure.
4. **Do not press Deploy yet.** First create the database (step 2) and set the
   environment variables (step 3). If you already deployed and it failed,
   that is harmless — it will succeed once the variables exist and you
   redeploy.

## Step 2 — Create the managed PostgreSQL database

The app needs plain PostgreSQL (version 16 or newer); nothing
provider-specific. The easiest path is a database from the Vercel Marketplace.

1. In your Vercel project (or team dashboard), open the **Storage** tab and
   choose **Create Database**.
2. Pick a PostgreSQL provider from the Marketplace — **Prisma Postgres** or
   **Neon** both work.
3. **Pick the same region as your Vercel project** (or the nearest one
   offered). This matters more than it sounds: every page load runs a handful
   of small database queries (7–30 depending on the route — see
   [`performance-measurement.md`](performance-measurement.md)), and each query
   is a round-trip between the app and the database. In the same region a
   round-trip is a millisecond or two; across an ocean it can be a hundred.
   The same page that feels instant colocated feels broken cross-region.
4. Find the database's **connection strings**. Most providers show two:
   * a **pooled** connection string (sometimes labelled "pooler" or
     "pgbouncer") — this becomes `DATABASE_URL`;
   * a **direct** (non-pooled) connection string — this becomes
     `DIRECT_DATABASE_URL`. Migrations must use this one; running migrations
     through a pooler can fail in confusing ways.

   If your provider shows only one connection string, use it for both
   variables.
5. Some Marketplace integrations offer to add environment variables to the
   project automatically, sometimes under their own names. That is fine, but
   the app reads exactly `DATABASE_URL` and `DIRECT_DATABASE_URL` — make sure
   those two exist with the right values in step 3.

## Step 3 — Set the environment variables

In the Vercel project: **Settings → Environment Variables**. Unless noted,
apply each variable to both the **Production** and **Preview** environments.
These are the same variables documented in `.env.example` in the repository.

| Variable | Required? | What it is |
|---|---|---|
| `DATABASE_URL` | Yes | The database connection string (the pooled one, if your provider has both). |
| `DIRECT_DATABASE_URL` | Yes | The direct, non-pooled connection string. Migrations use this. Locally the two are identical. |
| `AUTH_SECRET` | Yes | The secret that signs sign-in sessions. Generate one on your computer with `npx auth secret` (or `openssl rand -base64 33`) and paste the value. Rotating it later signs everyone out immediately. |
| `AUTH_GOOGLE_ID` | Yes | The Google OAuth client ID from [`google-oauth-setup.md`](google-oauth-setup.md). |
| `AUTH_GOOGLE_SECRET` | Yes | The Google OAuth client secret from the same place. |
| `ALLOWED_EMAILS` | Yes | Comma-separated email addresses allowed to sign in — e.g. `you@gmail.com,partner@gmail.com`. Anyone else is refused even after Google authenticates them. **Empty means nobody can sign in** — the allowlist fails closed. |
| `CRON_SECRET` | For background reminders | A random secret protecting the scheduled reminder endpoint. Generate with `openssl rand -base64 32`. Vercel sends it automatically as an `Authorization: Bearer` header when the variable is set. |
| `USDA_FDC_API_KEY` | Optional | Free key for USDA food search (<https://fdc.nal.usda.gov/api-key-signup.html>). Without it, food search still works locally and says USDA is not set up. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Optional | Web Push keys for background reminders — see [`web-push-setup.md`](web-push-setup.md). Without them, reminders work only while a tab is open. |
| `AUTH_TRUST_HOST` | **Not on Vercel** | Only needed when self-hosting behind a proxy (`AUTH_TRUST_HOST="true"`). Vercel sets the equivalent itself. |
| `DANGEROUSLY_ENABLE_DEV_LOGIN` | **Never in production** | Local development only. The app ignores it on Vercel regardless, but do not set it here. |

Two things to know about Vercel environment variables:

* Changing a variable does **not** affect the running site until you
  **redeploy** (Deployments → the latest deployment → Redeploy).
* Preview deployments read the Preview environment. Because the allowlist is
  enforced server-side on every deployment, **a preview URL is never publicly
  usable** — someone who stumbles on the link still cannot sign in.

## Step 4 — How database migrations run (nothing to do, but worth understanding)

You never run migrations by hand against production. Every deploy's
`vercel-build` step runs `prisma migrate deploy`, which applies exactly the
migration files committed in `prisma/migrations/` — nothing generated, nothing
guessed — and records which ones have run, so re-deploying is always safe.
The one requirement is the one from step 2: `DIRECT_DATABASE_URL` must be the
direct (non-pooled) connection string, because that is what migrations connect
through. If a deploy fails during the migration step, that is the first thing
to check — see [`troubleshooting.md`](troubleshooting.md).

## Step 5 — Deploy a preview first and smoke-test it

Vercel builds every branch and pull request into a **preview deployment** with
its own URL, using the Preview environment variables. Use one as your dress
rehearsal:

1. Push any branch (or open a pull request); Vercel builds it and shows the
   preview URL on the deployment page.
2. One caveat, stated plainly: if the Preview environment points at the same
   database as Production (the simple setup), a preview writes into that same
   database. For a first-ever deployment the database is empty, so
   smoke-testing there is fine. Later, either give Preview its own database or
   do your checking on the production URL directly.
3. Google sign-in only works on URLs that are registered as redirect URIs.
   Google matches them **exactly**, so add the exact preview URL you intend to
   test on (see [`google-oauth-setup.md`](google-oauth-setup.md)) — or run the
   smoke checklist on the production URL after step 6 instead.

### The smoke checklist

Run through this in order. Every line should hold.

1. Open the URL. You land on the sign-in page, and the browser shows the
   padlock (HTTPS).
2. Sign in with an allowlisted Google account. You land on the dashboard of an
   **empty** account — no demo data, just the optional getting-started
   checklist (which offers sample data but never loads it uninvited).
3. Try an email that is **not** in `ALLOWED_EMAILS` (a second Google account
   works). Sign-in is refused with the "isn't approved" message — it never
   reaches the app.
4. Click through every tab: Dashboard, Today, Planner, Habits, Nutrition,
   Workouts, Health, Calendar, Insights, Settings. Each loads without an
   error.
5. Settings → Backup → **Export JSON**. A backup file downloads.
6. Settings → Backup → **Choose file**, pick the file you just exported. The
   preview dialog shows its record counts. Press **Cancel — import nothing**
   (the preview writes nothing; this checks the whole import path safely).
7. Health → **Import health data**, using the synthetic CSV template
   (download it from `/health-template.csv` on the site). The preview shows
   what it found. Either cancel, or confirm and then remove the import batch
   from the Health page afterwards — both paths are part of the design.
8. Open `/api/health` on the site. It answers `{"status":"ok"}`.
9. Sign out from the account menu in the top bar. You are back on the sign-in
   page, and opening any deep URL (e.g. `/planner`) redirects there too.

## Step 6 — Production

1. Merge or push to `main`. Vercel builds it as the production deployment at
   your project's domain (`your-project.vercel.app`, plus any custom domain
   you add under **Settings → Domains** — remember to add a custom domain's
   redirect URI in Google too).
2. Re-verify the three things that matter most, on the production URL:
   * HTTPS padlock;
   * an unauthorized email is refused;
   * your account starts empty — no demo data.

Then bring your real data over: [`migrating-from-local.md`](migrating-from-local.md).

## Step 7 — Scheduled reminders (Vercel Cron)

The repository's `vercel.json` declares one cron job: call
`/api/reminders/run` every 5 minutes. Vercel reads that file automatically on
deploy — there is nothing to configure beyond setting `CRON_SECRET` in step 3.
When `CRON_SECRET` is set, Vercel sends it as an `Authorization: Bearer`
header with each cron invocation; the endpoint refuses everything else (it
answers 503 when the secret isn't configured at all, and 401 for a wrong or
missing header — it fails closed, never open).

Honest limits:

* Vercel crons run against the **production** deployment only.
* **Plan limits apply.** On some plans (Hobby, historically) crons cannot run
  as often as every 5 minutes — check your plan's cron limits in the Vercel
  docs. A less frequent cron means reminders arrive later; an occurrence more
  than 30 minutes past its time is skipped rather than delivered absurdly
  late. If your plan's cadence isn't enough, any external scheduler that can
  send `GET https://YOUR-DOMAIN/api/reminders/run` with the header
  `Authorization: Bearer <your CRON_SECRET>` every 5 minutes works identically.
* The cron only matters for **background push** reminders. In-tab reminders
  need no cron at all.

Full push setup (VAPID keys, per-device enabling) is in
[`web-push-setup.md`](web-push-setup.md).

## Step 8 — Uptime monitoring (optional)

Point any uptime monitor at `https://YOUR-DOMAIN/api/health`. It answers
`200 {"status":"ok"}` when the app can reach its database and
`503 {"status":"degraded"}` when it cannot, and deliberately reveals nothing
else — no versions, no counts. It needs no sign-in, so any monitoring service
can use it.

## After deploying — one small verification worth doing

No live request to the USDA or Open Food Facts food APIs was ever possible
from the environment the provider code was built in (its network blocked both
hosts), so the providers are verified against captured fixtures only. After
deploying, search for a food (e.g. "chicken breast") once and confirm online
results appear. From any normal computer you can also run
`node scripts/smoke-food-providers.mjs` (optionally with `USDA_FDC_API_KEY`
set), which performs the same checks and prints PASS/FAIL per provider.

## Where to go next

| Guide | When |
|---|---|
| [`google-oauth-setup.md`](google-oauth-setup.md) | Before step 3 — creating the Google sign-in credentials |
| [`migrating-from-local.md`](migrating-from-local.md) | Moving your real data from the local app |
| [`web-push-setup.md`](web-push-setup.md) | Background reminder notifications |
| [`backup-and-recovery.md`](backup-and-recovery.md) | The backup habit, once you're live |
| [`security-and-privacy.md`](security-and-privacy.md) | What protects the site, and the off switches |
| [`troubleshooting.md`](troubleshooting.md) | When something on this page didn't work |
