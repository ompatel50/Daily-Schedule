/** Test stand-in for next-auth provider factories (Credentials). */
export default function provider(options?: unknown): Record<string, unknown> {
  return { options };
}
