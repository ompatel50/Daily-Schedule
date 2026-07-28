/**
 * Creates `.env` from `.env.example` on first run.
 *
 * `.env` is gitignored (it's yours, and on a deployed setup it would hold a
 * real connection string), but Prisma refuses to load the schema without
 * `DATABASE_URL`. Without this, a fresh clone fails on the very first command.
 * The default value is just `file:./dev.db` — no secret, nothing to configure.
 */
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");
const examplePath = join(root, ".env.example");

if (existsSync(envPath)) {
  process.exit(0);
}

if (!existsSync(examplePath)) {
  console.error("Missing .env.example — cannot create .env automatically.");
  console.error('Create a .env containing: DATABASE_URL="file:./dev.db"');
  process.exit(1);
}

copyFileSync(examplePath, envPath);
console.log("Created .env from .env.example (DATABASE_URL=file:./dev.db)");
