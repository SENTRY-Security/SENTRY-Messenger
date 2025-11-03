// /app/features/settings.js
// Manage user settings encrypted with MK and stored per-user via conversation messages.

import { listMessages } from '../api/messages.js';
import { createMessage } from '../api/media.js';
import { getMkRaw, getUidHex, getAccountDigest, buildAccountPayload } from '../core/store.js';
import { wrapWithMK_JSON, unwrapWithMK_JSON } from '../crypto/aead.js';

const SETTINGS_INFO_TAG = 'settings/v1';

function convIdForSettings() {
  const acct = (getAccountDigest() || '').toUpperCase();
  return acct ? `settings-${acct}` : null;
}

export const DEFAULT_SETTINGS = Object.freeze({
  showOnlineStatus: true,
  autoLogoutOnBackground: true
});

function normalizeSettings(input = {}) {
  const normalized = {
    showOnlineStatus: typeof input.showOnlineStatus === 'boolean' ? input.showOnlineStatus : DEFAULT_SETTINGS.showOnlineStatus,
    autoLogoutOnBackground: typeof input.autoLogoutOnBackground === 'boolean' ? input.autoLogoutOnBackground : DEFAULT_SETTINGS.autoLogoutOnBackground
  };
  return normalized;
}

export async function loadSettings() {
  const mk = getMkRaw();
  const convId = convIdForSettings();
  if (!mk || !convId) throw new Error('Not unlocked: MK/account missing');

  const { r, data } = await listMessages({ convId, limit: 5 });
  if (!r.ok) {
    const msg = typeof data === 'string' ? data : data?.error || data?.message || 'load settings failed';
    throw new Error(msg);
  }
  const items = Array.isArray(data?.items) ? data.items : [];
  if (!items.length) return null;

  let latest = items[0];
  for (const it of items) {
    if ((it?.ts || 0) > (latest?.ts || 0)) latest = it;
  }
  try {
    const header = latest?.header_json ? JSON.parse(latest.header_json) : latest?.header;
    const envelope = header?.envelope;
    if (!envelope) return null;
    const settings = await unwrapWithMK_JSON(envelope, mk);
    return {
      ...normalizeSettings(settings),
      updatedAt: settings?.updatedAt || latest?.ts || Math.floor(Date.now() / 1000),
      msgId: latest?.id || null,
      ts: latest?.ts || null
    };
  } catch (err) {
    console.warn('[settings] decode failed', err);
    return null;
  }
}

export async function saveSettings(settings) {
  const mk = getMkRaw();
  const convId = convIdForSettings();
  if (!mk || !convId) throw new Error('Not unlocked: MK/account missing');
  const normalized = normalizeSettings(settings);
  const now = Math.floor(Date.now() / 1000);
  const payload = { ...normalized, updatedAt: now };

  const envelope = await wrapWithMK_JSON(payload, mk, SETTINGS_INFO_TAG);
  const header = { settings: 1, v: 1, ts: payload.updatedAt, envelope };
  const overrides = {
    convId,
    type: 'text',
    aead: 'aes-256-gcm',
    header,
    ciphertext_b64: envelope?.ct_b64 || 'settings'
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
