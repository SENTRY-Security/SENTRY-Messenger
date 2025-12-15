// /app/features/profile.js
// Manage encrypted user profile (nickname, etc.) stored per-user using MK.

import { listMessages } from '../api/messages.js';
import { createMessage } from '../api/media.js';
import { encryptAndPutWithProgress, downloadAndDecrypt } from './media.js';
import { getMkRaw, getAccountDigest, buildAccountPayload, ensureDeviceId } from '../core/store.js';
import { wrapWithMK_JSON, unwrapWithMK_JSON } from '../crypto/aead.js';
import { buildIdenticonImage } from '../lib/identicon.js';

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

// Expanded pools to widen nickname entropy (50+ each, balanced length to keep <=24 chars after join)
const adjectives = [
  'bright', 'calm', 'swift', 'lucky', 'merry', 'brave', 'gentle', 'bold', 'clever', 'sunny',
  'serene', 'lively', 'noble', 'vivid', 'cozy', 'quiet', 'sharp', 'breezy', 'daring', 'eager',
  'silver', 'amber', 'crimson', 'azure', 'ivory', 'jade', 'golden', 'rustic', 'spry', 'zen',
  'cosmic', 'fuzzy', 'glowing', 'hazy', 'misty', 'pearl', 'plucky', 'prism', 'pure', 'shy',
  'sincere', 'steady', 'tidy', 'warm', 'witty', 'zesty', 'silky', 'dappled', 'spruce', 'candid'
];
const nouns = [
  'sparrow', 'willow', 'aurora', 'nebula', 'harbor', 'meadow', 'ember', 'cascade', 'horizon', 'canyon',
  'pine', 'cedar', 'maple', 'birch', 'cove', 'lagoon', 'reef', 'delta', 'mesa', 'comet',
  'nova', 'meteor', 'quasar', 'orbit', 'zenith', 'lyric', 'echo', 'grove', 'harvest', 'quill',
  'ripple', 'terrace', 'summit', 'valley', 'brook', 'glade', 'drift', 'anchor', 'voyage', 'stride',
  'lumen', 'petal', 'tidal', 'prairie', 'shore', 'dune', 'gale', 'moraine', 'fjord', 'breeze',
  'thicket', 'spoke', 'emberglow', 'starling', 'heather', 'auric'
];

function randomFrom(arr) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return arr[buf[0] % arr.length];
}

export function generateRandomNickname() {
  const adj = randomFrom(adjectives);
  const noun = randomFrom(nouns);
  // 3-char base36 suffix for higher entropy (36^3=46,656 combos)
  const rand = crypto.getRandomValues(new Uint32Array(1))[0] % 46656;
  const suffix = rand.toString(36).padStart(3, '0');
  return `${adj}-${noun}-${suffix}`;
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
  const overridesForContacts = {
    nickname: obj.nickname || null,
    avatar: obj.avatar || null,
    updatedAt: obj.updatedAt
  };

  const envelope = await wrapWithMK_JSON(obj, mk, PROFILE_INFO_TAG);
  const deviceId = ensureDeviceId();
  const counter = Math.floor(Date.now() / 1000);
  const header = {
    profile: 1,
    v: 1,
    ts: obj.updatedAt,
    envelope,
    iv_b64: envelope?.iv_b64,
    device_id: deviceId || undefined,
    n: counter
  };
  const messageId = crypto.randomUUID();
  const payload = {
    convId,
    type: 'text',
    aead: 'aes-256-gcm',
    id: messageId,
    header,
    ciphertext_b64: envelope?.ct_b64 || 'profile',
    counter,
    receiverAccountDigest: (getAccountDigest() || '').toUpperCase(),
    receiverDeviceId: deviceId
  };
  const body = buildAccountPayload({ overrides: payload });
  const { r, data } = await createMessage(body);
  if (!r.ok) {
    const msg = typeof data === 'string' ? data : data?.error || data?.message || 'profile save failed';
    throw new Error(msg);
  }
  // 對所有已知好友推播 contacts-reload，讓對方同步暱稱/頭像
  try {
    const contacts = Array.isArray(window.sessionStore?.contactState) ? window.sessionStore.contactState : [];
    const wsSend = typeof window.wsSend === 'function' ? window.wsSend : null;
    const deviceId = window.getDeviceId ? window.getDeviceId() : null;
    if (wsSend && contacts.length) {
      contacts
        .map((c) => c?.peerAccountDigest || c?.accountDigest || c?.account_digest || null)
        .filter((d) => typeof d === 'string' && d.trim().length === 64)
        .forEach((peer) => {
          wsSend({
            type: 'contacts-reload',
            accountDigest: peer,
            senderDeviceId: deviceId || null
          });
        });
    }
  } catch (err) {
    console.warn('[profile] ws contacts-reload notify failed', err?.message || err);
  }

  // 透過共用的 broadcast pipeline 將最新暱稱/頭像同步給好友（contact-share）
  try {
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      document.dispatchEvent(
        new CustomEvent('contacts:broadcast-update', {
          detail: { reason: 'profile', overrides: overridesForContacts }
        })
      );
    }
  } catch (err) {
    console.warn('[profile] broadcast-update event failed', err?.message || err);
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
  const { objectKey, envelope, size } = await encryptAndPutWithProgress({
    convId,
    file,
    onProgress,
    dir: 'avatars',
    direction: 'drive'
  });
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

/**
 * For new accounts: create and upload a default identicon avatar if none exists.
 * Uses provided seed (uidHex preferred) or falls back to account digest.
 */
export async function ensureDefaultAvatarFromSeed({ seed, force = false } = {}) {
  const mk = getMkRaw();
  const convId = convIdForProfile();
  if (!mk || !convId) throw new Error('Not unlocked: MK/account missing');
  const profile = await loadLatestProfile().catch(() => null);
  if (!force && profile?.avatar?.objKey) {
    return { ok: true, skipped: true, reason: 'has-avatar' };
  }
  const identiconSeed = (typeof seed === 'string' && seed.trim()) || (getAccountDigest() || '').toUpperCase();
  if (!identiconSeed) throw new Error('missing identicon seed');
  const identicon = await buildIdenticonImage(identiconSeed, { size: 512, format: 'image/jpeg', quality: 0.88 });
  if (!identicon?.blob) throw new Error('identicon render failed');
  const file = new File([identicon.blob], 'avatar-identicon.jpg', { type: identicon.blob.type || 'image/jpeg' });
  const avatarMeta = await uploadAvatar({ file, thumbDataUrl: identicon.dataUrl });
  const nextProfile = {
    ...(profile || {}),
    avatar: { ...avatarMeta, autoGenerated: true },
    nickname: profile?.nickname || generateRandomNickname(),
    updatedAt: Math.floor(Date.now() / 1000)
  };
  const saved = await saveProfile(nextProfile).catch(() => nextProfile);
  return { ok: true, avatar: saved?.avatar || avatarMeta };
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
