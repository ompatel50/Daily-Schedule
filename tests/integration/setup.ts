/**
 * Runs before any test module is imported. Points Prisma at the disposable
 * integration-test database and refuses to run against anything else — a
 * mistyped URL must fail loudly, not wipe a real database.
 */
const url =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/personal_os_test";

if (!/personal_os_test|_test\b/.test(url)) {
  throw new Error(
    `Integration tests refuse to run against "${url}" — the database name must contain "test".`,
  );
}

process.env.DATABASE_URL = url;
process.env.DIRECT_DATABASE_URL = url;
// The users the tests sign in as must pass the live allowlist check.
process.env.ALLOWED_EMAILS = "alice@test.local,bob@test.local,owner@test.local";
