const CACHE_NAME = 'krista-v1';
const ASSETS = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
        .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
            if (response.status === 200) {
                const responseClone = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
            }
            return response;
        }).catch(() => caches.match('/index.html')))
    );
});

self.addEventListener('push', (event) => {
    const data = event.data ? event.data.json() : { title: 'Новое сообщение', body: 'Сообщение от Криста' };
    const options = {
        body: data.body || 'У вас новое сообщение',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        vibrate: [200, 100, 200],
        data: { url: data.url || '/', chatId: data.chatId || null },
        actions: [{ action: 'open', title: 'Открыть' }, { action: 'dismiss', title: 'Закрыть' }]
    };
    event.waitUntil(self.registration.showNotification(data.title || 'Криста.Мессенджер', options));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const urlToOpen = event.notification.data?.url || '/';
    const chatId = event.notification.data?.chatId;
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
            for (const client of windowClients) {
                if (client.url === urlToOpen && 'focus' in client) return client.focus();
            }
            return clients.openWindow(urlToOpen);
        }).then(client => {
            if (client && chatId) client.postMessage({ type: 'openChat', chatId });
        })
    );
});
