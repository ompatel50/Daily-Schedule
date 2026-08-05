"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

/**
 * The Health section's own navigation.
 *
 * Health is large enough to be a section rather than a page — activity, sleep,
 * heart, body, nutrition, workouts, vitals, trends, import and history each
 * own a route, so a link is shareable and the browser's back button means
 * something. The sidebar still has one Health entry; this is the second level
 * underneath it, and the shape mirrors the app's other tabbed surfaces.
 */
export const HEALTH_TABS = [
  { href: "/health", label: "Overview" },
  { href: "/health/activity", label: "Activity" },
  { href: "/health/sleep", label: "Sleep" },
  { href: "/health/heart", label: "Heart" },
  { href: "/health/body", label: "Body" },
  { href: "/health/nutrition", label: "Nutrition" },
  { href: "/health/workouts", label: "Workouts" },
  { href: "/health/vitals", label: "Vitals" },
  { href: "/health/trends", label: "Trends" },
  { href: "/health/import", label: "Import" },
  { href: "/health/imports", label: "History" },
] as const;

export function HealthNav() {
  const pathname = usePathname();

  // py-1/-my-1 give focus rings room inside the scroll container's clip.
  return (
    <nav aria-label="Health sections" className="-mx-1 -my-1 mb-5 overflow-x-auto pb-1">
      <ul className="flex min-w-max items-center gap-1 px-1 py-1">
        {HEALTH_TABS.map((tab) => {
          // `/health` must not light up for `/health/sleep`, so the overview
          // matches exactly and every other tab matches its own subtree.
          const active =
            tab.href === "/health"
              ? pathname === "/health"
              : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-10 items-center rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-domain-health/10 text-domain-health"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
