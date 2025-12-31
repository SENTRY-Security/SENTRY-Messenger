/**
 * OutboundKeyVault stores outbound DR message keys for self-sent history replay.
 * Keys are wrapped client-side with the master key; the server only stores opaque blobs.
 */
import { wrapWithMK_JSON, unwrapWithMK_JSON } from '../crypto/aead.js';
import { getMkRaw, ensureDeviceId, getAccountDigest } from '../core/store.js';
import { log } from '../core/log.js';
import { DEBUG } from '../ui/mobile/debug-flags.js';
import { putOutboundKey as apiPutOutboundKey, getOutboundKey as apiGetOutboundKey } from '../api/outbound-key-vault.js';

const WRAP_INFO_TAG = 'outbound-mk/v1';
const WRAP_CONTEXT_VERSION = 1;
const RETENTION_PER_CONVERSATION = 200;
const CACHE_MAX = 400;
const VAULT_RECORD_LOG_LIMIT = 3;
const VAULT_HIT_LOG_LIMIT = 3;

const cache = new Map(); // key -> messageKeyB64
let vaultRecordLogCount = 0;
let vaultHitLogCount = 0;

function normalizeCounter(n) {
  const num = Number(n);
  return Number.isFinite(num) ? Math.floor(num) : null;
}

function cacheKey({ conversationId, serverMessageId, messageId, headerCounter }) {
  const idPart = serverMessageId || messageId;
  if (idPart) return `${conversationId || 'unknown'}::msg:${idPart}`;
  const counterPart = Number.isFinite(headerCounter) ? `n:${headerCounter}` : 'n:unknown';
  return `${conversationId || 'unknown'}::${counterPart}`;
}

function u8ToHex(u8) {
  let out = '';
  for (let i = 0; i < u8.length; i += 1) {
    out += u8[i].toString(16).padStart(2, '0');
  }
  return out;
}

function base64ToU8(mkB64) {
  if (typeof atob !== 'function') return null;
  try {
    const normalized = String(mkB64 || '').replace(/-/g, '+').replace(/_/g, '/');
    const padLength = (4 - (normalized.length % 4 || 4)) % 4;
    const padded = normalized + '='.repeat(padLength);
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function summarizeMk(mkB64) {
  const summary = { mkLen: mkB64 ? mkB64.length : 0, mkHash: null };
  if (!mkB64 || typeof crypto === 'undefined' || !crypto.subtle || typeof crypto.subtle.digest !== 'function') {
    return summary;
  }
  const u8 = base64ToU8(mkB64);
  if (!u8) return summary;
  try {
    const digest = await crypto.subtle.digest('SHA-256', u8);
    summary.mkLen = u8.length;
    summary.mkHash = u8ToHex(new Uint8Array(digest)).slice(0, 32);
  } catch {
    summary.mkLen = u8.length;
  }
  return summary;
}

function emitVaultRecord(stage, fields, mkSummary = null) {
  if (!(DEBUG.replay && vaultRecordLogCount < VAULT_RECORD_LOG_LIMIT)) return;
  vaultRecordLogCount += 1;
  try {
    log({
      vaultRecord: {
        stage,
        ...fields,
        ...(mkSummary || {})
      }
    });
  } catch {
    /* ignore logging errors */
  }
}

function emitVaultHit(fields, mkSummary = null) {
  if (!(DEBUG.replay && vaultHitLogCount < VAULT_HIT_LOG_LIMIT)) return;
  vaultHitLogCount += 1;
  try {
    log({
      vaultHit: {
        unwrapSuccess: true,
        ...fields,
        ...(mkSummary || {})
      }
    });
  } catch {
    /* ignore logging errors */
  }
}

function setCache(key, value) {
  cache.set(key, value);
  if (cache.size > CACHE_MAX) {
    const first = cache.keys().next();
    if (!first.done) cache.delete(first.value);
  }
}

function getCache(key) {
  return cache.get(key) || null;
}

function contextsMatch(requested, stored) {
  if (!stored || typeof stored !== 'object') return false;
  if (stored.conversationId && requested.conversationId && stored.conversationId !== requested.conversationId) return false;
  const reqMessageId = requested.serverMessageId || requested.messageId || null;
  const storedMessageId = stored.serverMessageId || stored.messageId || null;
  if (reqMessageId && storedMessageId && storedMessageId !== reqMessageId) return false;
  if (!reqMessageId && storedMessageId && requested.headerCounter == null) return false;
  if (stored.senderDeviceId && requested.senderDeviceId && stored.senderDeviceId !== requested.senderDeviceId) return false;
  if (requested.targetDeviceId && stored.targetDeviceId && stored.targetDeviceId !== requested.targetDeviceId) return false;
  const storedHeader = normalizeCounter(stored.headerCounter);
  const reqHeader = normalizeCounter(requested.headerCounter);
  if (!reqMessageId && reqHeader !== null && storedHeader !== null && reqHeader !== storedHeader) return false;
  return true;
}

function buildContext(params, senderDeviceId) {
  const accountDigest = (getAccountDigest() || '').toUpperCase() || null;
  const headerCounter = normalizeCounter(params.headerCounter ?? params.counterN);
  const serverMessageId = params.serverMessageId || null;
  const messageId = serverMessageId || params.messageId || null;
  return {
    conversationId: params.conversationId || null,
    messageId,
    serverMessageId,
    senderDeviceId: senderDeviceId || null,
    targetDeviceId: params.targetDeviceId || null,
    headerCounter,
    msgType: params.msgType || null,
    accountDigest
  };
}

async function unwrapMessageKey(wrapped, mkRaw) {
  if (!wrapped) return null;
  const payload = await unwrapWithMK_JSON(wrapped, mkRaw);
  const mkB64 = payload?.mk_b64 || payload?.mkB64 || null;
  const context = payload?.context || payload?.wrap_context || null;
  if (!mkB64) return null;
  return { mkB64, context };
}

export class OutboundKeyVault {
  /**
   * Persist the outbound message key for a sent packet so history replay can deterministically decrypt it later.
   * Vault entries are keyed by { conversationId, serverMessageId|messageId, senderDeviceId, targetDeviceId } with headerCounter stored as context only.
   * @param {object} params
   * @param {string|number} params.conversationId
   * @param {string} [params.serverMessageId] - Server-assigned id when available.
   * @param {string} [params.messageId] - Client-generated id (used before ack).
   * @param {string|number} params.senderDeviceId
   * @param {string|number} params.targetDeviceId
   * @param {number} params.headerCounter - Header counter used for the outbound packet.
   * @param {string} params.msgType - Logical message type (e.g. text, contact-share, media).
   * @param {string} params.messageKeyB64 - Message key (base64) before wrapping.
   */
  static async recordOutboundKey(params) {
    const mkRaw = getMkRaw();
    if (!mkRaw) return;
    const conversationId = params?.conversationId || null;
    const serverMessageId = params?.serverMessageId || null;
    const messageId = serverMessageId || params?.messageId || null;
    const headerCounter = normalizeCounter(params?.headerCounter ?? params?.counterN);
    const messageKeyB64 = params?.messageKeyB64 || null;
    const senderDeviceId = params?.senderDeviceId || ensureDeviceId();
    const selfDeviceId = params?.selfDeviceId || senderDeviceId || null;
    const targetDeviceId = params?.targetDeviceId || null;
    if (!conversationId || !messageId || !messageKeyB64 || !senderDeviceId) return;
    const context = buildContext({ ...params, conversationId, messageId, serverMessageId, headerCounter }, senderDeviceId);
    const baseLogFields = {
      conversationId,
      messageId,
      serverMessageId,
      headerCounter,
      msgType: params?.msgType || null,
      wrapContextVersion: WRAP_CONTEXT_VERSION,
      wrapInfoTag: WRAP_INFO_TAG,
      wrapKeyType: WRAP_INFO_TAG,
      senderDeviceId,
      selfDeviceId,
      targetDeviceId
    };
    const recordLogEnabled = DEBUG.replay && vaultRecordLogCount < VAULT_RECORD_LOG_LIMIT;
    const mkSummary = recordLogEnabled ? await summarizeMk(messageKeyB64) : null;
    emitVaultRecord('before', baseLogFields, mkSummary);
    let wrapped;
    try {
      wrapped = await wrapWithMK_JSON({ mk_b64: messageKeyB64, context }, mkRaw, WRAP_INFO_TAG);
    } catch {
      return;
    }
    try {
      await apiPutOutboundKey({
        conversationId,
        messageId,
        senderDeviceId,
        targetDeviceId,
        headerCounter,
        msgType: params?.msgType || null,
        wrapped_mk: wrapped,
        wrap_context: context,
        retentionLimit: RETENTION_PER_CONVERSATION
      });
      setCache(cacheKey({ conversationId, serverMessageId, messageId, headerCounter }), messageKeyB64);
      emitVaultRecord('after', {
        ...baseLogFields,
        wrapEnvelopeVersion: wrapped?.v ?? null,
        wrapAead: wrapped?.aead || null,
        wrapInfoTag: wrapped?.info || baseLogFields.wrapInfoTag
      }, mkSummary);
    } catch {
      /* swallow store errors to avoid impacting send path */
    }
  }

  /**
   * Retrieve the outbound message key for a previously sent packet.
   * Vault lookup key is { conversationId, serverMessageId|messageId, senderDeviceId, targetDeviceId }; headerCounter only narrows matches when ids are absent.
   * @param {object} params
   * @param {string|number} params.conversationId
   * @param {string} [params.serverMessageId]
   * @param {string} [params.messageId]
   * @param {string|number} params.senderDeviceId
   * @param {string|number} params.targetDeviceId
   * @param {number} params.headerCounter
   * @param {string} params.msgType
   * @returns {Promise<string|null>} messageKeyB64 or null when absent.
   */
  static async getOutboundKey(params) {
    const mkRaw = getMkRaw();
    if (!mkRaw) return null;
    const conversationId = params?.conversationId || null;
    const serverMessageId = params?.serverMessageId || null;
    const messageId = serverMessageId || params?.messageId || null;
    const headerCounter = normalizeCounter(params?.headerCounter);
    const senderDeviceId = params?.senderDeviceId || ensureDeviceId();
    const selfDeviceId = params?.selfDeviceId || senderDeviceId || null;
    const targetDeviceId = params?.targetDeviceId || null;
    if (!conversationId || (!messageId && headerCounter === null) || !senderDeviceId) return null;
    const cacheK = cacheKey({ conversationId, serverMessageId, messageId, headerCounter });
    const cached = getCache(cacheK);
    if (cached) return cached;
    let data = null;
    try {
      const res = await apiGetOutboundKey({
        conversationId,
        messageId,
        senderDeviceId,
        targetDeviceId,
        headerCounter
      });
      data = res?.data || res || null;
    } catch {
      return null;
    }
    const entry = data?.entry || null;
    if (!entry?.wrapped_mk) return null;
    let unwrapped = null;
    try {
      unwrapped = await unwrapMessageKey(entry.wrapped_mk, mkRaw);
    } catch {
      return null;
    }
    const requestCtx = {
      conversationId,
      messageId,
      serverMessageId,
      senderDeviceId,
      targetDeviceId,
      headerCounter
    };
    if (!unwrapped || !contextsMatch(requestCtx, unwrapped.context || entry.wrap_context || null)) return null;
    const mkSummary = DEBUG.replay && vaultHitLogCount < VAULT_HIT_LOG_LIMIT ? await summarizeMk(unwrapped.mkB64) : null;
    emitVaultHit({
      conversationId,
      messageId,
      serverMessageId: params?.serverMessageId || null,
      senderDeviceId,
      selfDeviceId,
      targetDeviceId,
      headerCounter,
      msgType: params?.msgType || null,
      wrapContextVersion: entry?.wrap_context?.version ?? WRAP_CONTEXT_VERSION,
      wrapInfoTag: entry?.wrapped_mk?.info || WRAP_INFO_TAG,
      wrapKeyType: entry?.wrapped_mk?.info || WRAP_INFO_TAG,
      wrapAead: entry?.wrapped_mk?.aead || null,
      wrapEnvelopeVersion: entry?.wrapped_mk?.v ?? null
    }, mkSummary);
    setCache(cacheK, unwrapped.mkB64);
    return unwrapped.mkB64;
  }
}
