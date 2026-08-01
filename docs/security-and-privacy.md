# Security and privacy

What protects the hosted Personal OS, stated concretely enough to be checked
— and the off switches, because being able to turn something off is part of
owning it.

## Who can get in: public accounts, private data

* Sign-in is an in-app email + password form, and **registration is public
  self-serve at `/signup`** — anyone can create an account. There is **no
  Google, no OAuth, no third-party identity provider, no billing account,
  and no credit card anywhere in the stack**.
* What keeps the app private is not a gate on *who may register* but
  **per-account isolation of everything after**: every account only ever
  sees its own rows, enforced on every query and every action server-side
  (the next sections spell out how). Creating an account grants exactly one
  empty, isolated space — never a view into anyone else's.
* **Sign-up is abuse-fenced.** Account creation is rate limited per client
  address with database-backed counters (they hold across serverless
  instances, and store only an HMAC of the address keyed by `AUTH_SECRET` —
  never a raw IP), and the form carries a honeypot that silently rejects
  naive bots. The optional `SIGNUPS_DISABLED=1` environment variable pauses
  new registrations entirely without affecting existing accounts.
* **Password policy at creation:** minimum 12 characters, and passwords
  built around the email's local part are refused. Duplicate emails are
  rejected without ever touching the existing account.
* **Guessing is throttled twice.** Five wrong attempts in a row pause
  sign-in for that account for 15 minutes, and sign-in attempts are also
  rate limited per client address. Every kind of failure — wrong password,
  unknown email, currently locked — shows the **same generic message** and
  takes the same time to compute, so an attacker learns nothing from the
  response: not whether the account exists, and not whether a lock is in
  effect. Once the 15 minutes pass, the counter is forgiven **in full** —
  you get five fresh tries, so one old mistake can never keep re-locking
  you.
* **Password recovery is in-app and email-free**: every account holds 8
  one-time recovery codes (~79 bits of randomness each, stored only as
  SHA-256 hashes, shown exactly once at generation). Redeeming one at
  `/forgot-password` replaces the password, burns the code, clears any
  lockout and signs out every session. The flow is rate limited per client
  *and* per named account, and all identity failures read identically.

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

1. **Edge middleware** — every route except the public auth pages
   (`/signin`, `/signup`, `/forgot-password`) and a handful of public
   endpoints requires a session; signed-out visitors are redirected to
   `/signin`.
2. **The app layout** — the page shell independently requires the current
   user.
3. **Every server query and every server action** resolves the signed-in
   user itself, from the session — never from anything the browser claims.
   This is the only layer that is *trusted*; the outer two are fences.

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
* Health imports are owner-checked at every step — opening an upload, every
  part of it, assembling, staging, preview, confirm, cancel and undo. An upload
  resolves only by `(id, userId)`, so another account's id does not exist
  rather than being refused, and the most a client can store is the part count
  its own session declared. Every part is deleted as soon as the archive has
  been parsed, on every path including failure, and an abandoned upload expires
  within the hour. The parser refuses XML entity declarations and external
  DTDs outright, and bounds decompression, element size and nesting depth, so
  a crafted archive fails the import rather than the host
  ([`health-import-privacy.md`](health-import-privacy.md),
  [`health-module.md`](health-module.md)).
* The one deliberately shared table is the **provider food cache**
  (nutrition facts fetched from USDA / Open Food Facts — public data, owned
  by no account). Only the server writes into it from real provider
  responses; a backup import can never plant rows there, and a personal
  food row can never be flipped into it.
* This is not just policy but a **test suite**: a database-backed cross-user
  suite that runs in CI attempts each major operation against a victim
  account and asserts both the refusal *and* that the victim's row is
  byte-for-byte unchanged.

## Sessions, cookies, and what is stored about sign-in

* Sessions are stateless JWTs in a cookie: `__Secure-`-prefixed on HTTPS,
  `HttpOnly` (no script can read it), `SameSite=Lax`, maximum age 30 days.
  The per-request token-version check (below) means the 30 days is a
  convenience ceiling, not a revocation delay.
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

## The AI assistant sends data to exactly one place: yours

The assistant (`docs/ai-assistant.md`) talks only to the Ollama server whose
URL you typed into Settings — a machine you run. There is no cloud AI
provider, no API key, and no fallback endpoint; the client module builds
every request URL from that one base, tests assert a stubbed network only
ever sees that host, and a structural test fails the suite if the assistant's
server code ever names a cloud AI host. The browser cannot talk to Ollama at
all (the CSP allows same-origin requests only) — everything flows through
this app's server, as the signed-in user.

The model reads through the same ownership-checked, bounded server functions
as the rest of the app and has no direct database access. It cannot write:
changes are staged as proposals, validated with the app's own schemas, and
executed only after an explicit in-app confirmation — through the same server
actions the app's buttons call. Read-only mode (the default) refuses even the
staging, server-side. The audit trail stores bounded, app-authored summaries
— never transcripts — and conversations are not persisted at all. Assistant
base URLs are validated (http/https only, no credentials, cloud-metadata
addresses refused) and never appear in error messages or logs.

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

1. **Stop new registrations, reversibly:** set `SIGNUPS_DISABLED=1` and
   redeploy. The `/signup` form refuses (server-side, not just visually);
   existing accounts keep signing in. Unset it to reopen. This is the
   incident lever against sign-up abuse.
2. **Sign everyone out:** set a new `AUTH_SECRET` (generate with `npx auth
   secret`) and redeploy. Every existing session cookie becomes invalid at
   once; account holders simply sign in again with their passwords. (The
   everyday, no-redeploy version of this for your own account is the
   **Sign out everywhere** button in Settings → Sign-in & security.)
3. **Stop serving entirely:** pause the Vercel project (project settings →
   Pause), or delete the deployment. Nothing responds at all until
   unpaused. This — not an environment variable — is the true "nobody gets
   in" switch: with public sign-up there is deliberately no allowlist left
   to fail closed, so a full lockout means taking the site down.

## Rotating secrets, step by step

For each: change the value at its source, update the environment variable in
Vercel, redeploy. Consequences listed honestly:

| Secret | How to rotate | What happens |
|---|---|---|
| Your password | Settings → Sign-in & security → Change password (needs the current password). Forgotten it? Redeem a recovery code at `/forgot-password`; codes gone too? `npm run auth:reset-password` on a machine with the database connection string — see [`auth-setup.md`](auth-setup.md) | Every other device is signed out immediately; the browser you changed it in stays signed in. Recovery-code reset and the reset script sign out every device, including yours |
| Recovery codes | Settings → Sign-in & security → Generate new codes (needs the current password) | Every old code stops working instantly; the new batch is shown exactly once |
| `AUTH_SECRET` | `npx auth secret` for a fresh value → update → redeploy | Everyone is signed out immediately; sign-in works again at once |
| `CRON_SECRET` | New random value → update in Vercel *and* in your external scheduler (cron-job.org) → redeploy | Vercel's daily cron picks it up automatically; the external scheduler must be updated by hand. Blast radius if it ever leaked: someone could trigger your own reminder delivery run — nothing more; it reads no data |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | `npx web-push generate-vapid-keys` → update both → redeploy | **Every device's push enrollment stops working** — each device re-enables in Settings → Background reminders |
| `USDA_FDC_API_KEY` | New key from the USDA signup page → update → redeploy | None; food search continues |
| Database credentials | Rotate in the database provider's dashboard → update `DATABASE_URL` *and* `DIRECT_DATABASE_URL` → redeploy | None, once redeployed |

## Deliberate limits, stated plainly

* **No two-factor authentication (2FA/TOTP) today.** One factor — the
  password. Compensate the honest way: use a **long, unique passphrase kept
  in a password manager**. Length beats cleverness, and unique means a leak
  elsewhere can't touch this app.
* **No email-based recovery.** The app sends no email of any kind, so there
  is no reset link for an attacker to intercept — recovery is the one-time
  codes described above, which only the account holder ever saw. If the
  codes are lost too, the operator's reset script with direct database
  access is the last resort; being able to reach the database *is* that
  path's proof of ownership.
* **A stranger who knows your email can lock you out, 15 minutes at a
  time**, by deliberately failing sign-in five times and repeating. This is
  a denial of service, not a breach: they get no closer to your data, and
  the generic error tells them nothing — not even whether the account
  exists. If it ever happens, wait out the window or reset with a recovery
  code (it clears the lock instantly). The per-client sign-in rate limit
  blunts the cheapest version of this; a determined attacker with many
  addresses can still be a nuisance, never a threat to the data.
* **Duplicate-email sign-up necessarily confirms an address is taken.**
  Any sign-up form that rejects duplicates without sending email does; the
  sign-up rate limit is what keeps that from scaling into enumeration.
  Sign-*in* and recovery stay fully generic.
* **Request rate limiting beyond the auth surface is left to the
  platform.** Sign-up, sign-in and recovery each have their own
  database-backed fences (above); authenticated app traffic is bounded by
  ordinary use, and unauthenticated requests never reach application logic.
  Import staging has its own caps (bounded chunk sizes, at most 3
  concurrent import sessions per user).
* The CSP permits inline scripts/styles, as noted above.
