"use client";

import * as React from "react";

/**
 * Registers the service worker on load (when the browser supports it), so
 * push subscriptions created earlier keep a live worker for display and
 * click-through. Registration is idempotent and silent — enabling push is
 * still an explicit choice in Settings.
 */
export function PwaRegister() {
  React.useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // An old browser or a blocked worker never breaks the app.
    });
  }, []);
  return null;
}
