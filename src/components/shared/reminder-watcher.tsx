"use client";

import * as React from "react";
import { toast } from "sonner";

import { markReminderFired } from "@/server/actions/health";

export interface WatchedReminder {
  id: string;
  title: string;
  message: string | null;
  remindAt: string;
}

/**
 * Desktop-web reminders, kept deliberately modest: while a tab is open we poll
 * once a minute and fire a toast plus (if the user has granted permission) a
 * Notification. There is no service worker and no background delivery — a
 * local-first app with no server can't promise that, and pretending otherwise
 * would be worse than being upfront.
 */
export function ReminderWatcher({ reminders }: { reminders: WatchedReminder[] }) {
  const firedRef = React.useRef<Set<string>>(new Set());

  React.useEffect(() => {
    if (reminders.length === 0) return;

    function check() {
      const now = Date.now();
      for (const reminder of reminders) {
        const due = new Date(reminder.remindAt).getTime();
        if (Number.isNaN(due) || due > now) continue;
        // Don't resurface reminders that are more than an hour stale.
        if (now - due > 60 * 60 * 1000) continue;
        if (firedRef.current.has(reminder.id)) continue;

        firedRef.current.add(reminder.id);
        toast(reminder.title, { description: reminder.message ?? undefined, duration: 10000 });

        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          new Notification(reminder.title, { body: reminder.message ?? undefined });
        }

        void markReminderFired(reminder.id);
      }
    }

    check();
    const interval = setInterval(check, 60_000);
    return () => clearInterval(interval);
  }, [reminders]);

  return null;
}
