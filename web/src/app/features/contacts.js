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
import { normalizeNickname, generateRandomNickname } from './profile.js';
import { decryptContactPayload, isContactShareEnvelope } from './contact-share.js';
import { getContactSecret, setContactSecret, restoreContactSecrets } from '../core/contact-secrets.js';

const CONTACT_INFO_TAG = 'contact/v1';
const missingSecretWarned = new Set();
function contactConvIds() {
  const ids = [];
  const acct = (getAccountDigest() || '').toUpperCase();
  if (acct) ids.push(`contacts-${acct}`);
  return ids;
}

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

export async function loadContacts() {
  const mk = getMkRaw();
  const convIds = contactConvIds();
  if (!mk || !convIds.length) throw new Error('Not unlocked: MK/account missing');
  const selfDigest = (getAccountDigest() || '').toUpperCase();
  const deviceId = ensureDeviceId();

  restoreContactSecrets();

  const aggregatedItems = [];

  for (const convId of convIds) {
    const { r, data } = await listMessages({ convId, limit: 100 });
    if (r.status === 404) {
      continue;
    }
    if (!r.ok) {
      const msg = typeof data === 'string' ? data : data?.error || data?.message || 'load contacts failed';
      throw new Error(msg);
    }
    const items = Array.isArray(data?.items) ? data.items : [];
    if (items.length) {
      aggregatedItems.push(...items);
    }
  }

  if (!aggregatedItems.length) return [];

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
        continue;
      }
      const peerAccountDigest = peerDigest;
      const peerDeviceIdFromHeader = header?.peerDeviceId || envelope?.peerDeviceId || item?.peer_device_id || null;
      if (!peerDeviceIdFromHeader) {
        console.warn('[contacts]', { contactMissingPeerDevice: item?.id || null, peerAccountDigest });
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
          continue;
        }
        try {
          contact = await decryptContactPayload(sessionKey, envelope);
        } catch (err) {
          console.warn('[contacts] contact-share decrypt failed', err?.message || err);
          continue;
        }
        try {
          console.log('[contacts] decrypted contact-share', peerDigest, JSON.stringify(contact));
        } catch {
          console.log('[contacts] decrypted contact-share', peerDigest, contact);
        }
        if (!contact) continue;
        conversation = contact?.conversation && contact.conversation.token_b64 && contact.conversation.conversation_id
          ? {
              token_b64: String(contact.conversation.token_b64),
              conversation_id: String(contact.conversation.conversation_id),
              ...(contact.conversation.dr_init ? { dr_init: contact.conversation.dr_init } : null)
            }
          : (secretInfo?.conversationToken && secretInfo?.conversationId
              ? {
                  token_b64: secretInfo.conversationToken,
                  conversation_id: secretInfo.conversationId,
                  ...(secretInfo?.conversationDrInit ? { dr_init: secretInfo.conversationDrInit } : null)
                }
              : null);
        const conversationUpdate = {};
        if (conversation?.token_b64) conversationUpdate.token = conversation.token_b64;
        if (conversation?.conversation_id) conversationUpdate.id = conversation.conversation_id;
        if (conversation?.dr_init) conversationUpdate.drInit = conversation.dr_init;
        pendingSecretUpdate = {
          ...(Object.keys(conversationUpdate).length ? { conversation: conversationUpdate } : {}),
          meta: { source: 'contacts:pending-secret' }
        };
      } else {
        console.warn('[contacts] unsupported envelope format', { id: item?.id, envelope });
        continue;
      }

      const normalized = normalizeNickname(contact?.nickname || '') || contact?.nickname || generateRandomNickname();
      if (!conversation) {
        conversation = contact?.conversation && contact.conversation.token_b64 && contact.conversation.conversation_id
          ? {
              token_b64: String(contact.conversation.token_b64),
              conversation_id: String(contact.conversation.conversation_id),
              ...(contact.conversation.dr_init ? { dr_init: contact.conversation.dr_init } : null)
            }
          : null;
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
      console.log('[contacts]', {
        contactsLoadEntry: {
          peerAccountDigest: mapKey,
          hasConversation: !!entry.conversation?.conversation_id,
          msgId: entry.msgId || item?.id || null
        }
      });
    } catch (err) {
      console.error('[contacts] decode failed', err);
    }
  }
  const out = Array.from(peerMap.values());
  out.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  console.log('[contacts]', { contactsLoadDone: out.length });
  return out;
}

export async function saveContact(contact) {
  console.log('[contacts]', {
    contactSaveStart: {
      peerAccountDigest: contact?.peerAccountDigest ?? contact?.peer_account_digest ?? null,
      hasConversation: !!(contact?.conversation?.conversation_id && contact?.conversation?.token_b64),
      hasSecret: !!contact?.contactSecret
    }
  });
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
  console.log('[contacts]', {
    contactSaveConversationNormalized: {
      peerAccountDigest,
      conversationId: conversation?.conversation_id || null,
      hasDrInit: !!conversation?.dr_init,
      peerDeviceId: conversation?.peerDeviceId || null
    }
  });

  const payload = {
    peerAccountDigest: peerKey,
    accountDigest: peerAccountDigest,
    peerDeviceId,
    nickname: normalizeNickname(contact?.nickname || '') || generateRandomNickname(),
    avatar: contact?.avatar || null,
    addedAt: Number(contact?.addedAt || nowTs())
  };
  if (conversation) payload.conversation = conversation;

  // 新路徑僅使用 contact-share / secure-message，同步保存本機 snapshot，不再寫入 contacts-* 對話。
  console.warn('[contacts]', { contactSaveSkippedLegacyConv: true, peerAccountDigest, hasConversation: !!conversation });
  return { ...payload, msgId: null };
}
