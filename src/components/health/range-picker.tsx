"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";
import { HEALTH_RANGES, HEALTH_RANGE_META, type HealthRange } from "@/lib/health-ranges";

/**
 * 7 days / 30 days / 90 days / 1 year / all time.
 *
 * Links rather than buttons, so the chosen range lives in the URL: a range is
 * something you want to share, bookmark and go back to, and the pages read it
 * server-side and fetch exactly that window.
 */
export function RangePicker({ current }: { current: HealthRange }) {
  const pathname = usePathname();

  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-lg border p-0.5"
      role="group"
      aria-label="Time range"
    >
      {HEALTH_RANGES.map((range) => (
        <Link
          key={range}
          href={`${pathname}?range=${range}`}
          aria-current={range === current ? "true" : undefined}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
            range === current
              ? "bg-domain-health/10 text-domain-health"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          {HEALTH_RANGE_META[range].label}
        </Link>
      ))}
    </div>
  );
}
