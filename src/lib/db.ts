/**
 * The data-access surface the rest of the app imports.
 *
 * `getCurrentUser` is the seam every query and action resolves the user
 * through. It used to be a single-user `findFirst`; it is now the
 * authenticated, allowlisted session user — and redirects to /signin when
 * there is none — so every existing call site is authentication-enforcing
 * without having been rewritten. See src/server/auth/current-user.ts.
 */
export { prisma } from "@/lib/prisma";
export { requireCurrentUser as getCurrentUser } from "@/server/auth/current-user";
