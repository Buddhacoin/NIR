// NIR Markets service worker: shows price alerts sent by the server (Web Push)
// and opens the coin's page when one is tapped. It caches nothing.

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
