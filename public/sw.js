// Service worker của app LOCI trên điện thoại.
// Chỉ lưu tạm file tĩnh (JS/CSS/biểu tượng) để mở nhanh; trang và số liệu luôn lấy mới từ máy chủ,
// không lưu dữ liệu tài chính trên máy. Mất mạng thì hiện trang offline.html.
const CACHE = "loci-v2";
const OFFLINE = "/offline.html";
const PRECACHE = [OFFLINE, "/icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match(OFFLINE)));
    return;
  }

  // File trong /_next/static có mã băm trong tên nên lưu lâu dài an toàn.
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    e.respondWith(
      caches.match(req).then((hit) =>
        hit || fetch(req).then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
          return res;
        }),
      ),
    );
  }
});

// Thông báo đẩy (cảnh báo dọn phòng, sự cố được giao). Nội dung do máy chủ gửi: { title, body, url, tag, urgent }.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: "baocaodau", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "baocaodau", {
    body: d.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: d.tag,
    renotify: !!d.tag,
    requireInteraction: !!d.urgent, // cảnh báo dọn ngay nằm lại trên màn hình tới khi bấm
    vibrate: d.urgent ? [300, 120, 300, 120, 300] : [200],
    data: { url: d.url || "/don-dep" },
  }));
});

// Bấm thông báo: mở đúng trang (dùng lại cửa sổ app đang mở nếu có).
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "/don-dep", self.location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.startsWith(self.location.origin) && "focus" in c) return c.navigate(url).then((w) => (w || c).focus());
      }
      return self.clients.openWindow(url);
    }),
  );
});
