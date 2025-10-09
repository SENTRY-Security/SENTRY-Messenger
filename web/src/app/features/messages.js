
// /app/features/messages.js
// Feature: list conversation messages and decrypt DR packets using secure conversation tokens.

import { listSecureMessages } from '../api/messages.js';
import { drDecryptText } from '../crypto/dr.js';
import { drState, getUidHex } from '../core/store.js';
import { ensureDrReceiverState } from './dr-session.js';
import { decryptConversationEnvelope, computeConversationFingerprint } from './conversation.js';
import { b64UrlToBytes } from '../ui/mobile/ui-utils.js';

const decoder = new TextDecoder();
const secureFetchBackoff = new Map();

function urlB64ToStd(b64url) {
  let s = String(b64url || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  if (pad) s += '='.repeat(4 - pad);
  return s;
}

export async function listSecureAndDecrypt({ conversationId, tokenB64, peerUidHex, limit = 20, cursorTs }) {
  if (!conversationId) throw new Error('conversationId required');
  if (!tokenB64) throw new Error('conversation token required');
  if (!peerUidHex) throw new Error('peerUidHex required');

  const now = Date.now();
  const backoffUntil = secureFetchBackoff.get(conversationId) || 0;
  if (now < backoffUntil) {
    return {
      items: [],
      nextCursorTs: null,
      errors: ['訊息服務暫時無法使用，請稍後再試。']
    };
  }

  const { r, data } = await listSecureMessages({ conversationId, limit, cursorTs });
  const out = [];
  const errs = [];
  const state = drState(peerUidHex);
  let items = [];
  let nextCursorTs = null;
  if (!r.ok) {
    if (r.status === 404 || r.status >= 500) {
      errs.push(`訊息服務暫時無法使用（HTTP ${r.status}）`);
      if (r.status >= 500) {
        secureFetchBackoff.set(conversationId, now + 60_000);
      }
    } else {
      const msg = typeof data === 'string' ? data : JSON.stringify(data);
      throw new Error('listSecureMessages failed: ' + msg);
    }
  } else {
    items = Array.isArray(data?.items) ? data.items : [];
    nextCursorTs = data?.nextCursorTs ?? null;
    if (items.length || nextCursorTs !== null) {
      secureFetchBackoff.delete(conversationId);
    }
  }
  let fingerprintPeer = null;
  let fingerprintSelf = null;
  try { fingerprintPeer = await computeConversationFingerprint(tokenB64, peerUidHex); } catch {}
  try {
    const selfUid = getUidHex();
    if (selfUid) fingerprintSelf = await computeConversationFingerprint(tokenB64, selfUid);
  } catch {}

  await ensureDrReceiverState({ peerUidHex });

  for (const raw of items) {
    try {
      const payload = await decryptConversationEnvelope(tokenB64, raw?.payload_envelope || raw?.payloadEnvelope || raw?.payload);
      const headerJson = decoder.decode(b64UrlToBytes(payload.hdr_b64));
      const header = JSON.parse(headerJson);
      const ciphertextB64 = urlB64ToStd(payload.ct_b64);
      const pkt = {
        aead: 'aes-256-gcm',
        header,
        iv_b64: header?.iv_b64,
        ciphertext_b64: ciphertextB64
      };
      if (!pkt.iv_b64) throw new Error('缺少訊息 IV，無法進行 DR 解密');
      if (header?.fallback) throw new Error('偵測到舊版 fallback 封包，已不再支援');

      const text = await drDecryptText(state, pkt);
      const ts = Number(payload?.meta?.ts || raw?.created_at || null) || null;
      const senderFingerprint = payload?.meta?.sender_fingerprint || payload?.meta?.fingerprint || null;
      let direction = 'unknown';
      if (senderFingerprint && fingerprintSelf && senderFingerprint === fingerprintSelf) direction = 'outgoing';
      else if (senderFingerprint && fingerprintPeer && senderFingerprint === fingerprintPeer) direction = 'incoming';
      out.push({
        id: raw?.id || null,
        ts,
        text,
        header,
        meta: payload?.meta || null,
        direction,
        raw
      });
    } catch (err) {
      const msg = err?.message || String(err);
      errs.push(msg);
      console.warn('[messages] secure decrypt skipped', { id: raw?.id, error: msg });
      continue;
    }
  }

  return {
    items: out,
    nextCursorTs,
    errors: errs
  };
}
