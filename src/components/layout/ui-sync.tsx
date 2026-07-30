"use client";

import * as React from "react";

import type { DayKey } from "@/lib/date";
import { useUIStore } from "@/store/ui-store";

/**
 * Pushes the server-resolved "today" (the user's timezone, not the host's)
 * into the client UI store on every shell render, so quick add, new-habit
 * defaults and session starts all agree with the pages around them.
 */
export function UISync({ todayKey }: { todayKey: DayKey }) {
  const syncTodayKey = useUIStore((state) => state.syncTodayKey);
  React.useEffect(() => {
    syncTodayKey(todayKey);
  }, [todayKey, syncTodayKey]);
  return null;
}
