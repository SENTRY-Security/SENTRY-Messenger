// /app/features/contacts.js
// Manage E2EE contacts list stored in contacts-<uid> conversation.

import { listMessages } from '../api/messages.js';
import { createMessage } from '../api/media.js';
import { wrapWithMK_JSON, unwrapWithMK_JSON } from '../crypto/aead.js';
import { getMkRaw, getUidHex, getAccountDigest } from '../core/store.js';
import { normalizeNickname, generateRandomNickname } from './profile.js';
import { decryptContactPayload, isContactShareEnvelope } from './contact-share.js';
import { getContactSecret, setContactSecret, restoreContactSecrets } from '../core/contact-secrets.js';
import { log } from '../core/log.js';

const CONTACT_INFO_TAG = 'contact/v1';
const missingSecretWarned = new Set();

function contactConvIds() {
  const ids = [];
  const uid = (getUidHex() || '').toUpperCase();
  if (uid) ids.push(`contacts-${uid}`);
  const acct = (getAccountDigest() || '').toUpperCase();
  if (acct && acct !== uid) ids.push(`contacts-${acct}`);
  return ids;
}

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

export async function loadContacts() {
  const mk = getMkRaw();
  const convIds = contactConvIds();
  if (!mk || !convIds.length) throw new Error('Not unlocked: MK/account missing');

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
      const peerUid = String(header?.peerUid || '').toUpperCase();
      let contact = null;
      let conversation = null;
      if (envelope?.aead === 'aes-256-gcm') {
        contact = await unwrapWithMK_JSON(envelope, mk);
      } else if (isContactShareEnvelope(envelope) && peerUid) {
        const secretInfo = getContactSecret(peerUid);
        const secret = secretInfo?.secret;
        if (!secret) {
          if (!missingSecretWarned.has(peerUid)) {
            missingSecretWarned.add(peerUid);
            log({ contactMissingSecret: peerUid });
            console.warn('[contacts] missing contact secret for', peerUid);
          }
          continue;
        }
        try {
          contact = await decryptContactPayload(secret, envelope);
        } catch (err) {
          console.warn('[contacts] contact-share decrypt failed', err?.message || err);
          continue;
        }
        try {
          console.log('[contacts] decrypted contact-share', peerUid, JSON.stringify(contact));
        } catch {
          console.log('[contacts] decrypted contact-share', peerUid, contact);
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
        setContactSecret(peerUid, {
          inviteId: secretInfo?.inviteId || header?.inviteId || header?.invite_id || null,
          secret,
          role: secretInfo?.role || null,
          conversationToken: conversation?.token_b64 || null,
          conversationId: conversation?.conversation_id || null,
          conversationDrInit: conversation?.dr_init || null
        });
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
      const storedSecret = typeof contact?.contactSecret_b64 === 'string' ? contact.contactSecret_b64.trim() : null;
      const storedInviteId = typeof contact?.inviteId === 'string' ? contact.inviteId.trim() : null;
      const storedRole = typeof contact?.contactSecret_role === 'string' ? contact.contactSecret_role : null;
      const entry = {
        peerUid: peerUid || String(contact?.peerUid || '').toUpperCase(),
        nickname: normalized,
        avatar: contact?.avatar || null,
        addedAt: Number(contact?.addedAt || item?.ts || nowTs()),
        msgId: item?.id || null,
        conversation,
        contactSecret: storedSecret,
        inviteId: storedInviteId,
        secretRole: storedRole
      };
      const existing = peerMap.get(entry.peerUid);
      if (existing && (existing.addedAt || 0) >= (entry.addedAt || 0)) {
        continue;
      }
      if (storedSecret) {
        setContactSecret(entry.peerUid, {
          inviteId: storedInviteId,
          secret: storedSecret,
          role: storedRole,
          conversationToken: conversation?.token_b64 || null,
          conversationId: conversation?.conversation_id || null,
          conversationDrInit: conversation?.dr_init || null
        });
      }
      peerMap.set(entry.peerUid, entry);
    } catch (err) {
      console.error('[contacts] decode failed', err);
    }
  }
  const out = Array.from(peerMap.values());
  out.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  return out;
}

export async function saveContact(contact) {
  const mk = getMkRaw();
  const convIds = contactConvIds();
  if (!mk || !convIds.length) throw new Error('Not unlocked: MK/account missing');
  const peerUid = String(contact?.peerUid || '').toUpperCase();
  if (!peerUid) throw new Error('peerUid required');

  const conversation = contact?.conversation && contact.conversation.token_b64 && contact.conversation.conversation_id
    ? {
        token_b64: String(contact.conversation.token_b64),
        conversation_id: String(contact.conversation.conversation_id),
        ...(contact.conversation.dr_init ? { dr_init: contact.conversation.dr_init } : null)
      }
    : null;

  const contactSecret = typeof contact?.contactSecret === 'string' ? contact.contactSecret : null;
  const inviteId = typeof contact?.inviteId === 'string' ? contact.inviteId.trim() : null;
  const secretRole = typeof contact?.secretRole === 'string' ? contact.secretRole : null;

  const payload = {
    peerUid,
    nickname: normalizeNickname(contact?.nickname || '') || generateRandomNickname(),
    avatar: contact?.avatar || null,
    addedAt: Number(contact?.addedAt || nowTs())
  };
  if (conversation) payload.conversation = conversation;
  if (contactSecret) payload.contactSecret_b64 = contactSecret;
  if (inviteId) payload.inviteId = inviteId;
  if (secretRole) payload.contactSecret_role = secretRole;

  const envelope = await wrapWithMK_JSON(payload, mk, CONTACT_INFO_TAG);
  const header = { contact: 1, v: 1, peerUid, ts: payload.addedAt, envelope };

  let firstMsgId = null;
  for (const convId of convIds) {
    const body = {
      convId,
      type: 'text',
      aead: 'aes-256-gcm',
      header,
      ciphertext_b64: envelope?.ct_b64 || 'contact'
    };
    const { r, data } = await createMessage(body);
    if (!r.ok) {
      const msg = typeof data === 'string' ? data : data?.error || data?.message || 'contact save failed';
      throw new Error(msg);
    }
    if (!firstMsgId) firstMsgId = data?.id || null;
  }
  return { ...payload, msgId: firstMsgId };
}
