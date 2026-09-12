// ============================================================
// КРИСТА.МЕССЕНДЖЕР v0.11 — SERVICE WORKER
// HTML — network-first (всегда свежий)
// Статика — cache-first
// API и WebSocket — не кэшируются
// ============================================================

const CACHE = 'krista-v0.14';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

// ---- INSTALL ----
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

// ---- ACTIVATE ----
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ---- FETCH ----
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Только GET
  if (req.method !== 'GET') return;

  // Только свой origin
  if (url.origin !== self.location.origin) return;

  // API — не трогаем, идут напрямую
  if (url.pathname.startsWith('/api/')) return;

  // WebSocket — не трогаем
  if (url.pathname.startsWith('/ws') || req.headers.get('upgrade') === 'websocket') return;

  // HTML навигация — network-first
  if (req.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')) {
    e.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(cache => cache.put(req, clone)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req).then(c => c || caches.match('/index.html')))
    );
    return;
  }

  // Статика — cache-first
  e.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(cache => cache.put(req, clone)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match('/index.html'));
    })
  );
});

// ---- MESSAGE ----
self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
  if (e.data === 'clearCache') {
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))));
  }
});

// ---- PUSH (на будущее) ----
self.addEventListener('push', (e) => {
  const data = e.data ? e.data.json() : { title: 'Криста', body: 'Новое сообщение' };
  e.waitUntil(
    self.registration.showNotification(data.title || 'Криста', {
      body: data.body || 'Новое сообщение',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.chatId || 'krista',
      data: { url: data.url || '/', chatId: data.chatId || null }
    })
  );
});

// ---- NOTIFICATION CLICK ----
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        for (const c of clients) {
          if (c.url === url && 'focus' in c) return c.focus();
        }
        if (self.clients.openWindow) return self.clients.openWindow(url);
      })
  );
});

console.log('[SW] Криста v0.11 готов');
