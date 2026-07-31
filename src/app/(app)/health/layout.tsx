import type { ReactNode } from "react";

import { HealthNav } from "@/components/health/health-nav";

/**
 * The Health section shell. Every Health route renders inside the same
 * max-width column with the same second-level navigation, so moving between
 * Activity and Sleep never shifts the page under the pointer.
 */
export default function HealthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-7xl">
      <HealthNav />
      {children}
    </div>
  );
}
