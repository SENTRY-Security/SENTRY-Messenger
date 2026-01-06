// /app/features/messages-flow/live/adapters/index.js
// Legacy adapter bindings for live (B-route) flow.

import {
  ensureDrReceiverState as legacyEnsureDrReceiverState,
  persistDrSnapshot as legacyPersistDrSnapshot
} from '../../../dr-session.js';
import { MessageKeyVault } from '../../../message-key-vault.js';
import { ensureSecureConversationReady as legacyEnsureSecureConversationReady } from '../../../secure-conversation-manager.js';
import { appendBatch as timelineAppendBatch } from '../../../timeline-store.js';
import { drDecryptText as legacyDrDecryptText } from '../../../../crypto/dr.js';
import {
  drState as storeDrState,
  getAccountDigest as storeGetAccountDigest,
  getDeviceId as storeGetDeviceId
} from '../../../../core/store.js';

export function createLiveLegacyAdapters(deps = {}) {
  const ensureSecureConversationReady = deps.ensureSecureConversationReady || legacyEnsureSecureConversationReady;
  const ensureDrReceiverState = deps.ensureDrReceiverState || legacyEnsureDrReceiverState;
  const drState = deps.drState || storeDrState;
  const drDecryptText = deps.drDecryptText || legacyDrDecryptText;
  const persistDrSnapshot = deps.persistDrSnapshot || legacyPersistDrSnapshot;
  const vaultPutIncomingKey = deps.vaultPutIncomingKey || MessageKeyVault.putMessageKey;
  const appendTimelineBatch = deps.appendTimelineBatch || timelineAppendBatch;
  const getAccountDigest = deps.getAccountDigest || storeGetAccountDigest;
  const getDeviceId = deps.getDeviceId || storeGetDeviceId;

  return {
    ensureSecureConversationReady(params = {}) {
      return ensureSecureConversationReady(params);
    },

    ensureDrReceiverState(conversationId, peerAccountDigest, peerDeviceId) {
      return ensureDrReceiverState({
        conversationId,
        peerAccountDigest,
        peerDeviceId
      });
    },

    drState(params = {}) {
      return drState(params);
    },

    drDecryptText(state, packet, opts = {}) {
      return drDecryptText(state, packet, opts);
    },

    persistDrSnapshot(params = {}) {
      return persistDrSnapshot(params);
    },

    vaultPutIncomingKey(params = {}) {
      return vaultPutIncomingKey(params);
    },

    appendTimelineBatch(entries = [], opts = {}) {
      return appendTimelineBatch(entries, opts);
    },

    getAccountDigest() {
      return getAccountDigest();
    },

    getDeviceId() {
      return getDeviceId();
    }
  };
}
