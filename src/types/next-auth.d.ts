import type { DefaultSession } from "next-auth";
// Imported for its side effect: the module must be in the program for the
// `declare module "next-auth/jwt"` augmentation below to apply.
import type {} from "next-auth/jwt";

declare module "next-auth" {
  /**
   * The session's user always carries the database id and the token version
   * it was issued against (set in the jwt/session callbacks). The version is
   * compared with the User row on every request; a mismatch means the
   * password changed (or "sign out everywhere" ran) after this token was
   * issued, and the request is treated as signed out.
   */
  interface Session {
    user: {
      id: string;
      /** Absent on tokens issued before password auth — treated as invalid. */
      tokenVersion?: number;
    } & DefaultSession["user"];
  }

  /** What the password provider's `authorize` returns (becomes `user` in the jwt callback). */
  interface User {
    tokenVersion?: number;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    /** User.tokenVersion at sign-in time. */
    tv?: number;
  }
}
