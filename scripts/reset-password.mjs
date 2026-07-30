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

/** Prompt with the typed characters hidden. */
function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const write = rl._writeToOutput?.bind(rl);
    rl._writeToOutput = (chunk) => {
      // Echo the question and newlines, mask everything else.
      if (chunk.includes(question) || chunk === "\r\n" || chunk === "\n") write?.(chunk);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
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
  await prisma.$disconnect();
}
