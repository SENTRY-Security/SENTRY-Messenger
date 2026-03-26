// /app/features/contacts.js
// Manage E2EE contacts list stored in contacts-<account_digest> conversation (UID fallback).

import { fetchJSON } from '../core/http.js';
import { createSecureMessage, fetchSecureMaxCounter } from '../api/messages.js';
import { createMessage } from '../api/media.js';
import {
  getMkRaw,
  getAccountDigest,
  getAccountToken,
  buildAccountPayload,
  normalizePeerIdentity,
  ensureDeviceId,
  normalizeAccountDigest,
  normalizeDeviceId,
  allocateDeviceCounter,
  setDeviceCounter
} from '../core/store.js';
import { ensureDrSession } from './dr-session.js';
import { normalizeNickname } from './profile.js';
import { decryptContactPayload, encryptContactPayload, isContactShareEnvelope } from './contact-share.js';
import { getContactSecret, setContactSecret, clearContactTombstone, isContactTombstoned } from '../core/contact-secrets.js';
import { log, logCapped } from '../core/log.js';
import { upsertContactCore, findContactCoreByAccountDigest, resolveContactAvatarUrl, listContactCoreEntries } from '../ui/mobile/contact-core-store.js';
import { restorePendingInvites, persistPendingInvites, sessionStore } from '../ui/mobile/session-store.js';
import { DEBUG } from '../ui/mobile/debug-flags.js';

const CONTACT_INFO_TAG = 'contact/v1';
const missingSecretWarned = new Set();
const CONTACT_SHARE_PENDING_LOG_CAP = 5;
const pendingContactShares = new Map();
const CONTACTS_CHANGED_EVENT = 'contacts:changed';
const CONTACTS_CHANGED_THROTTLE_MS = 2000;
const contactShareRefreshThrottle = new Map();
let lastContactsHydrateSummary = null;
function contactConvIds() {
  const ids = [];
  const acct = (getAccountDigest() || '').toUpperCase();
  if (acct) ids.push(`contacts-${acct}`);
  return ids;
}

function nowTs() {
  return Date.now();
}

function safePrefix(value, len) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, len);
}

function safeSuffix(value, len) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(-len);
}

function emitContactsChanged({ conversationId, peerKey, sourceTag }) {
  if (!conversationId || typeof conversationId !== 'string') return;
  if (typeof document === 'undefined') return;
  const now = Date.now();
  const last = contactShareRefreshThrottle.get(conversationId) || 0;
  const isLiveContactShare = sourceTag === 'messages-flow:contact-share-commit'
    || sourceTag === 'messages-flow:contact-share-commit-batch';
  if (now - last < CONTACTS_CHANGED_THROTTLE_MS && !isLiveContactShare) return;
  contactShareRefreshThrottle.set(conversationId, now);
  const reason = isLiveContactShare
    ? (sourceTag === 'messages-flow:contact-share-commit' ? 'contact-share-commit' : 'contact-share-commit-batch')
    : (sourceTag || 'contact-share-commit');
  const detail = {
    reason,
    conversationId,
    peerKey: peerKey || null,
    conversationIdPrefix8: safePrefix(conversationId, 8),
    peerKeyPrefix8: safePrefix(peerKey || '', 8),
    tsMs: now
  };
  try {
    document.dispatchEvent(new CustomEvent(CONTACTS_CHANGED_EVENT, { detail }));
  } catch { }
}

function normalizePendingMessageId(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function resolvePendingMessageId(item) {
  const messageId = normalizePendingMessageId(
    item?.id
    || item?.messageId
    || item?.message_id
    || item?.serverMessageId
    || item?.server_message_id
    || null
  );
  if (messageId) return messageId;
  return normalizePendingMessageId(item?.ts || null);
}

function buildPendingContactShareKey({ peerDigest, peerDeviceId, messageId }) {
  const digest = typeof peerDigest === 'string' ? peerDigest.trim() : '';
  const deviceId = typeof peerDeviceId === 'string' ? peerDeviceId.trim() : '';
  const msgId = normalizePendingMessageId(messageId);
  const parts = [digest, deviceId, msgId].filter(Boolean);
  return parts.length ? parts.join('::') : null;
}

function queuePendingContactShare({ peerDigest, peerDeviceId, envelope, item }) {
  if (!peerDigest || !peerDeviceId || !envelope) return null;
  const messageId = resolvePendingMessageId(item);
  const key = buildPendingContactShareKey({ peerDigest, peerDeviceId, messageId });
  if (!key) return null;
  pendingContactShares.set(key, {
    key,
    peerDigest,
    peerDeviceId,
    envelope,
    item
  });
  logCapped('contactSharePendingTrace', {
    peerDigestPrefix8: safePrefix(peerDigest, 8),
    peerDeviceIdSuffix4: safeSuffix(peerDeviceId, 4),
    reasonCode: 'MISSING_CONTACT_SECRET',
    queued: true
  }, CONTACT_SHARE_PENDING_LOG_CAP);
  return key;
}



function extractConversationFromContact(contact) {
  if (!contact?.conversation?.token_b64 || !contact?.conversation?.conversation_id) return null;
  const rawPeerDeviceId = contact.conversation.peerDeviceId || contact.conversation.peer_device_id || null;
  return {
    token_b64: String(contact.conversation.token_b64),
    conversation_id: String(contact.conversation.conversation_id),
    ...(contact.conversation.dr_init ? { dr_init: contact.conversation.dr_init } : null),
    ...(rawPeerDeviceId ? { peerDeviceId: rawPeerDeviceId } : null)
  };
}




function buildPendingSecretUpdate(conversation) {
  if (!conversation) return null;
  const conversationUpdate = {};
  if (conversation?.token_b64) conversationUpdate.token = conversation.token_b64;
  if (conversation?.conversation_id) conversationUpdate.id = conversation.conversation_id;
  if (conversation?.dr_init) conversationUpdate.drInit = conversation.dr_init;
  if (!Object.keys(conversationUpdate).length) return null;
  return {
    conversation: conversationUpdate,
    meta: { source: 'contacts:pending-secret' }
  };
}

function buildContactEntry({ contact, item, peerAccountDigest, conversation }) {
  const normalized = normalizeNickname(contact?.nickname || '') || '';
  const resolvedConversation = conversation || extractConversationFromContact(contact);
  return {
    peerAccountDigest,
    nickname: normalized,
    avatar: contact?.avatar || null,
    addedAt: Number(contact?.addedAt || item?.ts || nowTs()),
    msgId: item?.id || null,
    conversation: resolvedConversation
  };
}

function buildContactCorePayload(entry, peerDeviceId) {
  const conversationId = entry?.conversation?.conversation_id || null;
  const conversationToken = entry?.conversation?.token_b64 || null;
  if (!entry?.peerAccountDigest || !peerDeviceId || !conversationId || !conversationToken) return null;
  const conversation = {
    token_b64: conversationToken,
    conversation_id: conversationId,
    peerDeviceId,
    ...(entry?.conversation?.dr_init ? { dr_init: entry.conversation.dr_init } : null)
  };
  return {
    peerAccountDigest: entry.peerAccountDigest,
    peerDeviceId,
    nickname: entry.nickname ?? null,
    avatar: entry.avatar ?? null,
    addedAt: entry.addedAt ?? null,
    profileUpdatedAt: entry.profileUpdatedAt ?? null,
    profileVersion: entry.profileVersion ?? null,
    msgId: entry.msgId ?? null,
    conversationId,
    conversationToken,
    conversation,
    contactSecret: conversationToken
  };
}

function removePendingInvitesByPeer({ peerAccountDigest, peerDeviceId } = {}) {
  const identity = normalizePeerIdentity({ peerAccountDigest, peerDeviceId });
  const digest = identity.accountDigest || null;
  const deviceId = identity.deviceId || null;
  if (!digest || !deviceId) return 0;
  const store = restorePendingInvites();
  if (!(store instanceof Map)) return 0;
  const ids = [];
  for (const [inviteId, entry] of store.entries()) {
    if (entry?.ownerAccountDigest === digest && entry?.ownerDeviceId === deviceId) {
      ids.push(inviteId);
    }
  }
  if (!ids.length) return 0;
  for (const inviteId of ids) {
    store.delete(inviteId);
  }
  persistPendingInvites();
  return ids.length;
}

export async function applyContactShareFromCommit({
  peerAccountDigest,
  peerDeviceId,
  sessionKey,
  plaintext,
  messageId,
  sourceTag = 'messages-flow:contact-share-commit',
  profileUpdatedAt = null
} = {}) {
  const identity = normalizePeerIdentity({ peerAccountDigest, peerDeviceId });
  const digest = identity.accountDigest || null;
  const deviceId = identity.deviceId || null;
  if (!digest || !deviceId || !sessionKey || !plaintext) {
    return { ok: false, reasonCode: 'MISSING_PARAMS' };
  }
  // [FIX] Guard: never process a contact-share where peerAccountDigest is self.
  const selfDigest = normalizeAccountDigest(getAccountDigest() || null);
  if (selfDigest && digest === selfDigest) {
    return { ok: false, reasonCode: 'SELF_DIGEST_SKIP' };
  }
  // [FIX] Guard: reject contact-share for contacts the user has deleted.
  // Without this, any incoming message from a deleted contact resurrects them.
  if (isContactTombstoned(digest)) {
    return { ok: false, reasonCode: 'CONTACT_DELETED_SKIP' };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return { ok: false, reasonCode: 'INVALID_PLAINTEXT' };
  }
  const type = typeof parsed?.type === 'string' ? parsed.type.trim().toLowerCase() : '';
  if (type !== 'contact-share') {
    return { ok: false, reasonCode: 'NOT_CONTACT_SHARE' };
  }

  // DR-encrypted: plaintext contains contact data directly (nickname, avatar, conversation, etc.)
  const contact = parsed;
  if (!contact || typeof contact !== 'object') {
    return { ok: false, reasonCode: 'EMPTY_CONTACT' };
  }
  const conversation = extractConversationFromContact(contact);
  if (!conversation?.token_b64 || !conversation?.conversation_id) {
    return { ok: false, reasonCode: 'MISSING_CONVERSATION' };
  }
  if (!conversation?.dr_init) {
    return { ok: false, reasonCode: 'MISSING_DR_INIT' };
  }

  const conversationPeerDeviceId = normalizeDeviceId(conversation?.peerDeviceId || null);
  if (conversationPeerDeviceId && conversationPeerDeviceId !== deviceId) {
    return { ok: false, reasonCode: 'PEER_DEVICE_MISMATCH' };
  }

  const normalizedNickname = normalizeNickname(contact?.nickname || '') || '';
  const incomingProfileVersion = Number.isFinite(contact?.profileVersion) ? contact.profileVersion : null;
  // Always include peer device ID in the conversation blob so it persists
  // through D1 cloud backup/restore (the DR envelope provides it).
  const conversationWithDevice = conversation
    ? { ...conversation, peerDeviceId: conversation.peerDeviceId || deviceId }
    : conversation;
  const entry = {
    peerAccountDigest: digest,
    nickname: normalizedNickname,
    avatar: contact?.avatar || null,
    addedAt: Number(contact?.addedAt || nowTs()),
    profileVersion: incomingProfileVersion,
    msgId: messageId || null,
    conversation: conversationWithDevice
  };
  const corePayload = buildContactCorePayload(entry, deviceId);
  if (!corePayload) {
    return { ok: false, reasonCode: 'MISSING_CORE_FIELDS' };
  }
  if (profileUpdatedAt) {
    corePayload.profileUpdatedAt = profileUpdatedAt;
  }
  const selfDeviceId = ensureDeviceId();
  if (selfDeviceId) {
    setContactSecret(digest, {
      conversation: {
        token: conversation.token_b64,
        id: conversation.conversation_id,
        drInit: conversation.dr_init || null
      },
      deviceId: selfDeviceId,
      peerDeviceId: deviceId,
      meta: { source: sourceTag }
    });
  }
  // Determine Diff BEFORE upsert
  let diff = null;
  const existingScan = findContactCoreByAccountDigest(digest);
  const existingEntry = existingScan.find(m => m.entry?.conversationId === conversation.conversation_id)?.entry || existingScan[0]?.entry;

  if (existingEntry) {
    // Stale check: prefer profileVersion (monotonic integer) over timestamp.
    // If both sides have a profileVersion, use that for comparison.
    // Fall back to timestamp comparison for legacy payloads without profileVersion.
    const existingVersion = Number.isFinite(existingEntry.profileVersion) ? existingEntry.profileVersion : null;
    if (incomingProfileVersion !== null && existingVersion !== null && incomingProfileVersion <= existingVersion) {
      if (DEBUG.contactsA1) {
        console.log('[contacts] skipping stale update (profileVersion)', {
          digest,
          existingVersion,
          incomingVersion: incomingProfileVersion
        });
      }
      return { ok: true, reasonCode: 'STALE_SKIP', diff: null };
    }
    // If existing entry has a profileVersion but incoming doesn't (legacy client),
    // reject the update — once versioned, only versioned updates can replace.
    if (incomingProfileVersion === null && existingVersion !== null) {
      if (DEBUG.contactsA1) {
        console.log('[contacts] skipping unversioned update for versioned entry', {
          digest,
          existingVersion
        });
      }
      return { ok: true, reasonCode: 'STALE_SKIP', diff: null };
    }
    if (incomingProfileVersion === null && existingVersion === null && profileUpdatedAt && existingEntry.profileUpdatedAt && existingEntry.profileUpdatedAt > profileUpdatedAt) {
      if (DEBUG.contactsA1) {
        console.log('[contacts] skipping stale update (timestamp)', {
          digest,
          existingTs: existingEntry.profileUpdatedAt,
          incomingTs: profileUpdatedAt,
          diff: (existingEntry.profileUpdatedAt - profileUpdatedAt) / 1000 + 's'
        });
      }
      return { ok: true, reasonCode: 'STALE_SKIP', diff: null };
    }
    const oldName = existingEntry.nickname;
    const newName = normalizedNickname;
    const oldAvatar = resolveContactAvatarUrl(existingEntry);
    const newAvatar = resolveContactAvatarUrl({ avatar: contact?.avatar });

    if (DEBUG.contactsA1) {
      console.log('[contacts] diff check', {
        digest,
        oldName, newName,
        oldAvatar, newAvatar,
        hasExisting: !!existingEntry
      });
    }

    if (typeof newName === 'string' && typeof oldName === 'string' && newName !== oldName) {
      diff = diff || {};
      diff.nickname = { from: oldName, to: newName };
    }
    if (newAvatar !== oldAvatar) {
      diff = diff || {};
      diff.avatar = { from: oldAvatar, to: newAvatar };
    }
  } else {
    if (DEBUG.contactsA1) console.log('[contacts] diff check: no existing entry for', digest);
  }

  // Note: clearContactTombstone is NOT called here — tombstone is only cleared
  // when the user actively re-adds a friend (via contacts:readded event in
  // share-controller).  Incoming contact-share messages must not clear it.

  try {
    upsertContactCore(corePayload, sourceTag);
  } catch (err) {
    return { ok: false, reasonCode: 'CORE_UPSERT_FAILED', error: err };
  }
  if (DEBUG.contactsA1) console.log('[contacts] applyContactShareFromCommit: upsert success', { sourceTag, diff: !!diff });
  removePendingInvitesByPeer({ peerAccountDigest: digest, peerDeviceId: deviceId });
  const isContactShareCommit = sourceTag === 'messages-flow:contact-share-commit'
    || sourceTag === 'messages-flow:contact-share-commit-batch';
  if (isContactShareCommit) {
    const peerKey = identity.key || (digest && deviceId ? `${digest}::${deviceId}` : null);
    emitContactsChanged({
      conversationId: conversation.conversation_id,
      peerKey,
      sourceTag
    });
    // [FIX] Emit contacts:entry-updated so messages pane refreshes
    // active conversation header (name/avatar) and conversation list.
    // Both live (contact-share-commit) and batch (contact-share-commit-batch)
    // paths must emit this event to ensure UI is always updated.
    if (peerKey && typeof document !== 'undefined') {
      try {
        document.dispatchEvent(new CustomEvent('contacts:entry-updated', {
          detail: {
            peerAccountDigest: peerKey,
            peerKey,
            isNew: !existingEntry,
            entry: corePayload
          }
        }));
      } catch { /* ignore */ }
    }
  }

  // Auto-init X3DH session (fire and forget) to pre-warm keys
  // [Fix] Skip side effects (DR Init, D1 Uplink) if this is a history replay
  const isHistoryReplay = sourceTag === 'entry-fetch:history-contact-share';

  if (!isHistoryReplay) {
    ensureDrSession({ peerAccountDigest: digest, peerDeviceId: deviceId })
      .catch(err => console.warn('[contacts] auto-init failed', err));

    // [Migration] Sync new state to D1 (Self-Healing)
    // This ensures that if I come online and peer has changed Avatar/Nickname,
    // we save this new state to D1 immediately.
    const baseConversation = contact?.conversation ? extractConversationFromContact(contact) : conversationWithDevice;
    // Ensure peerDeviceId survives the D1 round-trip so restore can
    // reconstruct the correct contact-secrets key.
    const uplinkConversation = baseConversation
      ? { ...baseConversation, peerDeviceId: baseConversation.peerDeviceId || deviceId }
      : conversationWithDevice;
    const updatedEntry = { ...entry, conversation: uplinkConversation };
    uplinkContactToD1(updatedEntry).catch(err => console.warn('[contacts] uplink from share failed', err));
  } else {
    if (DEBUG.contactsA1) console.log('[contacts] skipping side effects for history replay', { digest });
  }

  return { ok: true, diff };
}

export async function loadContacts() {
  const mk = getMkRaw();
  const convIds = contactConvIds();
  if (!mk || !convIds.length) throw new Error('Not unlocked: MK/account missing');
  const selfDigest = (getAccountDigest() || '').toUpperCase();
  const deviceId = ensureDeviceId();
  const DEBUG_CONTACTS_A1 = DEBUG.contactsA1 === true;

  // [Store Only] D1/R2 Architecture
  let d1Entries = [];
  try {
    const d1Contacts = await downlinkContactsFromD1();
    const rawEntries = d1Contacts || [];
    console.log('[contacts] D1 Restore:', rawEntries.length);

    // Cross-reference: contact-secrets backup (already hydrated before this
    // function runs) is the authoritative list of which contacts should exist.
    // If D1 has a row but the secrets backup does NOT contain that peer, it
    // means the contact was deleted and the D1 row is stale.  We skip it and
    // clean up the D1 row in the background.
    const secretsMap = sessionStore.contactSecrets instanceof Map ? sessionStore.contactSecrets : null;

    for (const c of rawEntries) {
      const peerDigest = normalizeAccountDigest(c.peerAccountDigest);
      if (!peerDigest) continue;
      if (selfDigest && peerDigest === selfDigest) continue;

      // Check if contact-secrets backup has ANY entry for this peer
      let hasSecret = false;
      if (secretsMap && secretsMap.size > 0) {
        for (const k of secretsMap.keys()) {
          if (k.startsWith(peerDigest + '::') || k === peerDigest) {
            hasSecret = true;
            break;
          }
        }
      }

      // If secrets backup has entries but this peer is NOT in it → stale D1 row
      if (secretsMap && secretsMap.size > 0 && !hasSecret) {
        console.log('[contacts] D1 stale row detected (not in secrets backup), cleaning:', peerDigest);
        deleteContactFromD1(peerDigest).catch(err =>
          console.warn('[contacts] stale D1 cleanup failed', err)
        );
        continue;
      }

      d1Entries.push({
        ...c,
        conversation: c.conversation,
        msgId: 'restored-from-d1'
      });
    }

    console.log('[contacts] D1 after filtering:', d1Entries.length);

    // Re-inject conversation secrets and core store.
    // Vault backup restore (hydrateContactSecretsFromBackup) has already run
    // and is the primary source of conversationToken.  D1 restore provides
    // per-contact metadata (nickname, avatar) and also carries the token as
    // a secondary write — but only when peerDeviceId is present in the blob.
    d1Entries.forEach(e => {
      const peerDevId = e.conversation?.peerDeviceId || null;

      if (e.conversation?.token_b64 && peerDevId) {
        setContactSecret(e.peerAccountDigest, {
          conversation: {
            token: e.conversation.token_b64,
            id: e.conversation.conversation_id,
            drInit: e.conversation.dr_init
          },
          deviceId: deviceId,
          peerDeviceId: peerDevId
        });
      }

      const corePayload = buildContactCorePayload(e, peerDevId || 'unknown');
      if (corePayload) upsertContactCore(corePayload, 'd1-restore');
    });

  } catch (err) {
    console.warn('[contacts] D1 download failed', err);
  }

  lastContactsHydrateSummary = { ok: true, peerCount: d1Entries.length, source: 'D1' };
  return d1Entries;
}

export async function flushPendingContactShares({ mk } = {}) {
  void mk;
  const attempted = pendingContactShares.size;
  let okCount = 0;
  let skippedMissingSecretCount = 0;
  let failCount = 0;
  const failReasons = {};
  const deviceId = ensureDeviceId();
  const bumpFail = (code) => {
    failCount += 1;
    if (!code) return;
    failReasons[code] = (failReasons[code] || 0) + 1;
  };
  for (const [key, pending] of Array.from(pendingContactShares.entries())) {
    const peerDigest = pending?.peerDigest || null;
    const peerDeviceId = pending?.peerDeviceId || null;
    const envelope = pending?.envelope || null;
    if (!peerDigest || !peerDeviceId || !envelope) {
      bumpFail('MISSING_PENDING_FIELDS');
      continue;
    }
    const secretInfo = getContactSecret(peerDigest, {
      deviceId: peerDeviceId,
      peerDeviceId
    });
    const sessionKey = secretInfo?.conversationToken || secretInfo?.conversation?.token || null;
    if (!sessionKey) {
      skippedMissingSecretCount += 1;
      continue;
    }
    let contact = null;
    try {
      contact = await decryptContactPayload(sessionKey, envelope);
    } catch (err) {
      bumpFail('DECRYPT_FAILED');
      continue;
    }
    if (!contact) {
      bumpFail('EMPTY_CONTACT');
      continue;
    }
    const conversation = extractConversationFromContact(contact);
    const pendingSecretUpdate = buildPendingSecretUpdate(conversation);
    if (pendingSecretUpdate && deviceId) {
      setContactSecret(peerDigest, {
        ...pendingSecretUpdate,
        deviceId,
        peerDeviceId
      });
    }
    const entry = buildContactEntry({
      contact,
      item: pending?.item,
      peerAccountDigest: peerDigest,
      conversation
    });
    const corePayload = buildContactCorePayload(entry, peerDeviceId);
    if (!corePayload) {
      bumpFail('MISSING_CONVERSATION');
      continue;
    }
    try {
      upsertContactCore(corePayload, 'contacts:pending-contact-share-flush');
    } catch (err) {
      bumpFail('CORE_UPSERT_ERROR');
      continue;
    }
    pendingContactShares.delete(key);
    okCount += 1;
  }
  logCapped('contactSharePendingFlushTrace', {
    attempted,
    okCount,
    skippedMissingSecretCount,
    failCount,
    failReasons
  }, CONTACT_SHARE_PENDING_LOG_CAP);
  return {
    attempted,
    okCount,
    skippedMissingSecretCount,
    failCount,
    failReasons
  };
}
export function getLastContactsHydrateSummary() {
  if (!lastContactsHydrateSummary) return null;
  try {
    return JSON.parse(JSON.stringify(lastContactsHydrateSummary));
  } catch {
    return { ...lastContactsHydrateSummary };
  }
}


export async function saveContact(contact) {
  if (DEBUG.contactsA1) {
    console.log('[contacts]', {
      contactSaveStart: {
        peerAccountDigest: contact?.peerAccountDigest ?? null,
        hasConversation: !!(contact?.conversation?.conversation_id && contact?.conversation?.token_b64),
        hasSecret: !!contact?.contactSecret,
        nickname: contact?.nickname,
        avatar: !!contact?.avatar
      }
    });
  }
  const mk = getMkRaw();
  const convIds = contactConvIds();
  if (!mk || !convIds.length) {
    console.warn('[contacts] contactSaveEarlyReturn: missing-mk-or-conv');
    throw new Error('Not unlocked: MK/account missing');
  }
  const deviceId = ensureDeviceId();
  let digest = null;
  let peerDeviceId = null;
  if (typeof contact?.peerAccountDigest === 'string' && contact.peerAccountDigest.includes('::')) {
    const [dPart, devPart] = contact.peerAccountDigest.split('::');
    digest = normalizeAccountDigest(dPart);
    peerDeviceId = normalizeDeviceId(devPart);
  }
  const identity = normalizePeerIdentity({
    peerAccountDigest: contact?.peerAccountDigest ?? null,
    peerDeviceId: peerDeviceId ?? null
  });
  const peerAccountDigest = digest || identity.accountDigest || null;
  peerDeviceId = peerDeviceId || identity.deviceId || null;
  if (!peerAccountDigest || !peerDeviceId) {
    console.warn('[contacts]', { contactSaveEarlyReturn: 'missing-peer-digest' });
    throw new Error('peerAccountDigest/peerDeviceId required');
  }
  const peerKey = `${peerAccountDigest}::${peerDeviceId}`;

  const conversation = contact?.conversation && contact.conversation.token_b64 && contact.conversation.conversation_id
    ? {
      token_b64: String(contact.conversation.token_b64),
      conversation_id: String(contact.conversation.conversation_id),
      ...(contact.conversation.dr_init ? { dr_init: contact.conversation.dr_init } : null)
    }
    : null;
  // conversation peer 裝置以解析出的 peerDeviceId 為唯一來源，不從其他欄位補或覆寫。
  if (conversation) {
    conversation.peerDeviceId = peerDeviceId;
  }
  if (conversation && conversation.conversation_id && String(conversation.conversation_id).startsWith('contacts-')) {
    throw new Error('缺少安全對話 ID，請重新同步好友（contacts-* 無效）');
  }
  if (DEBUG.contactsA1) {
    console.log('[contacts]', {
      contactSaveConversationNormalized: {
        peerAccountDigest,
        conversationId: conversation?.conversation_id || null,
        hasDrInit: !!conversation?.dr_init,
        peerDeviceId: conversation?.peerDeviceId || null
      }
    });
  }

  const normalizedNickname = normalizeNickname(contact?.nickname || '');
  const avatar = contact?.avatar || null;
  if (!normalizedNickname && !avatar) {
    throw new Error('contact nickname/avatar required');
  }
  const payload = {
    peerAccountDigest: peerKey,
    accountDigest: peerAccountDigest,
    peerDeviceId,
    nickname: normalizedNickname,
    avatar,
    addedAt: Number(contact?.addedAt || nowTs())
  };
  if (conversation) payload.conversation = conversation;

  // Ensure we have a session key for encryption
  const sessionKey = contact.contactSecret || conversation?.token_b64 || getContactSecret(peerKey)?.conversationToken;
  if (!sessionKey) {
    console.warn('[contacts]', { contactSaveSkippedMissingKey: true, peerAccountDigest });
    return { ...payload, msgId: null };
  }

  // DEBUG: Check for Self-Identity Corruption
  try {
    const selfDigest = (getAccountDigest() || '').toUpperCase();
    if (peerAccountDigest === selfDigest) {
      console.warn('[contacts] self-save detected');
    }
  } catch { }

  try {
    const envelope = await encryptContactPayload(sessionKey, payload);
    const { counter, commit } = allocateDeviceCounter();
    const header = {
      contact: 1,
      v: 1,
      ts: payload.addedAt,
      envelope,
      device_id: deviceId,
      n: counter,
      peerAccountDigest,
      peerDeviceId,
      accountDigest: peerAccountDigest
    };
    const ciphertextB64 = envelope.ct_b64 || envelope.ct;
    if (!ciphertextB64) throw new Error('contact ciphertext missing');

    const messageId = crypto.randomUUID();
    const { r, data } = await createSecureMessage({
      conversationId: convIds[0],
      header,
      ciphertextB64,
      counter,
      senderDeviceId: deviceId,
      receiverAccountDigest: (getAccountDigest() || '').toUpperCase(),
      receiverDeviceId: deviceId, // Target myself
      id: messageId,
      createdAt: payload.addedAt
    });

    if (!r.ok) {
      if (r.status === 409 && data?.error === 'CounterTooLow') {
        let maxCounter = Number.isFinite(data?.max_counter)
          ? Number(data.max_counter)
          : Number.isFinite(data?.details?.max_counter)
            ? Number(data.details.max_counter)
            : null;
        if (maxCounter === null) {
          try {
            const probe = await fetchSecureMaxCounter({ conversationId: convIds[0], senderDeviceId: deviceId });
            if (probe?.r?.ok && Number.isFinite(probe?.data?.maxCounter)) {
              maxCounter = probe.data.maxCounter;
            }
          } catch {}
        }
        const seed = maxCounter === null ? 1 : maxCounter + 1;
        setDeviceCounter(seed);
        log({
          contactSaveCounterTooLow: {
            peerAccountDigest,
            maxCounter,
            seed
          }
        });
        return false;
      }
      const msg = typeof data === 'string' ? data : data?.error || data?.message || 'contact save failed';
      throw new Error(msg);
    }

    try { commit(); } catch { }
    console.log('[contacts]', { contactSaved: true, msgId: data?.id || messageId, peerAccountDigest });

    // [Migration] Uplink to D1
    uplinkContactToD1(payload).catch(err => console.warn('[contacts] uplink bg failed', err));

    return { ...payload, msgId: data?.id || messageId };

  } catch (err) {
    console.error('[contacts] save failed', err);
    throw err;
  }
}

// ---- D1/R2 Storage Migration Logic ----

async function deriveContactStorageKey(mkRaw) {
  if (!mkRaw) return null;
  // HKDF-SHA256: derive 32-byte storage key from MK
  const keyMaterial = await crypto.subtle.importKey('raw', mkRaw, 'HKDF', false, ['deriveKey']);
  return await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode('contact-storage-v1'),
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

const CONTACT_BLOB_AAD = new TextEncoder().encode('contact-storage-v1');

// Derive a per-peer opaque slot ID: HMAC-SHA256(slotKey, peer_digest).
// slotKey is derived from MK via HKDF with a distinct info string, so it is
// independent of the storageKey used for encryption.
async function deriveContactSlotKey(mkRaw) {
  if (!mkRaw) return null;
  const keyMaterial = await crypto.subtle.importKey('raw', mkRaw, 'HKDF', false, ['deriveKey']);
  return await crypto.subtle.deriveKey(
    { name: 'HKDF', salt: new Uint8Array(0), info: new TextEncoder().encode('contact-slot-v1'), hash: 'SHA-256' },
    keyMaterial,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign']
  );
}

async function deriveContactSlotId(slotKey, peerDigest) {
  if (!slotKey || !peerDigest) return null;
  const sig = await crypto.subtle.sign('HMAC', slotKey, new TextEncoder().encode(peerDigest.toUpperCase()));
  return bytesToBase64Url(new Uint8Array(sig));
}

async function encryptContactBlob(storageKey, data) {
  if (!storageKey || !data) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(data));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: CONTACT_BLOB_AAD }, storageKey, encoded);
  // Format: v2:iv_b64:ct_b64 (v2 = with AAD)
  return `v2:${bytesToBase64Url(iv)}:${bytesToBase64Url(new Uint8Array(ct))}`;
}

async function decryptContactBlob(storageKey, blobStr) {
  if (!storageKey || !blobStr) return null;
  const parts = blobStr.split(':');
  // v2 format: v2:iv_b64:ct_b64 (with AAD)
  // legacy format: iv_b64:ct_b64 (no AAD)
  let iv, ct, useAad;
  if (parts.length === 3 && parts[0] === 'v2') {
    iv = b64ToU8(parts[1]);
    ct = b64ToU8(parts[2]);
    useAad = true;
  } else if (parts.length === 2) {
    iv = b64ToU8(parts[0]);
    ct = b64ToU8(parts[1]);
    useAad = false;
  } else {
    return null;
  }
  if (!iv || !ct) return null;
  try {
    const params = { name: 'AES-GCM', iv };
    if (useAad) params.additionalData = CONTACT_BLOB_AAD;
    let dec;
    try {
      dec = await crypto.subtle.decrypt(params, storageKey, ct);
    } catch {
      // Fallback: retry with opposite AAD for transition-window data
      const fallbackParams = { name: 'AES-GCM', iv };
      if (!useAad) fallbackParams.additionalData = CONTACT_BLOB_AAD;
      dec = await crypto.subtle.decrypt(fallbackParams, storageKey, ct);
    }
    return JSON.parse(new TextDecoder().decode(dec));
  } catch {
    return null;
  }
}

// Helpers for base64 (duplicated from worker but needed in frontend context if not imported)
function bytesToBase64Url(u8) {
  let bin = '';
  for (let i = 0; i < u8.length; i += 1) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function b64ToU8(str) {
  try {
    const bin = atob((str || '').replace(/-/g, '+').replace(/_/g, '/'));
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  } catch { return null; }
}

export async function uplinkContactToD1(contactEntry, { isBlocked = false } = {}) {
  const mk = getMkRaw();
  const accountToken = getAccountToken();
  if (!mk || !accountToken) return;
  const storageKey = await deriveContactStorageKey(mk);
  if (!storageKey) return;

  const peerDigest = contactEntry.peerAccountDigest;
  if (!peerDigest) return;

  const slotKey = await deriveContactSlotKey(mk);
  const slotId = await deriveContactSlotId(slotKey, peerDigest);

  // Prepare Blob Data — peer_digest and isBlocked are now inside the encrypted blob
  const data = {
    peerDigest: peerDigest.toUpperCase(),
    isBlocked: isBlocked ? true : false,
    nickname: contactEntry.nickname,
    avatar: contactEntry.avatar,
    note: contactEntry.note || null,
    addedAt: contactEntry.addedAt,
    profileUpdatedAt: contactEntry.profileUpdatedAt,
    profileVersion: contactEntry.profileVersion ?? null,
    conversation: contactEntry.conversation
  };

  const encryptedBlob = await encryptContactBlob(storageKey, data);
  if (!encryptedBlob) return;

  try {
    await fetchJSON('/api/v1/contacts/uplink', {
      accountToken,
      contacts: [{
        slotId,
        encryptedBlob
      }],
      // Tell server to delete the old legacy row for this peer
      migratedPeerDigests: [peerDigest]
    }, { 'X-Device-Id': ensureDeviceId() });
  } catch (err) {
    console.warn('[contacts] uplink failed', err);
  }
}

export async function computeContactSlotId(peerDigest) {
  const mk = getMkRaw();
  if (!mk || !peerDigest) return null;
  const slotKey = await deriveContactSlotKey(mk);
  return await deriveContactSlotId(slotKey, peerDigest);
}

export async function deleteContactFromD1(peerDigest) {
  const mk = getMkRaw();
  const accountToken = getAccountToken();
  if (!mk || !accountToken || !peerDigest) return;
  const slotKey = await deriveContactSlotKey(mk);
  const slotId = await deriveContactSlotId(slotKey, peerDigest);
  if (!slotId) return;
  try {
    await fetchJSON('/api/v1/contacts/uplink', {
      accountToken,
      contacts: [],
      migratedPeerDigests: [peerDigest],
      deleteSlotIds: [slotId]
    }, { 'X-Device-Id': ensureDeviceId() });
  } catch (err) {
    console.warn('[contacts] D1 delete failed', err);
  }
}

export async function downlinkContactsFromD1() {
  const mk = getMkRaw();
  const accountToken = getAccountToken();
  if (!mk || !accountToken) throw new Error('MK/Token required');
  const storageKey = await deriveContactStorageKey(mk);

  const { r, data } = await fetchJSON('/api/v1/contacts/downlink', {
    accountToken
  }, { 'X-Device-Id': ensureDeviceId() });

  if (!r.ok) {
    if (r.status === 404) return [];
    const msg = data?.message || data?.error || r.statusText;
    console.warn(`[contacts] D1 download failed status=${r.status}`, data);
    throw new Error('downlink failed: ' + msg);
  }

  const contacts = data?.contacts || [];
  const entries = [];
  const legacyRowsToMigrate = []; // legacy rows that need re-upload in new format

  for (const row of contacts) {
    try {
      const encryptedBlob = row.encryptedBlob || row.encrypted_blob;
      if (!encryptedBlob) continue;
      const decrypted = await decryptContactBlob(storageKey, encryptedBlob);
      if (!decrypted) continue;

      const slotId = row.slotId || row.slot_id;
      const legacyPeerDigest = row.peerDigest || row.peer_digest;

      // Determine peerAccountDigest: new format stores it inside blob, legacy in row
      const peerAccountDigest = decrypted.peerDigest || legacyPeerDigest;
      const isBlocked = decrypted.isBlocked ?? row.isBlocked ?? row.is_blocked ?? false;

      const entry = {
        peerAccountDigest,
        nickname: decrypted.nickname,
        avatar: decrypted.avatar,
        addedAt: decrypted.addedAt,
        profileUpdatedAt: decrypted.profileUpdatedAt,
        profileVersion: decrypted.profileVersion ?? null,
        isBlocked,
        conversation: decrypted.conversation || null
      };
      entries.push(entry);

      // If this is a legacy row (has peer_digest, no slot_id), queue for migration
      if (legacyPeerDigest && !slotId) {
        legacyRowsToMigrate.push(entry);
      }
    } catch (err) {
      console.warn('[contacts] decrypt row failed', err);
    }
  }

  // Background: migrate legacy rows to new slot_id format
  if (legacyRowsToMigrate.length > 0) {
    _migrateLegacyContacts(mk, legacyRowsToMigrate).catch(err => {
      console.warn('[contacts] legacy migration failed', err);
    });
  }

  return entries;
}

async function _migrateLegacyContacts(mkRaw, legacyEntries) {
  const accountToken = getAccountToken();
  if (!accountToken || !mkRaw) return;
  const storageKey = await deriveContactStorageKey(mkRaw);
  const slotKey = await deriveContactSlotKey(mkRaw);
  if (!storageKey || !slotKey) return;

  const newContacts = [];
  const migratedPeerDigests = [];

  for (const entry of legacyEntries) {
    const peerDigest = entry.peerAccountDigest;
    if (!peerDigest) continue;

    const slotId = await deriveContactSlotId(slotKey, peerDigest);
    if (!slotId) continue;

    // Re-encrypt with peer_digest and isBlocked inside the blob
    const data = {
      peerDigest: peerDigest.toUpperCase(),
      isBlocked: entry.isBlocked ? true : false,
      nickname: entry.nickname,
      avatar: entry.avatar,
      note: entry.note || null,
      addedAt: entry.addedAt,
      profileUpdatedAt: entry.profileUpdatedAt,
      profileVersion: entry.profileVersion ?? null,
      conversation: entry.conversation
    };

    const encryptedBlob = await encryptContactBlob(storageKey, data);
    if (!encryptedBlob) continue;

    newContacts.push({ slotId, encryptedBlob });
    migratedPeerDigests.push(peerDigest);
  }

  if (!newContacts.length) return;

  try {
    await fetchJSON('/api/v1/contacts/uplink', {
      accountToken,
      contacts: newContacts,
      migratedPeerDigests
    }, { 'X-Device-Id': ensureDeviceId() });
    console.log(`[contacts] migrated ${newContacts.length} legacy rows to slot_id format`);
  } catch (err) {
    console.warn('[contacts] migration uplink failed', err);
  }
}

export async function backupAllContactsToD1() {
  const accountDigest = getAccountDigest();
  const mk = getMkRaw();
  if (!accountDigest || !mk) return; // Locked or not logged in

  const entries = listContactCoreEntries();
  if (!entries.length) return;

  const storageKey = await deriveContactStorageKey(mk);

  for (const entry of entries) {
    if (!entry || !entry.peerAccountDigest) continue;

    // Skip backing up my own entry logic if it exists (though listContactCoreEntries shouldn't return it)
    if (entry.peerAccountDigest === accountDigest) continue;

    const data = {
      nickname: entry.nickname,
      avatar: entry.avatar,
      addedAt: entry.addedAt,
      profileUpdatedAt: entry.profileUpdatedAt, // [Fix] Persist timestamp in backup
      profileVersion: entry.profileVersion ?? null,
      conversation: entry.conversation // Backup the keys too!
    };
    try {
      const encryptedBlob = await encryptContactBlob(storageKey, data);
      // We should really batch this or use uplinkContactToD1?
      // uplinkContactToD1 expects "contactEntry" with fields.
      // uplinkContactToD1 Logic:
      // const data = { nickname: contactEntry.nickname, ... }
      // const encryptedBlob = await encryptContactBlob(storageKey, data);
      // await post('/d1/contacts/upsert', ...);

      // Re-using uplinkContactToD1 is safer to avoid duplication.
      await uplinkContactToD1(entry);
    } catch (err) {
      console.warn('[contacts] backup item failed', { peer: entry.peerAccountDigest, err });
    }
  }
}



