# Security and privacy

What protects the hosted Personal OS, stated concretely enough to be checked
— and the off switches, because being able to turn something off is part of
owning it.

## Who can get in: the allowlist

* Sign-in is Google OAuth only. There is no password system and **no public
  registration** — the sign-in page offers nothing to anyone unlisted.
* `ALLOWED_EMAILS` (an environment variable, comma-separated,
  case-insensitive) is the entire admission policy. Google proves identity;
  the allowlist grants access. An email not on it is refused **after** Google
  authenticates it, with a message that reveals nothing technical.
* **It fails closed.** No allowlist configured means *nobody* can sign in —
  a misconfiguration locks the door rather than opening it.
* **Revocation is live.** The allowlist is checked at sign-in *and again on
  every authenticated request*. Removing an email locks that account out on
  its very next request — not when its session eventually expires.

## Three layers of authentication

1. **Edge middleware** — every route except the sign-in page and a handful of
   public endpoints requires a session; signed-out visitors are redirected to
   `/signin`.
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
  suite (part of the 85 integration tests that run in CI) attempts each major
  operation against a victim account and asserts both the refusal *and* that
  the victim's row is byte-for-byte unchanged.

## Sessions, cookies, and what is stored about sign-in

* Sessions are stateless JWTs in a cookie: `__Secure-`-prefixed on HTTPS,
  `HttpOnly` (no script can read it), `SameSite=Lax`, maximum age 30 days.
  The live allowlist re-check means the 30 days is a convenience ceiling, not
  a revocation delay.
* **Google's tokens are never stored.** The app never calls Google after
  sign-in, so access/refresh/id tokens are stripped before the account link
  is written. What remains is the minimum that identifies the link.

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
  food name or health value can reach a log.
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
   once; allowlisted people simply sign in again.
3. **Stop serving entirely:** pause the Vercel project (project settings →
   Pause), or delete the deployment. Nothing responds at all until unpaused.

## Rotating secrets, step by step

For each: change the value at its source, update the environment variable in
Vercel, redeploy. Consequences listed honestly:

| Secret | How to rotate | What happens |
|---|---|---|
| `AUTH_SECRET` | `npx auth secret` for a fresh value → update → redeploy | Everyone is signed out immediately; sign-in works again at once |
| `AUTH_GOOGLE_SECRET` | Google Cloud Console → Credentials → your OAuth client → reset secret → update → redeploy | No user-visible effect beyond a brief window where the old secret is invalid |
| `CRON_SECRET` | New random value → update → redeploy | Vercel Cron picks it up automatically; an external scheduler must be updated by hand |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | `npx web-push generate-vapid-keys` → update both → redeploy | **Every device's push enrollment stops working** — each device re-enables in Settings → Background reminders |
| `USDA_FDC_API_KEY` | New key from the USDA signup page → update → redeploy | None; food search continues |
| Database credentials | Rotate in the database provider's dashboard → update `DATABASE_URL` *and* `DIRECT_DATABASE_URL` → redeploy | None, once redeployed |

## Deliberate limits, stated plainly

* **Request rate limiting is left to the platform.** This is a private app
  whose only possible users are the handful of allowlisted accounts;
  unauthenticated requests never reach application logic. Import staging has
  its own caps (bounded chunk sizes, at most 3 concurrent import sessions per
  user).
* The CSP permits inline scripts/styles, as noted above.
* Security of the Google account itself is out of the app's hands — the
  allowlist is only as strong as the listed accounts' own protection. Turn on
  two-factor authentication for them.
