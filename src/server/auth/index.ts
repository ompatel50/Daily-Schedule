/**
 * The server-side Auth.js instance.
 *
 * Node runtime only (the Prisma adapter needs a real database connection).
 * The middleware uses `authConfig` directly instead of importing this file.
 *
 * Two deliberate departures from the stock adapter setup:
 *
 * 1. **OAuth tokens are never stored.** The app never calls Google's APIs
 *    after sign-in, so `linkAccount` strips access/refresh/id tokens before
 *    the row is written. What remains is the minimum that identifies the
 *    link: provider + providerAccountId.
 * 2. **A missing name never blocks account creation.** Google occasionally
 *    returns no profile name; the app's `User.name` is required, so it falls
 *    back to the email's local part.
 *
 * Development sign-in: with `DANGEROUSLY_ENABLE_DEV_LOGIN=1` (and never on
 * Vercel), a credentials form on /signin signs in any *allowlisted* email
 * without Google — for local development and automated browser tests where
 * OAuth credentials do not exist. It is off unless explicitly enabled, it
 * still enforces the allowlist, and it must never be enabled in production.
 */
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import type { Adapter, AdapterAccount, AdapterUser } from "@auth/core/adapters";

import { prisma } from "@/lib/prisma";
import { authConfig } from "./config";
import { isAllowedEmail } from "./allowlist";

function minimalStorageAdapter(): Adapter {
  const base = PrismaAdapter(prisma);
  return {
    ...base,
    createUser(user: AdapterUser) {
      const name = user.name?.trim() || user.email?.split("@")[0] || "You";
      return base.createUser!({ ...user, name });
    },
    linkAccount(account: AdapterAccount) {
      // Store the link, not the credentials. The app never talks to Google
      // after sign-in, so the tokens would be pure liability at rest.
      const {
        access_token: _access,
        refresh_token: _refresh,
        id_token: _id,
        session_state: _state,
        ...link
      } = account;
      return base.linkAccount!(link as AdapterAccount);
    },
  };
}

const devLoginEnabled =
  process.env.DANGEROUSLY_ENABLE_DEV_LOGIN === "1" && !process.env.VERCEL;

const devLoginProvider = Credentials({
  id: "dev-login",
  name: "Development sign-in",
  credentials: { email: { label: "Email", type: "email" } },
  async authorize(credentials) {
    if (!devLoginEnabled) return null;
    const email = typeof credentials?.email === "string" ? credentials.email.trim().toLowerCase() : "";
    // The allowlist applies to the dev door exactly as it does to Google.
    if (!isAllowedEmail(email)) return null;
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return { id: existing.id, email: existing.email, name: existing.name };
    const created = await prisma.user.create({
      data: { name: email.split("@")[0], email, emailVerified: new Date() },
    });
    return { id: created.id, email: created.email, name: created.name };
  },
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: minimalStorageAdapter(),
  providers: devLoginEnabled ? [...authConfig.providers, devLoginProvider] : authConfig.providers,
});
