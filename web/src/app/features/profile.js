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
  normalizeAccountDigest
} from '../core/store.js';
import { wrapWithMK_JSON, unwrapWithMK_JSON, assertEnvelopeStrict } from '../crypto/aead.js';
import { log } from '../core/log.js';
import { DEBUG } from '../ui/mobile/debug-flags.js';
import { buildIdenticonImage } from '../lib/identicon.js';

const PROFILE_INFO_TAG = 'profile/v1';
const PROFILE_ALLOWED_INFO_TAGS = new Set([PROFILE_INFO_TAG]);
const PROFILE_MESSAGE_TYPE = 'profile-update';
const PROFILE_CONV_PREFIX = 'profile:';
const AVATAR_CONV_PREFIX = 'avatar-';
const AVATAR_WRITE_LOG_LIMIT = 5;
let avatarWriteLogCount = 0;

export const PROFILE_WRITE_SOURCE = Object.freeze({
  EXPLICIT: 'explicit_user_action',
  USER_NICKNAME: 'user-nickname',
  AUTO_NICKNAME: 'auto-nickname-normalize',
  CONTACT_SHARE: 'contact-share',
  PROFILE_SNAPSHOT: 'profile-snapshot-hydrate',
  AVATAR_INIT: 'avatar-init-identicon'
});

function shouldLogAvatarWrite() {
  return DEBUG.avatarBug && avatarWriteLogCount < AVATAR_WRITE_LOG_LIMIT;
}

function emitAvatarWriteLog(payload) {
  if (!shouldLogAvatarWrite()) return;
  avatarWriteLogCount += 1;
  try {
    log({ profileWriteTrace: payload });
  } catch {
    /* ignore logging errors */
  }
}

function logProfileCounter(payload) {
  if (!DEBUG.profileCounter) return;
  try {
    log(payload);
  } catch {
    /* ignore logging errors */
  }
}

async function hashString(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    if (typeof crypto === 'undefined' || !crypto.subtle || typeof TextEncoder === 'undefined') return null;
    const data = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest))
      .slice(0, 8)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return null;
  }
}

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

// Deterministic nickname pools (ASCII lowercase, fixed size for stable hashing).
const adjectives = [
  'bright', 'calm', 'swift', 'lucky', 'merry', 'brave', 'gentle', 'bold', 'clever', 'sunny',
  'serene', 'lively', 'noble', 'vivid', 'cozy', 'quiet', 'sharp', 'breezy', 'daring', 'eager',
  'silver', 'amber', 'crimson', 'azure', 'ivory', 'jade', 'golden', 'rustic', 'spry', 'zen',
  'cosmic', 'fuzzy', 'glowing', 'hazy', 'misty', 'pearl', 'plucky', 'prism', 'pure', 'shy',
  'sincere', 'steady', 'tidy', 'warm', 'witty', 'zesty', 'silky', 'dappled', 'spruce', 'candid',
  'agile', 'airy', 'ancient', 'aqua', 'ardent', 'autumn', 'balanced', 'basic', 'brisk', 'cheerful',
  'clear', 'crisp', 'dapper', 'earnest', 'easy', 'fair', 'faint', 'fast', 'fiery', 'floral',
  'fresh', 'friendly', 'frosty', 'grand', 'green', 'hardy', 'honest', 'humble', 'ideal', 'jolly',
  'keen', 'kind', 'lucid', 'mellow', 'mild', 'modern', 'nimble', 'open', 'pale', 'patient',
  'peaceful', 'polished', 'proud', 'quick', 'radiant', 'rare', 'regal', 'rich', 'rugged', 'safe',
  'shiny', 'simple', 'sleek', 'smart', 'smooth', 'snowy', 'solid', 'sturdy', 'subtle', 'tender',
  'tranquil', 'true', 'wise', 'young', 'zealous', 'zippy', 'zany', 'rapid', 'rosy', 'luminous',
  'muted', 'neat', 'prime', 'quaint', 'sandy', 'stormy', 'sunlit', 'verdant'
];
const nouns = [
  'sparrow', 'willow', 'aurora', 'nebula', 'harbor', 'meadow', 'ember', 'cascade', 'horizon', 'canyon',
  'pine', 'cedar', 'maple', 'birch', 'cove', 'lagoon', 'reef', 'delta', 'mesa', 'comet',
  'nova', 'meteor', 'quasar', 'orbit', 'zenith', 'lyric', 'echo', 'grove', 'harvest', 'quill',
  'ripple', 'terrace', 'summit', 'valley', 'brook', 'glade', 'drift', 'anchor', 'voyage', 'stride',
  'lumen', 'petal', 'tidal', 'prairie', 'shore', 'dune', 'gale', 'moraine', 'fjord', 'breeze',
  'thicket', 'spoke', 'emberglow', 'starling', 'heather', 'auric', 'otter', 'fox', 'wolf', 'bear',
  'raven', 'wren', 'finch', 'owl', 'lynx', 'puma', 'bison', 'seal', 'whale', 'tiger',
  'eagle', 'falcon', 'heron', 'ibis', 'koi', 'elk', 'moose', 'stag', 'doe', 'rabbit',
  'hare', 'badger', 'beaver', 'coyote', 'dolphin', 'coral', 'kelp', 'lotus', 'orchid', 'rose',
  'lilac', 'tulip', 'fern', 'moss', 'granite', 'pebble', 'stone', 'ridge', 'cliff', 'plain',
  'field', 'orchard', 'garden', 'forest', 'timber', 'river', 'stream', 'creek', 'spring', 'tide',
  'wave', 'foam', 'frost', 'cloud', 'sky', 'rain', 'snow', 'plume', 'feather', 'crown',
  'arrow', 'compass', 'lantern', 'beacon', 'island', 'islet', 'glacier', 'hollow'
];

async function sha256Bytes(value) {
  if (!value || typeof value !== 'string') throw new Error('nickname seed missing');
  if (typeof crypto === 'undefined' || !crypto.subtle || typeof TextEncoder === 'undefined') {
    throw new Error('crypto.subtle unavailable for nickname seed');
  }
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(digest);
}

export async function generateDeterministicNickname({ accountDigest, deviceId } = {}) {
  const digest = normalizeAccountDigest(accountDigest || getAccountDigest());
  const device = typeof deviceId === 'string' && deviceId.trim() ? deviceId.trim() : ensureDeviceId();
  if (!digest || !device) throw new Error('accountDigest/deviceId required for nickname seed');
  const seedInput = `${digest}:${device}`;
  const hash = await sha256Bytes(seedInput);
  const adjSeed = ((hash[0] << 24) | (hash[1] << 16) | (hash[2] << 8) | hash[3]) >>> 0;
  const nounSeed = ((hash[4] << 24) | (hash[5] << 16) | (hash[6] << 8) | hash[7]) >>> 0;
  const adj = adjectives[adjSeed % adjectives.length];
  const noun = nouns[nounSeed % nouns.length];
  const suffix = digest.slice(-4).toLowerCase();
  return `${adj}-${noun}-${suffix}`;
}

function normalizeProfilePayload(profile, { fallbackNickname, allowAvatar = true } = {}) {
  const now = Date.now();
  const nickname = normalizeNickname(profile?.nickname || '') || fallbackNickname || '';
  const payload = {
    msgType: PROFILE_MESSAGE_TYPE,
    nickname,
    updatedAt: Number.isFinite(profile?.updatedAt) ? Number(profile.updatedAt) : now,
    version: Number.isFinite(profile?.version) ? Number(profile.version) : 1
  };
  if (allowAvatar && Object.prototype.hasOwnProperty.call(profile || {}, 'avatar')) {
    if (typeof profile.avatar !== 'undefined') payload.avatar = profile.avatar;
  }
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
    const hasEnvelope = !!header?.envelope;
    const hasCiphertext = !!(it?.ciphertext_b64 || it?.ciphertextB64);
    if (!hasEnvelope && !hasCiphertext) {
      log({ profileHydrateSkip: { msgId, createdAt, reason: 'missing-envelope' } });
      continue;
    }
    candidates.push({ item: it, header, envelope: header?.envelope || null, createdAt });
  }

  if (!candidates.length) return null;

  const ordered = candidates.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  for (const entry of ordered) {
    const msgId = entry?.item?.id || null;
    const createdAt = entry?.createdAt || null;
    try {
      const header = entry?.header || {};
      let rawEnvelope = entry.envelope;

      // New: Reconstruct envelope from header + ciphertext
      if (!rawEnvelope && (entry.item?.ciphertext_b64 || entry.item?.ciphertextB64)) {
        const ctB64 = entry.item.ciphertext_b64 || entry.item.ciphertextB64;
        rawEnvelope = {
          v: header.v || 1,
          aead: header.aead || 'aes-256-gcm',
          iv_b64: header.iv_b64,
          salt_b64: header.hkdf_salt_b64 || header.salt_b64,
          info: header.info_tag || header.info || PROFILE_INFO_TAG,
          ct_b64: ctB64
        };
      }

      if (!rawEnvelope) {
        // Skip if no envelope found
        continue;
      }

      const normalizedEnvelope = assertEnvelopeStrict(rawEnvelope, { allowInfoTags: PROFILE_ALLOWED_INFO_TAGS });

      // Calculate Checksum of CT for debugging corruption
      let ctChecksum = 'null';
      const ctB64 = normalizedEnvelope.ct_b64;
      if (ctB64 && ctB64.length > 0) {
        try {
          const sample = ctB64.length > 200 ? (ctB64.slice(0, 100) + ':' + ctB64.slice(-100)) : ctB64;
          const buf = new TextEncoder().encode(sample);
          const hashBuf = await crypto.subtle.digest('SHA-256', buf);
          ctChecksum = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 8);
        } catch { }
      }

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
          ctChecksum,
          types: {
            info: typeof entry.envelope?.info,
            salt: typeof entry.envelope?.salt_b64,
            iv: typeof entry.envelope?.iv_b64,
            ct: typeof entry.envelope?.ct_b64
          }
        }
      });
      const profile = await unwrapWithMK_JSON(normalizedEnvelope, mk);
      const wrapped = { ...profile, msgId, ts: createdAt };
      console.log('[profile] loaded profile', wrapped);
      return wrapped;
    } catch (err) {
      log({
        profileHydrateSkip: {
          msgId,
          createdAt,
          reason: err?.message || 'profile decode failed',
          envelopeInfo: entry?.envelope?.info,
          ctLen: entry?.envelope?.ct_b64?.length
        }
      });
      console.warn('[profile] hydration failed', { msgId, err });
    }
  }
  return null;
}

let profileCounterSeedPromise = null;

export async function seedProfileCounterOnce() {
  if (profileCounterSeedPromise) return profileCounterSeedPromise;
  let deviceId = null;
  let digest = null;
  try {
    deviceId = ensureDeviceId();
    digest = normalizeAccountDigest(getAccountDigest());
  } catch (err) {
    logProfileCounter({ profileCounterSeedSkip: { reason: 'identity-missing', error: err?.message || err } });
    return null;
  }
  const conversationId = profileConversationId(digest);
  if (!deviceId || !digest || !conversationId) {
    logProfileCounter({
      profileCounterSeedSkip: {
        reason: 'identity-missing',
        hasDeviceId: !!deviceId,
        hasDigest: !!digest,
        hasConversation: !!conversationId
      }
    });
    return null;
  }

  profileCounterSeedPromise = (async () => {
    try {
      const { r, data } = await listSecureMessages({ conversationId, limit: 50 });
      if (!r.ok) {
        const msg = typeof data === 'string' ? data : data?.error || data?.message || 'profile seed failed';
        logProfileCounter({ profileCounterSeedError: msg, status: r.status || null });
        return null;
      }
      const items = Array.isArray(data?.items) ? data.items : [];
      let maxCounter = 0;
      for (const entry of items) {
        const senderAccount = normalizeAccountDigest(entry?.sender_account_digest || entry?.senderAccountDigest || null);
        if (senderAccount && senderAccount !== digest) continue;
        const senderDeviceId = entry?.sender_device_id || entry?.senderDeviceId || null;
        if (senderDeviceId && senderDeviceId !== deviceId) continue;
        const counters = [];
        const directCounter = Number(entry?.counter ?? entry?.n);
        if (Number.isFinite(directCounter) && directCounter > 0) counters.push(directCounter);
        try {
          const header = entry?.header_json ? JSON.parse(entry.header_json) : entry?.header;
          const headerDeviceId = header?.device_id || header?.deviceId || null;
          if (!headerDeviceId || headerDeviceId === deviceId) {
            const headerCounter = Number(header?.n ?? header?.counter);
            if (Number.isFinite(headerCounter) && headerCounter > 0) counters.push(headerCounter);
          }
        } catch { }
        for (const c of counters) {
          if (Number.isFinite(c) && c > maxCounter) maxCounter = c;
        }
        if (maxCounter && senderDeviceId && senderDeviceId === deviceId) break;
      }
      if (maxCounter > 0) {
        const seed = maxCounter + 1;
        setDeviceCounter(seed);
        logProfileCounter({ profileCounterSeeded: { maxCounter, seed, deviceId, source: 'seedProfileCounterOnce' } });
        return { maxCounter };
      }
      logProfileCounter({ profileCounterSeedSkip: { reason: 'no-self-messages', deviceId } });
      return null;
    } catch (err) {
      logProfileCounter({ profileCounterSeedError: err?.message || err });
      return null;
    }
  })();

  return profileCounterSeedPromise;
}

async function persistProfileControlState(profile, { accountDigest } = {}) {
  const mk = getMkRaw();
  const targetDigest = normalizeAccountDigest(accountDigest || getAccountDigest());
  const selfDigest = normalizeAccountDigest(getAccountDigest());
  const convId = profileConversationId(accountDigest);
  const deviceId = ensureDeviceId();
  if (!mk || !convId || !selfDigest || !deviceId) throw new Error('Not unlocked: MK/account missing');
  const inputProfile = profile && typeof profile === 'object' ? profile : {};
  const sourceTag = typeof inputProfile?.sourceTag === 'string'
    ? inputProfile.sourceTag
    : typeof inputProfile?.source === 'string'
      ? inputProfile.source
      : 'unknown';
  const explicitAvatarWrite = sourceTag === PROFILE_WRITE_SOURCE.EXPLICIT;
  const targetIsSelf = !!(targetDigest && selfDigest && targetDigest === selfDigest);
  const hasAvatarField = Object.prototype.hasOwnProperty.call(inputProfile, 'avatar');
  const hasNicknameField = Object.prototype.hasOwnProperty.call(inputProfile, 'nickname');
  const avatarWasNull = hasAvatarField && inputProfile?.avatar === null;
  const allowSelfAvatarWrite = targetIsSelf
    ? (explicitAvatarWrite || sourceTag === PROFILE_WRITE_SOURCE.AVATAR_INIT)
    : true;
  const shouldStripAvatar = targetIsSelf && hasAvatarField && !allowSelfAvatarWrite;
  let normalizedInput = inputProfile;
  if (shouldStripAvatar) {
    normalizedInput = { ...inputProfile };
    delete normalizedInput.avatar;
  }
  if (targetIsSelf && (!hasNicknameField || !hasAvatarField)) {
    const existing = await loadLatestProfile().catch(() => null);

    // Preserve Nickname if missing
    if (!hasNicknameField && existing?.nickname) {
      if (normalizedInput === inputProfile) normalizedInput = { ...inputProfile };
      normalizedInput.nickname = existing.nickname;
    }

    // [FIX] Preserve Avatar if missing (and not explicitly set to null)
    if (!hasAvatarField && existing?.avatar) {
      if (normalizedInput === inputProfile) normalizedInput = { ...inputProfile };
      normalizedInput.avatar = existing.avatar;
    }
  }
  const fallbackNickname = '';
  const allowAvatar = !targetIsSelf || allowSelfAvatarWrite;
  const obj = normalizeProfilePayload(normalizedInput, { fallbackNickname, allowAvatar });
  if (shouldLogAvatarWrite()) {
    const avatarObjKey = hasAvatarField && inputProfile?.avatar?.objKey ? String(inputProfile.avatar.objKey) : null;
    const env = hasAvatarField ? inputProfile?.avatar?.env || null : null;
    const identiconHint = hasAvatarField
      ? inputProfile?.avatar?.identiconSeed || inputProfile?.avatar?.identiconSvg || inputProfile?.avatar?.identicon
      : null;
    const hashInputRaw = hasAvatarField
      ? env?.ct_b64 || avatarObjKey || JSON.stringify(env || {})
      : null;
    const payloadHash = hashInputRaw ? await hashString(String(hashInputRaw)) : null;
    emitAvatarWriteLog({
      callsiteTag: 'persistProfileControlState',
      targetAccountDigestSuffix8: targetDigest ? targetDigest.slice(-8) : null,
      selfAccountDigestSuffix8: selfDigest ? selfDigest.slice(-8) : null,
      sourceTag,
      hasAvatarField,
      avatarWasNull,
      attemptedIdenticonWrite: identiconHint ? true : null,
      avatarObjKeySuffix8: avatarObjKey ? avatarObjKey.slice(-8) : null,
      avatarPayloadHash: payloadHash || null,
      avatarPayloadHashSource: hashInputRaw ? (env?.ct_b64 ? 'env.ct_b64' : (avatarObjKey ? 'objKey' : 'avatar.env')) : null,
      targetIsSelf,
      avatarWriteAllowed: allowSelfAvatarWrite,
      avatarStripped: shouldStripAvatar
    });
  }
  const envelope = await wrapWithMK_JSON(obj, mk, PROFILE_INFO_TAG);
  const normalizedEnvelope = assertEnvelopeStrict(envelope, { allowInfoTags: PROFILE_ALLOWED_INFO_TAGS });

  // [Integrity Check] Verify encryption/encoding locally before upload
  try {
    if (DEBUG.contactsA1) console.log('[profile] performing integrity check for size:', normalizedEnvelope.ct_b64.length);
    const check = await unwrapWithMK_JSON(normalizedEnvelope, mk);
    if (!check) throw new Error('Decoded is null');
  } catch (err) {
    console.error('[profile] Integrity Check Failed - Encryption/Encoding is broken locally!', err);
    throw new Error(`Profile Integrity Check Failed: ${err.message}`);
  }

  const { counter, commit } = allocateDeviceCounter();
  const header = {
    profile: 1,
    v: 1,
    ts: obj.updatedAt,
    // Optimized: envelope removed to reduce header size; reconstructed on load
    iv_b64: normalizedEnvelope.iv_b64,
    hkdf_salt_b64: normalizedEnvelope.salt_b64, // Map from internal 'salt_b64'
    info_tag: normalizedEnvelope.info,          // Map from internal 'info'
    device_id: deviceId || undefined,
    n: counter,
    meta: { msgType: PROFILE_MESSAGE_TYPE, subtype: PROFILE_MESSAGE_TYPE }
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
      const maxCounter = Number.isFinite(data?.maxCounter)
        ? Number(data.maxCounter)
        : Number.isFinite(data?.details?.maxCounter)
          ? Number(data.details.maxCounter)
          : null;
      const seed = maxCounter === null ? 1 : maxCounter + 1;
      setDeviceCounter(seed);
      logProfileCounter({
        profileCounterTooLowPayload: {
          keys: data && typeof data === 'object' ? Object.keys(data) : typeof data,
          hasDetails: !!data?.details
        }
      });
      logProfileCounter({ profileCounterReseeded: { maxCounter, seed, source: 'CounterTooLow' } });
      return false;
    }
    const msg = typeof data === 'string' ? data : data?.error || data?.message || 'profile save failed';
    throw new Error(msg);
  }
  try { commit(); } catch { }
  return { ...obj, msgId: data?.id || null };
}

export async function loadLatestProfile(accountDigest = null) {
  const targetDigest = normalizeAccountDigest(accountDigest || getAccountDigest());
  const selfDigest = normalizeAccountDigest(getAccountDigest());
  const isSelf = !accountDigest || (!!targetDigest && !!selfDigest && targetDigest === selfDigest);
  const limit = isSelf ? 5 : 1;
  return loadProfileControlState(accountDigest, { limit });
}

export async function saveProfile(profile, { sourceTag = null, explicitAvatarWrite = null } = {}) {
  const hasAvatar = Object.prototype.hasOwnProperty.call(profile || {}, 'avatar') && profile?.avatar !== null;
  const shouldWriteAvatar = typeof explicitAvatarWrite === 'boolean' ? explicitAvatarWrite : hasAvatar;

  const saved = await persistProfileControlState(profile, {
    accountDigest: getAccountDigest(),
    sourceTag,
    explicitAvatarWrite: shouldWriteAvatar
  });
  if (saved === false) return false;
  const overridesForContacts = {
    nickname: saved.nickname || null,
    updatedAt: saved.updatedAt
  };
  if (Object.prototype.hasOwnProperty.call(saved || {}, 'avatar')) {
    overridesForContacts.avatar = saved.avatar || null;
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
  return saved;
}

export async function persistProfileForAccount(profile, accountDigest) {
  return persistProfileControlState(profile, { accountDigest });
}

export async function ensureProfileNickname() {
  const profile = await loadLatestProfile().catch(() => null);
  if (!profile) return profile;
  const normalized = normalizeNickname(profile?.nickname || '');
  if (!normalized) return { ...profile, nickname: profile?.nickname || '' };
  if (normalized !== profile?.nickname) {
    return { ...profile, nickname: normalized };
  }
  return { ...profile, nickname: normalized };
}

export async function initProfileDefaultsOnce({ uidHex, evidence, sourceTag = PROFILE_WRITE_SOURCE.EXPLICIT } = {}) {
  const hasEvidence = evidence && typeof evidence === 'object';
  const isFirstRegistration = hasEvidence
    && !evidence.backupExists
    && !evidence.vaultExists
    && !evidence.messagesExists;
  if (!isFirstRegistration) {
    return {
      ok: true,
      skipped: true,
      reason: hasEvidence ? 'server-evidence-present' : 'evidence-missing',
      nicknameWritten: false,
      avatarWritten: false
    };
  }
  const digest = normalizeAccountDigest(getAccountDigest());
  const deviceId = ensureDeviceId();
  if (!digest) throw new Error('account digest missing');
  if (!deviceId) throw new Error('deviceId missing');
  let existing = null;
  try {
    existing = await loadLatestProfile();
  } catch (err) {
    const wrapped = new Error(err?.message || 'profile lookup failed');
    wrapped.code = 'ProfileLookupFailed';
    throw wrapped;
  }
  const existingNickname = typeof existing?.nickname === 'string' ? existing.nickname.trim() : '';
  const hasNickname = !!existingNickname;
  const hasAvatar = !!existing?.avatar;
  if (hasNickname || hasAvatar) {
    return {
      ok: true,
      skipped: true,
      reason: hasNickname ? 'nickname-exists' : 'avatar-exists',
      nicknameWritten: false,
      avatarWritten: false
    };
  }
  const generated = await generateDeterministicNickname({ accountDigest: digest, deviceId });
  const normalized = normalizeNickname(generated);
  if (!normalized) throw new Error('nickname generation failed');
  const now = Date.now();
  const savedNickname = await saveProfile({ nickname: normalized, updatedAt: now, sourceTag });
  if (savedNickname === false) throw new Error('profile nickname save failed');
  const avatarResult = await initProfileAvatarFromIdenticonOnce({ uidHex, sourceTag: PROFILE_WRITE_SOURCE.AVATAR_INIT });
  return {
    ok: true,
    skipped: false,
    nicknameWritten: true,
    avatarWritten: !avatarResult?.skipped,
    nickname: savedNickname?.nickname || normalized,
    avatar: avatarResult?.avatar || null,
    avatarReason: avatarResult?.reason || null
  };
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
  const now = Date.now();
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
 * Default identicon persistence is disabled; identicon is UI-only.
 */
export async function ensureDefaultAvatarFromSeed({ seed, force = false } = {}) {
  if (force) {
    return { ok: false, skipped: true, reason: 'auto-avatar-disabled' };
  }
  return { ok: true, skipped: true, reason: 'auto-avatar-disabled' };
}

export async function initProfileAvatarFromIdenticonOnce({ uidHex, sourceTag = PROFILE_WRITE_SOURCE.AVATAR_INIT } = {}) {
  const digest = normalizeAccountDigest(getAccountDigest());
  if (!digest) throw new Error('account digest missing');
  const uid = uidHex;
  if (!uid) throw new Error('uid missing (uidHex parameter required)');
  let existing = null;
  try {
    existing = await loadLatestProfile();
  } catch (err) {
    const wrapped = new Error(err?.message || 'profile lookup failed');
    wrapped.code = 'ProfileLookupFailed';
    throw wrapped;
  }
  if (existing?.avatar) {
    return { ok: true, skipped: true, reason: 'avatar-exists' };
  }
  const rendered = await buildIdenticonImage(uid, { size: 512, format: 'image/png', quality: 0.92 });
  if (!rendered?.blob) throw new Error('identicon render failed');
  const file = new File([rendered.blob], `avatar-${digest.slice(-6)}.png`, { type: rendered.blob.type || 'image/png' });
  const avatarMeta = await uploadAvatar({ file, thumbDataUrl: rendered.dataUrl || null });
  const now = Date.now();
  const saved = await saveProfile({ avatar: avatarMeta, updatedAt: now, sourceTag });
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
