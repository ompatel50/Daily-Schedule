/**
 * Personal OS service worker: Web Push display and click-through only.
 *
 * Deliberately no caching layer — this is a private, always-fresh app, and a
 * stale cached page showing yesterday's schedule would be worse than a
 * network round-trip. The worker exists so reminders can arrive while no tab
 * is open.
 */
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = { title: "Personal OS", body: undefined, url: "/today", tag: undefined };
  try {
    payload = { ...payload, ...event.data.json() };
  } catch {
    // An empty or non-JSON push still shows something rather than nothing.
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: payload.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/today";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
