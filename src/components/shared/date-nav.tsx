"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  type DayKey,
  formatDay,
  formatDayLong,
  formatMonthTitle,
  formatWeekRange,
  isToday,
  shiftDay,
  shiftMonth,
  today,
} from "@/lib/date";

export type DateScope = "day" | "week" | "month";

/**
 * URL-driven date navigation (`?date=YYYY-MM-DD`). Keeping the date in the URL
 * means Server Components can read it directly, back/forward works, and any
 * view is linkable.
 */
export function DateNav({
  date,
  scope = "day",
  weekStartsOn = 1,
  todayKey,
}: {
  date: DayKey;
  scope?: DateScope;
  weekStartsOn?: 0 | 1;
  /**
   * "Today" in the user's timezone, resolved on the server. Without it this
   * component navigates by the host clock, so a hand-off from one surface to
   * another can land on a different day than the one you left.
   */
  todayKey?: DayKey;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const now = todayKey ?? today();

  const go = React.useCallback(
    (next: DayKey) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === now) params.delete("date");
      else params.set("date", next);
      const query = params.toString();
      router.push(query ? `${pathname}?${query}` : pathname);
    },
    [now, pathname, router, searchParams],
  );

  const step = React.useCallback(
    (direction: 1 | -1) => {
      if (scope === "month") go(shiftMonth(date, direction));
      else go(shiftDay(date, direction * (scope === "week" ? 7 : 1)));
    },
    [date, go, scope],
  );

  // j/k step through days — the muscle memory from vim-ish tools, and `t`
  // jumps home. Ignored while typing (see KeyboardShortcuts for the same guard).
  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName.toLowerCase();
        if (tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable) return;
      }

      if (event.key === "j") {
        event.preventDefault();
        step(-1);
      } else if (event.key === "k") {
        event.preventDefault();
        step(1);
      } else if (event.key === "t") {
        event.preventDefault();
        go(now);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [go, now, step]);

  const title =
    scope === "month"
      ? formatMonthTitle(date)
      : scope === "week"
        ? formatWeekRange(date, weekStartsOn)
        : formatDayLong(date);
  // "Wednesday, August 5, 2026" alone is wider than a 320px header allows;
  // phones get "Wed, Aug 5" and the full form returns from `sm:` up.
  const shortTitle = scope === "day" ? formatDay(date, "EEE, MMM d") : title;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button variant="outline" size="icon-sm" onClick={() => step(-1)} aria-label="Previous">
        <ChevronLeft />
      </Button>
      <div className="min-w-0 px-1 text-center text-sm font-medium sm:min-w-[190px]">
        <span className="sm:hidden">{shortTitle}</span>
        <span className="hidden sm:inline">{title}</span>
      </div>
      <Button variant="outline" size="icon-sm" onClick={() => step(1)} aria-label="Next">
        <ChevronRight />
      </Button>
      <Button
        variant={isToday(date, now) ? "secondary" : "outline"}
        size="sm"
        onClick={() => go(now)}
        disabled={isToday(date, now)}
      >
        Today
      </Button>
    </div>
  );
}

