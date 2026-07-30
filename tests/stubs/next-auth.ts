/**
 * Test stand-in for `next-auth`.
 *
 * Unit tests import server modules whose dependency chain ends at the Auth.js
 * instance; none of them should ever perform real authentication. The stub
 * returns whatever session the test has planted on
 * `globalThis.__TEST_SESSION__`, which is also how the database-backed
 * integration tests choose "who is signed in" per test.
 */
type TestSession = {
  user: { id: string; email?: string | null; name?: string | null; tokenVersion?: number };
} | null;

declare global {
  var __TEST_SESSION__: TestSession | undefined;
}

export default function NextAuth(_config: unknown) {
  return {
    handlers: { GET: undefined, POST: undefined },
    auth: async (): Promise<TestSession> => globalThis.__TEST_SESSION__ ?? null,
    signIn: async (): Promise<void> => undefined,
    signOut: async (): Promise<void> => undefined,
  };
}

export type Session = NonNullable<TestSession>;
