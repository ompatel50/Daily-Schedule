/**
 * The server-side Auth.js instance.
 *
 * Node runtime only (credential verification reads the database and runs
 * scrypt). The middleware uses the edge-safe `authConfig` directly instead
 * of importing this file.
 *
 * There is exactly one way in: the "password" credentials provider, verified
 * by src/server/auth/credentials.ts (scrypt check, per-account lockout,
 * enumeration-resistant failures). No OAuth provider, no adapter, no
 * Account table — sessions are stateless JWTs and the user row is the only
 * persistent identity.
 *
 * The object `authorize` returns becomes the `user` argument of the `jwt`
 * callback (src/server/auth/config.ts), which is where the id and
 * tokenVersion get embedded in the session token.
 */
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

import { authConfig } from "./config";
import { verifyCredentials } from "./credentials";
import { clientRateLimitKey, consumeRateLimit } from "./rate-limit";

/**
 * Sign-in attempts allowed per client address per hour. Deliberately
 * generous: this is only the anti-resource-exhaustion cap on anonymous
 * scrypt work (targeted guessing is handled by the per-account lockout),
 * and the same authorize() path also serves the internal re-sign-in after
 * sign-up and password change, plus everyone behind one shared NAT. At
 * this level a real user (or a busy office) never notices, while a
 * single-source flood is still bounded to a few seconds of CPU per hour.
 */
const SIGNIN_RATE_LIMIT = 120;

const passwordProvider = Credentials({
  id: "password",
  name: "Email and password",
  credentials: {
    email: { label: "Email", type: "email" },
    password: { label: "Password", type: "password" },
  },
  async authorize(credentials) {
    // A per-client fence in front of the scrypt work. Sign-in is anonymous
    // and every attempt — unknown emails included — deliberately burns a
    // full hash verification, so without this one address could grind
    // passwords (or CPU) indefinitely; the per-account lockout alone cannot
    // stop a spray across many emails. Generous enough that a shared
    // office/NAT address never notices, and the refusal reads exactly like
    // a wrong password.
    const allowed = await consumeRateLimit(
      await clientRateLimitKey("signin"),
      SIGNIN_RATE_LIMIT,
      60 * 60_000,
    );
    if (!allowed) return null;

    const user = await verifyCredentials(credentials?.email, credentials?.password);
    if (!user) return null;
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      tokenVersion: user.tokenVersion,
    };
  },
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [passwordProvider],
});
