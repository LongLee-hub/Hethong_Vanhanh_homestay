// Service worker của app LOCI trên điện thoại.
// Chỉ lưu tạm file tĩnh (JS/CSS/biểu tượng) để mở nhanh; trang và số liệu luôn lấy mới từ máy chủ,
// không lưu dữ liệu tài chính trên máy. Mất mạng thì hiện trang offline.html.
const CACHE = "loci-v1";
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
