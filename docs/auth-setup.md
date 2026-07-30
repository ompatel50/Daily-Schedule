# Accounts, sign-in and password recovery

Personal OS handles accounts entirely by itself: email + password, checked
by the app's own server against its own database. There is no Google account
involved, no OAuth, no external identity provider, no credit card, no
billing account, and nothing to sign up for anywhere — the whole sign-in
system lives inside the app you deploy.

**Registration is public self-serve.** Anyone can open the site, go to
`/signup`, and create an account. There is no allowlist, no invite code and
no setup token — and no `/setup` page: the one-time owner-bootstrap flow
from earlier versions is gone. What keeps a public deployment private is
per-account isolation: every query and every action on the server is scoped
to the signed-in account, so an account only ever sees its own data. (The
integration suite pins this — see `tests/integration/cross-user.test.ts`.)

## Creating an account

1. Open `https://YOUR-DOMAIN/signup`.
2. Enter an email address (this is the sign-in identifier), an optional
   display name, and a password twice.
3. Passwords must be at least **12 characters** and must not be built
   around the email address (if your address is `jane.doe@example.com`,
   anything containing `jane.doe` is refused). A long passphrase of several
   words beats a short complicated password.
4. Submit. The account is created, this browser is signed in, and the page
   shows your **recovery codes** — save them before continuing (copy or
   download; they are never shown again).

If the email is already taken, sign-up says so and points at sign-in and
password recovery instead. It never attaches a new password to an existing
account.

Abuse protection is built in: account creation is rate limited per client
address (the counters live in the database, so they hold across serverless
instances, and store only a keyed hash of the address — never the raw IP),
and the form carries a honeypot field that silently rejects the dumbest
bots. Set `SIGNUPS_DISABLED=1` in the environment to pause new
registrations entirely (existing accounts still sign in) — useful during an
abuse incident or for running a private instance. Normal operation needs
nothing.

## Signing in

`/signin` — email and password. Every failure (wrong password, unknown
email, locked account) shows the same message, so the page never confirms
which addresses have accounts. After **5 wrong attempts in a row**, sign-in
for that account pauses for **15 minutes** — during the pause even the
correct password shows the same generic message. Sign-in attempts are
additionally rate limited per client address.

## Signing out

The account menu (top-right) → **Sign out** ends the session and returns to
the sign-in page. Settings → *Sign-in & security* → **Sign out everywhere**
invalidates every session of the account at once — every device, including
the current one — by bumping the account's token version; a session token
issued before the bump is dead on its very next request.

## Forgot password: recovery codes

This app sends no email, so "forgot password" is proven by a **recovery
code** instead of an email link:

* Every account gets **8 one-time codes** at sign-up (format
  `xxxx-xxxx-xxxx-xxxx`; case, spaces and dashes never matter when typing
  one back in).
* The server stores only a SHA-256 hash of each code. The plaintext exists
  exactly once, on the screen that generated it — save it like a password.
* To reset: open `/forgot-password`, enter the email, one unused code and a
  new password. On success the code is burned (it never works twice), the
  password is replaced, any lockout is cleared, and **every existing
  session of the account is signed out**.
* Wrong email, wrong code and used code all fail with the same message, and
  the flow is rate limited both per client address and per named account.

Manage codes in Settings → *Sign-in & security*: the panel shows how many
unused codes remain and can generate a fresh batch (which invalidates all
old codes). Generating a new batch requires the current password — a stolen
browser session alone cannot mint itself a permanent way back in.

## Managing your password (Settings → Sign-in & security)

* **The "last sign-in" line.** The panel shows when the account last signed
  in successfully and, if there ever was one, when the last *failed*
  attempt happened. If the last failed attempt wasn't you, someone tried
  your account — change the password right there. (A failed attempt alone
  means the password *held*; it's a prompt to act, not a sign of a
  break-in.)
* **Change password.** Enter the current password, then the new one twice
  (same 12-character minimum, same "not built around your email" rule).
  Changing it immediately signs out **every other device** — only the
  browser you changed it in stays signed in. Getting the *current* password
  wrong here counts toward the same 5-tries lockout as the sign-in page, so
  a stolen laptop with an open session still can't take over the account by
  guessing.
* **Recovery codes.** See above — the count of unused codes, and a
  regenerate button gated by the current password.
* **Sign out everywhere.** Ends every session, including the one you're in.
  Use it if you signed in on a machine you shouldn't have — no password
  change needed.

## Break-glass: the offline reset script

If an account's password **and** recovery codes are both lost, whoever runs
the deployment can still reset the password with direct database access
(the database password from your deployment is the proof of ownership):

```bash
node scripts/reset-password.mjs person@example.com
```

Run it from a checkout of the repository. On your own machine it reads the
database address from the local `.env` file; to reset a password on the
*hosted* deployment, set `DATABASE_URL` (and `DIRECT_DATABASE_URL`, if your
database uses one) in the terminal first, copied from your hosting
dashboard — [`backup-and-recovery.md`](backup-and-recovery.md) shows where
they live. The npm shortcut `npm run auth:reset-password -- you@example.com`
runs the same script (note the `--` before the email).

The script asks for the new password at a hidden prompt (nothing appears as
you type — that's normal), asks again to confirm, then:

* stores the new password (hashed exactly the way the app itself does it),
* signs the account out of **every** device, and
* clears any failed-attempt lockout.

It refuses to create accounts, and it leaves recovery codes untouched —
generate a fresh batch from Settings afterwards if the old ones may be
exposed. This is deliberately an *operator* action; normal users never need
it — that's what recovery codes are for.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `AUTH_SECRET` | Yes | Seals session cookies (generate with `openssl rand -base64 33` or `npx auth secret`); also keys the pseudonymized rate-limit counters. Rotating it signs everyone out. |
| `AUTH_TRUST_HOST` | Self-hosting only | Set `"true"` behind your own proxy; Vercel sets the equivalent itself. |
| `SIGNUPS_DISABLED` | No (optional) | `"1"` pauses new registrations. Existing accounts are unaffected. |

Gone from earlier versions — delete them from your environment if present;
nothing reads them anymore:

* `ALLOWED_EMAILS` (the private allowlist — replaced by public sign-up with
  per-account isolation)
* `AUTH_SETUP_TOKEN` (the one-time `/setup` page — replaced by `/signup`)

## Migrating from an owner-only deployment

If your deployment previously used the allowlist + `/setup` flow: deploy
the new version and simply keep signing in — your account, password and
data are untouched (only the extra gates were removed). Delete
`ALLOWED_EMAILS` and `AUTH_SETUP_TOKEN` from the environment, and generate
recovery codes from Settings → *Sign-in & security* so "forgot password"
works for you without database access. If you'd rather not accept new
registrations, set `SIGNUPS_DISABLED=1`.

## Deliberate limits — an honest note

A few things are left out on purpose:

* **No two-factor authentication.** Your defenses are a long password, the
  lockout, the rate limits and the recovery codes. Pick the password
  accordingly.
* **No email-based password reset.** The app sends no email of any kind, so
  recovery is the codes above (or the operator script). Store the codes
  somewhere safe — they *are* the reset link.
* **Someone who knows your email can annoy you.** By deliberately entering
  wrong passwords, a stranger could trigger the 15-minute lockout on your
  account. They learn nothing and get no closer to the password, and you
  can always get back in — wait out the window, or reset with a recovery
  code, which clears the lock instantly.

## How sessions work (the fine print)

Sessions are stateless JWTs sealed with `AUTH_SECRET`, valid at most 30
days. Every token carries the account's `tokenVersion`; the server compares
it against the database row on every request, which is what makes
revocation immediate: password change, password reset and "sign out
everywhere" all bump the version, and every older token dies on its next
request. Passwords are hashed with scrypt (N=2¹⁶, r=8 — 64 MiB, ~200 ms)
via Node's built-in crypto; the hash format stores its own parameters, so
costs can be raised later and old hashes upgrade transparently on the next
successful sign-in. The password hash is globally omitted from every query
by the Prisma client — only credential verification and the password-change
action can read it back, so no page, export or log can leak it by accident.

For the wider picture — what the app stores, what it never stores, and how
per-account isolation is enforced — see
[`security-and-privacy.md`](security-and-privacy.md).
