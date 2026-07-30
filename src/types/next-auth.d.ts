import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  /** The session's user always carries the database id (set in the jwt/session callbacks). */
  interface Session {
    user: {
      id: string;
    } & DefaultSession["user"];
  }
}
