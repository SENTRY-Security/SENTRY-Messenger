// Push notification subscription management
// Handles subscribe/unsubscribe and communicates with the backend.

import { getAccountDigest, ensureDeviceId } from '../core/store.js';

// VAPID public key — must match the server's VAPID_PUBLIC_KEY.
// This is a URL-safe base64 encoded P-256 public key.
// Replace with the actual key after generating VAPID keys.
const VAPID_PUBLIC_KEY = 'BGNlllC_H-lqHnnKrxT2IhF_5_xei3is_loJHesBmzjhfgmGMwq_nwlVVaKkrOhTnCO9_DeFtlotIl3Oug3eI2k';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function parseUA(ua) {
  if (!ua) return 'Unknown';
  if (/iPhone|iPad/.test(ua)) {
    if (/CriOS/.test(ua)) return 'iPhone Chrome';
    return 'iPhone Safari';
  }
  if (/Android/.test(ua)) {
    if (/Firefox/.test(ua)) return 'Android Firefox';
    return 'Android Chrome';
  }
  if (/Macintosh/.test(ua)) {
    if (/Chrome/.test(ua) && !/Edg/.test(ua)) return 'Mac Chrome';
    if (/Edg/.test(ua)) return 'Mac Edge';
    if (/Firefox/.test(ua)) return 'Mac Firefox';
    return 'Mac Safari';
  }
  if (/Windows/.test(ua)) {
    if (/Edg/.test(ua)) return 'Windows Edge';
    if (/Chrome/.test(ua)) return 'Windows Chrome';
    if (/Firefox/.test(ua)) return 'Windows Firefox';
    return 'Windows';
  }
  if (/Linux/.test(ua)) {
    if (/Chrome/.test(ua)) return 'Linux Chrome';
    if (/Firefox/.test(ua)) return 'Linux Firefox';
    return 'Linux';
  }
  return 'Unknown';
}

export function isPushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function isPWAMode() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}

export async function getSwRegistration() {
  if (!('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker.getRegistration('/sw.js');
}

export async function getPushSubscription() {
  const reg = await getSwRegistration();
  if (!reg?.pushManager) return null;
  return reg.pushManager.getSubscription();
}

export async function subscribePush() {
  if (!isPushSupported()) throw new Error('Push not supported');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    const err = new Error('Notification permission denied');
    err.code = 'PERMISSION_DENIED';
    throw err;
  }

  let reg = await getSwRegistration();
  if (!reg) {
    reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
  }

  const accountDigest = getAccountDigest();
  if (!accountDigest) {
    throw new Error('Not logged in — cannot register push subscription');
  }

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
  });

  const subJSON = sub.toJSON();
  const deviceId = ensureDeviceId();

  const res = await fetch('/d1/push/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      accountDigest,
      deviceId,
      subscription: subJSON,
      userAgent: navigator.userAgent
    })
  });

  if (!res.ok) {
    // Rollback browser subscription if server rejected
    try { await sub.unsubscribe(); } catch { /* best-effort */ }
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Subscribe failed');
  }

  return sub;
}

export async function unsubscribePush() {
  const sub = await getPushSubscription();
  if (!sub) return;

  const endpoint = sub.endpoint;
  await sub.unsubscribe();

  const accountDigest = getAccountDigest();
  try {
    await fetch('/d1/push/unsubscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountDigest, endpoint })
    });
  } catch (err) {
    console.warn('[push] backend unsubscribe failed', err);
  }
}

export async function unsubscribeByEndpoint(endpoint) {
  const accountDigest = getAccountDigest();
  const res = await fetch('/d1/push/unsubscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountDigest, endpoint })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Unsubscribe failed');
  }

  // If this endpoint matches local subscription, unsubscribe locally too
  try {
    const localSub = await getPushSubscription();
    if (localSub && localSub.endpoint === endpoint) {
      await localSub.unsubscribe();
    }
  } catch { /* no local push support (e.g. Safari without PWA) */ }
}

export async function listPushDevices() {
  const accountDigest = getAccountDigest();
  if (!accountDigest) return [];

  const res = await fetch('/d1/push/list', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountDigest })
  });

  if (!res.ok) return [];
  const data = await res.json();
  const items = Array.isArray(data.items) ? data.items : [];

  // Get local endpoint for "this device" detection
  let localEndpoint = null;
  try {
    const sub = await getPushSubscription();
    if (sub) localEndpoint = sub.endpoint;
  } catch { /* ignore */ }

  return items.map(item => ({
    deviceId: item.device_id,
    endpoint: item.endpoint,
    createdAt: item.created_at,
    userAgent: item.user_agent || '',
    displayName: parseUA(item.user_agent),
    isThisDevice: item.endpoint === localEndpoint
  }));
}

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    console.info('[push] service worker registered');
    return reg;
  } catch (err) {
    console.warn('[push] service worker registration failed', err);
    return null;
  }
}
