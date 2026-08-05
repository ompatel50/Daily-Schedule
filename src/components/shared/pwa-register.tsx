"use client";

import * as React from "react";
import { toast } from "sonner";

/**
 * Registers the service worker and owns the update handshake.
 *
 * The worker deliberately does not `skipWaiting` on install (see
 * public/sw.js): when a new version is waiting, this component shows one
 * quiet toast with a Reload action. Choosing it tells the waiting worker to
 * take over and reloads once the controller changes; ignoring it costs
 * nothing — the update simply applies on the next natural full load.
 */
export function PwaRegister() {
  React.useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    let reloading = false;
    const onControllerChange = () => {
      // Only reload when WE asked the waiting worker to take over —
      // a first-time registration also fires this event.
      if (!reloading) return;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    const promptUpdate = (registration: ServiceWorkerRegistration) => {
      const waiting = registration.waiting;
      // No controller means first install, not an update — nothing to announce.
      if (!waiting || !navigator.serviceWorker.controller) return;
      toast.info("A new version of Personal OS is ready", {
        id: "pwa-update",
        duration: Infinity,
        action: {
          label: "Reload",
          onClick: () => {
            reloading = true;
            waiting.postMessage("SKIP_WAITING");
          },
        },
      });
    };

    navigator.serviceWorker
      .register("/sw.js", { updateViaCache: "none" })
      .then((registration) => {
        promptUpdate(registration);
        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (installing.state === "installed") promptUpdate(registration);
          });
        });
      })
      .catch(() => {
        // An old browser or a blocked worker never breaks the app.
      });

    return () => navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
  }, []);
  return null;
}
