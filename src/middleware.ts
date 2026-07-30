/**
 * Route protection — the outer fence.
 *
 * Runs on the Edge runtime, so it uses the edge-safe `authConfig` (JWT check
 * only, no database). The `authorized` callback in that config is the policy:
 * everything except /signin, the one-time /setup page and the Auth.js
 * endpoints requires a session, and unauthenticated visitors are redirected
 * to the sign-in page.
 *
 * This is deliberately NOT the only protection. Middleware can be bypassed by
 * misconfiguration and never sees server-action internals, so every query and
 * mutation independently resolves the user from the session via
 * src/server/auth/current-user.ts. Defense in depth, not a single gate.
 */
import NextAuth from "next-auth";

import { authConfig } from "@/server/auth/config";

export const { auth: middleware } = NextAuth(authConfig);

export const config = {
  // Protect everything except Next.js internals and the few public files.
  matcher: [
    "/((?!_next/static|_next/image|icon.svg|favicon.ico|health-template.csv|sw.js|manifest.webmanifest|icons/|api/reminders/run|api/health).*)",
  ],
};
