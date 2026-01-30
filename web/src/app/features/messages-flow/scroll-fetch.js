// /app/features/messages-flow/scroll-fetch.js
// Scroll fetch pipeline: server list + vault-only decrypt. No state writes.

import { MessageKeyVault } from '../message-key-vault.js';
import { buildDrAadFromHeader as cryptoBuildDrAadFromHeader } from '../../crypto/dr.js';
import { b64u8 as naclB64u8 } from '../../crypto/nacl.js';
import {
  getAccountDigest as storeGetAccountDigest,
  getDeviceId as storeGetDeviceId,
  getMkRaw as storeGetMkRaw
} from '../../core/store.js';
import { listSecureMessagesForReplay } from './server-api.js';
import { decryptReplayBatch } from './vault-replay.js';
import { normalizeReplayItems } from './normalize.js';
import { handoffReplayVaultMissing } from '../restore-coordinator.js';

function normalizeCursor(cursor) {
  if (cursor === null || cursor === undefined) return { cursorTs: null, cursorId: null };
  if (typeof cursor === 'object') {
    return {
      cursorTs: cursor.ts ?? cursor.cursorTs ?? null,
      cursorId: cursor.id ?? cursor.cursorId ?? null
    };
  }
  return { cursorTs: cursor, cursorId: null };
}

function resolveReplayMissingKeyHandoff(errors) {
  const list = Array.isArray(errors) ? errors : [];
  let maxCounter = null;
  let reasonCode = null;
  for (const entry of list) {
    const entryReason = entry?.reasonCode || entry?.reason || null;
    if (entryReason !== 'vault_missing' && entryReason !== 'MISSING_MESSAGE_KEY') continue;
    const counter = Number(entry?.counter);
    if (Number.isFinite(counter)) {
      maxCounter = maxCounter === null ? counter : Math.max(maxCounter, counter);
    }
    if (!reasonCode) reasonCode = entryReason;
  }
  return {
    hasMissing: reasonCode !== null,
    maxCounter,
    reasonCode
  };
}

export function createMessagesFlowScrollFetch(deps = {}) {
  const {
    listSecureMessages,
    getAccountDigest = storeGetAccountDigest,
    getDeviceId = storeGetDeviceId,
    getMkRaw = storeGetMkRaw,
    getMessageKey = MessageKeyVault.getMessageKey,
    buildDrAadFromHeader = cryptoBuildDrAadFromHeader,
    b64u8 = naclB64u8
  } = deps;

  return async function scrollFetch({
    conversationId,
    cursor,
    limit = 20,
    isReplay = true
  } = {}) {
    if (!conversationId) throw new Error('conversationId required');
    if (!isReplay) throw new Error('scroll fetch requires replay mode');
    let mkRaw = null;
    try { mkRaw = typeof getMkRaw === 'function' ? getMkRaw() : null; } catch { }
    if (!mkRaw) {
      const err = new Error('MK missing');
      err.code = 'MKMissing';
      throw err;
    }
    let selfDeviceId = null;
    let selfDigest = null;
    try { selfDeviceId = typeof getDeviceId === 'function' ? getDeviceId() : null; } catch { }
    try { selfDigest = typeof getAccountDigest === 'function' ? getAccountDigest() : null; } catch { }
    if (typeof selfDigest === 'string') selfDigest = selfDigest.toUpperCase();

    const { cursorTs, cursorId } = normalizeCursor(cursor);
    const { items: rawItems, nextCursor, keys: serverKeys } = await listSecureMessagesForReplay({
      conversationId,
      limit,
      cursorTs,
      cursorId,
      includeKeys: true,
      listSecureMessages
    });
    const { items: decryptedItems, errors } = await decryptReplayBatch({
      conversationId,
      items: rawItems,
      selfDeviceId,
      selfDigest,
      mk: mkRaw,
      serverKeys,
      getMessageKey,
      buildDrAadFromHeader,
      b64u8
    });
    const normalized = normalizeReplayItems({
      items: decryptedItems,
      errors
    });
    const missingHandoff = resolveReplayMissingKeyHandoff(normalized.errors);
    if (missingHandoff.hasMissing) {
      handoffReplayVaultMissing({
        conversationId,
        maxCounter: missingHandoff.maxCounter,
        reasonCode: missingHandoff.reasonCode || 'vault_missing',
        source: 'scroll_fetch'
      });
    }
    return {
      items: normalized.items,
      errors: normalized.errors,
      nextCursor
    };
  };
}
