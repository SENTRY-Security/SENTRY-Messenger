/**
 * Business Conversation Crypto Module
 *
 * Implements the Sender Key protocol for group messaging:
 * - HKDF-SHA256 key derivation hierarchy
 * - group_seed → group_meta_key, sender_chain_key, message_key
 * - AES-256-GCM encryption/decryption with AAD
 * - Chain advancement for forward secrecy
 */

import { bytesToB64Url, b64UrlToBytes } from '../utils/base64.js';
import { deriveConversationContext } from '../conversation/context.js';

const encoder = new TextEncoder();

// ── Key Derivation ──────────────────────────────────────────────

/**
 * Derive group_meta_key from group_seed.
 * Used to encrypt/decrypt meta blob, policy blob, role blob, tombstone payloads.
 */
export async function deriveGroupMetaKey(groupSeed) {
  const baseKey = await crypto.subtle.importKey(
    'raw', groupSeed, 'HKDF', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: encoder.encode('sentry/biz-conv/meta-key/v1')
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Derive sender chain key for a specific (epoch, deviceId) pair.
 */
export async function deriveSenderChainKey(groupSeed, epoch, deviceId) {
  const baseKey = await crypto.subtle.importKey(
    'raw', groupSeed, 'HKDF', false, ['deriveBits']
  );
  const info = `sentry/biz-conv/sender-key/v1/${epoch}/${deviceId}`;
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: encoder.encode(info)
    },
    baseKey,
    256
  );
  return new Uint8Array(bits);
}

/**
 * Advance a sender chain: derive message_key and next chain_key.
 */
export async function advanceSenderChain(chainKey) {
  // Derive message key
  const mkBase = await crypto.subtle.importKey('raw', chainKey, 'HKDF', false, ['deriveBits']);
  const mkBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF', hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: encoder.encode('sentry/biz-conv/msg-key/v1')
    },
    mkBase, 256
  );
  const messageKey = new Uint8Array(mkBits);

  // Advance chain key
  const ckBase = await crypto.subtle.importKey('raw', chainKey, 'HKDF', false, ['deriveBits']);
  const ckBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF', hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: encoder.encode('sentry/biz-conv/chain-advance/v1')
    },
    ckBase, 256
  );
  const nextChainKey = new Uint8Array(ckBits);

  return { messageKey, nextChainKey };
}

// ── AAD Construction ────────────────────────────────────────────

export function buildBizConvAad({ v = 1, epoch, deviceId, counter }) {
  return encoder.encode(
    `sentry/biz-conv/aad/v${v}:${epoch}:${deviceId}:${counter}`
  );
}

// ── Meta Blob Encryption ────────────────────────────────────────

/**
 * Encrypt a meta object (name, description, avatar, etc.) with group_meta_key.
 */
export async function encryptMetaBlob(metaKey, meta) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(meta));
  const aad = encoder.encode('sentry/biz-conv/meta/v1');
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    metaKey,
    plaintext
  );
  return {
    v: 1,
    iv_b64: bytesToB64Url(iv),
    ct_b64: bytesToB64Url(new Uint8Array(ciphertext))
  };
}

/**
 * Decrypt a meta blob back to the original object.
 */
export async function decryptMetaBlob(metaKey, blob) {
  if (!blob) return null;
  const parsed = typeof blob === 'string' ? JSON.parse(blob) : blob;
  const iv = b64UrlToBytes(parsed.iv_b64);
  const ct = b64UrlToBytes(parsed.ct_b64);
  const aad = encoder.encode('sentry/biz-conv/meta/v1');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    metaKey,
    ct
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

// ── Policy Blob Encryption ──────────────────────────────────────

export async function encryptPolicyBlob(metaKey, policy) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(policy));
  const aad = encoder.encode('sentry/biz-conv/policy/v1');
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    metaKey,
    plaintext
  );
  return {
    v: 1,
    iv_b64: bytesToB64Url(iv),
    ct_b64: bytesToB64Url(new Uint8Array(ciphertext))
  };
}

export async function decryptPolicyBlob(metaKey, blob) {
  if (!blob) return null;
  const parsed = typeof blob === 'string' ? JSON.parse(blob) : blob;
  const iv = b64UrlToBytes(parsed.iv_b64);
  const ct = b64UrlToBytes(parsed.ct_b64);
  const aad = encoder.encode('sentry/biz-conv/policy/v1');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    metaKey,
    ct
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

// ── Role Blob Encryption ────────────────────────────────────────

export async function encryptRoleBlob(metaKey, role) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(role));
  const aad = encoder.encode('sentry/biz-conv/role/v1');
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    metaKey,
    plaintext
  );
  return {
    v: 1,
    iv_b64: bytesToB64Url(iv),
    ct_b64: bytesToB64Url(new Uint8Array(ciphertext))
  };
}

export async function decryptRoleBlob(metaKey, blob) {
  if (!blob) return null;
  const parsed = typeof blob === 'string' ? JSON.parse(blob) : blob;
  const iv = b64UrlToBytes(parsed.iv_b64);
  const ct = b64UrlToBytes(parsed.ct_b64);
  const aad = encoder.encode('sentry/biz-conv/role/v1');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    metaKey,
    ct
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

// ── Tombstone Payload Encryption ────────────────────────────────

export async function encryptTombstonePayload(metaKey, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(payload));
  const aad = encoder.encode('sentry/biz-conv/tombstone/v1');
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    metaKey,
    plaintext
  );
  return {
    v: 1,
    iv_b64: bytesToB64Url(iv),
    ct_b64: bytesToB64Url(new Uint8Array(ciphertext))
  };
}

export async function decryptTombstonePayload(metaKey, blob) {
  if (!blob) return null;
  const parsed = typeof blob === 'string' ? JSON.parse(blob) : blob;
  if (!parsed.iv_b64 || !parsed.ct_b64) return parsed; // unencrypted placeholder
  const iv = b64UrlToBytes(parsed.iv_b64);
  const ct = b64UrlToBytes(parsed.ct_b64);
  const aad = encoder.encode('sentry/biz-conv/tombstone/v1');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    metaKey,
    ct
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

// ── Message Encryption (Sender Key) ────────────────────────────

const MAX_SKIP = 100;

/**
 * Derive the message key for a given counter by advancing the chain from scratch.
 * For production use, prefer the cached chain state in BizConvStore.
 */
export async function deriveMessageKeyAt(groupSeed, epoch, deviceId, counter) {
  let chainKey = await deriveSenderChainKey(groupSeed, epoch, deviceId);
  let messageKey;
  for (let i = 0; i <= counter; i++) {
    const result = await advanceSenderChain(chainKey);
    messageKey = result.messageKey;
    chainKey = result.nextChainKey;
  }
  return { messageKey, nextChainKey: chainKey };
}

/**
 * Encrypt a message using the Sender Key protocol.
 * Returns an envelope object.
 */
export async function encryptBizConvMessage(groupSeed, epoch, myDeviceId, counter, plaintext) {
  const { messageKey } = await deriveMessageKeyAt(groupSeed, epoch, myDeviceId, counter);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = buildBizConvAad({ v: 1, epoch, deviceId: myDeviceId, counter });
  const key = await crypto.subtle.importKey('raw', messageKey, 'AES-GCM', false, ['encrypt']);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    key,
    encoder.encode(JSON.stringify(plaintext))
  );

  return {
    epoch,
    sender_device_id: myDeviceId,
    counter,
    iv_b64: bytesToB64Url(iv),
    ciphertext_b64: bytesToB64Url(new Uint8Array(ct))
  };
}

/**
 * Decrypt a message using the Sender Key protocol.
 */
export async function decryptBizConvMessage(groupSeed, envelope) {
  const { epoch, sender_device_id, counter, iv_b64, ciphertext_b64 } = envelope;

  const { messageKey } = await deriveMessageKeyAt(groupSeed, epoch, sender_device_id, counter);

  const iv = b64UrlToBytes(iv_b64);
  const ct = b64UrlToBytes(ciphertext_b64);
  const aad = buildBizConvAad({ v: 1, epoch, deviceId: sender_device_id, counter });
  const key = await crypto.subtle.importKey('raw', messageKey, 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    key, ct
  );

  return JSON.parse(new TextDecoder().decode(plain));
}

/**
 * Encrypt a message using a cached chain state (more efficient).
 * Mutates chainState in place (advances counter and chainKey).
 */
export async function encryptWithChainState(chainState, epoch, myDeviceId, plaintext) {
  const { messageKey, nextChainKey } = await advanceSenderChain(chainState.chainKey);
  const counter = chainState.counter;

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = buildBizConvAad({ v: 1, epoch, deviceId: myDeviceId, counter });
  const key = await crypto.subtle.importKey('raw', messageKey, 'AES-GCM', false, ['encrypt']);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    key,
    encoder.encode(JSON.stringify(plaintext))
  );

  // Advance state
  chainState.chainKey = nextChainKey;
  chainState.counter = counter + 1;

  return {
    epoch,
    sender_device_id: myDeviceId,
    counter,
    iv_b64: bytesToB64Url(iv),
    ciphertext_b64: bytesToB64Url(new Uint8Array(ct))
  };
}

/**
 * Decrypt a message using cached chain state with out-of-order support.
 * Mutates chainState (advances chain, stores skipped keys).
 */
export async function decryptWithChainState(chainState, groupSeed, envelope) {
  const { epoch, sender_device_id, counter, iv_b64, ciphertext_b64 } = envelope;

  let messageKey;

  // Check skipped keys first
  if (chainState.skippedKeys && chainState.skippedKeys.has(counter)) {
    messageKey = chainState.skippedKeys.get(counter);
    chainState.skippedKeys.delete(counter);
  } else if (counter < chainState.counter) {
    // Already past this counter and not in skipped — re-derive from seed
    const result = await deriveMessageKeyAt(groupSeed, epoch, sender_device_id, counter);
    messageKey = result.messageKey;
  } else {
    // Need to advance chain
    const skip = counter - chainState.counter;
    if (skip > MAX_SKIP) {
      throw new Error(`Too many skipped messages: ${skip} > ${MAX_SKIP}`);
    }

    // Store skipped keys
    for (let i = chainState.counter; i < counter; i++) {
      const result = await advanceSenderChain(chainState.chainKey);
      if (!chainState.skippedKeys) chainState.skippedKeys = new Map();
      chainState.skippedKeys.set(i, result.messageKey);
      chainState.chainKey = result.nextChainKey;
      chainState.counter = i + 1;
    }

    // Derive the target message key
    const result = await advanceSenderChain(chainState.chainKey);
    messageKey = result.messageKey;
    chainState.chainKey = result.nextChainKey;
    chainState.counter = counter + 1;

    // Trim skipped keys if too many
    if (chainState.skippedKeys && chainState.skippedKeys.size > MAX_SKIP) {
      const keys = Array.from(chainState.skippedKeys.keys()).sort((a, b) => a - b);
      while (chainState.skippedKeys.size > MAX_SKIP) {
        chainState.skippedKeys.delete(keys.shift());
      }
    }
  }

  const iv = b64UrlToBytes(iv_b64);
  const ct = b64UrlToBytes(ciphertext_b64);
  const aad = buildBizConvAad({ v: 1, epoch, deviceId: sender_device_id, counter });
  const key = await crypto.subtle.importKey('raw', messageKey, 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    key, ct
  );

  return JSON.parse(new TextDecoder().decode(plain));
}

// ── Conversation ID Derivation ──────────────────────────────────

/**
 * Derive conversation_id from group_seed.
 * Uses a fixed deviceId so all members derive the same conversation_id.
 */
export async function deriveBizConvId(groupSeed) {
  const { conversationId, tokenB64 } = await deriveConversationContext(groupSeed, { deviceId: 'biz-conv' });
  return { conversationId, tokenB64 };
}

// ── KDM Structure ───────────────────────────────────────────────

/**
 * Build a Key Distribution Message payload (sent via DR session).
 */
export function buildKDM({ conversationId, epoch, groupSeed, meta = null }) {
  return {
    v: 1,
    msg_type: 'biz-conv-kdm',
    conversation_id: conversationId,
    epoch,
    group_seed_b64: bytesToB64Url(groupSeed),
    meta: meta || null,
    ts: Date.now()
  };
}

/**
 * Parse a received KDM payload.
 */
export function parseKDM(payload) {
  if (!payload || payload.msg_type !== 'biz-conv-kdm') return null;
  return {
    conversationId: payload.conversation_id,
    epoch: payload.epoch,
    groupSeed: b64UrlToBytes(payload.group_seed_b64),
    meta: payload.meta,
    ts: payload.ts
  };
}
