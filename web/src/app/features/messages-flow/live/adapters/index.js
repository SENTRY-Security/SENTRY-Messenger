// /app/features/messages-flow/live/adapters/index.js
// Legacy adapter bindings for live (B-route) flow.

import {
  listSecureMessages as apiListSecureMessages,
  getSecureMessageByCounter as apiGetSecureMessageByCounter,
  fetchSecureMaxCounter as apiFetchSecureMaxCounter
} from '../../../../api/messages.js';
import { ensureDrReceiverState as legacyEnsureDrReceiverState } from '../../../dr-session.js';
import { listSecureAndDecrypt as legacyListSecureAndDecrypt } from '../../../messages.js';
import { MessageKeyVault } from '../../../message-key-vault.js';

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

function normalizeCounter(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function createLiveLegacyAdapters(deps = {}) {
  const listSecureMessages = deps.listSecureMessages || apiListSecureMessages;
  const getSecureMessageByCounter = deps.getSecureMessageByCounter || apiGetSecureMessageByCounter;
  const fetchSecureMaxCounter = deps.fetchSecureMaxCounter || apiFetchSecureMaxCounter;
  const ensureDrReceiverState = deps.ensureDrReceiverState || legacyEnsureDrReceiverState;
  const listSecureAndDecrypt = deps.listSecureAndDecrypt || legacyListSecureAndDecrypt;
  const vaultPutIncomingKey = deps.vaultPutIncomingKey || MessageKeyVault.putMessageKey;

  return {
    // Legacy API passthrough; TODO: replace with live server API wrapper.
    listSecureMessages(conversationId, limit, cursor) {
      const { cursorTs, cursorId } = normalizeCursor(cursor);
      return listSecureMessages({ conversationId, limit, cursorTs, cursorId });
    },

    // Legacy API passthrough; TODO: replace with live server max counter wrapper.
    getMaxCounter(conversationId, senderDeviceId) {
      return fetchSecureMaxCounter({ conversationId, senderDeviceId });
    },

    // Legacy API passthrough; TODO: replace with live counter lookup wrapper.
    getMessageByCounter(conversationId, counter, opts = {}) {
      return getSecureMessageByCounter({
        conversationId,
        counter: normalizeCounter(counter),
        senderDeviceId: opts?.senderDeviceId || null,
        senderAccountDigest: opts?.senderAccountDigest || null
      });
    },

    // Legacy DR state bootstrap; TODO: replace with live state access.
    ensureDrReceiverState(conversationId, peerAccountDigest, peerDeviceId) {
      return ensureDrReceiverState({
        conversationId,
        peerAccountDigest,
        peerDeviceId
      });
    },

    // Legacy decrypt pipeline; TODO: replace with live decrypt implementation.
    decryptLiveItem(item, context = {}) {
      const conversationId = context?.conversationId
        || item?.conversationId
        || item?.conversation_id
        || null;
      return listSecureAndDecrypt({
        conversationId,
        tokenB64: context?.tokenB64 || null,
        peerAccountDigest: context?.peerAccountDigest || null,
        peerDeviceId: context?.peerDeviceId || null,
        prefetchedList: item ? [item] : [],
        limit: 1,
        mutateState: true,
        allowReplay: false,
        priority: 'live',
        bRoute: true,
        sourceTag: 'messages-flow/live:decryptLiveItem'
      });
    },

    // Legacy vault write; TODO: replace with live vault gateway.
    vaultPutIncomingKey(params = {}) {
      return vaultPutIncomingKey(params);
    }
  };
}
