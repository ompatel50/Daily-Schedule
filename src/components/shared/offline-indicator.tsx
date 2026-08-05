"use client";

import * as React from "react";
import { WifiOff } from "lucide-react";
import { toast } from "sonner";

/**
 * Connection awareness for the whole shell: a slim, persistent bar while the
 * browser reports itself offline (screen-reader announced via role="status"),
 * and a one-off toast when the connection returns. Nothing here blocks the
 * UI — pages stay readable; actions that need the network fail with their own
 * error handling and can be retried once this bar disappears.
 */
export function OfflineIndicator() {
  // Start "online" so SSR and the first client render agree; the effect
  // corrects it immediately if the browser is actually offline.
  const [online, setOnline] = React.useState(true);
  const wasOffline = React.useRef(false);

  React.useEffect(() => {
    const sync = () => {
      const next = navigator.onLine;
      setOnline(next);
      if (next && wasOffline.current) {
        toast.success("Back online", { description: "It's safe to retry anything that failed." });
      }
      wasOffline.current = !next;
    };
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  if (online) return null;

  return (
    <div
      role="status"
      className="sticky top-0 z-40 flex items-center justify-center gap-2 border-b border-amber-500/30 bg-amber-500/15 px-3 py-1.5 text-xs font-medium text-amber-900 dark:text-amber-300"
    >
      <WifiOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>Offline — you can keep reading, but changes need a connection. Typed text is kept.</span>
    </div>
  );
}
