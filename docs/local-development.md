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

   The demo dataset covers every module, so a fresh install has something to
   look at everywhere: ~10 weeks of planner / habit / nutrition / workout /
   health history, plus projects and tagged tasks, inbox captures (one of them
   already converted into a task), three finance accounts with a ledger,
   recurring bills, savings goals, monthly **and** weekly budgets (one with an
   alert threshold), a CSV import batch whose rows are still linked — so "undo
   this import" has something real to demonstrate — and documents with
   upcoming, imminent and already-lapsed expiry dates.

   Demo data is never mixed into a real account. Every row the generator
   writes is registered in a `SeedBatch`, which is what lets **Settings →
   Sample data → Remove** delete exactly what was seeded and nothing else; the
   in-app "Start with sample data" button is offered only while the account is
   empty (finance, tasks, inbox and documents all count toward "empty"), and
   the CLI seed refuses non-local databases outright.

5. Start the dev server:

   ```bash
   npm run dev
   ```

   and open <http://localhost:3000>.

## Signing in during development

Sign-in works locally exactly as it does everywhere else: the app's own
email + password form. There is no Google, no OAuth, no separate
"development login" — the door you use locally is the real one.

1. In `.env` (created from `.env.example` in step 4), set:

   ```
   AUTH_SECRET="<generate one: openssl rand -base64 33>"
   ```

2. Restart the dev server and sign in with the account the demo seed
   created:

   * **Email:** `you@local`
   * **Password:** `local-dev-password`

   `npm run setup` prints this sign-in at the end of seeding. The known
   password is only ever set on **local** databases (the seed refuses to run
   against anything else), and only if the account doesn't already have one.

If you used `npm run setup:empty`, there is no account yet — create one the
way any visitor would: open <http://localhost:3000/signup> and register.
This is the exact flow a fresh deployment uses (recovery codes and all) —
see [`auth-setup.md`](auth-setup.md).

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
# terminal 1 — seed the two test accounts, then build and start:
#   .env needs AUTH_SECRET set
npm run seed:e2e
npm run build
npm start

# terminal 2 —
npm run test:e2e
```

`npm run seed:e2e` creates `you@local` and `alice@example.com` with the
known e2e password (`e2e-password-123`, or `E2E_USER_PASSWORD` if set).
The app never creates accounts at sign-in, so the suite needs both to
exist before the server starts; re-running the seed just resets their
passwords, never their data. Like the demo seed, it refuses non-local
databases — well-known credentials must never reach a real deployment.

If Playwright's Chromium isn't installed yet: `npx playwright install
chromium` once. The suite signs in through the real password form — no
external services involved.

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
