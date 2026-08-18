/**
 * Route protection — the outer fence. (Next 16's proxy, formerly middleware.)
 *
 * Uses the lightweight `authConfig` (JWT check only, no database) so no
 * request pays for a database round trip here. The `authorized` callback in
 * that config is the policy: everything except the public auth pages
 * (/signin, /signup, /forgot-password) and the Auth.js endpoints requires a
 * session, and unauthenticated visitors are redirected to the sign-in page.
 *
 * This is deliberately NOT the only protection. The proxy can be bypassed by
 * misconfiguration and never sees server-action internals, so every query and
 * mutation independently resolves the user from the session via
 * src/server/auth/current-user.ts. Defense in depth, not a single gate.
 */
import NextAuth from "next-auth";
import type { NextFetchEvent, NextRequest } from "next/server";

import { authConfig } from "@/server/auth/config";

const { auth } = NextAuth(authConfig);

// The middleware call shape — `auth(request, event)` — is what the old
// `export const { auth: middleware }` invoked; only the overload types fail
// to narrow to it, hence the assertion.
const handle = auth as unknown as (
  request: NextRequest,
  event: NextFetchEvent,
) => Promise<Response | undefined>;

/** The session cookie, under either the plain or the HTTPS-only name. */
const SESSION_COOKIE = /^(?:__Secure-)?authjs\.session-token=/;

/**
 * Auth.js re-issues the session cookie on every response that passes through
 * `auth` (sliding expiration). Under Next 16 that re-issue is a sign-out
 * bug: router prefetches issued while signed in can land AFTER the sign-out
 * action cleared the cookie, and their refreshed Set-Cookie silently
 * resurrects the session (observed deterministically — Next 16 prefetches
 * aggressively, and it strips every prefetch marker before the proxy runs,
 * so the straggler responses cannot even be told apart from navigations).
 *
 * So the proxy never touches the session cookie at all. Signing in and out
 * set and clear it through their server-action responses, which don't pass
 * through here; the only thing lost is proxy-driven sliding expiration, so a
 * session now lasts Auth.js's maxAge from sign-in rather than from last
 * activity. Other proxy cookies (CSRF seed, callback-url) pass untouched.
 */
function withoutSessionRefresh(response: Response): Response {
  const cookies = response.headers.getSetCookie();
  if (cookies.length === 0) return response;
  response.headers.delete("set-cookie");
  for (const cookie of cookies) {
    if (!SESSION_COOKIE.test(cookie)) response.headers.append("set-cookie", cookie);
  }
  return response;
}

export default async function proxy(request: NextRequest, event: NextFetchEvent) {
  const response = await handle(request, event);
  return response ? withoutSessionRefresh(response) : response;
}

export const config = {
  // Protect everything except Next.js internals and the few public files.
  matcher: [
    "/((?!_next/static|_next/image|icon.svg|favicon.ico|health-template.csv|sw.js|manifest.webmanifest|icons/|api/reminders/run|api/health).*)",
  ],
};
