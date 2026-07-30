/**
 * A no-op stand-in for `next/cache`.
 *
 * `revalidatePath` / `revalidateTag` throw outside a real Next.js request
 * scope. Server actions call them after their database work; tests that
 * exercise those actions against a real database only care about the database
 * work, so the cache invalidation becomes a no-op here — exactly like the
 * `server-only` stub above it.
 */
export function revalidatePath(_path: string, _type?: string): void {}
export function revalidateTag(_tag: string): void {}
export function unstable_cache<T extends (...args: never[]) => unknown>(fn: T): T {
  return fn;
}
