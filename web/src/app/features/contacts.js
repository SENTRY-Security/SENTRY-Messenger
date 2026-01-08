// /app/features/contacts.js
// Manage E2EE contacts list stored in contacts-<account_digest> conversation (UID fallback).

import { listMessages } from '../api/messages.js';
import { createMessage } from '../api/media.js';
import { wrapWithMK_JSON, unwrapWithMK_JSON } from '../crypto/aead.js';
import {
  getMkRaw,
  getAccountDigest,
  buildAccountPayload,
  normalizePeerIdentity,
  ensureDeviceId,
  normalizeAccountDigest,
  normalizeDeviceId
} from '../core/store.js';
import { normalizeNickname } from './profile.js';
import { decryptContactPayload, isContactShareEnvelope } from './contact-share.js';
import { getContactSecret, setContactSecret, restoreContactSecrets } from '../core/contact-secrets.js';
import { logCapped } from '../core/log.js';
import { upsertContactCore } from '../ui/mobile/contact-core-store.js';
import { DEBUG } from '../ui/mobile/debug-flags.js';

const CONTACT_INFO_TAG = 'contact/v1';
const missingSecretWarned = new Set();
const CONTACT_SHARE_PENDING_LOG_CAP = 5;
const pendingContactShares = new Map();
let lastContactsHydrateSummary = null;
function contactConvIds() {
  const ids = [];
  const acct = (getAccountDigest() || '').toUpperCase();
  if (acct) ids.push(`contacts-${acct}`);
  return ids;
}

function nowTs() {
  return Math.floor(Date.now() / 1000);
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

function logContactShareDropTrace({ peerDigest, peerDeviceId, reasonCode } = {}) {
  logCapped('contactShareDropTrace', {
    peerDigestPrefix8: safePrefix(peerDigest, 8),
    peerDeviceIdSuffix4: safeSuffix(peerDeviceId, 4),
    reasonCode: reasonCode || null
  }, CONTACT_SHARE_PENDING_LOG_CAP);
}

function extractConversationFromContact(contact) {
  if (!contact?.conversation?.token_b64 || !contact?.conversation?.conversation_id) return null;
  return {
    token_b64: String(contact.conversation.token_b64),
    conversation_id: String(contact.conversation.conversation_id),
    ...(contact.conversation.dr_init ? { dr_init: contact.conversation.dr_init } : null)
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
    msgId: entry.msgId ?? null,
    conversationId,
    conversationToken,
    conversation,
    contactSecret: conversationToken
  };
}

export async function loadContacts() {
  const mk = getMkRaw();
  const convIds = contactConvIds();
  if (!mk || !convIds.length) throw new Error('Not unlocked: MK/account missing');
  const selfDigest = (getAccountDigest() || '').toUpperCase();
  const deviceId = ensureDeviceId();
  const DEBUG_CONTACTS_A1 = DEBUG.contactsA1 === true;

  restoreContactSecrets();

  const aggregatedItems = [];
  const diag = {
    status: null,
    itemCount: 0,
    decryptOkCount: 0,
    missingPeerDeviceCount: 0,
    missingConvFieldsCount: 0
  };
  let debugContactsA1Logged = 0;

  for (const convId of convIds) {
    const { r, data } = await listMessages({ convId, limit: 100 });
    if (diag.status === null && r) diag.status = r.status ?? null;
    if (r.status === 404) {
      continue;
    }
    if (!r.ok) {
      const msg = typeof data === 'string' ? data : data?.error || data?.message || 'load contacts failed';
      lastContactsHydrateSummary = { ...diag, ok: false, error: msg, status: r.status ?? diag.status ?? null };
      throw new Error(msg);
    }
    const items = Array.isArray(data?.items) ? data.items : [];
    diag.itemCount += items.length;
    if (items.length) {
      aggregatedItems.push(...items);
    }
  }

  if (!aggregatedItems.length) {
    lastContactsHydrateSummary = { ...diag, ok: true, peerCount: 0 };
    return [];
  }

  const peerMap = new Map();
  for (const item of aggregatedItems) {
    try {
      const header = item?.header_json ? JSON.parse(item.header_json) : item?.header;
      const envelope = header?.envelope;
      if (!header?.contact || !envelope) continue;
      const identityFromHeader = normalizePeerIdentity({
        peerAccountDigest: header?.peerAccountDigest || header?.accountDigest || null
      });
      const peerDigest = identityFromHeader.key || identityFromHeader.accountDigest || null;
      if (!peerDigest) {
        console.warn('[contacts]', { contactMissingDigest: item?.id || null });
        logContactShareDropTrace({
          peerDigest: header?.peerAccountDigest || header?.accountDigest || null,
          peerDeviceId: header?.peerDeviceId || envelope?.peerDeviceId || item?.peer_device_id || null,
          reasonCode: 'MISSING_PEER_DIGEST'
        });
        continue;
      }
      const peerAccountDigest = peerDigest;
      const peerDeviceIdFromHeader = header?.peerDeviceId || envelope?.peerDeviceId || item?.peer_device_id || null;
      if (!peerDeviceIdFromHeader) {
        console.warn('[contacts]', { contactMissingPeerDevice: item?.id || null, peerAccountDigest });
        logContactShareDropTrace({
          peerDigest,
          peerDeviceId: null,
          reasonCode: 'MISSING_PEER_DEVICE_ID'
        });
        diag.missingPeerDeviceCount += 1;
        continue; // 嚴禁 fallback：沒有對端裝置就不處理
      }
      let contact = null;
      let conversation = null;
      let pendingSecretUpdate = null;
      if (envelope?.aead === 'aes-256-gcm') {
        contact = await unwrapWithMK_JSON(envelope, mk);
      } else if (isContactShareEnvelope(envelope) && peerDigest) {
        // contact-secret 必須用「對端裝置」索引，禁止 fallback 自己
        const secretInfo = getContactSecret(peerDigest, {
          deviceId: peerDeviceIdFromHeader,
          peerDeviceId: peerDeviceIdFromHeader
        });
        const sessionKey = secretInfo?.conversationToken || secretInfo?.conversation?.token || null;
        if (!sessionKey) {
          const warnKey = peerDigest;
          if (!missingSecretWarned.has(warnKey)) {
            missingSecretWarned.add(warnKey);
            console.warn('[contacts] missing contact secret for', warnKey);
          }
          queuePendingContactShare({
            peerDigest,
            peerDeviceId: peerDeviceIdFromHeader,
            envelope,
            item
          });
        } else {
          try {
            contact = await decryptContactPayload(sessionKey, envelope);
          } catch (err) {
            console.warn('[contacts] contact-share decrypt failed', err?.message || err);
            continue;
          }
          if (DEBUG_CONTACTS_A1) {
            try {
              console.log('[contacts] decrypted contact-share', peerDigest, JSON.stringify(contact));
            } catch {
              console.log('[contacts] decrypted contact-share', peerDigest, contact);
            }
          }
          if (!contact) continue;
          conversation = extractConversationFromContact(contact);
          pendingSecretUpdate = buildPendingSecretUpdate(conversation);
        }
      } else {
        console.warn('[contacts] unsupported envelope format', { id: item?.id, envelope });
        logContactShareDropTrace({
          peerDigest,
          peerDeviceId: peerDeviceIdFromHeader,
          reasonCode: 'NOT_CONTACT_SHARE'
        });
        continue;
      }

      if (!contact) continue;

      const normalized = normalizeNickname(contact?.nickname || '') || '';
      if (!conversation) {
        conversation = extractConversationFromContact(contact);
      }
      if (conversation && !(conversation.token_b64 && conversation.conversation_id)) {
        diag.missingConvFieldsCount += 1;
      }
      if (!conversation) {
        diag.missingConvFieldsCount += 1;
      }
      if (contact) {
        diag.decryptOkCount += 1;
      }
      if (pendingSecretUpdate) {
        setContactSecret({ peerAccountDigest }, {
          ...pendingSecretUpdate,
          deviceId,
          peerDeviceId: peerDeviceIdFromHeader
        });
      }
      const entry = {
        peerAccountDigest,
        nickname: normalized,
        avatar: contact?.avatar || null,
        addedAt: Number(contact?.addedAt || item?.ts || nowTs()),
        msgId: item?.id || null,
        conversation
      };
      if (DEBUG_CONTACTS_A1 && debugContactsA1Logged < 3) {
        debugContactsA1Logged += 1;
        const conversationId = entry?.conversation?.conversation_id || entry?.conversation?.id || null;
        const conversationTokenPresent = !!entry?.conversation?.token_b64;
        const nicknamePresent = entry?.nickname !== null && entry?.nickname !== undefined;
        const avatarPresent = !!entry?.avatar;
        try {
          console.log('[contacts][A1]', {
            loadContactsEntry: true,
            peerAccountDigest: entry.peerAccountDigest,
            conversationId,
            conversationTokenPresent,
            nicknamePresent,
            avatarPresent
          });
        } catch {}
      }
      const selfKeys = new Set([selfDigest].filter(Boolean));
      const isSelfContact = !!peerDigest && selfKeys.has(peerDigest);
      if (isSelfContact) {
        entry.isSelfContact = true;
        entry.hidden = true;
      }
      const mapKey = entry.peerAccountDigest;
      const existing = peerMap.get(mapKey);
      if (existing && (existing.addedAt || 0) >= (entry.addedAt || 0)) {
        continue;
      }
      peerMap.set(mapKey, entry);
      if (DEBUG_CONTACTS_A1) {
        console.log('[contacts]', {
          contactsLoadEntry: {
            peerAccountDigest: mapKey,
            hasConversation: !!entry.conversation?.conversation_id,
            msgId: entry.msgId || item?.id || null
          }
        });
      }
    } catch (err) {
      console.error('[contacts] decode failed', err);
    }
  }
  const out = Array.from(peerMap.values());
  out.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  if (DEBUG_CONTACTS_A1) {
    console.log('[contacts]', { contactsLoadDone: out.length });
  }
  lastContactsHydrateSummary = { ...diag, ok: true, peerCount: out.length };
  return out;
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
      setContactSecret({ peerAccountDigest: peerDigest }, {
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
        peerAccountDigest: contact?.peerAccountDigest ?? contact?.peer_account_digest ?? null,
        hasConversation: !!(contact?.conversation?.conversation_id && contact?.conversation?.token_b64),
        hasSecret: !!contact?.contactSecret
      }
    });
  }
  const mk = getMkRaw();
  const convIds = contactConvIds();
  if (!mk || !convIds.length) {
    console.warn('[contacts]', { contactSaveEarlyReturn: 'missing-mk-or-conv', hasMk: !!mk, convCount: convIds.length });
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

  // 新路徑僅使用 contact-share / secure-message，同步保存本機 snapshot，不再寫入 contacts-* 對話。
  console.warn('[contacts]', { contactSaveSkippedLegacyConv: true, peerAccountDigest, hasConversation: !!conversation });
  return { ...payload, msgId: null };
}
