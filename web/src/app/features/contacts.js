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
import { DEBUG } from '../ui/mobile/debug-flags.js';

const CONTACT_INFO_TAG = 'contact/v1';
const missingSecretWarned = new Set();
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
        continue;
      }
      const peerAccountDigest = peerDigest;
      const peerDeviceIdFromHeader = header?.peerDeviceId || envelope?.peerDeviceId || item?.peer_device_id || null;
      if (!peerDeviceIdFromHeader) {
        console.warn('[contacts]', { contactMissingPeerDevice: item?.id || null, peerAccountDigest });
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
          continue;
        }
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
        conversation = contact?.conversation && contact.conversation.token_b64 && contact.conversation.conversation_id
          ? {
              token_b64: String(contact.conversation.token_b64),
              conversation_id: String(contact.conversation.conversation_id),
              ...(contact.conversation.dr_init ? { dr_init: contact.conversation.dr_init } : null)
            }
          : null;
        const conversationUpdate = {};
        if (conversation?.token_b64) conversationUpdate.token = conversation.token_b64;
        if (conversation?.conversation_id) conversationUpdate.id = conversation.conversation_id;
        if (conversation?.dr_init) conversationUpdate.drInit = conversation.dr_init;
        if (Object.keys(conversationUpdate).length) {
          pendingSecretUpdate = {
            conversation: conversationUpdate,
            meta: { source: 'contacts:pending-secret' }
          };
        }
      } else {
        console.warn('[contacts] unsupported envelope format', { id: item?.id, envelope });
        continue;
      }

      const normalized = normalizeNickname(contact?.nickname || '') || '';
      if (!conversation) {
        conversation = contact?.conversation && contact.conversation.token_b64 && contact.conversation.conversation_id
          ? {
              token_b64: String(contact.conversation.token_b64),
              conversation_id: String(contact.conversation.conversation_id),
              ...(contact.conversation.dr_init ? { dr_init: contact.conversation.dr_init } : null)
            }
          : null;
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
