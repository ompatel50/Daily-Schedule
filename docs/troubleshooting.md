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
failure** — wrong password, unknown email, an email not on the allowlist,
and a temporarily locked account all read identically, so the page never
confirms which accounts exist. That means the fix isn't always "retype the
password". Check in this order:

1. **Allowlist.** `ALLOWED_EMAILS` must contain the **exact** email address
   you typed (comma-separated; case and surrounding spaces don't matter).
   It **fails closed**: an empty or missing `ALLOWED_EMAILS` refuses
   everyone — by design, not a bug. After editing the variable, redeploy.
2. **Lockout.** Five wrong password attempts in a row pause sign-in for
   that account for **15 minutes** — during the pause even the correct
   password is refused. Wait it out, or run the reset script below, which
   also clears the lockout immediately.
3. **Forgotten password.** There is no "forgot password" email (the app
   sends no email at all). Recovery is the offline script, run where the
   database connection strings are available:

   ```bash
   npm run auth:reset-password you@example.com
   ```

   It prompts for the new password with typing hidden, signs every device
   out, and clears any lockout. The full walk-through is in
   [`auth-setup.md`](auth-setup.md) under "Lost the password entirely".

No part of sign-in involves Google, OAuth, or any other external service —
when sign-in fails, the cause is always the password itself or the app's
own environment variables.

## `/setup` shows nothing — it just redirects to the sign-in page

By design. The one-time owner setup page only exists while **all three**
of these hold:

1. `AUTH_SETUP_TOKEN` is set in the environment **and is at least 32
   characters long** — anything shorter is ignored entirely and setup
   stays off (generate a proper one with `openssl rand -base64 33`).
2. `ALLOWED_EMAILS` is not empty.
3. **No account has a password yet.** The moment setup completes — or a
   password exists for any other reason, such as the local demo/e2e
   seeds — the page disables itself everywhere, permanently.

If a password already exists and you've lost it, `/setup` will not come
back — deliberately, so a setup token found later can never overwrite the
owner account. Use the reset script instead (previous section). After
changing environment variables, redeploy.

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

1. The password was changed, "Sign out everywhere" was used (Settings →
   Sign-in & security), or the reset script ran — each of these ends every
   session immediately, by design.
2. `AUTH_SECRET` was rotated (also signs everyone out immediately).
3. The session hit its 30-day maximum age.
4. Your email was removed from `ALLOWED_EMAILS` (lockout is immediate).

Sign in again; if refused, see the sign-in section above.

## Food search says "USDA … is not set up"

Not an error — the optional `USDA_FDC_API_KEY` isn't configured. Local
results, custom foods, favourites, recents and Open Food Facts all work
without it. Add the free key (link in `.env.example`) and redeploy to enable
USDA. To verify the providers end to end from any normal machine:
`node scripts/smoke-food-providers.mjs`.
