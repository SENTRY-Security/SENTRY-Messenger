// /app/features/messages-flow/live/adapters/index.js
// Legacy adapter bindings for live (B-route) flow.

import { logCapped } from '../../../../core/log.js';
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

const LIVE_ADAPTERS_LOG_CAP = 5;
const LIVE_LEGACY_ADAPTER_METHODS = Object.freeze([
  'ensureSecureConversationReady',
  'ensureDrReceiverState',
  'drState',
  'drDecryptText',
  'persistDrSnapshot',
  'vaultPutIncomingKey',
  'appendTimelineBatch',
  'getAccountDigest',
  'getDeviceId'
]);
const LIVE_LEGACY_ADAPTER_METHOD_SET = new Set(LIVE_LEGACY_ADAPTER_METHODS);

function findUnexpectedKeys(target, { exclude = [] } = {}) {
  if (!target || typeof target !== 'object') return [];
  const extras = [];
  const excludeSet = new Set(exclude);
  for (const key of Object.keys(target)) {
    if (excludeSet.has(key)) continue;
    if (!LIVE_LEGACY_ADAPTER_METHOD_SET.has(key)) extras.push(key);
  }
  return extras;
}

export function createLiveLegacyAdapters(deps = {}) {
  const logger = typeof deps.logCapped === 'function' ? deps.logCapped : logCapped;
  const extraDeps = findUnexpectedKeys(deps, { exclude: ['logCapped'] });
  if (extraDeps.length) {
    logger('liveAdaptersInterfaceTrace', {
      source: 'deps',
      unexpectedKeys: extraDeps.sort()
    }, LIVE_ADAPTERS_LOG_CAP);
  }

  const ensureSecureConversationReady = deps.ensureSecureConversationReady || legacyEnsureSecureConversationReady;
  const ensureDrReceiverState = deps.ensureDrReceiverState || legacyEnsureDrReceiverState;
  const drState = deps.drState || storeDrState;
  const drDecryptText = deps.drDecryptText || legacyDrDecryptText;
  const persistDrSnapshot = deps.persistDrSnapshot || legacyPersistDrSnapshot;
  const vaultPutIncomingKey = deps.vaultPutIncomingKey || MessageKeyVault.putMessageKey;
  const appendTimelineBatch = deps.appendTimelineBatch || timelineAppendBatch;
  const getAccountDigest = deps.getAccountDigest || storeGetAccountDigest;
  const getDeviceId = deps.getDeviceId || storeGetDeviceId;

  const adapters = {
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

  const extraAdapters = findUnexpectedKeys(adapters);
  if (extraAdapters.length) {
    logger('liveAdaptersInterfaceTrace', {
      source: 'adapters',
      unexpectedKeys: extraAdapters.sort()
    }, LIVE_ADAPTERS_LOG_CAP);
  }

  return adapters;
}
