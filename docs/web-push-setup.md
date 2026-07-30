# Background reminders (Web Push)

Out of the box, reminders fire while a Personal OS tab is open — as toasts,
and as desktop notifications where allowed. With Web Push configured, they
also arrive as real push notifications on devices that opted in, **with no
tab open at all**. This guide sets that up.

Reminders stay schedule-aware either way: nothing fires on a rest day, for
something not scheduled today, for an item already completed, or twice.

## Step 1 — Generate the VAPID key pair (once)

On your own computer, in the repository folder:

```bash
npx web-push generate-vapid-keys
```

This prints a **public key** and a **private key**. They identify your server
to the browsers' push services. Generate them once and keep the private key
secret like any other credential.

## Step 2 — Set four environment variables

In Vercel (**Settings → Environment Variables**), or `.env` locally:

| Variable | Value |
|---|---|
| `VAPID_PUBLIC_KEY` | the public key from step 1 |
| `VAPID_PRIVATE_KEY` | the private key from step 1 |
| `VAPID_SUBJECT` | a contact for the push services, e.g. `mailto:you@example.com` |
| `CRON_SECRET` | a random secret (e.g. `openssl rand -base64 32`) protecting the scheduled endpoint |

Then **redeploy** — environment changes only take effect on the next deploy.

## Step 3 — The schedule that actually sends them

Push notifications are sent by a scheduled run of `/api/reminders/run`, which
evaluates every opted-in user's reminder feed in *that user's* timezone and
pushes what is due.

* **On Vercel this is already wired up.** The repository's `vercel.json`
  declares a cron that calls the endpoint every 5 minutes; Vercel picks the
  file up automatically on deploy and, because `CRON_SECRET` is set, sends it
  as an `Authorization: Bearer` header with each call. The endpoint refuses
  anything else — 503 when no secret is configured, 401 for a wrong header.
  Nothing to configure beyond step 2.
* **Plan limits, stated plainly:** Vercel crons run against the production
  deployment only, and on some plans (Hobby, historically) crons cannot run
  as often as every 5 minutes — check your plan's cron limits. A slower cron
  means later reminders; an occurrence more than **30 minutes** past its time
  is skipped rather than delivered absurdly late.
* **Any external scheduler works identically**: something that sends
  `GET https://YOUR-DOMAIN/api/reminders/run` with the header
  `Authorization: Bearer <your CRON_SECRET>` every 5 minutes — a
  cron-as-a-service, a Raspberry Pi, anything.

## Step 4 — Enable it on each device

Push is opted into **per device**, in the app:

1. On the device, sign in and go to **Settings → Background reminders**.
2. Press **Enable on this device** and allow notifications when the browser
   asks.
3. Done — that device now receives reminders with no tab open. Repeat on each
   device you want (each shows up in the list with a coarse label like
   "Chrome · Mac").

## Turning it off / revoking a device

* **This device:** Settings → Background reminders → **Disable on this
  device**.
* **Any device, from anywhere:** every enrolled device is listed in the same
  panel with a remove button — removing one revokes it immediately, which is
  how you cut off a lost or old device.
* Blocking notifications in the browser's own settings also works; the
  server notices dead registrations and cleans them up automatically.

## Exactly once, even with tabs open

A reminder can be seen by an open tab and by the push runner. They share a
single delivery ledger in the database, and whichever claims an occurrence
first delivers it — the other stays silent. You never get the same reminder
twice, from any combination of tabs and devices, and everything the in-tab
rules suppress (rest days, completed items, archived habits, weekly targets
already met) is suppressed for push by construction, because both read the
same feed.

## Honest limits

* **HTTPS is required** for push. Any deployed Vercel URL qualifies;
  `http://localhost:3000` works for development.
* **Delivery timing is not guaranteed to the minute.** It depends on your
  cron cadence (step 3), on the browser vendor's push service, and on the
  device's operating system — aggressive battery savers can hold
  notifications back. The 30-minute late window bounds how stale a pushed
  reminder can be.
* **iPhone and iPad:** browsers there only deliver web push for sites that
  have been added to the Home Screen (the app ships the manifest and icons
  that make that work — use Share → Add to Home Screen, then enable push
  from inside it).
* **In-tab reminders remain the fallback** and keep working with no push
  setup at all — this whole page is optional.
* A push carries only the reminder's own title and message — never health
  values, journal text, or anything you didn't type into the reminder — and
  is encrypted to the receiving browser's keys in transit.
* Real push delivery could not be exercised from the environment this feature
  was built in (no HTTPS or reachable push service there); it is verified to
  the transport boundary by automated tests, and the first end-to-end
  notification on your own deployment is the final confirmation. If it
  doesn't arrive, [`troubleshooting.md`](troubleshooting.md) has the
  checklist.
