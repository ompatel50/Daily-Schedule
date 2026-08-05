/**
 * Personal OS service worker: Web Push display/click-through, plus a
 * deliberately narrow cache for immutable static assets.
 *
 * What is cached: `/_next/static/*` (content-hashed, immutable by
 * construction), the app icons and the manifest. Nothing else — never HTML,
 * never `/api/*`, never a server action, never anything authenticated. This
 * is a private app: serving one account's cached data to another, or a stale
 * page showing yesterday's schedule, would be worse than every network
 * round-trip this saves. Offline support is therefore honest: static chrome
 * may load, data requires a connection, and the app says so.
 *
 * Updates: bumping SW_VERSION (or any byte of this file) installs a new
 * worker that WAITS instead of taking over mid-session. The page shows a
 * "new version ready" notice and posts SKIP_WAITING when the user opts in —
 * see src/components/shared/pwa-register.tsx.
 */
const SW_VERSION = "personal-os-static-v1";

const STATIC_CACHE = SW_VERSION;

function isCacheableStatic(url) {
  if (url.origin !== self.location.origin) return false;
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/manifest.webmanifest"
  );
}

self.addEventListener("install", () => {
  // No skipWaiting: a new worker waits for the user's explicit reload so an
  // open session is never hot-swapped under them.
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== STATIC_CACHE).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (!isCacheableStatic(url)) return; // fall through to the network untouched

  // Cache-first: these files are content-hashed, so a hit can never be stale.
  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(STATIC_CACHE);
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })(),
  );
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
