# Security and privacy

What protects the hosted Personal OS, stated concretely enough to be checked
— and the off switches, because being able to turn something off is part of
owning it.

## Who can get in: a password and the allowlist

* Sign-in is an in-app email + password form. There is **no Google, no OAuth,
  no third-party identity provider, no billing account, and no credit card
  anywhere in the stack** — and **no public registration**: the app never
  creates an account at sign-in, and the sign-in page offers nothing to
  anyone else.
* Getting in requires **two independent things**: the correct password *and*
  an email on `ALLOWED_EMAILS` (an environment variable, comma-separated,
  case-insensitive). Knowing a password is not enough; the allowlist decides
  who is authorized.
* **It fails closed.** No allowlist configured means *nobody* can sign in —
  a misconfiguration locks the door rather than opening it.
* **Revocation is live.** The allowlist is checked at sign-in *and again on
  every authenticated request*. Removing an email locks that account out on
  its very next request — not when its session eventually expires.
* **The first account is created once, at the `/setup` page** — and that page
  only exists while three things are true at the same time: the deployment
  has an `AUTH_SETUP_TOKEN` environment variable (a long random secret, at
  least 32 characters, that only the deployer knows), the allowlist is
  configured, and no account has a password yet. The page asks for that token
  plus your email and chosen password (minimum 12 characters, and it refuses
  passwords built around your email address). The moment setup succeeds, the
  page disables itself everywhere; delete `AUTH_SETUP_TOKEN` afterwards — it
  has no other purpose.
* **Guessing is throttled.** Five wrong attempts in a row pause sign-in for
  that account for 15 minutes. Every kind of failure — wrong password,
  unknown email, not allowlisted, currently locked — shows the **same generic
  message** and takes the same time to compute, so an attacker learns nothing
  from the response: not whether the account exists, and not whether a lock
  is in effect. Once the 15 minutes pass, the counter is forgiven **in
  full** — you get five fresh tries, so one old mistake can never keep
  re-locking you.

## How your password is stored

* Never as the password itself. The server keeps only a **scrypt hash**,
  computed with Node's built-in `crypto` module — no third-party hashing
  library to trust or update.
* scrypt is **memory-hard**: each guess costs about 64 MiB of memory and a
  fifth of a second of computation. A single sign-in barely notices; bulk
  guessing against a stolen database becomes enormously expensive.
* Every password gets its **own random salt**, so identical passwords produce
  unrelated hashes and precomputed lookup tables are useless.
* The cost parameters are **stored inside the hash string itself**. If the
  cost is raised in a future version, existing hashes keep verifying with
  their recorded parameters, and the next successful sign-in transparently
  re-hashes at the new cost — no forced reset, ever.
* What you type is Unicode-normalized (NFKC) before hashing, so the "same"
  password entered through a different keyboard, phone IME or operating
  system still matches.
* The hash **never leaves the database**: it appears in no log, and the
  backup export contains profile data only — no email, no hash, no sign-in
  metadata. Beyond policy, the database client is **built to structurally
  omit the hash from every query** (at runtime and in the type system);
  code has to explicitly opt back in, and exactly two call sites do —
  verifying a sign-in and verifying a password change.

## Three layers of authentication

1. **Edge middleware** — every route except the sign-in page, the one-time
   setup page and a handful of public endpoints requires a session;
   signed-out visitors are redirected to `/signin`.
2. **The app layout** — the page shell independently requires the current
   user.
3. **Every server query and every server action** resolves the signed-in,
   allowlisted user itself, from the session — never from anything the
   browser claims. This is the only layer that is *trusted*; the outer two
   are fences.

Layer 3 is why a bug in routing or middleware cannot expose data: the code
that touches the database re-checks on its own, every time.

## Your data is only yours

* Every record carries its owner, and every read and write filters by the
  authenticated owner. A record id arriving from a browser is never trusted:
  fetching by id requires ownership, and "exists but not yours" is
  indistinguishable from "does not exist".
* Backup imports **re-identify every record into the importing account** — a
  file structurally cannot address another account's rows
  ([`migrating-from-local.md`](migrating-from-local.md) explains the
  mechanism).
* Health-import staging sessions are owner-checked at every step
  ([`health-import-privacy.md`](health-import-privacy.md)).
* This is not just policy but a **test suite**: a database-backed cross-user
  suite that runs in CI attempts each major operation against a victim
  account and asserts both the refusal *and* that the victim's row is
  byte-for-byte unchanged.

## Sessions, cookies, and what is stored about sign-in

* Sessions are stateless JWTs in a cookie: `__Secure-`-prefixed on HTTPS,
  `HttpOnly` (no script can read it), `SameSite=Lax`, maximum age 30 days.
  The live allowlist re-check means the 30 days is a convenience ceiling, not
  a revocation delay.
* **Revocation is immediate, on every device at once.** Each session token
  carries the account's *token version*. Changing your password (Settings →
  Sign-in & security) or pressing **Sign out everywhere** bumps that version
  on the account, and every session issued before the bump dies on its very
  next request. (A password change signs this browser back in for you; only
  the other devices notice.)
* Sessions issued by the pre-password build (the Google era) carry no token
  version at all and are **all dead** — after the upgrade, everyone signs in
  fresh with a password.
* **No OAuth tokens exist at all** — there is no third-party identity
  provider, so there is nothing from Google (or anyone else) to store, leak
  or revoke.
* What the database records about signing in: the time of your last
  successful sign-in and last failed attempt — shown in Settings → Sign-in &
  security as a "was that me?" check — plus the failure counter behind the
  15-minute pause. Nothing else: no IP addresses, no device fingerprints.

## Security headers

Set on every response and verified against the running server:

* A same-origin **Content Security Policy** — the page may load nothing from
  any other host. (Inline scripts/styles are allowed for the framework's
  hydration and the styling system — a documented trade-off; a nonce-based
  CSP is a noted possible hardening step.)
* `frame-ancestors 'none'` and `X-Frame-Options: DENY` — the app cannot be
  embedded in someone else's page.
* `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  strict-origin-when-cross-origin`.
* A `Permissions-Policy` denying every browser capability except same-origin
  camera (used only by the barcode scanner, only on explicit click).
* `Strict-Transport-Security` (2 years, includeSubDomains) in production.
* Dynamic pages answer with `Cache-Control: private, no-cache, no-store` — no
  shared cache ever holds your data.

## No analytics, no trackers

There is no third-party analytics, no tracking pixel, no external font or
CDN request — the CSP would block them, and a scan of the built client bundle
confirms no tracking host, no secret name and no database URL appears in it.

## What ends up in logs

* Errors shown to you carry a short **reference id**; the server log holds
  that id with the error's message text only — never the data that was being
  processed.
* The optional database query log (`PRISMA_LOG_QUERIES=1`) records query text
  and duration only; **parameters are never logged**, so no journal text,
  food name, health value — or password — can reach a log.
* Health-import code logs no row contents at all.

## Turning access off

Three levers, in increasing severity. The first two require a redeploy on
Vercel (environment changes take effect on the next deploy).

1. **Lock everyone out, immediately and reversibly:** set `ALLOWED_EMAILS` to
   an empty value and redeploy. The allowlist fails closed — no one can sign
   in, and existing sessions are refused on their next request. Restore the
   variable to reopen.
2. **Sign everyone out:** set a new `AUTH_SECRET` (generate with `npx auth
   secret`) and redeploy. Every existing session cookie becomes invalid at
   once; allowlisted people simply sign in again. (The everyday, no-redeploy
   version of this for your own account is the **Sign out everywhere**
   button in Settings → Sign-in & security.)
3. **Stop serving entirely:** pause the Vercel project (project settings →
   Pause), or delete the deployment. Nothing responds at all until unpaused.

## Rotating secrets, step by step

For each: change the value at its source, update the environment variable in
Vercel, redeploy. Consequences listed honestly:

| Secret | How to rotate | What happens |
|---|---|---|
| Your password | Settings → Sign-in & security → Change password (needs the current password). Forgotten it? `npm run auth:reset-password` on a machine with the database connection string — see [`auth-setup.md`](auth-setup.md) | Every other device is signed out immediately; the browser you changed it in stays signed in. The reset script signs out every device, including yours |
| `AUTH_SECRET` | `npx auth secret` for a fresh value → update → redeploy | Everyone is signed out immediately; sign-in works again at once |
| `AUTH_SETUP_TOKEN` | Don't rotate it — **delete it** from Vercel once setup is done. It is used exactly once, to create the owner account | None: the setup page already refuses to run once an account has a password; removing the token is belt-and-braces |
| `CRON_SECRET` | New random value → update in Vercel *and* in your external scheduler (cron-job.org) → redeploy | Vercel's daily cron picks it up automatically; the external scheduler must be updated by hand. Blast radius if it ever leaked: someone could trigger your own reminder delivery run — nothing more; it reads no data |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | `npx web-push generate-vapid-keys` → update both → redeploy | **Every device's push enrollment stops working** — each device re-enables in Settings → Background reminders |
| `USDA_FDC_API_KEY` | New key from the USDA signup page → update → redeploy | None; food search continues |
| Database credentials | Rotate in the database provider's dashboard → update `DATABASE_URL` *and* `DIRECT_DATABASE_URL` → redeploy | None, once redeployed |

## Deliberate limits, stated plainly

* **No two-factor authentication (2FA/TOTP) today.** One factor — the
  password — plus the allowlist. Compensate the honest way: use a **long,
  unique passphrase kept in a password manager**. Length beats cleverness,
  and unique means a leak elsewhere can't touch this app.
* **No email-based recovery.** The app sends no email of any kind, so there
  is no "forgot password" link for an attacker to abuse — and none to help
  you, either. Recovery is direct database access: run
  `npm run auth:reset-password` with the database connection string. Being
  able to reach the database *is* the proof of ownership.
* **A stranger who knows your email can lock you out, 15 minutes at a
  time**, by deliberately failing sign-in five times and repeating. This is
  a denial of service, not a breach: they get no closer to your data, and
  the generic error tells them nothing — not even whether the account
  exists. If it ever happens, wait out the window or run the reset script
  (it clears the lock instantly). The allowlist plus uniform errors make
  this the accepted trade; the alternatives (IP rate limits are trivially
  evaded, CAPTCHAs tax the owner every day) buy little here.
* **Request rate limiting beyond sign-in is left to the platform.** Sign-in
  has its own database-backed throttle (the lockout above); everything else
  is a private app whose only possible users are the handful of allowlisted
  accounts, and unauthenticated requests never reach application logic.
  Import staging has its own caps (bounded chunk sizes, at most 3 concurrent
  import sessions per user).
* The CSP permits inline scripts/styles, as noted above.
