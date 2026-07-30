/**
 * Edge-safe Auth.js configuration.
 *
 * This module is imported by the middleware, which runs on the Edge runtime —
 * it must never import Prisma, `node:crypto`, `server-only`, or anything
 * Node-specific. The full server-side instance (the password provider, which
 * needs the database) lives in `src/server/auth/index.ts` and spreads this
 * config; that is why `providers` is empty here — the middleware only
 * validates the session JWT, it never performs a sign-in.
 *
 * Security posture:
 *  - Sign-in is in-app email + password only. No OAuth provider and no
 *    external identity service. Registration is public self-serve
 *    (/signup): anyone can create an account, and every account is fully
 *    isolated to its own rows by the per-user checks on every query.
 *  - Sessions are stateless JWTs (no session table), 30-day maximum. Each
 *    token carries the account's `tokenVersion`; a password change bumps the
 *    version, so every previously issued token dies on its next request
 *    (checked in src/server/auth/current-user.ts, costing no extra query).
 *  - `authorized` is what the middleware enforces: every route except the
 *    public auth pages (sign-in, sign-up, forgot-password) and the few
 *    public endpoints requires a session. Middleware is the outer fence
 *    only — every server action and query independently resolves the user
 *    from the session.
 */
import type { NextAuthConfig } from "next-auth";

export const authConfig = {
  providers: [],
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60, // 30 days; tokenVersion makes revocation immediate anyway
  },
  pages: {
    signIn: "/signin",
    error: "/signin", // error codes surface as ?error= on our own page, never a technical page
  },
  callbacks: {
    authorized({ auth, request }) {
      const { pathname } = request.nextUrl;
      // Public: the auth pages (sign-in, sign-up, forgot-password), the
      // Auth.js endpoints, the PWA assets and the cron endpoint (which
      // enforces its own CRON_SECRET check).
      if (pathname === "/signin" || pathname === "/signup" || pathname === "/forgot-password")
        return true;
      if (pathname.startsWith("/api/auth")) return true;
      if (pathname === "/sw.js" || pathname === "/manifest.webmanifest") return true;
      if (pathname.startsWith("/icons/") || pathname === "/api/reminders/run") return true;
      if (pathname === "/api/health") return true;
      return Boolean(auth?.user);
    },
    jwt({ token, user }) {
      // On sign-in `user` is the verified database row (see the password
      // provider); persist its id and token version so every later request
      // can resolve and validate the account without a session table.
      if (user?.id) {
        token.sub = user.id;
        token.tv = user.tokenVersion ?? 0;
      }
      return token;
    },
    session({ session, token }) {
      if (token.sub && session.user) {
        session.user.id = token.sub;
        // Deliberately NOT defaulted: a token without the claim (e.g. issued
        // by the pre-password build) must fail the strict version comparison
        // in current-user.ts, not silently match version 0.
        session.user.tokenVersion = token.tv;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
