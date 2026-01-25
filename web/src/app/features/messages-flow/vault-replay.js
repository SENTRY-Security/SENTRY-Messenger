// /app/features/messages-flow/vault-replay.js
// Vault-only decrypt path for scroll fetch replay mode.

import { MessageKeyVault } from '../message-key-vault.js';
import { buildDrAadFromHeader as cryptoBuildDrAadFromHeader } from '../../crypto/dr.js';
import { b64u8 as naclB64u8 } from '../../crypto/nacl.js';
import { toU8Strict } from '/shared/utils/u8-strict.js';
import {
  normalizeSemanticSubtype,
  isUserMessageSubtype,
  CONTROL_STATE_SUBTYPES,
  TRANSIENT_SIGNAL_SUBTYPES,
  classifyDecryptedPayload
} from '../semantic.js';
import { buildDecryptError } from './normalize.js';
import { importContactSecretsSnapshot } from '../../core/contact-secrets.js';

const decoder = new TextDecoder();

function normalizeCounterValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toMessageTimestamp(raw) {
  const candidates = [
    raw?.created_at,
    raw?.createdAt,
    raw?.ts,
    raw?.timestamp,
    raw?.meta?.ts
  ];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) {
      if (n > 10_000_000_000) return Math.floor(n / 1000);
      return Math.floor(n);
    }
  }
  return null;
}

function resolveServerTimestampPair(raw) {
  const candidates = [
    raw?.created_at,
    raw?.createdAt,
    raw?.ts,
    raw?.timestamp,
    raw?.meta?.ts
  ];
  for (const value of candidates) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (n > 10_000_000_000) {
      return { ts: Math.floor(n / 1000), tsMs: Math.floor(n) };
    }
    const ts = Math.floor(n);
    return { ts, tsMs: ts * 1000 };
  }
  return { ts: null, tsMs: null };
}

function toMessageId(raw) {
  if (typeof raw?.id === 'string' && raw.id.length) return raw.id;
  if (typeof raw?.message_id === 'string' && raw.message_id.length) return raw.message_id;
  if (typeof raw?.messageId === 'string' && raw.messageId.length) return raw.messageId;
  if (typeof raw?.serverMessageId === 'string' && raw.serverMessageId.length) return raw.serverMessageId;
  if (typeof raw?.server_message_id === 'string' && raw.server_message_id.length) return raw.server_message_id;
  if (typeof raw?.serverMsgId === 'string' && raw.serverMsgId.length) return raw.serverMsgId;
  return null;
}

function resolveMessageTsMs(ts) {
  if (!Number.isFinite(ts)) return null;
  const n = Number(ts);
  if (n > 10_000_000_000) return Math.floor(n);
  return Math.floor(n) * 1000;
}

function buildCounterMessageId(counter) {
  if (!Number.isFinite(counter)) return null;
  return `counter:${counter}`;
}

function resolveHeaderFromEnvelope(raw) {
  if (!raw) return { header: null, headerJson: null };
  const headerJson = raw?.header_json ?? raw?.headerJson ?? raw?.header ?? null;
  if (typeof headerJson === 'object') return { header: headerJson, headerJson: null };
  if (typeof headerJson !== 'string') return { header: null, headerJson: null };
  try {
    return { header: JSON.parse(headerJson), headerJson };
  } catch {
    return { header: null, headerJson };
  }
}

function resolveCiphertextFromEnvelope(raw) {
  if (!raw) return null;
  return raw?.ciphertext_b64 || raw?.ciphertextB64 || raw?.ciphertext || null;
}

function resolveEnvelopeCounter(raw, header) {
  const transportCounter = normalizeCounterValue(raw?.counter ?? raw?.n ?? null);
  if (Number.isFinite(transportCounter)) return transportCounter;
  return normalizeCounterValue(header?.n ?? header?.counter ?? null);
}

function resolveMessageSubtypeFromHeader(header) {
  const meta = header?.meta || null;
  return normalizeSemanticSubtype(meta?.msgType || meta?.msg_type || null);
}

function isQueueEligibleSubtype(subtype) {
  if (!subtype) return true;
  if (isUserMessageSubtype(subtype)) return true;
  // [Fix] Allow Control/Transient messages to pass through Vault Replay.
  // The presentation layer (hybrid-flow.js) will decide whether to hide or show them.
  // Dropping them here causes them to be effectively lost (no side effects, no placeholder cleanup).
  if (CONTROL_STATE_SUBTYPES.has(subtype)) return true;
  if (TRANSIENT_SIGNAL_SUBTYPES.has(subtype)) return true;
  return true;
}

function resolveSenderDeviceId(raw, header) {
  return raw?.senderDeviceId
    || raw?.sender_device_id
    || header?.meta?.senderDeviceId
    || header?.meta?.sender_device_id
    || header?.device_id
    || null;
}

function resolveTargetDeviceId(raw, header) {
  return raw?.targetDeviceId
    || raw?.target_device_id
    || raw?.receiverDeviceId
    || raw?.receiver_device_id
    || header?.meta?.targetDeviceId
    || header?.meta?.target_device_id
    || header?.meta?.receiverDeviceId
    || header?.meta?.receiver_device_id
    || null;
}

function resolveSenderDigest(raw, header) {
  const digest = raw?.senderAccountDigest
    || raw?.sender_digest
    || header?.meta?.senderDigest
    || header?.meta?.sender_digest
    || null;
  if (!digest || typeof digest !== 'string') return null;
  return digest.toUpperCase();
}

function resolveMessageDirection({
  senderDeviceId,
  targetDeviceId,
  senderDigest,
  selfDeviceId,
  selfDigest
} = {}) {
  if (targetDeviceId && selfDeviceId && targetDeviceId === selfDeviceId) return 'incoming';
  if (senderDeviceId && selfDeviceId && senderDeviceId === selfDeviceId) return 'outgoing';
  if (senderDigest && selfDigest && senderDigest === selfDigest) return 'outgoing';
  return 'incoming';
}

function sortMessagesByTimeline(items) {
  if (!Array.isArray(items) || items.length <= 1) return items || [];
  const enriched = items.map((item) => {
    const id = toMessageId(item);
    let header = item?.header || null;
    if (!header && typeof item?.header_json === 'string') {
      try { header = JSON.parse(item.header_json); } catch { }
    } else if (!header && typeof item?.headerJson === 'string') {
      try { header = JSON.parse(item.headerJson); } catch { }
    }
    if (!header && item?.header_json && typeof item.header_json === 'object') {
      header = item.header_json;
    }
    const counter = normalizeCounterValue(item?.counter ?? item?.n ?? header?.n ?? header?.counter ?? null);
    const senderDeviceId = item?.senderDeviceId
      || item?.sender_device_id
      || header?.device_id
      || header?.meta?.senderDeviceId
      || header?.meta?.sender_device_id
      || null;
    return {
      raw: item,
      id,
      tsMs: resolveMessageTsMs(toMessageTimestamp(item)),
      counter,
      senderDeviceId
    };
  });
  enriched.sort((a, b) => {
    const aHasTs = Number.isFinite(a.tsMs);
    const bHasTs = Number.isFinite(b.tsMs);
    if (aHasTs && bHasTs && a.tsMs !== b.tsMs) return a.tsMs - b.tsMs;
    if (aHasTs !== bHasTs) return aHasTs ? -1 : 1;
    const aHasCounter = Number.isFinite(a.counter);
    const bHasCounter = Number.isFinite(b.counter);
    const sameSender = a.senderDeviceId && b.senderDeviceId && a.senderDeviceId === b.senderDeviceId;
    if (sameSender && aHasCounter && bHasCounter && a.counter !== b.counter) return a.counter - b.counter;
    if (a.id && b.id && a.id !== b.id) return a.id.localeCompare(b.id);
    if (a.id && !b.id) return -1;
    if (!a.id && b.id) return 1;
    return 0;
  });
  return enriched.map((entry) => entry.raw);
}

function buildReplayItemFromRaw(raw, {
  conversationId,
  selfDeviceId,
  selfDigest
} = {}) {
  if (!raw) return { item: null };
  const packetConversationId = raw?.conversationId || raw?.conversation_id || conversationId || null;
  const { header } = resolveHeaderFromEnvelope(raw);
  const ciphertextB64 = resolveCiphertextFromEnvelope(raw);
  if (!header || !ciphertextB64) return { item: null };
  if (!header?.dr) return { item: null };
  if (header?.fallback) return { item: null };
  const counter = resolveEnvelopeCounter(raw, header);
  if (!Number.isFinite(counter)) return { item: null };
  const subtype = resolveMessageSubtypeFromHeader(header);
  if (!isQueueEligibleSubtype(subtype)) return { item: null };
  const senderDeviceId = resolveSenderDeviceId(raw, header);
  if (!senderDeviceId) return { item: null };
  const senderDigest = resolveSenderDigest(raw, header);
  const targetDeviceId = resolveTargetDeviceId(raw, header);
  const direction = resolveMessageDirection({
    senderDeviceId,
    targetDeviceId,
    senderDigest,
    selfDeviceId,
    selfDigest
  });
  const serverMessageId = toMessageId(raw) || raw?.id || raw?.messageId || null;
  const tsPair = resolveServerTimestampPair(raw);
  return {
    item: {
      conversationId: packetConversationId,
      senderDeviceId,
      senderAccountDigest: senderDigest,
      targetDeviceId,
      counter,
      serverMessageId,
      header,
      ciphertextB64,
      raw,
      meta: header?.meta || null,
      msgType: subtype,
      direction,
      ts: tsPair.ts,
      tsMs: tsPair.tsMs
    }
  };
}

async function decryptWithMessageKey({
  messageKeyB64,
  ivB64,
  ciphertextB64,
  header,
  b64u8,
  buildDrAadFromHeader
}) {
  if (!messageKeyB64) throw new Error('message key missing');
  if (!ivB64 || !ciphertextB64) throw new Error('ciphertext missing');
  const keyU8 = toU8Strict(b64u8(messageKeyB64), 'messages-flow:scroll-fetch:decrypt');
  const ivU8 = b64u8(ivB64);
  const ctU8 = b64u8(ciphertextB64);
  const key = await crypto.subtle.importKey('raw', keyU8, 'AES-GCM', false, ['decrypt']);
  const aad = header && typeof buildDrAadFromHeader === 'function'
    ? buildDrAadFromHeader(header)
    : null;
  const params = aad
    ? { name: 'AES-GCM', iv: ivU8, additionalData: aad }
    : { name: 'AES-GCM', iv: ivU8 };
  const ptBuf = await crypto.subtle.decrypt(params, key, ctU8);
  return decoder.decode(ptBuf);
}

export async function decryptReplayBatch({
  conversationId,
  items,
  selfDeviceId,
  selfDigest,
  mk,
  getMessageKey = MessageKeyVault.getMessageKey,
  buildDrAadFromHeader = cryptoBuildDrAadFromHeader,
  b64u8 = naclB64u8
} = {}) {
  void mk;
  const sortedItems = sortMessagesByTimeline(Array.isArray(items) ? items : []);
  const decrypted = [];
  const errors = [];
  for (const raw of sortedItems) {
    const built = buildReplayItemFromRaw(raw, {
      conversationId,
      selfDeviceId,
      selfDigest
    });
    const item = built?.item || null;
    if (!item) continue;
    // 2. Retrieve Message Key
    const messageId = toMessageId(item.raw) || `gap:v1:${item.counter}`; // normalized ID
    let vaultKeyResult = null;
    try {
      vaultKeyResult = await getMessageKey({
        conversationId,
        messageId,
        senderDeviceId: item.senderDeviceId
      });
    } catch (err) {
      vaultKeyResult = { ok: false, error: err?.message || err };
    }
    if (!vaultKeyResult || !vaultKeyResult.messageKeyB64) {
      errors.push(buildDecryptError({
        messageId,
        counter: item.counter,
        direction: item.direction,
        ts: item.ts,
        msgType: item.msgType || null,
        reason: 'vault_missing'
      }));
      continue;
    }

    // ATOMIC PIGGYBACK SELF-HEALING
    if (vaultKeyResult.drStateSnapshot) {
      try {
        // "Lost Entropy" Recovery:
        // If the vault provided a valid DR state snapshot (authenticated by our Master Key),
        // and we are capable of decrypting it, we should opportunistically import it.
        // This fixes scenarios where local storage was wiped/stale but the vault has the
        // correct ratchet state for this message.
        // We use 'merge' or 'replace'? `importContactSecretsSnapshot` with `replace: true` 
        // is generally safe because it has internal checks to only promote if newer/better.
        importContactSecretsSnapshot(vaultKeyResult.drStateSnapshot, {
          replace: true,
          reason: 'vault-replay-healing',
          persist: true
        });
      } catch (err) {
        console.warn('[vault-replay] self-healing failed', err);
      }
    }

    let text = null;
    try {
      text = await decryptWithMessageKey({
        messageKeyB64: vaultKeyResult.messageKeyB64,
        ivB64: item.header?.iv_b64 || null,
        ciphertextB64: item.ciphertextB64,
        header: item.header,
        b64u8,
        buildDrAadFromHeader
      });

    } catch (err) {
      // Extensive Diagnostics for Decryption Failure
      const diagVersion = Number(item.header?.v ?? item.header?.version ?? 1);
      const diagDeviceId = item.header?.device_id || item.header?.deviceId || null;
      const diagCounter = Number(item.header?.n ?? item.header?.counter);
      const diagAadStr = `v:${diagVersion};d:${diagDeviceId};c:${diagCounter}`;
      console.error('[vault-replay] decrypt failed (Route A)', {
        messageId,
        reason: err?.message,
        header: item.header,
        diag: {
          version: diagVersion,
          deviceId: diagDeviceId,
          counter: diagCounter,
          aadString: diagAadStr,
          ivLen: item.header?.iv_b64?.length,
          ctLen: item.ciphertextB64?.length,
          mkLen: vaultKeyResult.messageKeyB64?.length
        }
      });
      // User requested NO self-healing (do not delete key).
      // Fallthrough to error reporting (Route B / Gap Queue).

      errors.push(buildDecryptError({
        messageId,
        counter: item.counter,
        direction: item.direction,
        ts: item.ts,
        msgType: item.msgType || null,
        reason: err?.message || 'decrypt_failed'
      }));
      continue;
    }
    const decryptedItem = {
      conversationId: item.conversationId,
      text: text,
      decrypted: true,
      header: item.header,
      raw: item.raw,
      direction: item.direction || 'incoming',
      ts: item.ts ?? null,
      tsMs: item.tsMs ?? null,
      messageId,
      messageKeyB64: vaultKeyResult.messageKeyB64,
      meta: item.meta || null,
      counter: item.counter,
      msgType: item.msgType || null
    };

    // [Phase 29] Fix Image Rehydration (Robust)
    // 1. Re-classify subtype based on decrypted content (fixes missing header metadata)
    try {
      const cls = classifyDecryptedPayload(text, { header: item.header });
      if (cls?.subtype) {
        decryptedItem.msgType = cls.subtype;
      }
    } catch (e) { }

    // 2. If identified as media, attempt to parse JSON and extract payload
    if (decryptedItem.msgType === 'media' && typeof text === 'string' && text.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(text);
        // Case A: Nested (screenshot format) {"type":"media", "media": {...}}
        if (parsed.media && typeof parsed.media === 'object') {
          decryptedItem.media = parsed.media;
        }
        // Case B: Flattened/Legacy
        else {
          decryptedItem.media = parsed;
        }
      } catch (e) {
        console.warn('[vault-replay] failed to parse media json', e);
      }
    }

    decrypted.push(decryptedItem);
  }
  return { items: decrypted, errors };
}
