// /app/features/dr-session.js
// X3DH 初始化與 DR 文字訊息發送（功能層，無 UI）。

import { prekeysBundle } from '../api/prekeys.js';
import { createSecureMessage } from '../api/messages.js';
import { devkeysFetch } from '../api/devkeys.js';
import { x3dhInitiate, drEncryptText, x3dhRespond } from '../crypto/dr.js';
import { unwrapDevicePrivWithMK } from '../crypto/prekeys.js';
import {
  getUidHex,
  getMkRaw,
  getDevicePriv, setDevicePriv,
  drState
} from '../core/store.js';
import { sessionStore } from '../ui/mobile/session-store.js';
import {
  computeConversationFingerprint,
  encryptConversationEnvelope,
  conversationIdFromToken,
  base64ToUrl
} from './conversation.js';
import { bytesToB64Url } from '../ui/mobile/ui-utils.js';

function normHex(s) { return String(s || '').replace(/[^0-9a-f]/gi, '').toUpperCase(); }

function cloneU8(src) {
  if (!(src instanceof Uint8Array)) return src;
  return new Uint8Array(src);
}

function copyDrState(target, source) {
  if (!target || !source) return;
  target.rk = cloneU8(source.rk) || null;
  target.ckS = cloneU8(source.ckS) || null;
  target.ckR = cloneU8(source.ckR) || null;
  target.Ns = Number(source.Ns || 0);
  target.Nr = Number(source.Nr || 0);
  target.PN = Number(source.PN || 0);
  target.myRatchetPriv = cloneU8(source.myRatchetPriv) || null;
  target.myRatchetPub = cloneU8(source.myRatchetPub) || null;
  target.theirRatchetPub = cloneU8(source.theirRatchetPub) || null;
}

async function ensureDevicePrivLoaded(meUidHex) {
  let priv = getDevicePriv();
  if (priv) return priv;
  const me = meUidHex || getUidHex();
  if (!me) throw new Error('UID not set (run SDM exchange)');
  const { r, data } = await devkeysFetch({ uidHex: me });
  if (r.status === 404) throw new Error('device backup missing; login page should have initialized prekeys');
  if (!r.ok) throw new Error('devkeys.fetch failed: ' + (typeof data === 'string' ? data : JSON.stringify(data)));
  const mk = getMkRaw();
  if (!mk) throw new Error('MK not unlocked');
  priv = await unwrapDevicePrivWithMK(data.wrapped_dev, mk);
  setDevicePriv(priv);
  return priv;
}

/**
 * 確保（本端→對方）的 DR 會話已初始化。
 * 會：
 *  - 若記憶體中尚無 devicePriv，嘗試從伺服器抓 wrapped_dev 並以 MK 解開後寫入 store
 *  - 呼叫 /keys/bundle 取得對方 bundle，執行 x3dhInitiate()，把狀態寫回 store.drState(peer)
 * @param {{ peerUidHex: string }} p
 * @returns {Promise<{ initialized: boolean }>} 
 */
export async function ensureDrSession({ peerUidHex }) {
  const me = getUidHex();
  const peer = normHex(peerUidHex);
  if (!me) throw new Error('UID not set (run SDM exchange)');
  if (!peer) throw new Error('peerUidHex required');

  const holder = drState(peer);
  if (holder?.rk && holder?.myRatchetPriv && holder?.myRatchetPub) {
    return { initialized: true, reused: true };
  }

  const priv = await ensureDevicePrivLoaded(me);

  const { r: rb, data: bundle } = await prekeysBundle({ peer_uidHex: peer });
  if (!rb.ok) throw new Error('prekeys.bundle failed: ' + (typeof bundle === 'string' ? bundle : JSON.stringify(bundle)));

  const st = await x3dhInitiate(priv, bundle);
  copyDrState(holder, st);
  holder.baseKey = { role: 'initiator', initializedAt: Date.now() };
  return { initialized: true };
}

function conversationContextForPeer(peerUid) {
  try {
    const key = String(peerUid || '').toUpperCase();
    if (!key) return null;
    const entry = sessionStore.contactIndex?.get?.(key);
    if (entry?.conversation?.token_b64) {
      return {
        token_b64: entry.conversation.token_b64,
        conversation_id: entry.conversation.conversation_id || null,
        dr_init: entry.conversation.dr_init || null
      };
    }
    const map = sessionStore.conversationIndex;
    if (map && typeof map.get === 'function') {
      for (const [convId, info] of map.entries()) {
        if (info?.peerUid === key && info?.token_b64) {
          return {
            token_b64: info.token_b64,
            conversation_id: convId,
            dr_init: info.dr_init || null
          };
        }
      }
    }
  } catch (err) {
    console.warn('[conversation] lookup failed', err);
  }
  return null;
}

/**
 * 發送 DR 文字訊息（必要時會先初始化會話）。
 * @param {{ peerUidHex: string, text: string, conversation?: { token_b64?:string, conversation_id?:string }, convId?: string }} p
 * @returns {Promise<{ msg: any, convId: string }>} 
 */
export async function sendDrText({ peerUidHex, text, conversation, convId }) {
  const me = getUidHex();
  const peer = normHex(peerUidHex);
  if (!me) throw new Error('UID not set');
  if (!peer) throw new Error('peerUidHex required');

  const convContext = conversation || conversationContextForPeer(peer);
  const tokenB64 = convContext?.token_b64 || convContext?.tokenB64 || null;
  if (!tokenB64) throw new Error('conversation token missing for peer, please refresh contacts');

  const state = drState(peer);
  const hasDrState = state?.rk && state.myRatchetPriv && state.myRatchetPub;
  const hasDrInit = !!(convContext?.dr_init?.guest_bundle || convContext?.dr_init?.guestBundle);
  if (!hasDrState && !hasDrInit) {
    throw new Error('尚未建立安全對話，請重新同步好友或重新建立邀請');
  }

  try {
    await ensureDrSession({ peerUidHex: peer });
  } catch (err) {
    throw new Error('DR 會話初始化失敗：' + (err?.message || err));
  }

  const pkt = await drEncryptText(state, text);
  const now = Math.floor(Date.now() / 1000);

  let conversationId = convContext?.conversation_id || convContext?.conversationId || null;
  if (!conversationId) conversationId = await conversationIdFromToken(tokenB64);

  const headerPayload = { ...pkt.header, iv_b64: pkt.iv_b64 };
  const headerJson = JSON.stringify(headerPayload);
  const hdrB64 = bytesToB64Url(new TextEncoder().encode(headerJson));
  const ctB64 = base64ToUrl(pkt.ciphertext_b64);
  const fingerprint = await computeConversationFingerprint(tokenB64, me);

  const securePayload = {
    v: 1,
    hdr_b64: hdrB64,
    ct_b64: ctB64,
    meta: {
      ts: now,
      sender_fingerprint: fingerprint,
      msg_type: 'text'
    }
  };

  const envelope = await encryptConversationEnvelope(tokenB64, securePayload);
  const { r, data } = await createSecureMessage({
    conversationId,
    payloadEnvelope: envelope,
    createdAt: now
  });
  if (!r.ok) throw new Error('sendText failed: ' + (typeof data === 'string' ? data : JSON.stringify(data)));
  return { msg: data, convId: conversationId, secure: true };
}

export async function bootstrapDrFromGuestBundle({ peerUidHex, guestBundle }) {
  const peer = normHex(peerUidHex);
  if (!peer) return false;
  if (!guestBundle || typeof guestBundle !== 'object') return false;
  const holder = drState(peer);
  if (holder?.rk) return false;
  try {
    const priv = await ensureDevicePrivLoaded();
    const st = await x3dhRespond(priv, guestBundle);
    copyDrState(holder, st);
    holder.baseKey = { role: 'responder', initializedAt: Date.now(), guestBundle };
    return true;
  } catch (err) {
    console.warn('[dr] responder bootstrap failed', err);
    return false;
  }
}

export function primeDrStateFromInitiator({ peerUidHex, state }) {
  const peer = normHex(peerUidHex);
  if (!peer || !state) return false;
  const holder = drState(peer);
  if (holder?.rk) return false;
  copyDrState(holder, state);
  holder.baseKey = { role: 'initiator', initializedAt: Date.now(), primed: true };
  return true;
}

export async function ensureDrReceiverState({ peerUidHex }) {
  const peer = normHex(peerUidHex);
  if (!peer) return false;
  const state = drState(peer);
  if (state?.rk && (state.ckR || state.ckS) && state.myRatchetPriv && state.myRatchetPub) {
    return true;
  }

  const context = conversationContextForPeer(peer) || {};
  const drInit = context?.dr_init || null;
  const guestBundle = drInit?.guest_bundle || drInit?.guestBundle || null;
  if (guestBundle) {
    const ok = await bootstrapDrFromGuestBundle({ peerUidHex: peer, guestBundle });
    if (ok) return true;
  }

  return false;
}
