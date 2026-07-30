/**
 * Creates `.env` from `.env.example` on first local run.
 *
 * `.env` is gitignored (on a deployed setup the real values live in the
 * hosting provider's environment settings, never in a file in this repo), but
 * Prisma refuses to load the schema without `DATABASE_URL`. Without this, a
 * fresh clone fails on the very first command.
 *
 * On a hosted build (Vercel, CI) `DATABASE_URL` is already present in the
 * process environment, and this script must not interfere: it exits without
 * touching anything. It never overwrites an existing `.env` either.
 */
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.DATABASE_URL) {
  // Hosted/CI build — the environment is configured externally.
  process.exit(0);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");
const examplePath = join(root, ".env.example");

if (existsSync(envPath)) {
  process.exit(0);
}

if (!existsSync(examplePath)) {
  console.error("Missing .env.example — cannot create .env automatically.");
  console.error("Create a .env with DATABASE_URL and DIRECT_DATABASE_URL (see README).");
  process.exit(1);
}

copyFileSync(examplePath, envPath);
console.log("Created .env from .env.example — edit it if your database differs.");
console.log("Local default: postgresql://postgres:postgres@localhost:5432/personal_os_dev");
