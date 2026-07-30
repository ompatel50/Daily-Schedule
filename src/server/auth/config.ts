/**
 * Edge-safe Auth.js configuration.
 *
 * This module is imported by the middleware, which runs on the Edge runtime —
 * it must never import Prisma, `server-only`, or anything Node-specific. The
 * full server-side instance (adapter, dev sign-in) lives in
 * `src/server/auth/index.ts` and spreads this config.
 *
 * Security posture:
 *  - Google OAuth is the only real sign-in method; there is no registration.
 *  - `signIn` refuses any email that is not on the server-side allowlist,
 *    even after Google has authenticated it. It also fails closed when the
 *    allowlist is missing entirely.
 *  - Sessions are stateless JWTs (no session table), 30-day maximum.
 *  - `authorized` is what the middleware enforces: every route except the
 *    sign-in page and the auth endpoints requires a session. Middleware is
 *    the outer fence only — every server action and query independently
 *    resolves the user from the session (src/server/auth/current-user.ts).
 */
import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";

import { allowlistConfigured, isAllowedEmail } from "./allowlist";

export const authConfig = {
  providers: [Google],
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60, // 30 days; the allowlist re-check makes revocation immediate anyway
  },
  pages: {
    signIn: "/signin",
    error: "/signin", // error codes surface as ?error= on our own page, never a technical page
  },
  callbacks: {
    signIn({ user, profile }) {
      // Fail closed: no allowlist configured means nobody signs in.
      if (!allowlistConfigured()) return false;
      const email = user.email ?? profile?.email;
      return isAllowedEmail(email);
    },
    authorized({ auth, request }) {
      const { pathname } = request.nextUrl;
      // Public: the sign-in page, the Auth.js endpoints, the PWA assets and
      // the cron endpoint (which enforces its own CRON_SECRET check).
      if (pathname === "/signin" || pathname.startsWith("/api/auth")) return true;
      if (pathname === "/sw.js" || pathname === "/manifest.webmanifest") return true;
      if (pathname.startsWith("/icons/") || pathname === "/api/reminders/run") return true;
      return Boolean(auth?.user);
    },
    jwt({ token, user }) {
      // On first sign-in `user` is the database row; persist its id so every
      // later request can resolve the account without a session table.
      if (user?.id) token.sub = user.id;
      return token;
    },
    session({ session, token }) {
      if (token.sub && session.user) session.user.id = token.sub;
      return session;
    },
  },
} satisfies NextAuthConfig;
