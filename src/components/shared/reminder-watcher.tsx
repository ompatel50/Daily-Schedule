"use client";

import * as React from "react";
import { toast } from "sonner";

import { showSystemNotification } from "@/lib/client-notifications";
import { isDeliverable, type ReminderOccurrence } from "@/lib/logic/reminders";
import { deliverReminderAction, getReminderFeedAction } from "@/server/actions/reminders";

/**
 * In-app reminders at their exact minutes, while the app is open: poll the
 * schedule-aware feed, and when an occurrence's minute arrives, CLAIM it on
 * the delivery ledger first and only then show it — as a toast plus (with
 * permission) a system notification. Claim-first is what makes every channel
 * exactly-once together: if the push runner or another tab already delivered
 * this occurrence, the claim collides and this tab stays silent.
 *
 * The system notification goes through the service worker registration when
 * one exists (`registration.showNotification` — the only path an installed
 * PWA supports; `new Notification` throws there) and falls back to the bare
 * constructor in plain tabs. No platform currently allows a web app to
 * schedule a notification for later with nothing running, so this is honest:
 * precise minutes need the app open (or the push path); the settings copy
 * says exactly that.
 *
 * All schedule awareness lives server-side in the feed: this component fires
 * whatever it is given and re-fetches every few minutes so a habit ticked in
 * another tab stops nagging without a reload.
 */

const FEED_REFRESH_MS = 5 * 60 * 1000;

/** Show the system notification via the one shared, PWA-correct helper. */
async function showOccurrenceNotification(occurrence: ReminderOccurrence): Promise<void> {
  await showSystemNotification(occurrence.title, {
    body: occurrence.message ?? undefined,
    // The occurrence key as the OS-level tag: even if two surfaces raced past
    // the ledger somehow, the platform collapses them into one notification.
    tag: occurrence.key,
    icon: "/icons/icon-192.png",
  });
}

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
        void (async () => {
          // Claim first, show second. `fresh: false` means the push runner or
          // another tab delivered this occurrence already — stay silent.
          try {
            const claimed = await deliverReminderAction({
              key: occurrence.key,
              reminderId: occurrence.reminderId,
            });
            if (!claimed.ok || !claimed.data.fresh) return;
          } catch {
            // Offline: the ledger is unreachable, but a silent missed
            // reminder is worse than a rare duplicate — deliver anyway. The
            // OS-level tag still collapses same-key duplicates.
          }
          toast(occurrence.title, {
            description: occurrence.message ?? undefined,
            duration: 10000,
          });
          void showOccurrenceNotification(occurrence);
        })();
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
