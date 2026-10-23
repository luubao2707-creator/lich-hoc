// Service worker: cache toàn bộ file tĩnh để chạy offline.
// Mỗi lần sửa file tĩnh, tăng VERSION để máy người dùng tải bản mới.
const VERSION = 'v4';
const CACHE = `lichhoc-${VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/app.js',
  './js/db.js',
  './js/time.js',
  './js/schedule.js',
  './js/sample.js',
  './js/notify.js',
  './js/backup.js',
  './js/ics.js',
  './js/gcal-import.js',
  './js/ui/dom.js',
  './js/ui/today.js',
  './js/ui/courses.js',
  './js/ui/deadlines.js',
  './js/ui/settings.js',
  './js/ui/course-form.js',
  './js/ui/deadline-form.js',
  './js/ui/event-form.js',
  './js/ui/week.js',
  './js/ui/gcal-sheet.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Stale-while-revalidate: trả bản trong cache ngay (chạy offline, mở nhanh),
// đồng thời tải bản mới ở nền để lần mở sau dùng. Điều hướng trang luôn dùng index.html.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const key = req.mode === 'navigate' ? './index.html' : req;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(key, { ignoreSearch: true });
      const fresh = fetch(req.mode === 'navigate' ? './index.html' : req)
        .then((res) => {
          if (res.ok) cache.put(key, res.clone());
          return res;
        })
        .catch(() => hit || Response.error());
      if (hit) {
        event.waitUntil(fresh.catch(() => {}));
        return hit;
      }
      return fresh;
    })
  );
});

// Chạm vào thông báo: mở lại cửa sổ app đang có, hoặc mở mới ở màn "Hôm nay".
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './#today', self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
