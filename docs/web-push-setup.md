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
pushes what is due. Something has to call that endpoint regularly. On the
free setup, two things do — and it matters which one is which.

### The built-in daily run (safety net, not the delivery path)

The repository's `vercel.json` declares one Vercel cron, **once a day**.
That is deliberate, not an oversight:

* Vercel's free Hobby plan only allows daily crons. A more frequent schedule
  in `vercel.json` is not quietly ignored — it makes the **whole deploy
  fail**. Leave the file as it is.
* Hobby crons also fire *sometime within* the scheduled hour, not at the
  exact minute.
* The runner skips any reminder occurrence more than **30 minutes** past its
  time rather than delivering it absurdly late.

Put those together and a daily cron alone can never deliver timely push — by
the time it fires, almost everything due that day is already past the
30-minute window and is skipped. The daily run is a safety net and a daily
proof the pipeline works, nothing more. (Vercel does handle its own
authentication: because `CRON_SECRET` is set, it sends the
`Authorization: Bearer` header with each call automatically.)

### The primary path: a free external scheduler (cron-job.org)

Timely delivery comes from a scheduler outside Vercel calling the same
endpoint every 10–15 minutes. [cron-job.org](https://cron-job.org) does this
well: free, **no credit card**, and it can send the required header.

1. Create a free account at **cron-job.org**.
2. Create a cronjob with the URL
   `https://your-app.vercel.app/api/reminders/run` (your real deployed
   address).
3. In the job's settings, add one request header:
   * Name: `Authorization`
   * Value: `Bearer YOUR_CRON_SECRET` — the word `Bearer`, a space, then the
     exact value of the `CRON_SECRET` you set in step 2.
4. Set the schedule to **every 10 or 15 minutes**. That sits well inside the
   30-minute late window, so reminders arrive close to their time.
5. Save, then check the job's execution history: `200` is healthy. A `401`
   means the header value doesn't match `CRON_SECRET`; a `503` means
   `CRON_SECRET` isn't set on the deployment at all.

This cadence is also friendly to a free Neon database: each call wakes it
briefly (the occasional 1–3 second cold start is normal), and every 10–15
minutes stays comfortably inside Neon's free monthly compute allowance.

### Alternative: a GitHub Actions scheduled workflow

If the repository is public on GitHub, a scheduled Actions workflow that
sends the same request — `GET` the URL with the same `Authorization: Bearer`
header — is also free and works just as well. cron-job.org is the simpler of
the two to set up; either is fine, and they can even coexist, because the
delivery ledger (below) prevents duplicates.

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
