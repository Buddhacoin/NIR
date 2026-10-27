// NIR Markets service worker: shows price alerts sent by the server (Web Push) and opens the coin's page
// when one is tapped; and makes moving between the pages instant, as in an app. The site's files with a
// version in their address (scripts, styles: /common.js?v=31) never change, so a kept copy is used as it
// is; a page itself is asked of the server first, and its kept copy stands in when the answer is slow
// (over a second) or the network is down. The pages behind the bottom menu are fetched ahead, when the
// browser is idle (common.js asks), so the first tap on them is instant too. Data (/market/*) is never
// touched here.

self.addEventListener("push", (event) => {
  let message = {};
  try { message = event.data?.json() ?? {}; } catch {}
  event.waitUntil(self.registration.showNotification(message.title || "NIR Markets", {
    body: message.body || "", icon: "/icon-192.png", badge: "/icon-192.png", tag: message.url || "nir-alert",
    data: { url: typeof message.url === "string" && message.url.startsWith("/") ? message.url : "/alerts/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/alerts/", self.location.origin).href;
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const same = open.find((client) => client.url === url);
    if (same) return same.focus();
    return self.clients.openWindow(url);
  })());
});

const FILES = "nir-files-v1";
const PAGES = "nir-pages-v1";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const versioned = (url) => url.searchParams.has("v") && /\.(js|css)$/.test(url.pathname);
const isPage = (request, url) => request.mode === "navigate" && !url.pathname.startsWith("/market/") && !url.pathname.startsWith("/api/");
async function fileFirst(request) {
  const cache = await caches.open(FILES);
  const kept = await cache.match(request);
  if (kept) return kept;
  const answer = await fetch(request);
  if (answer.ok) void cache.put(request, answer.clone());
  return answer;
}
async function pageFirst(request) {
  const cache = await caches.open(PAGES);
  const live = fetch(request).then((answer) => {
    if (answer.ok && answer.type === "basic") void cache.put(request, answer.clone());
    return answer;
  });
  const kept = await cache.match(request, { ignoreSearch: false });
  if (!kept) return live;
  // The server's page when it answers within a second; the kept one otherwise (it is refreshed behind).
  const slow = new Promise((resolve) => { setTimeout(() => resolve(null), 1_000); });
  const first = await Promise.race([live.catch(() => null), slow]);
  return first ?? kept;
}
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (versioned(url)) { event.respondWith(fileFirst(request).catch(() => fetch(request))); return; }
  if (isPage(request, url)) event.respondWith(pageFirst(request).catch(() => fetch(request)));
});
// The pages behind the bottom menu, fetched ahead: { warm: ["/", "/portfolio/", …] }.
self.addEventListener("message", (event) => {
  const pages = Array.isArray(event.data?.warm) ? event.data.warm.filter((path) => typeof path === "string" && path.startsWith("/") && !path.startsWith("/market/")).slice(0, 8) : [];
  if (!pages.length) return;
  event.waitUntil((async () => {
    const cache = await caches.open(PAGES);
    for (const path of pages) {
      try {
        const answer = await fetch(path, { credentials: "same-origin" });
        if (answer.ok) await cache.put(new Request(new URL(path, self.location.origin).href), answer);
      } catch {}
    }
  })());
});
