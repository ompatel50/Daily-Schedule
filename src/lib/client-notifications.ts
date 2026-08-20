"use client";

/**
 * The one way client code raises a system notification.
 *
 * Order matters: an installed PWA only supports
 * `registration.showNotification` — `new Notification` THROWS there — while a
 * plain tab may have no service-worker registration yet, so the bare
 * constructor is the fallback. Both consumers (the reminder watcher and the
 * workout rest timer) go through here so the platform quirk is handled once.
 *
 * No-ops without permission; never throws — a notification that cannot show
 * must not break the surface that asked for it (a toast already carries the
 * message in both call sites).
 */
export async function showSystemNotification(
  title: string,
  options: NotificationOptions = {},
): Promise<void> {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const registration =
      "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    if (registration) {
      await registration.showNotification(title, options);
      return;
    }
  } catch {
    // Fall through to the constructor.
  }
  try {
    new Notification(title, options);
  } catch {
    // Installed PWA without a usable registration: the caller's toast showed.
  }
}
