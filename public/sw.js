const CACHE_NAME = "soluna-v3";
const PRECACHE = ["/app", "/api/menu", "/icon-192.svg", "/icon-512.svg"];

// Install: cache halaman utama
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

// Activate: hapus cache lama
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network first, fallback cache
self.addEventListener("fetch", (event) => {
  // Skip non-GET dan socket.io
  if (event.request.method !== "GET" || event.request.url.includes("socket.io")) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

// Push notification
self.addEventListener("push", (event) => {
  let data = { title: "Cafe Soluna", body: "Ada notifikasi baru!" };
  try { data = event.data.json(); } catch (e) {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon-192.svg",
      badge: "/icon-192.svg",
      tag: data.tag || "warkop-notif",
      requireInteraction: true,
      vibrate: [200, 100, 200, 100, 200],
      actions: [{ action: "open", title: "Buka" }],
      data: { url: data.url || "/app" },
    })
  );
});

// Klik notifikasi
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/app";
  event.waitUntil(
    clients.matchAll({ type: "window" }).then((list) => {
      for (const c of list) {
        if ((c.url.includes("/app") || c.url.includes("/pesan")) && "focus" in c) return c.focus();
      }
      return clients.openWindow(url);
    })
  );
});
