/**
 * Owner password recovery — run where you have direct database access:
 *
 *   node scripts/reset-password.mjs you@example.com
 *
 * Locally it uses .env; against a hosted database, set DATABASE_URL (and
 * DIRECT_DATABASE_URL if you use a pooler) in the environment first — the
 * deployment guide shows where to copy them from. The new password is typed
 * at a hidden prompt, never passed as an argument (arguments end up in shell
 * history).
 *
 * What it does, and all it does:
 *   - stores a fresh scrypt hash for that account (literally the same code
 *     the app runs — scripts/lib/password-hash.mjs),
 *   - bumps tokenVersion, signing the account out of every device,
 *   - clears any failed-attempt lockout.
 *
 * It refuses to create accounts: recovery is for an owner who already exists.
 * There is deliberately no in-app "forgot password" flow — this app sends no
 * email, so the recovery proof is direct access to the database itself.
 */
import readline from "node:readline";
import { PrismaClient } from "@prisma/client";

import { hashPassword } from "./lib/password-hash.mjs";

const MIN_PASSWORD_LENGTH = 12;

/**
 * One readline interface for the whole run, drained through a line queue —
 * per-question interfaces drop buffered input, and `rl.question` breaks when
 * piped stdin EOFs between questions. Questions are printed directly and
 * readline's own echo is suppressed, so typed characters stay hidden at a
 * terminal.
 */
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const rlWrite = rl._writeToOutput?.bind(rl);
rl._writeToOutput = (chunk) => {
  // Echo newlines only — every typed character stays masked.
  if (chunk === "\r\n" || chunk === "\n") rlWrite?.(chunk);
};

const bufferedLines = [];
const lineWaiters = [];
let stdinClosed = false;
rl.on("line", (line) => {
  const waiter = lineWaiters.shift();
  if (waiter) waiter(line);
  else bufferedLines.push(line);
});
rl.on("close", () => {
  stdinClosed = true;
  while (lineWaiters.length > 0) lineWaiters.shift()(null);
});

function nextLine() {
  if (bufferedLines.length > 0) return Promise.resolve(bufferedLines.shift());
  if (stdinClosed) return Promise.resolve(null);
  return new Promise((resolve) => lineWaiters.push(resolve));
}

async function promptHidden(question) {
  process.stdout.write(question);
  const line = await nextLine();
  process.stdout.write("\n");
  if (line === null) {
    console.error("Input ended before a password was provided — nothing was changed.");
    process.exit(1);
  }
  return line;
}

const email = (process.argv[2] ?? "").trim().toLowerCase();
if (!email || !email.includes("@")) {
  console.error("Usage: node scripts/reset-password.mjs you@example.com");
  process.exit(1);
}

const prisma = new PrismaClient();
try {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) {
    console.error(`No account exists for ${email} — this script never creates one.`);
    console.error("If this is a fresh deployment, use the /setup page instead.");
    process.exit(1);
  }

  const password = await promptHidden("New password (typing is hidden): ");
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
    process.exit(1);
  }
  const confirm = await promptHidden("Once more: ");
  if (password !== confirm) {
    console.error("The two entries didn't match — nothing was changed.");
    process.exit(1);
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(password),
      passwordUpdatedAt: new Date(),
      tokenVersion: { increment: 1 },
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });
  console.log(`Password updated for ${email}. Every signed-in device now needs the new password.`);
} finally {
  rl.close();
  await prisma.$disconnect();
}
