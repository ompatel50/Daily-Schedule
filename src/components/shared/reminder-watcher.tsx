"use client";

import * as React from "react";
import { toast } from "sonner";

import { isDeliverable, type ReminderOccurrence } from "@/lib/logic/reminders";
import { deliverReminderAction, getReminderFeedAction } from "@/server/actions/reminders";

/**
 * Desktop-web reminders, kept deliberately modest: while a tab is open we poll
 * once a minute and fire a toast plus (if the user has granted permission) a
 * Notification. There is no service worker and no background delivery — a
 * local-first app with no server can't promise that, and pretending otherwise
 * would be worse than being upfront. The toast IS the fallback when browser
 * notifications are unavailable or denied.
 *
 * All schedule awareness lives server-side in the feed: this component fires
 * whatever it is given, records the delivery (exactly-once via the occurrence
 * key), and re-fetches every few minutes so a habit ticked in another tab
 * stops nagging without a reload.
 */

const FEED_REFRESH_MS = 5 * 60 * 1000;

export function ReminderWatcher({ initial }: { initial?: ReminderOccurrence[] }) {
  const [feed, setFeed] = React.useState<ReminderOccurrence[]>(initial ?? []);
  const firedRef = React.useRef<Set<string>>(new Set());

  React.useEffect(() => {
    if (initial) setFeed(initial);
  }, [initial]);

  // The feed loads after mount (it is deliberately NOT awaited by the app
  // shell — reminders must never delay a navigation render), then refreshes
  // periodically and when the tab regains focus, so state changes made
  // elsewhere (another tab, another device) are honoured without a reload.
  React.useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const result = await getReminderFeedAction();
        if (!cancelled && result.ok) setFeed(result.data);
      } catch {
        // Offline or server restarting — keep the last feed and try later.
      }
    }
    void refresh();
    const interval = setInterval(refresh, FEED_REFRESH_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  React.useEffect(() => {
    if (feed.length === 0) return;

    function check() {
      const now = Date.now();
      for (const occurrence of feed) {
        const due = new Date(occurrence.fireAt).getTime();
        if (Number.isNaN(due) || !isDeliverable(due, now)) continue;
        if (firedRef.current.has(occurrence.key)) continue;

        firedRef.current.add(occurrence.key);
        toast(occurrence.title, {
          description: occurrence.message ?? undefined,
          duration: 10000,
        });

        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          new Notification(occurrence.title, { body: occurrence.message ?? undefined });
        }

        void deliverReminderAction({ key: occurrence.key, reminderId: occurrence.reminderId });
      }
    }

    // The first check waits a beat: firing during hydration can race the
    // Toaster's mount and silently swallow the toast half of the delivery.
    const first = setTimeout(check, 1500);
    const interval = setInterval(check, 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(interval);
    };
  }, [feed]);

  return null;
}
