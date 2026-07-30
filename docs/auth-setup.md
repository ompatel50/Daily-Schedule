# Sign-in setup (email + password)

Personal OS handles sign-in entirely by itself: one email address and one
password, checked by the app's own server against its own database. There is
no Google account involved, no OAuth, no external identity provider, no
credit card, no billing account, and nothing to sign up for anywhere — the
whole sign-in system lives inside the app you deploy.

Two things decide who gets in:

* **The allowlist** (`ALLOWED_EMAILS`) decides *who is allowed to have an
  account at all*. Knowing a password is never enough — an email that isn't
  on this list cannot sign in, full stop.
* **The password** proves the person at the keyboard is really the owner of
  that email's account.

There is no public registration. The one and only account is created once,
by you, through a one-time setup page — everything below walks through it.

## Step 1 — Generate the two secrets

You need two random values. On a Mac or Linux machine (or in any online
terminal), run this command **twice** and copy each result:

```bash
openssl rand -base64 33
```

Each run prints a different 44-character string of random letters, numbers
and symbols. Use them as:

* `AUTH_SECRET` — the key the app uses to seal its session cookies. The app
  will not start without it.
* `AUTH_SETUP_TOKEN` — the temporary "proof of ownership" for the one-time
  setup page. It must be at least **32 characters long**; anything shorter is
  ignored and the setup page simply stays off. (The command above always
  produces something long enough.)

Don't reuse one value for both, and don't write either into any file that
gets committed to the repository.

## Step 2 — Set the environment variables

In your hosting dashboard (for Vercel: project → **Settings → Environment
Variables** — see [`deployment-guide.md`](deployment-guide.md) for the full
list), set:

| Variable | Value |
|---|---|
| `AUTH_SECRET` | the first random string |
| `AUTH_SETUP_TOKEN` | the second random string — temporary, removed after setup |
| `ALLOWED_EMAILS` | your email address (comma-separated if more than one, case doesn't matter) |

Then redeploy — environment changes only take effect on the next deploy.
If `ALLOWED_EMAILS` is missing or empty, nobody can sign in and setup stays
off: the app fails closed rather than open.

## Step 3 — The one-time setup page

Open `https://YOUR-DOMAIN/setup`. This page exists only while **all three**
of these are true: `AUTH_SETUP_TOKEN` is set (and long enough), the
allowlist is configured, and no account has a password yet. At any other
time it silently redirects to the sign-in page. (While setup is open, the
sign-in page also shows a "Create the owner account" link pointing here.)

The form has four fields:

1. **Setup token** — paste the `AUTH_SETUP_TOKEN` value.
2. **Email address** — must be one of the addresses in `ALLOWED_EMAILS`.
3. **Password** — at least **12 characters**. A long passphrase of several
   words beats a short complicated password. It also can't be built around
   your email address (if your address is `jane.doe@example.com`, anything
   containing `jane.doe` is refused).
4. **Password, again** — the same thing, to catch typos.

Press **Create owner account**. On success you land on the sign-in page
with a confirmation message; sign in with the email and password you just
chose.

If the form refuses with "The setup token or email address wasn't
accepted", one of those two was wrong — the page deliberately doesn't say
which one, so a stranger who finds the page can't use it to learn anything.
Check both and try again (each rejected attempt is slowed down by a second,
also on purpose).

**Afterwards, delete `AUTH_SETUP_TOKEN` from the environment variables.**
Nothing else uses it, and the setup form has already disabled itself — once
an account has a password, the page refuses to run again and cannot be used
to overwrite your password. (Lost-password recovery works differently — see
below.)

## Signing in

Go to your site; signed out, you land on the sign-in page — email address,
password, **Sign in**. That's the whole page.

Every kind of failure — wrong password, unknown email, an email not on the
allowlist, a temporarily locked account — shows the **same** message:

> Those details didn't sign you in. Check the email address and password and
> try again — after several failed tries, sign-in pauses for 15 minutes.

That sameness is deliberate: the page never confirms to anyone which email
addresses have accounts here.

### Too many wrong tries

After **5 wrong attempts in a row**, sign-in for that account pauses for
**15 minutes** — during the pause even the *correct* password shows the
same generic message. Wait it out and sign in normally. If you're locked
out and can't wait, the recovery script below also clears the lock.

## Managing your password (Settings → Sign-in & security)

Once signed in, open **Settings** and find the **Sign-in & security** panel.

* **The "last sign-in" line.** At the top, the panel shows when the account
  last signed in successfully and, if there ever was one, when the last
  *failed* attempt happened. Glance at it now and then: if the last failed
  attempt wasn't you, someone tried your account — change the password right
  there, below the line. (A failed attempt alone means the password *held*;
  it's a prompt to act, not a sign of a break-in.)
* **Change password.** Enter your current password, then the new one twice
  (same 12-character minimum, same "not built around your email" rule).
  Changing it immediately signs out **every other device** — only the
  browser you changed it in stays signed in. Getting the *current* password
  wrong here counts toward the same 5-tries lockout as the sign-in page, so
  a stolen laptop with an open session still can't take over the account by
  guessing.
* **Sign out everywhere.** The button below ends every session, including
  the one you're in, and returns you to the sign-in page. Use it if you
  signed in on a machine you shouldn't have (a friend's laptop, a hotel
  computer) — no password change needed.

## Lost the password entirely

There is no "forgot password" link — this app sends no email, so there is
nothing to send a reset link *with*. Instead, recovery is a small script
run by someone with direct access to the database (that's you — the
database password from your deployment is the proof of ownership):

```bash
node scripts/reset-password.mjs you@example.com
```

Run it from a checkout of the repository. On your own machine it reads the
database address from the local `.env` file; to reset the *hosted*
deployment's password, set `DATABASE_URL` (and `DIRECT_DATABASE_URL`, if
your database uses one) in the terminal first, copied from your hosting
dashboard — [`backup-and-recovery.md`](backup-and-recovery.md) shows where
they live. The npm shortcut `npm run auth:reset-password -- you@example.com`
runs the same script (note the `--` before the email).

The script asks for the new password at a hidden prompt (nothing appears as
you type — that's normal), asks again to confirm, then:

* stores the new password (hashed exactly the way the app itself does it),
* signs the account out of **every** device, and
* clears any failed-attempt lockout.

It refuses to create accounts — it only resets a password for an owner who
already exists. For a brand-new deployment, use the `/setup` page instead.

## Migrating from the old Google-sign-in version

If your deployment previously used Google sign-in: deploy the new version,
then go through Step 1–3 above using **the same email address** you used
with Google. Setup attaches the new password to your **existing account** —
all your data (tasks, meals, weights, everything) stays exactly where it
was, because the account is matched by email, not recreated.

Two things to expect, both by design:

* Every device that was signed in via Google is signed out — old sessions
  are not honored by the new version. Sign in once with the new password on
  each device.
* `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET` are no longer used; delete them
  from the environment. You can also delete the Google Cloud project you
  made for the old setup — nothing in the stack talks to Google anymore.

## Deliberate limits — an honest note

This is a single-owner system tuned for simplicity, and a few things are
left out on purpose:

* **No two-factor authentication.** Your defenses are a long password, the
  allowlist, and the 5-tries lockout. Pick the password accordingly.
* **No email-based password reset.** The app sends no email of any kind, so
  recovery is the database-access script above. Keep your database
  credentials somewhere safe — they *are* the recovery key.
* **Someone who knows your email can annoy you.** By deliberately entering
  wrong passwords, a stranger could trigger the 15-minute lockout on your
  account. They learn nothing and get no closer to the password, and you
  can always get back in — wait out the window, or run the reset script,
  which clears the lock instantly.

For the wider picture — what the app stores, what it never stores, and how
sessions work — see [`security-and-privacy.md`](security-and-privacy.md).
