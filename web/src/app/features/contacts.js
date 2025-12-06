// /app/features/contacts.js
// Manage E2EE contacts list stored in contacts-<account_digest> conversation (UID fallback).

import { listMessages } from '../api/messages.js';
import { createMessage } from '../api/media.js';
import { wrapWithMK_JSON, unwrapWithMK_JSON } from '../crypto/aead.js';
import { getMkRaw, getUidHex, getAccountDigest, buildAccountPayload, normalizePeerIdentity } from '../core/store.js';
import { normalizeNickname, generateRandomNickname } from './profile.js';
import { decryptContactPayload, isContactShareEnvelope } from './contact-share.js';
import { getContactSecret, setContactSecret, restoreContactSecrets } from '../core/contact-secrets.js';
import { log } from '../core/log.js';

const CONTACT_INFO_TAG = 'contact/v1';
const missingSecretWarned = new Set();

function contactConvIds() {
  const ids = [];
  const acct = (getAccountDigest() || '').toUpperCase();
  if (acct) ids.push(`contacts-${acct}`);
  const uid = (getUidHex() || '').toUpperCase();
  if (uid && uid !== acct) ids.push(`contacts-${uid}`);
  return ids;
}

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

export async function loadContacts() {
  const mk = getMkRaw();
  const convIds = contactConvIds();
  if (!mk || !convIds.length) throw new Error('Not unlocked: MK/account missing');
  const selfUid = (getUidHex() || '').toUpperCase();
  const selfDigest = (getAccountDigest() || '').toUpperCase();

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
        peerAccountDigest: header?.peerAccountDigest || header?.peer_account_digest || null,
        peerUid: header?.peerUid || header?.peer_uid || null
      });
      let peerAccountDigest = identityFromHeader.accountDigest || null;
      let peerUid = identityFromHeader.uid || null;
      let peerKey = identityFromHeader.key || null;
      let contact = null;
      let conversation = null;
      let pendingSecretUpdate = null;
      if (envelope?.aead === 'aes-256-gcm') {
        contact = await unwrapWithMK_JSON(envelope, mk);
      } else if (isContactShareEnvelope(envelope) && peerUid) {
        const secretInfo = getContactSecret(peerKey || peerUid);
        const secret = secretInfo?.secret;
        if (!secret) {
          const warnKey = peerKey || peerUid;
          if (!missingSecretWarned.has(warnKey)) {
            missingSecretWarned.add(warnKey);
            log({ contactMissingSecret: warnKey });
            console.warn('[contacts] missing contact secret for', warnKey);
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
        const inviteIdValue = secretInfo?.inviteId || header?.inviteId || header?.invite_id || null;
        const inviteUpdate = { secret };
        if (inviteIdValue) inviteUpdate.id = inviteIdValue;
        const resolvedRole = secretInfo?.role || null;
        if (resolvedRole !== null && resolvedRole !== undefined) {
          inviteUpdate.role = resolvedRole;
        }
        const conversationUpdate = {};
        if (conversation?.token_b64) conversationUpdate.token = conversation.token_b64;
        if (conversation?.conversation_id) conversationUpdate.id = conversation.conversation_id;
        if (conversation?.dr_init) conversationUpdate.drInit = conversation.dr_init;
        pendingSecretUpdate = {
          invite: inviteUpdate,
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
      const storedSecret = typeof contact?.contactSecret_b64 === 'string' ? contact.contactSecret_b64.trim() : null;
      const storedInviteId = typeof contact?.inviteId === 'string' ? contact.inviteId.trim() : null;
      const storedRole = typeof contact?.contactSecret_role === 'string' ? contact.contactSecret_role : null;
      const resolvedPeerUid = peerUid || normalizePeerIdentity({ peerUid: contact?.peerUid || contact?.peer_uid || null }).uid || null;
      if (!resolvedPeerUid && !peerAccountDigest) continue;
      const finalIdentity = normalizePeerIdentity({
        peerAccountDigest,
        peerUid: resolvedPeerUid || peerUid
      });
      peerKey = finalIdentity.key || peerKey || resolvedPeerUid;
      peerAccountDigest = finalIdentity.accountDigest || peerAccountDigest || null;
      peerUid = finalIdentity.uid || resolvedPeerUid || peerUid || null;
      if (!peerKey) continue;
      if (pendingSecretUpdate) {
        setContactSecret({ peerAccountDigest, peerUid }, pendingSecretUpdate);
      }
      const entry = {
        peerUid: peerKey,
        peerAccountDigest,
        nickname: normalized,
        avatar: contact?.avatar || null,
        addedAt: Number(contact?.addedAt || item?.ts || nowTs()),
        msgId: item?.id || null,
        conversation,
        contactSecret: storedSecret,
        inviteId: storedInviteId,
        secretRole: storedRole
      };
      const selfKeys = new Set([selfUid, selfDigest].filter(Boolean));
      const isSelfContact = !!peerKey && (
        selfKeys.has(peerKey) ||
        (peerAccountDigest && selfKeys.has(peerAccountDigest)) ||
        (peerUid && selfKeys.has(peerUid))
      );
      if (isSelfContact) {
        entry.isSelfContact = true;
        entry.hidden = true;
      }
      const existing = peerMap.get(entry.peerUid);
      if (existing && (existing.addedAt || 0) >= (entry.addedAt || 0)) {
        continue;
      }
      if (storedSecret) {
        const inviteUpdate = { secret: storedSecret };
        if (storedInviteId) inviteUpdate.id = storedInviteId;
        if (storedRole) inviteUpdate.role = storedRole;
        const conversationUpdate = {};
        if (conversation?.token_b64) conversationUpdate.token = conversation.token_b64;
        if (conversation?.conversation_id) conversationUpdate.id = conversation.conversation_id;
        if (conversation?.dr_init) conversationUpdate.drInit = conversation.dr_init;
        const updatePayload = {
          invite: inviteUpdate,
          meta: { source: 'contacts:stored-secret' }
        };
        if (Object.keys(conversationUpdate).length) {
          updatePayload.conversation = conversationUpdate;
        }
        setContactSecret({ peerAccountDigest, peerUid }, updatePayload);
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
  const identity = normalizePeerIdentity({
    peerAccountDigest: contact?.peerAccountDigest || null,
    peerUid: contact?.peerUid || null
  });
  const peerAccountDigest = identity.accountDigest || null;
  const peerUid = identity.uid || null;
  const peerKey = identity.key;
  if (!peerKey) throw new Error('peerUid or peerAccountDigest required');

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

  const headerPeerUid = peerUid || peerKey;
  const payload = {
    peerUid: headerPeerUid,
    nickname: normalizeNickname(contact?.nickname || '') || generateRandomNickname(),
    avatar: contact?.avatar || null,
    addedAt: Number(contact?.addedAt || nowTs())
  };
  if (conversation) payload.conversation = conversation;
  if (contactSecret) payload.contactSecret_b64 = contactSecret;
  if (inviteId) payload.inviteId = inviteId;
  if (secretRole) payload.contactSecret_role = secretRole;

  const envelope = await wrapWithMK_JSON(payload, mk, CONTACT_INFO_TAG);
  const header = { contact: 1, v: 1, peerUid: headerPeerUid, peerAccountDigest, ts: payload.addedAt, envelope };

  let firstMsgId = null;
  for (const convId of convIds) {
    const msgPayload = {
      convId,
      type: 'text',
      aead: 'aes-256-gcm',
      header,
      ciphertext_b64: envelope?.ct_b64 || 'contact'
    };
    const body = buildAccountPayload({ overrides: msgPayload });
    const { r, data } = await createMessage(body);
    if (!r.ok) {
      const msg = typeof data === 'string' ? data : data?.error || data?.message || 'contact save failed';
      throw new Error(msg);
    }
    if (!firstMsgId) firstMsgId = data?.id || null;
  }
  return { ...payload, msgId: firstMsgId };
}
