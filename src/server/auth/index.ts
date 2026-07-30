/**
 * The server-side Auth.js instance.
 *
 * Node runtime only (credential verification reads the database and runs
 * scrypt). The middleware uses the edge-safe `authConfig` directly instead
 * of importing this file.
 *
 * There is exactly one way in: the "password" credentials provider, verified
 * by src/server/auth/credentials.ts (allowlist, scrypt check, per-account
 * lockout, enumeration-resistant failures). No OAuth provider, no adapter,
 * no Account table — sessions are stateless JWTs and the user row is the
 * only persistent identity.
 *
 * The object `authorize` returns becomes the `user` argument of the `jwt`
 * callback (src/server/auth/config.ts), which is where the id and
 * tokenVersion get embedded in the session token.
 */
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

import { authConfig } from "./config";
import { verifyCredentials } from "./credentials";

const passwordProvider = Credentials({
  id: "password",
  name: "Email and password",
  credentials: {
    email: { label: "Email", type: "email" },
    password: { label: "Password", type: "password" },
  },
  async authorize(credentials) {
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
