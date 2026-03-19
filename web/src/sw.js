// Service Worker — push notification only (no offline cache)
// Scope: / (root)

// ─── Push notification type taxonomy ───────────────────────────────────────
//
//  message-new / secure-message
//    私人訊息 — 與聯絡人之間的 1:1 對話，可傳送文字、圖片、影片及檔案。
//
//  biz-conv-message
//    群組訊息 — 多人群組中的對話訊息，可傳送文字、圖片、影片及檔案。
//
//  ephemeral-message
//    臨時訊息 — 限時自動銷毀的臨時對話，可傳送文字及圖片（圖片限 5 MB）。
//
//  call-invite
//    來電通知 — 來自私人對話或臨時對話的語音／視訊通話邀請（群組目前不支援通話）。
//
//  notify
//    系統通知 — 好友邀請、群組成員異動（加入／移除／解散）、已讀回條、
//    送達回條、加密會話建立、對話刪除等系統自動產生的通知。
//
// ───────────────────────────────────────────────────────────────────────────

// i18n: push notification translations keyed by locale, then by message type
const PUSH_I18N = {
  en: {
    title: 'SENTRY MESSENGER',
    body: {
      'message-new':       'You have a new message',
      'secure-message':    'You have a new message',
      'biz-conv-message':  'You have a new group message',
      'ephemeral-message': 'You have a new ephemeral message',
      'call-invite':       'You have an incoming call',
      'notify':            'You have a system notification',
      _default:            'You have a new message'
    }
  },
  'zh-Hant': {
    title: 'SENTRY MESSENGER',
    body: {
      'message-new':       '你有一則新訊息',
      'secure-message':    '你有一則新訊息',
      'biz-conv-message':  '你有一則新群組訊息',
      'ephemeral-message': '你有一則新臨時訊息',
      'call-invite':       '你有一通來電',
      'notify':            '你有一則系統通知',
      _default:            '你有一則新訊息'
    }
  },
  'zh-Hans': {
    title: 'SENTRY MESSENGER',
    body: {
      'message-new':       '你有一条新消息',
      'secure-message':    '你有一条新消息',
      'biz-conv-message':  '你有一条新群组消息',
      'ephemeral-message': '你有一条新临时消息',
      'call-invite':       '你有一通来电',
      'notify':            '你有一条系统通知',
      _default:            '你有一条新消息'
    }
  },
  ja: {
    title: 'SENTRY MESSENGER',
    body: {
      'message-new':       '新しいメッセージがあります',
      'secure-message':    '新しいメッセージがあります',
      'biz-conv-message':  '新しいグループメッセージがあります',
      'ephemeral-message': '新しい一時メッセージがあります',
      'call-invite':       '着信があります',
      'notify':            'システム通知があります',
      _default:            '新しいメッセージがあります'
    }
  },
  ko: {
    title: 'SENTRY MESSENGER',
    body: {
      'message-new':       '새 메시지가 있습니다',
      'secure-message':    '새 메시지가 있습니다',
      'biz-conv-message':  '새 그룹 메시지가 있습니다',
      'ephemeral-message': '새 임시 메시지가 있습니다',
      'call-invite':       '수신 전화가 있습니다',
      'notify':            '시스템 알림이 있습니다',
      _default:            '새 메시지가 있습니다'
    }
  },
  th: {
    title: 'SENTRY MESSENGER',
    body: {
      'message-new':       'คุณมีข้อความใหม่',
      'secure-message':    'คุณมีข้อความใหม่',
      'biz-conv-message':  'คุณมีข้อความกลุ่มใหม่',
      'ephemeral-message': 'คุณมีข้อความชั่วคราวใหม่',
      'call-invite':       'คุณมีสายเรียกเข้า',
      'notify':            'คุณมีการแจ้งเตือนระบบ',
      _default:            'คุณมีข้อความใหม่'
    }
  },
  vi: {
    title: 'SENTRY MESSENGER',
    body: {
      'message-new':       'Bạn có tin nhắn mới',
      'secure-message':    'Bạn có tin nhắn mới',
      'biz-conv-message':  'Bạn có tin nhắn nhóm mới',
      'ephemeral-message': 'Bạn có tin nhắn tạm thời mới',
      'call-invite':       'Bạn có cuộc gọi đến',
      'notify':            'Bạn có thông báo hệ thống',
      _default:            'Bạn có tin nhắn mới'
    }
  }
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
  'message-new':        '/assets/images/push/message.png',      // 私人訊息
  'secure-message':     '/assets/images/push/message.png',      // 私人訊息（加密）
  'biz-conv-message':   '/assets/images/push/group-chat.png',   // 群組訊息
  'ephemeral-message':  '/assets/images/push/ephemeral.png',    // 臨時訊息（文字＋圖片）
  'call-invite':        '/assets/images/push/incoming-call.png', // 來電（語音／視訊）
  'notify':             '/assets/images/push/system.png'        // 系統通知
};

// ─── E2E push preview decryption (ECDH P-256 + HKDF + AES-256-GCM) ──

const HKDF_INFO = new TextEncoder().encode('sentry-push-preview-v1');

function b64uDecode(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - base64.length % 4) % 4);
  const raw = atob(base64 + padding);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf;
}

function getPreviewPrivateKey() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('sentry-push-prefs', 1);
      req.onupgradeneeded = (ev) => {
        const db = ev.target.result;
        if (!db.objectStoreNames.contains('prefs')) db.createObjectStore('prefs');
      };
      req.onsuccess = (ev) => {
        try {
          const db = ev.target.result;
          const tx = db.transaction('prefs', 'readonly');
          const get = tx.objectStore('prefs').get('preview-private-key');
          get.onsuccess = () => resolve(get.result || null);
          get.onerror = () => resolve(null);
        } catch { resolve(null); }
      };
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function decryptPreview(privateKeyB64, blobB64) {
  const privBytes = b64uDecode(privateKeyB64);
  const blob = b64uDecode(blobB64);

  const ephPubRaw = blob.slice(0, 65);
  const iv = blob.slice(65, 77);
  const ciphertext = blob.slice(77);

  const privateKey = await crypto.subtle.importKey(
    'pkcs8', privBytes,
    { name: 'ECDH', namedCurve: 'P-256' },
    false, ['deriveBits']
  );
  const ephPub = await crypto.subtle.importKey(
    'raw', ephPubRaw,
    { name: 'ECDH', namedCurve: 'P-256' },
    false, []
  );

  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: ephPub },
    privateKey, 256
  );

  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  const aesKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: HKDF_INFO },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false, ['decrypt']
  );

  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext);
  return new TextDecoder().decode(plainBuf);
}

// ─── Preview preference (in-memory + IndexedDB) ─────────────────
// In-memory cache — updated instantly via postMessage from PWA page
let _previewPref = null; // null = not yet loaded

// Listen for preference updates from PWA page (instant, no IDB delay)
self.addEventListener('message', (ev) => {
  if (ev.data && ev.data.type === 'set-preview-pref') {
    _previewPref = !!ev.data.value;
  }
});

// Read preview preference: use in-memory cache if available, else fall back to IndexedDB
function getPreviewPref() {
  if (_previewPref !== null) return Promise.resolve(_previewPref);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('sentry-push-prefs', 1);
      req.onupgradeneeded = (ev) => {
        const db = ev.target.result;
        if (!db.objectStoreNames.contains('prefs')) db.createObjectStore('prefs');
      };
      req.onsuccess = (ev) => {
        try {
          const db = ev.target.result;
          const tx = db.transaction('prefs', 'readonly');
          const get = tx.objectStore('prefs').get('preview');
          get.onsuccess = () => {
            _previewPref = !!get.result;
            resolve(_previewPref);
          };
          get.onerror = () => resolve(false);
        } catch { resolve(false); }
      };
      req.onerror = () => resolve(false);
    } catch { resolve(false); }
  });
}

self.addEventListener('push', (e) => {
  let payload = {};
  if (e.data) {
    try { payload = e.data.json(); } catch {
      try { payload = { body: e.data.text() }; } catch { /* empty */ }
    }
  }

  const locale = resolvePushLocale();
  const i18n = PUSH_I18N[locale] || PUSH_I18N.en;
  const bodyMap = i18n.body || PUSH_I18N.en.body;

  const icon = (payload.type && PUSH_TYPE_ICONS[payload.type]) || '/assets/images/push/message.png';
  const title = payload.title || i18n.title;
  const localizedBody = (payload.type && bodyMap[payload.type]) || bodyMap._default;

  // Preview logic:
  //   OFF → always show generic localized body (no content leak)
  //   ON  → decrypt encrypted_preview if available, else show generic text
  const notifyPromise = getPreviewPref().then(async (previewOn) => {
    let body = localizedBody;

    if (previewOn && payload.encrypted_preview) {
      // E2E decrypt: server never sees the plaintext
      try {
        const privKey = await getPreviewPrivateKey();
        if (privKey) {
          body = await decryptPreview(privKey, payload.encrypted_preview);
        }
      } catch (err) {
        console.warn('[sw] preview decrypt failed', err);
        // Fall back to generic text on decrypt failure
      }
    }
    // Preview disabled or no encrypted_preview → generic localized text

    return self.registration.showNotification(title, {
      body: body,
      icon: icon,
      badge: '/assets/images/logo.svg',
      tag: 'sentry-push',
      renotify: true,
      data: { url: '/pages/app.html' }
    });
  });

  e.waitUntil(notifyPromise);
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
