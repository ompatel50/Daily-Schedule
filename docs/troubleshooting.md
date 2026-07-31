# Troubleshooting

Symptoms, causes and fixes, in the order you're likely to meet them. Where a
fix says "redeploy": on Vercel, environment variable changes only take effect
on the next deploy (Deployments → latest → Redeploy).

## Sign-in shows an "UntrustedHost" error (or a 500 on the sign-in flow)

**Only happens when self-hosting** (running the app on your own server behind
a proxy) — Vercel sets the equivalent itself.

1. Add `AUTH_TRUST_HOST="true"` to the environment.
2. Restart the app.

## Sign-in is refused: "Those details didn't sign you in"

The sign-in page deliberately shows this **one message for every kind of
failure** — wrong password, unknown email, and a temporarily locked account
all read identically, so the page never confirms which accounts exist. That
means the fix isn't always "retype the password". Check in this order:

1. **Lockout.** Five wrong password attempts in a row pause sign-in for
   that account for **15 minutes** — during the pause even the correct
   password is refused. Wait it out, or reset with a recovery code (next
   item), which also clears the lockout immediately. Sign-in is also rate
   limited per network address; an hour-long pause after very many attempts
   from one connection resolves itself.
2. **Forgotten password.** Open `/forgot-password` and redeem one of the
   recovery codes shown when the account was created (or last generated in
   Settings). Codes tolerate case, spaces and missing dashes; each works
   exactly once, and a successful reset signs every device out.
3. **Recovery codes also lost.** Whoever runs the deployment can reset any
   account's password with direct database access:

   ```bash
   npm run auth:reset-password you@example.com
   ```

   It prompts for the new password with typing hidden, signs every device
   out, and clears any lockout. The full walk-through is in
   [`auth-setup.md`](auth-setup.md) under "Break-glass".

No part of sign-in involves Google, OAuth, or any other external service —
when sign-in fails, the cause is always the password itself or the app's
own environment variables.

## Sign-up is refused

* **"An account with that email address already exists"** — the address is
  taken. Sign in instead, or reset the password with a recovery code at
  `/forgot-password`.
* **"Too many sign-up attempts from your network"** — the per-address rate
  limit (a handful of accounts per hour) closed the window; try again in an
  hour. If this fires for a legitimate crowd behind one shared address
  (an office, a school), have them spread sign-ups out.
* **"Sign-ups are currently disabled on this deployment"** — the operator
  set `SIGNUPS_DISABLED=1`. Existing accounts still sign in; remove the
  variable and redeploy to reopen registration.
* **The password is rejected** — at least 12 characters, and it can't be
  built around the part of the email before the `@`.

## The recovery code "wasn't accepted"

One message covers every identity failure on `/forgot-password` — wrong
email, mistyped code, already-used code — deliberately, so the form
confirms nothing about which accounts exist. Codes are forgiving about
case, spaces and dashes, so "mistyped" usually means a character swap
(the code alphabet deliberately has no `0`/`O`, `1`/`l`/`I`). Each code
works exactly once; if all are spent, generate a new batch from Settings
while signed in, or fall back to the reset script above. The flow is rate
limited — after several failed tries, wait an hour.

## A deploy is rejected before it even builds ("invalid maxDuration")

Vercel validates a route's `maxDuration` against the account's plan **at deploy
time** and fails the whole deployment rather than clamping the value. A number
that is fine on one plan (fluid compute allows far more) breaks the deploy on
Hobby, whose ceiling is 60 seconds.

Nothing in lint, types, tests or the production build sees this — which is why
`tests/deploy-config.test.ts` now holds every route in the app to
`MAX_FUNCTION_SECONDS` (60, the highest value every plan accepts) and checks
`vercel.json`'s cron cadence at the same time. If you raise a route's
`maxDuration`, that test fails first, in CI, instead of the deploy failing
later.

The value must be a **literal**: Next.js statically analyses route segment
config and refuses to build if it is an imported constant.

## A health import fails with `413 FUNCTION_PAYLOAD_TOO_LARGE`

**This should no longer happen.** If it does, it is a bug — please report it
with the request path from the browser's network panel.

Vercel rejects a request body above about **4.5 MB** *at the edge*, before the
function runs, so the app never sees it and cannot phrase the error. The
importer used to POST the whole Apple Health `export.zip` as one body, which is
one to three orders of magnitude over that cap — so on a hosted deployment
every real export failed with exactly this message and nothing else.

The upload is now staged: the browser slices the archive into 4 MB parts, sends
one request each to `PUT /api/health/import/part`, and a final call reassembles
and parses them. No request the client makes approaches the platform's cap, and
`tests/deploy-config.test.ts` asserts that relationship so it cannot regress
into a production-only failure.

If you see a 413 today, check in this order:

1. **A proxy in front of the app with a smaller body limit than 4 MB.** nginx's
   `client_max_body_size` defaults to 1 MB. Raise it to at least 8 MB.
2. **A stale deployment.** The staged upload needs both the client and the three
   `/api/health/import*` routes from the same build.

## A health export is refused as too large on a hosted deployment

Different failure, different cause: this one comes *from the app*, names a size,
and says what to do about it.

The archive is reassembled in the function's own scratch space (Vercel gives it
about 500 MB) and its parts sit in your database while the upload is in flight,
so a hosted deployment stages up to **256 MB** by default — not the 4.5 MB
request cap, which no longer bounds the file.

1. **Set the real limit if you know it.** `HEALTH_MAX_UPLOAD_MB` overrides the
   default — a plan with more scratch space, or a database that can hold more
   than a free tier. It can never raise the app's own 2 GB ceiling.
2. **Self-host for a genuinely large export.** `npm start` behind your own proxy
   has neither the scratch-space cap nor the execution-time cap and stages up to
   2 GB, which a decade-long export with workout routes can need.

Nothing partial is ever written: a refused upload's parts are deleted with it,
and an abandoned one expires within the hour.

## A health upload says another import is already in progress

An account may hold two staged uploads at once — the bound that stops an
abandoned upload filling the database. Closing the tab mid-upload leaves one
behind.

It clears itself: opening a new upload discards any of your own that have been
idle for fifteen minutes, and every upload expires an hour after it started.
Cancelling an upload with the button deletes its parts immediately, which is the
fastest way to free a slot.

## A deploy fails during the migration step

The build log shows `prisma migrate deploy` failing.

1. Check `DIRECT_DATABASE_URL` is set and is the **direct, non-pooled**
   connection string from your database provider. Migrations through a
   connection pooler are the classic cause.
2. Check the database is reachable and awake — some free tiers suspend idle
   databases; open the provider's dashboard once to wake it, then redeploy.
3. The failed deploy did not replace the running site — the previous
   deployment keeps serving until a build succeeds.

## `/api/health` answers `{"status":"degraded"}`

The app is up but cannot reach its database.

1. Database suspended (free tiers sleep when idle) — open the provider
   dashboard; it usually wakes on connection.
2. Credentials rotated but `DATABASE_URL` / `DIRECT_DATABASE_URL` not
   updated — update both and redeploy.
3. Provider incident — check their status page.

## A backup import is refused or fails as "too large"

Vercel caps a single request at about **4.5 MB**. Nothing was written — the
request never reached the app.

1. Most real backups are far below the cap. An oversized file usually means
   the demo dataset is still in the account that exported it — remove it
   first (Settings → Sample data → Remove sample data), export again, and the
   file shrinks substantially.
2. If your genuine data alone exceeds the cap, the honest options today are:
   restore into a self-hosted instance (whose limit is the app's own 16 MB
   ceiling), or wait — chunked backup import is a known possible improvement,
   not a promise. The export side always works regardless of size.

Note this is the *backup* import, which travels through a server action — one
request, whole body, so the platform cap genuinely binds it. The **health**
import no longer works that way: it uploads in 4 MB parts, so its limit is set
by what the deployment can stage rather than by what one request may carry. The
same staging approach is the obvious future fix for backup import; it is a known
possible improvement, not a promise.

## Push reminders don't arrive

Work through this in order — each item alone can silence push:

1. **Keys configured?** Settings → Background reminders says "the server
   doesn't have push keys configured" when `VAPID_PUBLIC_KEY` /
   `VAPID_PRIVATE_KEY` are missing. Set them and redeploy
   ([`web-push-setup.md`](web-push-setup.md)).
2. **`CRON_SECRET` set?** Without it the endpoint answers 503 and Vercel Cron
   delivers nothing. With a wrong header it answers 401. You can check the
   responses in the Vercel logs.
3. **Is the scheduler actually calling the endpoint, and how often?** On the
   free Vercel plan the built-in cron runs only **once a day** — timely
   delivery comes from the free external scheduler (cron-job.org) calling
   `/api/reminders/run` every few minutes; check its dashboard shows the job
   enabled and succeeding, and check the Vercel runtime logs. An occurrence
   more than 30 minutes past its time is skipped on purpose.
4. **Device enrolled and permitted?** The device must appear in Settings →
   Background reminders, and the browser's notification permission must be
   granted (check the browser's site settings).
5. **Platform quirks:** push needs HTTPS; on iPhone/iPad the site must be
   added to the Home Screen; aggressive battery savers can delay
   notifications.
6. **Did the reminder have a time, and was it actually due?** Reminders are
   schedule-aware — rest days, completed items, archived habits and
   already-met weekly targets are silent on purpose, and an occurrence
   already shown in an open tab will not also push (exactly-once is by
   design).

In-tab reminders keep working through all of this — if those fire and push
doesn't, the problem is in steps 1–5.

## Where the server logs live, and what a "reference id" is

* **Vercel → your project → Logs** shows the runtime logs (each deployment's
  build log lives on its deployment page).
* When something fails in the app you may see a short **reference id**. Search
  the runtime logs for that id to find the matching entry. Logs deliberately
  contain no personal values — reference ids exist precisely so an error can
  be found without the log ever holding your data
  ([`security-and-privacy.md`](security-and-privacy.md)).

## Signed out unexpectedly

1. The password was changed, a recovery code was redeemed, "Sign out
   everywhere" was used (Settings → Sign-in & security), or the reset
   script ran — each of these ends every session immediately, by design.
2. `AUTH_SECRET` was rotated (also signs everyone out immediately).
3. The session hit its 30-day maximum age.

Sign in again; if refused, see the sign-in section above.

## Food search says "USDA … is not set up"

Not an error — the optional `USDA_FDC_API_KEY` isn't configured. Local
results, custom foods, favourites, recents and Open Food Facts all work
without it. Add the free key (link in `.env.example`) and redeploy to enable
USDA. To verify the providers end to end from any normal machine:
`node scripts/smoke-food-providers.mjs`.
