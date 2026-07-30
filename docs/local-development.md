# Local development

Running Personal OS on your own machine — for development, for testing, or
just to poke at it before deploying.

## Requirements

* Node.js 20 or newer (the project is developed and CI-tested on 22)
* Docker (for the zero-config local PostgreSQL), **or** your own
  PostgreSQL 16+ if you prefer to run one yourself

## First run

1. Clone the repository and enter it:

   ```bash
   git clone <repository-url>
   cd Daily-Schedule
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Start the local database:

   ```bash
   docker compose up -d
   ```

   This starts PostgreSQL 16 on `localhost:5432` with the credentials the
   default `.env` expects (`postgres`/`postgres`, database
   `personal_os_dev`), plus a second database `personal_os_test` used only by
   the integration tests. Data survives restarts in a Docker volume;
   `docker compose down -v` deletes it. If you run PostgreSQL yourself
   instead, edit `DATABASE_URL` and `DIRECT_DATABASE_URL` in `.env` after
   step 4 creates it.

4. Set the app up:

   ```bash
   npm run setup        # migrations + backfills + demo sample data
   # — or —
   npm run setup:empty  # the same, but a completely empty app
   ```

   On first run this creates `.env` from `.env.example` automatically (it
   points at the docker-compose database). `setup` is idempotent — re-running
   it re-seeds the demo dataset. The seed refuses to run against anything
   that isn't a local database, so it can never hit production by accident.

5. Start the dev server:

   ```bash
   npm run dev
   ```

   and open <http://localhost:3000>.

## Signing in during development

The hosted app signs in with Google, which is awkward on a laptop. The
development sign-in exists for exactly this:

1. In `.env`, set:

   ```
   DANGEROUSLY_ENABLE_DEV_LOGIN="1"
   ALLOWED_EMAILS="you@local"
   ```

   (any email-shaped address works; `ALLOWED_EMAILS` applies to the dev door
   exactly as it does to Google).
2. Restart the dev server. The sign-in page now shows a "Development
   sign-in" form — type an allowlisted email and you're in, no password.

The name is deliberate: **never set `DANGEROUSLY_ENABLE_DEV_LOGIN` in
production.** As a backstop, the app ignores it entirely when running on
Vercel — but the variable is local-only by intent, not just by enforcement.

Real Google sign-in also works locally if you add
`http://localhost:3000/api/auth/callback/google` as a redirect URI — see
[`google-oauth-setup.md`](google-oauth-setup.md).

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with hot reload |
| `npm run build` / `npm start` | Production build and server |
| `npm test` | Unit tests (Vitest) — pure logic, no database needed |
| `npm run test:watch` | Unit tests in watch mode |
| `npm run test:integration` | Database-backed tests against the disposable test database |
| `npm run test:e2e` | Playwright browser tests (needs the server running — see below) |
| `npm run typecheck` | TypeScript, no emit |
| `npm run lint` | ESLint (kept at zero problems; also enforced in CI) |
| `npm run db:studio` | Prisma Studio — browse/edit the database directly |
| `npm run db:seed` | Re-seed sample data (refuses non-local databases) |
| `npm run db:migrate` | Create + apply a schema migration locally (`prisma migrate dev`) |
| `npm run db:migrate:deploy` | Apply committed migrations (what deploys run) |
| `npm run db:migrate:status` | Show which migrations are applied |
| `npm run db:backfill` | Run the idempotent TypeScript data backfills |
| `npm run db:reset` | Drop everything and re-seed — destructive, guarded (see below) |

## Running the tests

**Unit tests** need nothing running:

```bash
npm test
```

**Integration tests** run against a real PostgreSQL — but always the
disposable `personal_os_test` database (created by docker compose), never
your dev data:

```bash
npm run test:integration
```

Each run drops the test database's schema and re-applies the committed
migrations from zero. Two guards refuse any target database whose name does
not contain "test", so it cannot be pointed at real data by a typo. A
different test database can be set with `TEST_DATABASE_URL`.

**End-to-end browser tests** run against an *already-running* production
server (deliberately — building inside the test run would double its cost):

```bash
# terminal 1 — build and start with the dev sign-in enabled:
#   .env needs DANGEROUSLY_ENABLE_DEV_LOGIN="1" and ALLOWED_EMAILS
#   containing you@local and alice@example.com (the test accounts)
npm run build
npm start

# terminal 2 —
npm run test:e2e
```

If Playwright's Chromium isn't installed yet: `npx playwright install
chromium` once. The suite signs in through the dev form, so it needs no
Google credentials.

## The guarded `db:reset`

`npm run db:reset` drops every table and re-seeds — useful locally, fatal in
the wrong terminal. It is therefore gated by `scripts/guard-local-db.mjs`,
which refuses to run when `DATABASE_URL` points at anything that isn't a
local host (`localhost`, `127.0.0.1`, …). "I ran db:reset against production"
is a refused command, not a lost database. If you genuinely need to reset a
*disposable* remote database you own, override for that one command with
`DANGEROUSLY_ALLOW_REMOTE_DB=1`.

## Query logging (`PRISMA_LOG_QUERIES`)

```bash
PRISMA_LOG_QUERIES=1 npm start
```

prints every database query's SQL shape and duration to the server log —
useful for performance work (see
[`performance-measurement.md`](performance-measurement.md)). It is
deliberately **query-text-only**: parameters are never logged, so no journal
text, food name, health value or title can end up in a log file.
