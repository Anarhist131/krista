// ============================================================
// КРИСТА.МЕССЕНДЖЕР — SERVICE WORKER (SW)
// ============================================================

const CACHE_NAME = 'krista-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

// Установка SW — кэшируем основные файлы
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Активация — очищаем старые кэши
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      );
    })
    .then(() => self.clients.claim())
  );
});

// Перехват запросов — отдаём из кэша или сети
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request)
      .then(cached => {
        // Если есть в кэше — возвращаем, иначе идём в сеть
        return cached || fetch(event.request).then(response => {
          // Кэшируем успешные ответы для будущего использования
          if (response.status === 200) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, responseClone);
            });
          }
          return response;
        });
      })
      .catch(() => {
        // Если нет сети и нет кэша — заглушка
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
      })
  );
});

// ===== PUSH-УВЕДОМЛЕНИЯ =====

// Подписка на push
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : { title: 'Новое сообщение', body: 'Сообщение от Криста' };
  
  const options = {
    body: data.body || 'У вас новое сообщение',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [200, 100, 200],
    data: {
      url: data.url || '/',
      chatId: data.chatId || null
    },
    actions: [
      { action: 'open', title: 'Открыть' },
      { action: 'dismiss', title: 'Закрыть' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'Криста.Мессенджер', options)
  );
});

// Обработка клика по уведомлению
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const urlToOpen = event.notification.data?.url || '/';
  const chatId = event.notification.data?.chatId;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(windowClients => {
        // Если уже есть открытое окно — переключаемся на него
        for (const client of windowClients) {
          if (client.url === urlToOpen && 'focus' in client) {
            return client.focus();
          }
        }
        // Иначе открываем новое
        return clients.openWindow(urlToOpen);
      })
      .then(client => {
        // Если есть chatId, можно передать его через postMessage
        if (client && chatId) {
          client.postMessage({ type: 'openChat', chatId });
        }
      })
  );
});
