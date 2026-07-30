# Google sign-in setup (OAuth)

Google is the only way to sign in to the hosted Personal OS — there is no
password system and no public registration. Google's job is to prove *who* you
are; the app's own server-side allowlist (`ALLOWED_EMAILS`) then decides
whether that person is *allowed in*. This guide creates the two values the app
needs: a **client ID** and a **client secret**.

The app asks Google for nothing beyond the basics (your name, email address
and profile picture at the moment of sign-in). It never calls Google again
afterwards and never stores Google's tokens — so there are no extra
permissions to grant and no scopes to add anywhere below.

## Step 1 — Create a Google Cloud project

1. Go to <https://console.cloud.google.com> and sign in with your Google
   account.
2. Open the project picker (top bar) and choose **New project**.
3. Name it anything — "Personal OS" works — and create it. Make sure it is
   the selected project before continuing.

## Step 2 — Configure the OAuth consent screen

This is the screen Google shows the first time someone signs in.

1. In the left menu go to **APIs & Services → OAuth consent screen**.
2. User type: choose **External**. ("Internal" only exists for Google
   Workspace organisations.)
3. Fill in the required fields: app name (e.g. "Personal OS"), your email as
   the support email and as the developer contact. No logo or website is
   required.
4. **Scopes: add none.** Skip the scopes step entirely — the basic profile
   and email come with sign-in by default, and that is all the app uses.
5. **Test users:** while the consent screen is in "Testing" mode, only the
   people listed as test users can sign in. Add your own email address (and
   any other address you plan to put in `ALLOWED_EMAILS`). For a private app
   this is the simplest permanent setup.

   The alternative is to press **Publish app**, which lets any Google account
   pass the Google step (the app's allowlist still refuses everyone you
   haven't listed). Publishing without Google's verification review can show
   users an "unverified app" warning screen. For a personal app, staying in
   Testing mode with yourself as a test user is usually the better choice.

## Step 3 — Create the OAuth client ID

1. Go to **APIs & Services → Credentials**.
2. **Create credentials → OAuth client ID**.
3. Application type: **Web application**. Name it anything.
4. **Authorized redirect URIs** — this is the part that must be exact. Add
   one line per URL you will sign in from, each ending in
   `/api/auth/callback/google`:

   * `https://YOUR-DOMAIN/api/auth/callback/google` — your production site.
     `YOUR-DOMAIN` is your project's Vercel domain (it looks like
     `your-project.vercel.app`) and/or your custom domain; if you use both,
     add both as separate lines.
   * The preview URL variant, if you want to sign in on a Vercel preview
     deployment: `https://YOUR-PREVIEW-URL/api/auth/callback/google`. Google
     matches redirect URIs **exactly** — no wildcards — and each preview
     deployment gets its own URL, so add the exact preview URL you intend to
     test on.
   * `http://localhost:3000/api/auth/callback/google` — for signing in with
     real Google on your own machine during development. (Optional: local
     development normally uses the passwordless dev sign-in instead — see
     [`local-development.md`](local-development.md).)

   "Authorized JavaScript origins" can be left empty — the app's sign-in flow
   does not need it.
5. Press **Create**. Google shows the **Client ID** and **Client secret**.
   Copy both.

## Step 4 — Where to paste the two values

* **Hosted (Vercel):** project → **Settings → Environment Variables** →
  * `AUTH_GOOGLE_ID` = the client ID
  * `AUTH_GOOGLE_SECRET` = the client secret

  then redeploy (environment changes only take effect on the next deploy).
* **Local development** (only if you want real Google locally): the same two
  lines in the `.env` file at the repository root.

Never commit these values to the repository — `.env` is gitignored for
exactly this reason, and the secret can be reset from the Credentials page if
it ever leaks (see [`security-and-privacy.md`](security-and-privacy.md)).

## If sign-in fails

| What you see | What it means | Fix |
|---|---|---|
| `redirect_uri_mismatch` from Google | The URL you signed in from isn't in the redirect URI list, character for character | Add the exact URL (including `https://` and the full `/api/auth/callback/google` path) in step 3 |
| "Access blocked: … has not completed the Google verification process" | Consent screen is in Testing mode and this account isn't a test user | Add the email as a test user, or publish the app |
| "This Google account isn't approved for this Personal OS" | Google succeeded — this is the **app's own allowlist** refusing | Add the email to `ALLOWED_EMAILS` in Vercel and redeploy |
| "Sign-in isn't fully configured yet" | `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` / `AUTH_SECRET` missing or wrong | Check the environment variables, redeploy |
