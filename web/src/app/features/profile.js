// /app/features/profile.js
// Manage encrypted profile control-state (nickname, avatar) stored per-account using MK.

import { listSecureMessages, createSecureMessage } from '../api/messages.js';
import { encryptAndPutWithProgress, downloadAndDecrypt } from './media.js';
import {
  getMkRaw,
  getAccountDigest,
  ensureDeviceId,
  allocateDeviceCounter,
  setDeviceCounter,
  normalizeAccountDigest,
  getUidHex
} from '../core/store.js';
import { wrapWithMK_JSON, unwrapWithMK_JSON, assertEnvelopeStrict } from '../crypto/aead.js';
import { buildIdenticonImage } from '../lib/identicon.js';
import { log } from '../core/log.js';

const PROFILE_INFO_TAG = 'profile/v1';
const PROFILE_ALLOWED_INFO_TAGS = new Set([PROFILE_INFO_TAG]);
const PROFILE_MESSAGE_TYPE = 'profile-update';
const PROFILE_CONV_PREFIX = 'profile:';
const AVATAR_CONV_PREFIX = 'avatar-';

export function profileConversationId(accountDigest = null) {
  const acct = normalizeAccountDigest(accountDigest || getAccountDigest());
  return acct ? `${PROFILE_CONV_PREFIX}${acct}` : null;
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

function normalizeProfilePayload(profile, { fallbackNickname } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const nickname = normalizeNickname(profile?.nickname || '') || fallbackNickname || '';
  const payload = {
    type: PROFILE_MESSAGE_TYPE,
    nickname,
    avatar: profile?.avatar || null,
    updatedAt: Number.isFinite(profile?.updatedAt) ? Number(profile.updatedAt) : now,
    version: Number.isFinite(profile?.version) ? Number(profile.version) : 1
  };
  if (profile?.ts && !payload.ts) {
    const tsVal = Number(profile.ts);
    if (Number.isFinite(tsVal)) payload.ts = tsVal;
  }
  return payload;
}

async function loadProfileControlState(accountDigest = null, { limit = 1 } = {}) {
  const mk = getMkRaw();
  const convId = profileConversationId(accountDigest);
  if (!mk || !convId) throw new Error('Not unlocked: MK/account missing');

  const { r, data } = await listSecureMessages({ conversationId: convId, limit });
  const status = r.status;
  if (status === 404 || status === 204) return null;
  if (!r.ok) {
    const msg = typeof data === 'string' ? data : data?.error || data?.message || 'load profile failed';
    throw new Error(msg);
  }
  const items = Array.isArray(data?.items) ? data.items : [];
  if (!items.length) return null;

  const candidates = [];
  for (const it of items) {
    const msgId = it?.id || null;
    const createdAt = it?.ts || it?.created_at || null;
    let header = null;
    try {
      header = it?.header_json ? JSON.parse(it.header_json) : it?.header;
    } catch (err) {
      log({ profileHydrateSkip: { msgId, createdAt, reason: 'header-json-invalid', error: err?.message || String(err) } });
      continue;
    }
    const metaType = header?.meta?.msg_type || header?.meta?.msgType || null;
    if (!(header?.profile === 1 || metaType === PROFILE_MESSAGE_TYPE)) {
      log({ profileHydrateSkip: { msgId, createdAt, reason: 'non-profile-message' } });
      continue;
    }
    if (!header?.envelope) {
      log({ profileHydrateSkip: { msgId, createdAt, reason: 'missing-envelope' } });
      continue;
    }
    candidates.push({ item: it, header, envelope: header.envelope, createdAt });
  }

  if (!candidates.length) return null;

  const ordered = candidates.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  for (const entry of ordered) {
    const msgId = entry?.item?.id || null;
    const createdAt = entry?.createdAt || null;
    try {
      const normalizedEnvelope = assertEnvelopeStrict(entry.envelope, { allowInfoTags: PROFILE_ALLOWED_INFO_TAGS });
      log({
        profileHydrateEnvelope: {
          conversationId: convId,
          serverMessageId: msgId,
          createdAt,
          hasMk: !!mk,
          info: typeof normalizedEnvelope.info === 'string' ? normalizedEnvelope.info : null,
          saltB64Len: typeof normalizedEnvelope.salt_b64 === 'string' ? normalizedEnvelope.salt_b64.length : null,
          ivB64Len: typeof normalizedEnvelope.iv_b64 === 'string' ? normalizedEnvelope.iv_b64.length : null,
          ctB64Len: typeof normalizedEnvelope.ct_b64 === 'string' ? normalizedEnvelope.ct_b64.length : null,
          types: {
            info: typeof entry.envelope?.info,
            salt: typeof entry.envelope?.salt_b64,
            iv: typeof entry.envelope?.iv_b64,
            ct: typeof entry.envelope?.ct_b64
          }
        }
      });
      const profile = await unwrapWithMK_JSON(normalizedEnvelope, mk);
      console.log('[profile] loaded profile', profile);
      return { ...profile, msgId, ts: createdAt };
    } catch (err) {
      log({ profileHydrateSkip: { msgId, createdAt, reason: err?.message || 'profile decode failed' } });
    }
  }
  return null;
}

async function persistProfileControlState(profile, { accountDigest } = {}) {
  const mk = getMkRaw();
  const targetDigest = normalizeAccountDigest(accountDigest || getAccountDigest());
  const selfDigest = normalizeAccountDigest(getAccountDigest());
  const convId = profileConversationId(accountDigest);
  const deviceId = ensureDeviceId();
  if (!mk || !convId || !selfDigest || !deviceId) throw new Error('Not unlocked: MK/account missing');
  const fallbackNickname = targetDigest ? `好友 ${targetDigest.slice(-4)}` : '';
  const obj = normalizeProfilePayload(profile, { fallbackNickname });
  if (obj?.avatar) {
    const env = obj.avatar?.env || null;
    console.log('[profile] avatar:env-written', {
      hasInfoTag: !!env?.info_tag,
      hasKeyType: !!env?.key_type,
      hasIv: !!env?.iv_b64,
      hasSalt: !!env?.hkdf_salt_b64,
      objKey: obj.avatar?.objKey || null
    });
  }
  const envelope = await wrapWithMK_JSON(obj, mk, PROFILE_INFO_TAG);
  const normalizedEnvelope = assertEnvelopeStrict(envelope, { allowInfoTags: PROFILE_ALLOWED_INFO_TAGS });
  const { counter, commit } = allocateDeviceCounter();
  const header = {
    profile: 1,
    v: 1,
    ts: obj.updatedAt,
    envelope: normalizedEnvelope,
    iv_b64: normalizedEnvelope.iv_b64,
    device_id: deviceId || undefined,
    n: counter,
    meta: { msg_type: PROFILE_MESSAGE_TYPE, subtype: PROFILE_MESSAGE_TYPE }
  };
  const ciphertextB64 = normalizedEnvelope.ct_b64;
  if (!ciphertextB64) {
    throw new Error('profile ciphertext missing');
  }
  const messageId = crypto.randomUUID();
  const { r, data } = await createSecureMessage({
    conversationId: convId,
    header,
    ciphertextB64,
    counter,
    senderDeviceId: deviceId,
    receiverAccountDigest: selfDigest,
    receiverDeviceId: deviceId,
    id: messageId,
    createdAt: obj.updatedAt
  });
  if (!r.ok) {
    if (r.status === 409 && data?.error === 'CounterTooLow') {
      const maxCounter = Number.isFinite(data?.maxCounter) ? Number(data.maxCounter) : null;
      const seed = maxCounter === null ? 1 : maxCounter + 1;
      setDeviceCounter(deviceId, seed);
      log({ profileCounterReseeded: { maxCounter, seed, source: 'CounterTooLow' } });
      return false;
    }
    const msg = typeof data === 'string' ? data : data?.error || data?.message || 'profile save failed';
    throw new Error(msg);
  }
  try { commit(); } catch {}
  return { ...obj, msgId: data?.id || null };
}

export async function loadLatestProfile(accountDigest = null) {
  return loadProfileControlState(accountDigest, { limit: 1 });
}

export async function saveProfile(profile) {
  const saved = await persistProfileControlState(profile, { accountDigest: getAccountDigest() });
  if (saved === false) return false;
  const overridesForContacts = {
    nickname: saved.nickname || null,
    avatar: saved.avatar || null,
    updatedAt: saved.updatedAt
  };

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
  return saved;
}

export async function persistProfileForAccount(profile, accountDigest) {
  return persistProfileControlState(profile, { accountDigest });
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
  const env = {
    iv_b64: envelope.iv_b64,
    hkdf_salt_b64: envelope.hkdf_salt_b64,
    info_tag: envelope.info_tag,
    key_type: envelope.key_type,
    aead: envelope.aead
  };
  if (envelope?.key_b64) env.key_b64 = envelope.key_b64;
  if (typeof envelope?.v !== 'undefined') env.v = envelope.v;
  return {
    objKey: objectKey,
    env,
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
  const convId = profileConversationId();
  if (!mk || !convId) throw new Error('Not unlocked: MK/account missing');
  const profile = await loadLatestProfile().catch(() => null);
  if (!force && profile?.avatar?.objKey) {
    return { ok: true, skipped: true, reason: 'has-avatar' };
  }
  const identiconSeed =
    (typeof seed === 'string' && seed.trim()) ||
    getUidHex?.() ||
    (getAccountDigest() || '').toUpperCase();
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
  const env = profile.avatar?.env || null;
  console.log('[profile] avatar:env-read', {
    hasInfoTag: !!env?.info_tag,
    hasKeyType: !!env?.key_type,
    hasIv: !!env?.iv_b64,
    hasSalt: !!env?.hkdf_salt_b64,
    objKey: profile.avatar?.objKey || null
  });
  if (!env?.info_tag) {
    console.log('[profile] avatar:skip', { reason: 'missing-info_tag' });
    return null;
  }
  if (!env?.key_type || !env?.iv_b64 || !env?.hkdf_salt_b64) {
    return null;
  }
  const envelope = {
    iv_b64: env.iv_b64,
    hkdf_salt_b64: env.hkdf_salt_b64,
    info_tag: env.info_tag,
    key_type: env.key_type,
    contentType: profile.avatar.contentType || 'image/png',
    name: profile.avatar.name || 'avatar'
  };
  if (env?.aead) envelope.aead = env.aead;
  if (env?.key_b64) envelope.key_b64 = env.key_b64;
  if (typeof env?.v !== 'undefined') envelope.v = env.v;
  try {
    const result = await downloadAndDecrypt({ key: profile.avatar.objKey, envelope });
    return result;
  } catch (err) {
    console.error('[profile] avatar download failed', err);
    return null;
  }
}
