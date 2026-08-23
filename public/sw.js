// Minimal service worker for Web Push. Ceko only -- see push.ts for why
// Taruna never subscribes.

self.addEventListener("push", (event) => {
  let data = { title: "Ceko", body: "" };
  try {
    if (event.data) data = event.data.json();
  } catch {
    // Not JSON -- fall back to the default above rather than throwing.
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      data: { conversationId: data.conversationId },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const clientsList = await clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = clientsList.find((c) => "focus" in c);
      if (existing) return existing.focus();
      return clients.openWindow("/");
    })()
  );
});
