/**
 * Business Conversation Message Replay Module
 *
 * Fetches encrypted group message history from the server and decrypts it
 * using deterministic key derivation from backed-up seeds.
 *
 * Unlike 1:1 messages (which store per-message keys in vault), group message
 * keys are deterministically derived from `seed + epoch + deviceId + counter`
 * via HKDF.  This means we only need the seeds (already persisted in backup)
 * to re-decrypt any historical message — no vault round-trip required.
 *
 * Flow:
 *   hydrateBizConvFromBackup  →  seeds restored
 *   syncBizConvListFromServer →  threads rebuilt
 *   replayBizConvMessages     →  fetch ciphertext from server → derive key → decrypt → timeline
 */

import { BizConvStore } from './biz-conv.js';
import { listSecureMessages } from '../api/messages.js';
import { decryptBizConvMessage } from '../../shared/crypto/biz-conv.js';
import { appendBatch } from './timeline-store.js';
import { upsertBizConvThread } from './conversation-updates.js';
import { log } from '../core/log.js';

/** Maximum messages to fetch per group during initial replay */
const REPLAY_PAGE_LIMIT = 50;

/**
 * Replay recent messages for ALL active business conversations.
 * Called once after hydration + sync during post-login flow.
 */
export async function replayAllBizConvMessages() {
  const active = BizConvStore.listActive();
  if (!active.length) return;

  log({ bizConvReplayStart: active.length });

  // Run replays concurrently (bounded) to avoid blocking login
  const results = await Promise.allSettled(
    active.map(state => replayBizConvMessages(state.conversation_id))
  );

  let totalDecrypted = 0;
  let totalFailed = 0;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) {
      totalDecrypted += r.value.decrypted;
      totalFailed += r.value.failed;
    }
  }

  log({ bizConvReplayDone: active.length, totalDecrypted, totalFailed });
}

/**
 * Replay recent messages for a single business conversation.
 * Fetches encrypted messages from server, derives keys from seed, decrypts,
 * and appends to the timeline store.
 *
 * @param {string} conversationId
 * @param {{ limit?: number, cursorTs?: number }} [opts]
 * @returns {Promise<{ decrypted: number, failed: number }>}
 */
export async function replayBizConvMessages(conversationId, opts = {}) {
  const state = BizConvStore.get(conversationId);
  if (!state || state.status !== 'active') {
    return { decrypted: 0, failed: 0 };
  }

  const limit = opts.limit || REPLAY_PAGE_LIMIT;

  try {
    const { r, data } = await listSecureMessages({
      conversationId,
      limit,
      cursorTs: opts.cursorTs,
      includeKeys: false  // Not needed — we derive keys from seed
    });

    if (!r.ok || !data?.items?.length) {
      return { decrypted: 0, failed: 0 };
    }

    const items = data.items;
    const decryptedEntries = [];
    let failedCount = 0;

    for (const item of items) {
      try {
        const envelope = extractEnvelopeFromItem(item);
        if (!envelope) {
          failedCount++;
          continue;
        }

        // Check we have the seed for this epoch
        const seed = state.seeds[envelope.epoch];
        if (!seed) {
          failedCount++;
          continue;
        }

        // Deterministic decryption — does NOT mutate chain state
        const plaintext = await decryptBizConvMessage(seed, envelope);

        const messageId = item.id || item.message_id || crypto.randomUUID();
        const ts = resolveItemTs(item);

        decryptedEntries.push({
          messageId,
          conversationId,
          msgType: 'biz-conv-text',
          text: typeof plaintext === 'string' ? plaintext : plaintext?.text || JSON.stringify(plaintext),
          senderAccountDigest: item.sender_account_digest,
          senderDeviceId: envelope.sender_device_id,
          counter: envelope.counter,
          ts,
          decrypted: true,
          replayed: true  // Mark so UI can distinguish from live messages if needed
        });
      } catch (err) {
        failedCount++;
        console.warn('[biz-conv-replay] decrypt failed', {
          convId: conversationId.slice(0, 16),
          itemId: item?.id?.slice(0, 12),
          error: err?.message
        });
      }
    }

    // Batch-append to timeline (dedup is handled by timeline-store)
    if (decryptedEntries.length > 0) {
      appendBatch(decryptedEntries);

      // Update thread preview with the most recent message
      const newest = decryptedEntries[0]; // items come newest-first from server
      if (newest) {
        upsertBizConvThread(conversationId, {
          lastMessageText: newest.text,
          lastMessageTs: newest.ts,
          lastMessageId: newest.messageId
        });
      }
    }

    return { decrypted: decryptedEntries.length, failed: failedCount };
  } catch (err) {
    log({ bizConvReplayError: err?.message, convId: conversationId.slice(0, 16) });
    return { decrypted: 0, failed: 0 };
  }
}

/**
 * Fetch older messages for scroll-back pagination.
 * Called when user scrolls up in a biz-conv chat.
 *
 * @param {string} conversationId
 * @param {number} cursorTs - Timestamp cursor for pagination (oldest message currently visible)
 * @param {number} [limit=20]
 * @returns {Promise<{ entries: Array, hasMore: boolean }>}
 */
export async function fetchOlderBizConvMessages(conversationId, cursorTs, limit = 20) {
  const result = await replayBizConvMessages(conversationId, { limit, cursorTs });
  // If we got a full page, there are likely more messages
  return {
    entries: result.decrypted,
    hasMore: result.decrypted >= limit
  };
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Extract a crypto envelope from a server message item.
 * The server stores crypto fields inside header_json.
 */
function extractEnvelopeFromItem(item) {
  const header = parseHeader(item);
  if (!header) return null;

  const epoch = header.epoch ?? item.epoch;
  const senderDeviceId = header.sender_device_id || header.senderDeviceId || item.sender_device_id;
  const counter = header.counter ?? item.counter;
  const ivB64 = header.iv_b64 || item.iv_b64;
  const ciphertextB64 = header.ciphertext_b64 || item.ciphertext_b64;

  if (epoch === undefined || epoch === null) return null;
  if (!senderDeviceId) return null;
  if (counter === undefined || counter === null) return null;
  if (!ivB64 || !ciphertextB64) return null;

  return {
    epoch: Number(epoch),
    sender_device_id: senderDeviceId,
    counter: Number(counter),
    iv_b64: ivB64,
    ciphertext_b64: ciphertextB64
  };
}

function parseHeader(item) {
  if (!item) return null;
  if (item.header && typeof item.header === 'object') return item.header;
  if (typeof item.header_json === 'string') {
    try { return JSON.parse(item.header_json); } catch { return null; }
  }
  if (typeof item.header === 'string') {
    try { return JSON.parse(item.header); } catch { return null; }
  }
  return null;
}

function resolveItemTs(item) {
  // Server stores created_at in seconds; client uses milliseconds
  const createdAt = Number(item.created_at);
  if (Number.isFinite(createdAt)) {
    return createdAt < 1e12 ? createdAt * 1000 : createdAt;
  }
  const ts = Number(item.ts);
  if (Number.isFinite(ts)) {
    return ts < 1e12 ? ts * 1000 : ts;
  }
  return Date.now();
}
