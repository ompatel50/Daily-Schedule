/**
 * Refuses to run destructive database commands against anything that does not
 * look like a local development database.
 *
 * Used as a gate in front of `db:reset` (and anything else that wipes data).
 * A production `DATABASE_URL` points at a managed host, never localhost; this
 * check makes "I ran db:reset in the wrong terminal" a refused command instead
 * of a lost database.
 *
 * Override — only for a disposable database you own that happens to be
 * remote — by setting DANGEROUSLY_ALLOW_REMOTE_DB=1 for that one command.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function loadDotEnvUrl() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return undefined;
  const match = readFileSync(envPath, "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
  return match?.[1];
}

const url = process.env.DATABASE_URL ?? loadDotEnvUrl();

if (!url) {
  console.error("guard-local-db: DATABASE_URL is not set — refusing.");
  process.exit(1);
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "db", "postgres"]);

let host = "";
try {
  host = new URL(url).hostname;
} catch {
  console.error("guard-local-db: DATABASE_URL is not a parseable URL — refusing.");
  process.exit(1);
}

if (LOCAL_HOSTS.has(host)) {
  process.exit(0);
}

if (process.env.DANGEROUSLY_ALLOW_REMOTE_DB === "1") {
  console.warn(`guard-local-db: proceeding against REMOTE host "${host}" because DANGEROUSLY_ALLOW_REMOTE_DB=1.`);
  process.exit(0);
}

console.error(
  `guard-local-db: DATABASE_URL points at "${host}", which is not a local development database.\n` +
    "Destructive commands (reset, force-push) are refused against remote databases.\n" +
    "If this really is a disposable database, re-run with DANGEROUSLY_ALLOW_REMOTE_DB=1.",
);
process.exit(1);
