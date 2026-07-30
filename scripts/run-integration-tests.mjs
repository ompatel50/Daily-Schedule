/**
 * Runs the database-backed integration tests against the DISPOSABLE
 * personal_os_test database: reset it, apply the committed migrations, run
 * vitest with the integration config. Never touches the dev database.
 *
 * Override the target with TEST_DATABASE_URL (its database name must contain
 * "test" — both this script and tests/integration/setup.ts refuse otherwise).
 */
import { spawnSync } from "node:child_process";

const url =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/personal_os_test";

if (!/test/.test(new URL(url).pathname)) {
  console.error(`Refusing: integration-test database name must contain "test" (got ${url}).`);
  process.exit(1);
}

const env = {
  ...process.env,
  DATABASE_URL: url,
  DIRECT_DATABASE_URL: url,
};

function run(command, args, input) {
  const result = spawnSync(command, args, {
    stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
    env,
    shell: false,
    input,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`Integration tests → ${url.replace(/\/\/[^@]*@/, "//***@")}`);
// Reset = drop the schema and re-apply the committed migrations from zero.
// Guarded twice above: only a database whose name contains "test" gets here.
run(
  "npx",
  ["prisma", "db", "execute", "--url", url, "--stdin"],
  "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;",
);
run("npx", ["prisma", "migrate", "deploy"]);
run("npx", ["vitest", "run", "--config", "vitest.integration.config.ts"]);
