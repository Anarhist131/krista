// КРИСТА.ФРИНЕТ · Service Worker v3.35
// Требования PWABuilder: cache handlers, версионирование, install/activate/fetch

const CACHE_VERSION = 'krista-v3.35';
const CACHE_STATIC = `${CACHE_VERSION}-static`;
const CACHE_DYNAMIC = `${CACHE_VERSION}-dynamic`;

// Файлы для предкэширования при установке
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/music.js'
];

// ============================================================
//  INSTALL — предкэширование статики
// ============================================================
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_STATIC)
      .then((cache) => cache.addAll(PRECACHE_ASSETS).catch((err) => {
        console.warn('[SW] Precache partial fail:', err);
      }))
      .then(() => self.skipWaiting())
  );
});

// ============================================================
//  ACTIVATE — очистка старых кэшей
// ============================================================
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== CACHE_STATIC && key !== CACHE_DYNAMIC)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// ============================================================
//  FETCH — стратегии кэширования
// ============================================================
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // API — всегда сеть, без кэша
  if (url.pathname.startsWith('/api/')) return;

  // Только GET
  if (request.method !== 'GET') return;

  // Внешние ресурсы (Google Fonts и т.п.) — stale-while-revalidate
  if (url.origin !== self.location.origin) {
    event.respondWith(
      caches.open(CACHE_DYNAMIC).then((cache) =>
        cache.match(request).then((cached) => {
          const fetched = fetch(request).then((response) => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          }).catch(() => cached);
          return cached || fetched;
        })
      )
    );
    return;
  }

  // Навигация — network-first, fallback на кэш
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_STATIC).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Остальное — cache-first, fallback на сеть
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_DYNAMIC).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});

// ============================================================
//  MESSAGE — принудительное обновление
// ============================================================
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
