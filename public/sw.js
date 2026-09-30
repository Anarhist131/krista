// Service Worker для Криста.Net
// Кэш обновляем при каждом релизе

const CACHE = 'krista-net-v4.42';
const RUNTIME = 'krista-runtime-v4.42';

const CORE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

// Установка: кэшируем базовые ассеты
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

// Активация: чистим старые кэши
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE && k !== RUNTIME)
            .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Fetch: сеть → кэш fallback
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);

  // API и WebSocket — всегда сеть, без кэша
  if (url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/ws') ||
      req.method !== 'GET') {
    return;
  }

  // HTML — сначала сеть (свежая версия), потом кэш
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(()=>{});
          return res;
        })
        .catch(() => caches.match(req).then(r => r || caches.match('/index.html')))
    );
    return;
  }

  // Остальное: кэш → сеть
  e.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(RUNTIME).then(c => c.put(req, copy)).catch(()=>{});
        }
        return res;
      }).catch(() => cached);
    })
  );
});

// Сообщения от клиента (для команды skipWaiting)
self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
