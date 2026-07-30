/** Test stand-in for @auth/prisma-adapter — never used by stubbed NextAuth. */
export function PrismaAdapter(_client: unknown): Record<string, never> {
  return {};
}
