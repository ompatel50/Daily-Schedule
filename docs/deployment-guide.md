# Deployment guide — putting Personal OS on the web

This is the master guide for deploying Personal OS to Vercel with a managed
PostgreSQL database. Follow it top to bottom; every other guide in `docs/` is
linked from the step that needs it.

Two honest notes before anything else:

* **This deployment has not been performed yet.** The coding environment that
  produced this guide had no Vercel credentials, so no project was created and
  no deploy was run from it. Everything on the *app's* side — the build
  script, the migrations, the environment variables, the endpoints, the
  `/setup` and sign-in pages — is implemented and verified; the dashboard
  steps below describe the standard Vercel and Neon flows, whose exact button
  labels may drift over time. This guide is the exact remaining path a person
  has to walk.
* **The pre-web local version is permanently preserved** at commit
  `f5b4fe1d950abf56cc11ae97d2750ac714d365fb` (local tag
  `preview3-complete-before-web`; pushing tags was blocked from the coding
  environment, so the commit hash is the authoritative reference). Nothing in
  this guide can damage it. How to return to it is in
  [`migrating-from-local.md`](migrating-from-local.md).

## What you need before starting

1. The GitHub account that owns this repository.
2. A Vercel account on the free **Hobby** plan — **no credit card needed**.
3. A free Neon account for the database (created in step 2) — **no credit
   card needed** there either.
4. About 30–45 minutes.

That is the whole list. Sign-in is a private email + password held by the app
itself, so there is **no Google Cloud project, no OAuth client, no external
identity provider, and no credit card, billing account, or paid trial
anywhere in this stack**. How sign-in works is explained in
[`auth-setup.md`](auth-setup.md); this guide walks you through it at the
right moment (step 5).

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

## Step 2 — Create the free PostgreSQL database (directly at Neon)

The app needs plain PostgreSQL (version 16 or newer); nothing
provider-specific. The recommended path is to create the database **directly
at Neon** and paste its connection strings into Vercel by hand:

1. Go to <https://neon.tech> and sign up (the GitHub account works). The free
   plan asks for **no credit card**.
2. Create a project. **Pick the same region as your Vercel project** (or the
   nearest one offered). This matters more than it sounds: every page load
   runs a handful of small database queries (7–30 depending on the route —
   see [`performance-measurement.md`](performance-measurement.md)), and each
   query is a round-trip between the app and the database. In the same region
   a round-trip is a millisecond or two; across an ocean it can be a hundred.
   The same page that feels instant colocated feels broken cross-region.
3. Find the database's **connection strings** in Neon's connect panel. Neon
   has two kinds:
   * a **pooled** connection string (its host name contains `-pooler`; the
     panel has a pooled-connection option) — this becomes `DATABASE_URL`;
   * a **direct** (non-pooled) connection string — this becomes
     `DIRECT_DATABASE_URL`. Migrations must use this one; running migrations
     through a pooler can fail in confusing ways.

   Copy both somewhere safe for step 3. If you can only find one string, use
   it for both variables — but Neon does offer both.
4. You will paste these two values into Vercel's environment variables **by
   hand** in step 3. That's the whole integration; nothing else connects the
   two services.

**A warning about the other path.** Vercel's own **Storage** tab can create a
Marketplace database (Neon or Prisma Postgres) inside the Vercel dashboard,
and some integrations add the environment variables automatically. That flow
runs through Marketplace billing, which **can ask for a payment method even
for a free-tier database**. If you already have a card on file with Vercel
and don't mind, it works fine — just make sure the variables `DATABASE_URL`
and `DIRECT_DATABASE_URL` end up existing with the right values (Marketplace
integrations sometimes use their own variable names). If you want the
guaranteed no-card path, create the database at neon.tech as above.

## Free-tier expectations (read once, then relax)

* **The free database sleeps when idle.** Neon's free tier suspends compute
  after a period of no traffic, and the first request afterwards pays a
  **1–3 second cold start** while it wakes. So the first page load after a
  quiet stretch is slow, and every load after that is fast. This is normal
  free-tier behaviour, not a bug — don't chase it in the troubleshooting
  guide.
* **Leave Vercel's Fluid compute setting on.** It is the default for new
  projects and free on Hobby; there is nothing to configure or pay for.
* The scheduled-reminder cadence recommended in step 8 (a call every 10–15
  minutes) stays comfortably inside Neon's free monthly compute allowance.

## Step 3 — Set the environment variables

In the Vercel project: **Settings → Environment Variables**. Unless noted,
apply each variable to both the **Production** and **Preview** environments.
These are the same variables documented in `.env.example` in the repository.

| Variable | Required? | What it is |
|---|---|---|
| `DATABASE_URL` | Yes | The database connection string (the pooled one, if your provider has both). |
| `DIRECT_DATABASE_URL` | Yes | The direct, non-pooled connection string. Migrations use this. Locally the two are identical. |
| `AUTH_SECRET` | Yes | The secret that signs sign-in sessions. Generate one on your computer with `npx auth secret` (or `openssl rand -base64 33`) and paste the value. Rotating it later signs everyone out immediately. |
| `ALLOWED_EMAILS` | Yes | Comma-separated email addresses allowed to hold an account and sign in — e.g. `you@gmail.com,partner@gmail.com`. Anyone else is refused **even with a correct password**. **Empty means nobody can sign in** — the allowlist fails closed. |
| `AUTH_SETUP_TOKEN` | For first-run setup only | A long random secret — generate with `openssl rand -base64 33`. It makes the one-time `/setup` page exist (step 5). **Anything under 32 characters is ignored and setup stays off.** **Delete this variable after creating the owner account**; nothing else ever uses it. |
| `CRON_SECRET` | For background reminders | A random secret protecting the scheduled reminder endpoint. Generate with `openssl rand -base64 32`. Vercel sends it automatically as an `Authorization: Bearer` header when the variable is set; the external scheduler in step 8 sends the same header. |
| `USDA_FDC_API_KEY` | Optional | Free key for USDA food search (<https://fdc.nal.usda.gov/api-key-signup.html>). Without it, food search still works locally and says USDA is not set up. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Optional | Web Push keys for background reminders — see [`web-push-setup.md`](web-push-setup.md). Without them, reminders work only while a tab is open. |
| `AUTH_TRUST_HOST` | **Not on Vercel** | Only needed when self-hosting behind a proxy (`AUTH_TRUST_HOST="true"`). Vercel sets the equivalent itself. |

Two things to know about Vercel environment variables:

* Changing a variable does **not** affect the running site until you
  **redeploy** (Deployments → the latest deployment → Redeploy).
* Preview deployments read the Preview environment. Because the allowlist and
  the password check are enforced server-side on every deployment, **a
  preview URL is never publicly usable** — someone who stumbles on the link
  still cannot sign in.

## Step 4 — How database migrations run (nothing to do, but worth understanding)

You never run migrations by hand against production. Every deploy's
`vercel-build` step runs `prisma migrate deploy`, which applies exactly the
migration files committed in `prisma/migrations/` — nothing generated, nothing
guessed — and records which ones have run, so re-deploying is always safe.
The one requirement is the one from step 2: `DIRECT_DATABASE_URL` must be the
direct (non-pooled) connection string, because that is what migrations connect
through. If a deploy fails during the migration step, that is the first thing
to check — see [`troubleshooting.md`](troubleshooting.md).

## Step 5 — Deploy, then create the owner account at `/setup`

Sign-in needs an account to exist, and the app never creates accounts at
sign-in. The one-time `/setup` page is how the owner account comes to exist.
It works exactly once, then disappears.

1. Deploy the project (press **Deploy**, or redeploy the earlier failed
   attempt now that the variables exist).
2. Open `https://your-project.vercel.app/setup`. You should see the **Owner
   setup** form with four fields: **Setup token**, **Email address**,
   **Password**, and **Password, again**. If you get redirected to the
   sign-in page instead, setup isn't available — check that `AUTH_SETUP_TOKEN`
   is set (at least 32 characters), that `ALLOWED_EMAILS` is set, and that
   you redeployed after adding them.
3. Fill it in:
   * **Setup token** — the exact `AUTH_SETUP_TOKEN` value from step 3.
   * **Email address** — must be one of the addresses in `ALLOWED_EMAILS`.
   * **Password** — at least 12 characters; a long passphrase beats a short
     complicated password. The form refuses a password built around the part
     of your email before the `@`.
4. Press **Create owner account**. You land back on the sign-in page with an
   "Owner account created" confirmation — sign in with the email and password
   you just chose.
5. **Now delete `AUTH_SETUP_TOKEN`** from the Vercel environment variables
   and redeploy. The page has already disabled itself (it refuses to run
   twice), but removing the token retires it completely, and nothing else
   uses it.

Two things worth knowing about this page:

* Its error messages are deliberately vague — a wrong token and a
  non-allowlisted email produce the same "wasn't accepted" message, so the
  page confirms nothing to a stranger who finds it.
* If a deployment migrated from the earlier Google-era build, setup
  **attaches** the password to your existing account (matched by email)
  rather than creating a new one — your data stays yours.

Unlike OAuth, password sign-in has no redirect URIs to register: it works on
every URL of the deployment — production, previews, and any custom domain —
with nothing to configure per-URL.

## Step 6 — Smoke-test it

Vercel builds every branch and pull request into a **preview deployment**
with its own URL, using the Preview environment variables — you can run this
checklist there as a dress rehearsal, or on the production URL directly. One
caveat, stated plainly: if the Preview environment points at the same
database as Production (the simple setup), a preview writes into that same
database — which also means completing `/setup` from a preview URL completes
it for production too (same database, same single owner account; that is
fine). For a first-ever deployment the database is empty, so smoke-testing on
a preview is fine. Later, either give Preview its own database or do your
checking on the production URL.

### The smoke checklist

Run through this in order. Every line should hold. (If the site has sat idle,
expect the very first load to take a couple of extra seconds — that is the
free database waking up, per the free-tier note above.)

1. Open the URL. You land on the sign-in page, and the browser shows the
   padlock (HTTPS).
2. Before signing in properly, try your owner email with a **wrong
   password**. Sign-in is refused with one generic message ("Those details
   didn't sign you in…"). An email that isn't allowlisted gets the exact same
   message — the page deliberately confirms nothing about which accounts
   exist. Don't repeat this test over and over: five consecutive failures
   pause sign-in for that account for 15 minutes. One wrong try proves the
   point.
3. Sign in with the owner email and the correct password. You land on the
   dashboard of an **empty** account — no demo data, just the optional
   getting-started checklist (which offers sample data but never loads it
   uninvited).
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

## Step 7 — Production

1. Merge or push to `main`. Vercel builds it as the production deployment at
   your project's domain (`your-project.vercel.app`, plus any custom domain
   you add under **Settings → Domains** — password sign-in works there
   automatically; there is nothing to register for a new domain).
2. Re-verify the three things that matter most, on the production URL:
   * HTTPS padlock;
   * a wrong password is refused;
   * your account starts empty — no demo data.
3. If you haven't already: confirm `AUTH_SETUP_TOKEN` is deleted (step 5).

Then bring your real data over: [`migrating-from-local.md`](migrating-from-local.md).

## Step 8 — Scheduled reminders (daily Vercel cron + a free external scheduler)

The repository's `vercel.json` declares one cron job: call
`/api/reminders/run` **once a day** (`0 12 * * *`, noon UTC). Vercel reads
that file automatically on deploy. When `CRON_SECRET` is set, Vercel sends it
as an `Authorization: Bearer` header with each cron invocation; the endpoint
refuses everything else (it answers 503 when the secret isn't configured at
all, and 401 for a wrong or missing header — it fails closed, never open).

Stated plainly, because this is where free plans bite:

* **The Hobby plan allows daily cron jobs only.** A sub-daily schedule in
  `vercel.json` doesn't just get throttled — **it makes the deploy fail**.
  That is why the repository ships a daily schedule; don't edit it to run
  more often while on Hobby.
* Hobby crons fire **sometime within the scheduled hour**, not on the minute.
* The reminder runner **skips any occurrence more than 30 minutes past its
  time** rather than delivering it absurdly late. Put those two facts
  together and the daily Vercel cron will deliver few or no push reminders on
  time by itself. It is a **safety net**, not the delivery path.
* **Timely reminders therefore come from a free external scheduler.** Use
  <https://cron-job.org> (free, no credit card): create a job that requests
  `GET https://YOUR-DOMAIN/api/reminders/run` every **10–15 minutes** with
  the custom header `Authorization: Bearer <your CRON_SECRET>` (cron-job.org
  supports custom headers on the free plan). That cadence keeps reminders
  timely and stays comfortably inside Neon's free monthly compute allowance
  — each call briefly wakes the database.
* Vercel crons run against the **production** deployment only; point the
  external scheduler at the production domain too.
* The cron only matters for **background push** reminders. In-tab reminders
  need no cron at all.

Full push setup (VAPID keys, per-device enabling, and the external-scheduler
walkthrough) is in [`web-push-setup.md`](web-push-setup.md).

## Step 9 — Uptime monitoring (optional)

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
| [`auth-setup.md`](auth-setup.md) | How sign-in, the allowlist, `/setup`, and password recovery work — background for steps 3 and 5 |
| [`migrating-from-local.md`](migrating-from-local.md) | Moving your real data from the local app |
| [`web-push-setup.md`](web-push-setup.md) | Background reminder notifications and the external scheduler |
| [`backup-and-recovery.md`](backup-and-recovery.md) | The backup habit, once you're live |
| [`security-and-privacy.md`](security-and-privacy.md) | What protects the site, and the off switches |
| [`troubleshooting.md`](troubleshooting.md) | When something on this page didn't work |
