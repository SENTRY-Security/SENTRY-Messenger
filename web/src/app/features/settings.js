// /app/features/settings.js
// Manage user settings encrypted with MK and stored per-user via conversation messages.

import { listMessages } from '../api/messages.js';
import { createMessage } from '../api/media.js';
import { getMkRaw, getAccountDigest, buildAccountPayload, ensureDeviceId } from '../core/store.js';
import { wrapWithMK_JSON, unwrapWithMK_JSON, assertEnvelopeStrict } from '../crypto/aead.js';

const SETTINGS_INFO_TAG = 'settings/v1';
const SETTINGS_ALLOWED_INFO_TAGS = new Set([SETTINGS_INFO_TAG]);

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

  const candidates = [];
  for (const it of items) {
    const ts = Number.isFinite(it?.ts) ? it.ts : (Number(it?.created_at) || 0);
    let header = null;
    try {
      header = it?.header_json ? JSON.parse(it.header_json) : (typeof it?.header === 'object' ? it.header : null);
    } catch {
      header = typeof it?.header === 'object' ? it.header : null;
    }
    const msgType = it?.msgType || it?.msg_type
      || (it?.meta && typeof it.meta === 'object' ? (it.meta.msgType || it.meta.msg_type) : null)
      || (header?.meta && typeof header.meta === 'object' ? (header.meta.msgType || header.meta.msg_type) : null)
      || header?.msgType || header?.msg_type
      || null;
    const isSettings = (header && header.settings === 1) || msgType === 'settings-update';
    if (!isSettings) {
      try {
        console.debug('[settings] skip non-settings message', { id: it?.id || null, msgType });
      } catch { }
      continue;
    }
    candidates.push({ item: it, header, msgType, ts });
  }

  if (!candidates.length) {
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

  candidates.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const latest = candidates[0];
  const envelope = latest?.header?.envelope;
  if (!envelope) {
    const err = new Error('settings envelope missing');
    err.messageId = latest?.item?.id || null;
    throw err;
  }
  try {
    const normalizedEnvelope = assertEnvelopeStrict(envelope, { allowInfoTags: SETTINGS_ALLOWED_INFO_TAGS });
    const settings = await unwrapWithMK_JSON(normalizedEnvelope, mk);
    const normalized = {
      ...normalizeSettings(settings),
      updatedAt: settings?.updatedAt || latest?.ts || Date.now(),
      msgId: latest?.item?.id || null,
      ts: latest?.ts || null
    };
    const meta = {
      ok: true,
      hasEnvelope: true,
      urlMode: normalized.autoLogoutRedirectMode || null,
      hasUrl: !!normalized.autoLogoutCustomUrl,
      urlLen: normalized.autoLogoutCustomUrl ? String(normalized.autoLogoutCustomUrl).length : 0,
      ts: normalized.ts || null,
      messageId: latest?.item?.id || null
    };
    try {
      console.info('[settings] hydrate ' + JSON.stringify(meta));
    } catch { }
    return returnMeta ? { settings: normalized, meta } : normalized;
  } catch (err) {
    const meta = {
      ok: false,
      hasEnvelope: true,
      urlMode: null,
      hasUrl: false,
      urlLen: 0,
      ts: latest?.ts || null,
      reason: err?.message || String(err),
      messageId: latest?.item?.id || null
    };
    try {
      console.info('[settings] hydrate ' + JSON.stringify(meta));
    } catch { }
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
  const now = Date.now();
  const payload = { ...normalized, updatedAt: now };
  try {
    console.info('[settings] persist ' + JSON.stringify({
      mode: payload.autoLogoutRedirectMode,
      hasUrl: !!payload.autoLogoutCustomUrl,
      urlLen: payload.autoLogoutCustomUrl ? String(payload.autoLogoutCustomUrl).length : 0
    }));
  } catch { }

  const envelope = await wrapWithMK_JSON(payload, mk, SETTINGS_INFO_TAG);
  const normalizedEnvelope = assertEnvelopeStrict(envelope, { allowInfoTags: SETTINGS_ALLOWED_INFO_TAGS });
  const header = {
    settings: 1,
    v: 1,
    ts: payload.updatedAt,
    envelope: normalizedEnvelope,
    iv_b64: normalizedEnvelope.iv_b64
  };
  const messageId = crypto.randomUUID();
  const overrides = {
    convId,
    type: 'text',
    aead: 'aes-256-gcm',
    id: messageId,
    header,
    ciphertext_b64: normalizedEnvelope.ct_b64,
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
    return { ...normalizeSettings(existing), updatedAt: existing.updatedAt || Date.now() };
  }
  try {
    const saved = await saveSettings(DEFAULT_SETTINGS);
    return saved;
  } catch (err) {
    console.warn('[settings] initialize failed', err);
    return { ...DEFAULT_SETTINGS, updatedAt: Date.now() };
  }
}
