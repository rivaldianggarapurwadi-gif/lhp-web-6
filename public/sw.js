// Service worker for Web Push. Ceko only -- see push.ts for why Taruna
// never subscribes.

self.addEventListener("push", (event) => {
  let data = { title: "Materi", body: "" };
  try {
    if (event.data) data = event.data.json();
  } catch {
    // Not JSON -- fall back to the default above rather than throwing.
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: data.conversationId || "ceko-notification", // replaces a still-visible notification from the same conversation instead of stacking a duplicate
      renotify: true,
      vibrate: [200, 100, 200],
      data: { conversationId: data.conversationId },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const conversationId = event.notification.data?.conversationId;
  const targetUrl = conversationId ? `/?conv=${encodeURIComponent(conversationId)}` : "/";

  event.waitUntil(
    (async () => {
      const clientsList = await clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = clientsList.find((c) => new URL(c.url).origin === self.location.origin);
      if (existing) {
        // Already open -- tell the running page which conversation to
        // switch to instead of navigating it (a full reload would lose
        // its socket connection and in-memory state for no reason).
        existing.postMessage({ type: "open-conversation", conversationId });
        return existing.focus();
      }
      return clients.openWindow(targetUrl);
    })()
  );
});
