# Troubleshooting

Symptoms, causes and fixes, in the order you're likely to meet them. Where a
fix says "redeploy": on Vercel, environment variable changes only take effect
on the next deploy (Deployments → latest → Redeploy).

## Sign-in shows an "UntrustedHost" error (or a 500 on the sign-in flow)

**Only happens when self-hosting** (running the app on your own server behind
a proxy) — Vercel sets the equivalent itself.

1. Add `AUTH_TRUST_HOST="true"` to the environment.
2. Restart the app.

## Sign-in is refused: "That … isn't approved for this Personal OS"

Google succeeded; the app's own allowlist said no.

1. Check `ALLOWED_EMAILS` contains the **exact** email address of the Google
   account you signed in with (comma-separated; case and surrounding spaces
   don't matter).
2. Remember it **fails closed**: an empty or missing `ALLOWED_EMAILS` refuses
   everyone. That is by design, not a bug.
3. After editing the variable, redeploy.

If the refusal comes from **Google** instead (an "Access blocked" or
"unverified app" page before you ever reach the app), see the end of
[`google-oauth-setup.md`](google-oauth-setup.md) — usually the consent screen
is in Testing mode and the account isn't a test user, or a redirect URI
doesn't match exactly.

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
3. **Is the cron actually running, and how often?** Vercel project → the Cron
   section / runtime logs. Crons run on the production deployment only, and
   some plans can't run every 5 minutes — a slower cadence delays delivery,
   and an occurrence more than 30 minutes past its time is skipped.
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

1. `AUTH_SECRET` was rotated (signs everyone out immediately — by design).
2. The session hit its 30-day maximum age.
3. Your email was removed from `ALLOWED_EMAILS` (lockout is immediate).

Sign in again; if refused, see the allowlist section above.

## Food search says "USDA … is not set up"

Not an error — the optional `USDA_FDC_API_KEY` isn't configured. Local
results, custom foods, favourites, recents and Open Food Facts all work
without it. Add the free key (link in `.env.example`) and redeploy to enable
USDA. To verify the providers end to end from any normal machine:
`node scripts/smoke-food-providers.mjs`.
