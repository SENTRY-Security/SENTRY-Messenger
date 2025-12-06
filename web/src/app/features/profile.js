// /app/features/profile.js
// Manage encrypted user profile (nickname, etc.) stored per-user using MK.

import { listMessages } from '../api/messages.js';
import { createMessage } from '../api/media.js';
import { encryptAndPutWithProgress, downloadAndDecrypt } from './media.js';
import { getMkRaw, getAccountDigest, buildAccountPayload } from '../core/store.js';
import { wrapWithMK_JSON, unwrapWithMK_JSON } from '../crypto/aead.js';

const PROFILE_INFO_TAG = 'profile/v1';
const AVATAR_CONV_PREFIX = 'avatar-';

function convIdForProfile() {
  const acct = (getAccountDigest() || '').toUpperCase();
  return acct ? `profile-${acct}` : null;
}

export function normalizeNickname(raw) {
  if (!raw && raw !== 0) return '';
  const trimmed = String(raw).trim().replace(/[\u3000]+/gu, ' ');
  if (!trimmed) return '';
  const filtered = trimmed.normalize('NFKC').replace(/[^\p{L}\p{N}\p{M}\p{So}\p{Sk}\p{Zs}\-_.]/gu, '');
  const collapsed = filtered.replace(/\s+/gu, ' ').trim().slice(0, 24);
  if (!collapsed) return '';
  const pattern = /^[\p{L}\p{N}\p{So}][\p{L}\p{N}\p{So}\p{M}\p{Sk}\p{Zs}\-_.]{0,23}$/u;
  if (!pattern.test(collapsed)) return '';
  const lower = collapsed.toLowerCase();
  const banned = ['avatar', 'btn', 'margin', 'padding', 'position', 'width', 'height', 'px', 'color', 'shadow', 'border', 'background', 'display'];
  if (banned.some((kw) => lower.includes(kw))) return '';
  return collapsed;
}

const adjectives = ['bright', 'calm', 'swift', 'lucky', 'merry', 'brave', 'gentle', 'bold', 'clever', 'sunny'];
const nouns = ['sparrow', 'willow', 'aurora', 'nebula', 'harbor', 'meadow', 'ember', 'cascade', 'horizon', 'aurora'];

function randomFrom(arr) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return arr[buf[0] % arr.length];
}

export function generateRandomNickname() {
  const adj = randomFrom(adjectives);
  const noun = randomFrom(nouns);
  const num = String(crypto.getRandomValues(new Uint16Array(1))[0] % 100).padStart(2, '0');
  return `${adj}-${noun}-${num}`;
}

export async function loadLatestProfile() {
  const mk = getMkRaw();
  const convId = convIdForProfile();
  if (!mk || !convId) throw new Error('Not unlocked: MK/account missing');

  const { r, data } = await listMessages({ convId, limit: 5 });
  const status = r.status;
  if (status === 404 || status === 204) return null;
  if (!r.ok) {
    const msg = typeof data === 'string' ? data : data?.error || data?.message || 'load profile failed';
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
    if (!envelope) {
      console.warn('[profile] missing envelope on message', latest?.id);
      return null;
    }
    const profile = await unwrapWithMK_JSON(envelope, mk);
    console.log('[profile] loaded profile', profile);
    return { ...profile, msgId: latest?.id || null, ts: latest?.ts || null };
  } catch (err) {
    console.error('profile decode failed', err);
    return null;
  }
}

export async function saveProfile(profile) {
  const mk = getMkRaw();
  const convId = convIdForProfile();
  if (!mk || !convId) throw new Error('Not unlocked: MK/account missing');
  const obj = { ...profile, updatedAt: profile?.updatedAt || Math.floor(Date.now() / 1000) };

  const envelope = await wrapWithMK_JSON(obj, mk, PROFILE_INFO_TAG);
  const header = { profile: 1, v: 1, ts: obj.updatedAt, envelope };
  const payload = {
    convId,
    type: 'text',
    aead: 'aes-256-gcm',
    header,
    ciphertext_b64: envelope?.ct_b64 || 'profile'
  };
  const body = buildAccountPayload({ overrides: payload });
  const { r, data } = await createMessage(body);
  if (!r.ok) {
    const msg = typeof data === 'string' ? data : data?.error || data?.message || 'profile save failed';
    throw new Error(msg);
  }
  return { ...obj, msgId: data?.id || null };
}

export async function ensureProfileNickname() {
  let profile = await loadLatestProfile().catch(() => null);
  const now = Math.floor(Date.now() / 1000);
  const normalized = normalizeNickname(profile?.nickname || '');

  if (!normalized) {
    const nickname = generateRandomNickname();
    const entry = { nickname, updatedAt: now };
    const saved = await saveProfile(entry).catch((err) => {
      console.error('profile save failed', err);
      return entry;
    });
    console.log('[profile] generated nickname', saved);
    return saved;
  }

  if (normalized !== profile?.nickname) {
    const entry = { ...(profile || {}), nickname: normalized, updatedAt: now };
    const saved = await saveProfile(entry).catch((err) => {
      console.error('profile normalize failed', err);
      return entry;
    });
    console.log('[profile] normalized nickname', saved);
    return saved;
  }

  return { ...profile, nickname: normalized };
}

export async function uploadAvatar({ file, onProgress, thumbDataUrl } = {}) {
  if (!file) throw new Error('請先選擇圖片');
  if (!file.type || !file.type.startsWith('image/')) throw new Error('只支援圖片格式');
  const sizeLimit = 6 * 1024 * 1024;
  if (file.size > sizeLimit) throw new Error('圖片超過 6MB，請選擇較小的檔案');
  const acct = (getAccountDigest() || '').toUpperCase();
  if (!acct) throw new Error('Account missing');
  const convId = `${AVATAR_CONV_PREFIX}${acct}`;
  const { objectKey, envelope, size } = await encryptAndPutWithProgress({ convId, file, onProgress, dir: 'avatars' });
  const now = Math.floor(Date.now() / 1000);
  return {
    objKey: objectKey,
    env: { iv_b64: envelope.iv_b64, hkdf_salt_b64: envelope.hkdf_salt_b64, aead: envelope.aead },
    contentType: file.type || 'image/png',
    size,
    updatedAt: now,
    name: file.name || 'avatar',
    thumbDataUrl: thumbDataUrl || null
  };
}

export async function loadAvatarBlob(profile) {
  if (!profile?.avatar?.objKey) return null;
  const env = profile.avatar.env || profile.avatar;
  if (!env?.iv_b64 || !env?.hkdf_salt_b64) return null;
  const envelope = {
    iv_b64: env.iv_b64,
    hkdf_salt_b64: env.hkdf_salt_b64,
    contentType: profile.avatar.contentType || 'image/png',
    name: profile.avatar.name || 'avatar'
  };
  try {
    const result = await downloadAndDecrypt({ key: profile.avatar.objKey, envelope });
    return result;
  } catch (err) {
    console.error('[profile] avatar download failed', err);
    return null;
  }
}
