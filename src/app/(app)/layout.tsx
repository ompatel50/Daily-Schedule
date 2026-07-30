import type { ReactNode } from "react";

import { AppShell } from "@/components/layout/app-shell";
import { requireCurrentUser } from "@/server/auth/current-user";

/**
 * Everything inside the (app) group is the application itself, and none of it
 * exists for a signed-out visitor. The redirect here is the layout-level
 * guard; the middleware fences the route earlier, and every query and action
 * independently re-derives the user from the session — three layers, of which
 * only the deepest one is trusted.
 */
export default async function AuthenticatedLayout({ children }: { children: ReactNode }) {
  await requireCurrentUser();
  return <AppShell>{children}</AppShell>;
}
