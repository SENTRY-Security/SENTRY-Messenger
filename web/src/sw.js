// Service Worker — push notification only (no offline cache)
// Scope: / (root)

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('push', (e) => {
  let payload = {};
  if (e.data) {
    try { payload = e.data.json(); } catch {
      try { payload = { body: e.data.text() }; } catch { /* empty */ }
    }
  }

  const title = payload.title || 'SENTRY MESSENGER';
  const options = {
    body: payload.body || payload.message || 'You have a new message',
    icon: '/assets/images/logo.svg',
    badge: '/assets/images/logo.svg',
    tag: 'sentry-push',
    renotify: true,
    data: { url: '/pages/app.html' }
  };

  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();

  const url = e.notification.data?.url || '/pages/app.html';

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Focus existing window if available
      for (const client of clients) {
        if (client.url.includes('/pages/app.html') && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open new window
      return self.clients.openWindow(url);
    })
  );
});
