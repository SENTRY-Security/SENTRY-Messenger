// /app/features/settings.js
// Manage user settings encrypted with MK and stored per-user via conversation messages.

import { listMessages } from '../api/messages.js';
import { createMessage } from '../api/media.js';
import { getMkRaw, getAccountDigest, buildAccountPayload, ensureDeviceId } from '../core/store.js';
import { wrapWithMK_JSON, unwrapWithMK_JSON } from '../crypto/aead.js';

const SETTINGS_INFO_TAG = 'settings/v1';

function convIdForSettings() {
  const acct = (getAccountDigest() || '').toUpperCase();
  return acct ? `settings-${acct}` : null;
}

export const DEFAULT_SETTINGS = Object.freeze({
  showOnlineStatus: true,
  autoLogoutOnBackground: true,
  autoLogoutRedirectMode: 'default',
  autoLogoutCustomUrl: ''
});

function sanitizeLogoutUrl(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeSettings(input = {}) {
  const sanitizedUrl = sanitizeLogoutUrl(input.autoLogoutCustomUrl);
  const wantsCustomRedirect = input.autoLogoutRedirectMode === 'custom';
  const hasUrl = !!sanitizedUrl;
  const normalized = {
    showOnlineStatus: typeof input.showOnlineStatus === 'boolean' ? input.showOnlineStatus : DEFAULT_SETTINGS.showOnlineStatus,
    autoLogoutOnBackground: typeof input.autoLogoutOnBackground === 'boolean' ? input.autoLogoutOnBackground : DEFAULT_SETTINGS.autoLogoutOnBackground,
    autoLogoutRedirectMode: wantsCustomRedirect && hasUrl ? 'custom' : DEFAULT_SETTINGS.autoLogoutRedirectMode,
    autoLogoutCustomUrl: sanitizedUrl || null
  };
  return normalized;
}

export async function loadSettings({ returnMeta = false } = {}) {
  const mk = getMkRaw();
  const convId = convIdForSettings();
  if (!mk || !convId) throw new Error('Not unlocked: MK/account missing');

  const { r, data } = await listMessages({ convId, limit: 5 });
  if (!r.ok) {
    const msg = typeof data === 'string' ? data : data?.error || data?.message || 'load settings failed';
    throw new Error(msg);
  }
  const items = Array.isArray(data?.items) ? data.items : [];
  if (!items.length) {
    const meta = {
      ok: true,
      hasEnvelope: false,
      urlMode: null,
      hasUrl: false,
      urlLen: 0,
      ts: null
    };
    return returnMeta ? { settings: null, meta } : null;
  }

  let latest = items[0];
  for (const it of items) {
    if ((it?.ts || 0) > (latest?.ts || 0)) latest = it;
  }
  try {
    const header = latest?.header_json ? JSON.parse(latest.header_json) : latest?.header;
    const envelope = header?.envelope;
    if (!envelope) {
      const meta = {
        ok: true,
        hasEnvelope: false,
        urlMode: null,
        hasUrl: false,
        urlLen: 0,
        ts: latest?.ts || null
      };
      return returnMeta ? { settings: null, meta } : null;
    }
    const settings = await unwrapWithMK_JSON(envelope, mk);
    const normalized = {
      ...normalizeSettings(settings),
      updatedAt: settings?.updatedAt || latest?.ts || Math.floor(Date.now() / 1000),
      msgId: latest?.id || null,
      ts: latest?.ts || null
    };
    const meta = {
      ok: true,
      hasEnvelope: true,
      urlMode: normalized.autoLogoutRedirectMode || null,
      hasUrl: !!normalized.autoLogoutCustomUrl,
      urlLen: normalized.autoLogoutCustomUrl ? String(normalized.autoLogoutCustomUrl).length : 0,
      ts: normalized.ts || null
    };
    try {
      console.info('[settings] hydrate ' + JSON.stringify(meta));
    } catch {}
    return returnMeta ? { settings: normalized, meta } : normalized;
  } catch (err) {
    const meta = {
      ok: false,
      hasEnvelope: true,
      urlMode: null,
      hasUrl: false,
      urlLen: 0,
      ts: latest?.ts || null,
      reason: err?.message || String(err)
    };
    try {
      console.info('[settings] hydrate ' + JSON.stringify(meta));
    } catch {}
    throw err;
  }
}

export async function saveSettings(settings) {
  const mk = getMkRaw();
  const convId = convIdForSettings();
  if (!mk || !convId) throw new Error('Not unlocked: MK/account missing');
  const normalized = normalizeSettings(settings);
  if (normalized.autoLogoutRedirectMode === 'custom' && !normalized.autoLogoutCustomUrl) {
    const err = new Error('autoLogoutCustomUrl required for custom redirect');
    err.userMessage = '請輸入有效的 http/https 網址，或改選預設登出頁面。';
    throw err;
  }
  const now = Math.floor(Date.now() / 1000);
  const payload = { ...normalized, updatedAt: now };
  try {
    console.info('[settings] persist ' + JSON.stringify({
      mode: payload.autoLogoutRedirectMode,
      hasUrl: !!payload.autoLogoutCustomUrl,
      urlLen: payload.autoLogoutCustomUrl ? String(payload.autoLogoutCustomUrl).length : 0
    }));
  } catch {}

  const envelope = await wrapWithMK_JSON(payload, mk, SETTINGS_INFO_TAG);
  const header = {
    settings: 1,
    v: 1,
    ts: payload.updatedAt,
    envelope,
    iv_b64: envelope.iv_b64
  };
  const messageId = crypto.randomUUID();
  const overrides = {
    convId,
    type: 'text',
    aead: 'aes-256-gcm',
    id: messageId,
    header,
    ciphertext_b64: envelope?.ct_b64 || 'settings',
    receiverAccountDigest: (getAccountDigest() || '').toUpperCase(),
    receiverDeviceId: ensureDeviceId()
  };

  const body = buildAccountPayload({ overrides });
  const { r, data } = await createMessage(body);
  if (!r.ok) {
    const msg = typeof data === 'string' ? data : data?.error || data?.message || 'settings save failed';
    throw new Error(msg);
  }
  return { ...payload, msgId: data?.msgId || data?.id || null };
}

export async function ensureSettings() {
  const existing = await loadSettings().catch((err) => {
    console.warn('[settings] load failed', err);
    return null;
  });
  if (existing && typeof existing === 'object') {
    return { ...normalizeSettings(existing), updatedAt: existing.updatedAt || Math.floor(Date.now() / 1000) };
  }
  try {
    const saved = await saveSettings(DEFAULT_SETTINGS);
    return saved;
  } catch (err) {
    console.warn('[settings] initialize failed', err);
    return { ...DEFAULT_SETTINGS, updatedAt: Math.floor(Date.now() / 1000) };
  }
}
