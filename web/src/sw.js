// Service Worker — push notification only (no offline cache)
// Scope: / (root)

// i18n: push notification translations keyed by locale
const PUSH_I18N = {
  en:      { title: 'SENTRY MESSENGER', body: 'You have a new message' },
  'zh-Hant': { title: 'SENTRY MESSENGER', body: '你有一則新訊息' },
  'zh-Hans': { title: 'SENTRY MESSENGER', body: '你有一条新消息' },
  ja:      { title: 'SENTRY MESSENGER', body: '新しいメッセージがあります' },
  ko:      { title: 'SENTRY MESSENGER', body: '새 메시지가 있습니다' },
  th:      { title: 'SENTRY MESSENGER', body: 'คุณมีข้อความใหม่' },
  vi:      { title: 'SENTRY MESSENGER', body: 'Bạn có tin nhắn mới' }
};

function resolvePushLocale() {
  const lang = (self.navigator?.language || 'en').toLowerCase();
  // Traditional Chinese
  if (lang === 'zh-tw' || lang === 'zh-hk' || lang === 'zh-mo' || lang.startsWith('zh-hant')) return 'zh-Hant';
  // Simplified Chinese
  if (lang === 'zh-cn' || lang === 'zh-sg' || lang.startsWith('zh-hans') || lang === 'zh') return 'zh-Hans';
  const base = lang.split('-')[0];
  return PUSH_I18N[base] ? base : 'en';
}

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

// Map server payload.type to notification icon
const PUSH_TYPE_ICONS = {
  'message-new':        '/assets/images/push/message.png',
  'secure-message':     '/assets/images/push/message.png',
  'biz-conv-message':   '/assets/images/push/group-chat.png',
  'ephemeral-message':  '/assets/images/push/ephemeral.png',
  'call-invite':        '/assets/images/push/incoming-call.png',
  'notify':             '/assets/images/push/system.png'
};

self.addEventListener('push', (e) => {
  let payload = {};
  if (e.data) {
    try { payload = e.data.json(); } catch {
      try { payload = { body: e.data.text() }; } catch { /* empty */ }
    }
  }

  const locale = resolvePushLocale();
  const i18n = PUSH_I18N[locale] || PUSH_I18N.en;

  const icon = (payload.type && PUSH_TYPE_ICONS[payload.type]) || '/assets/images/push/message.png';
  const title = payload.title || i18n.title;
  const options = {
    body: payload.body || payload.message || i18n.body,
    icon: icon,
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
