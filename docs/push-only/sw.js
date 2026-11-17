self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {}
  if (!payload || typeof payload !== "object") payload = {};
  let url = new URL("/", self.location.origin).href;
  try {
    if (typeof payload.url === "string") {
      const candidate = new URL(payload.url, self.location.origin);
      if (
        candidate.origin === self.location.origin &&
        ["https:", "http:"].includes(candidate.protocol)
      )
        url = candidate.href;
    }
  } catch {}
  event.waitUntil(
    self.registration.showNotification(
      typeof payload.title === "string" ? payload.title : "Notification",
      {
        body:
          typeof payload.body === "string"
            ? payload.body
            : "Open the application to view the update.",
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        lang: "en",
        dir: "ltr",
        tag: typeof payload.id === "string" ? payload.id : undefined,
        renotify: false,
        data: { url },
      }
    )
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  let url = new URL("/", self.location.origin).href;
  try {
    if (typeof event.notification.data?.url === "string") {
      const candidate = new URL(
        event.notification.data.url,
        self.location.origin
      );
      if (
        candidate.origin === self.location.origin &&
        ["https:", "http:"].includes(candidate.protocol)
      )
        url = candidate.href;
    }
  } catch {}
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windows) {
        if (client.url === url) return client.focus();
      }
      return self.clients.openWindow(url);
    })()
  );
});
