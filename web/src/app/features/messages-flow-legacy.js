// /app/features/messages-flow-legacy.js
// Facade for legacy message pipeline entry points.

import { logCapped } from '../core/log.js';
import {
  syncOfflineDecryptNow,
  triggerServerCatchup,
  triggerServerCatchupForTargets
} from './messages.js';
import { startRestorePipeline } from './restore-coordinator.js';
import {
  OFFLINE_SYNC_LOG_CAP,
  OFFLINE_SYNC_TRIGGER_COALESCE_MS,
  SERVER_CATCHUP_TRIGGER_COALESCE_MS
} from './messages-sync-policy.js';

let offlineSyncTriggerLastAtMs = 0;

export function startRestorePipelineAfterLogin({ source } = {}) {
  return startRestorePipeline({ source });
}

export function onWsIncomingMessageNew({ event, handleIncomingSecureMessage } = {}) {
  if (typeof handleIncomingSecureMessage === 'function') {
    return handleIncomingSecureMessage(event);
  }
  return null;
}

export function onEnterConversation({
  conversationId,
  peerAccountDigest,
  peerDeviceId,
  loadActiveConversationMessages,
  replay,
  reason,
  runCatchup = true
} = {}) {
  if (runCatchup && conversationId) {
    triggerServerCatchup({
      source: 'enter_conversation',
      conversationId,
      peerAccountDigest,
      peerDeviceId
    });
  }
  if (typeof loadActiveConversationMessages === 'function') {
    return loadActiveConversationMessages({
      append: false,
      replay,
      reason
    });
  }
  return null;
}

export async function onPullToRefreshContacts({
  loadInitialContacts,
  renderContacts,
  syncConversationThreadsFromContacts,
  refreshConversationPreviews,
  renderConversationList,
  onError,
  onFinally
} = {}) {
  try {
    if (typeof loadInitialContacts === 'function') {
      await loadInitialContacts();
    }
    if (typeof renderContacts === 'function') {
      renderContacts();
    }
    if (typeof syncConversationThreadsFromContacts === 'function') {
      syncConversationThreadsFromContacts();
    }
    if (typeof refreshConversationPreviews === 'function') {
      await refreshConversationPreviews({ force: true });
    }
    if (typeof renderConversationList === 'function') {
      renderConversationList();
    }
  } catch (err) {
    if (typeof onError === 'function') onError(err);
  } finally {
    if (typeof onFinally === 'function') onFinally();
  }
}

export function runOfflineCatchupNow({
  source,
  reasonCode,
  debounceMs,
  onOfflineDecryptError,
  reconcileOutgoingStatus,
  runOfflineDecrypt = true,
  runServerCatchup = true
} = {}) {
  let offlinePromise = null;
  if (runOfflineDecrypt) {
    offlinePromise = syncOfflineDecryptNow({ source, reasonCode });
    if (offlinePromise && typeof offlinePromise.catch === 'function') {
      offlinePromise.catch((err) => {
        if (typeof onOfflineDecryptError === 'function') onOfflineDecryptError(err);
      });
    }
  }
  if (runServerCatchup) {
    triggerServerCatchupForTargets({ source, debounceMs });
  }
  if (typeof reconcileOutgoingStatus === 'function') {
    reconcileOutgoingStatus({ source });
  }
  return offlinePromise;
}

export function onVisibilityResume({
  source,
  reconcileOutgoingStatus,
  onOfflineDecryptError
} = {}) {
  const now = Date.now();
  const coalesced = offlineSyncTriggerLastAtMs
    && Number.isFinite(OFFLINE_SYNC_TRIGGER_COALESCE_MS)
    && (now - offlineSyncTriggerLastAtMs) < OFFLINE_SYNC_TRIGGER_COALESCE_MS;
  logCapped('offlineSyncTriggerTrace', {
    source: source || null,
    coalesced,
    tsMs: now
  }, OFFLINE_SYNC_LOG_CAP);
  if (coalesced) return null;
  offlineSyncTriggerLastAtMs = now;
  return runOfflineCatchupNow({
    source,
    debounceMs: SERVER_CATCHUP_TRIGGER_COALESCE_MS,
    onOfflineDecryptError,
    reconcileOutgoingStatus
  });
}

export function reconcileOutgoingStatusForConversation({
  conversationId,
  peerAccountDigest,
  source,
  reconcileOutgoingStatusNow
} = {}) {
  if (typeof reconcileOutgoingStatusNow === 'function') {
    return reconcileOutgoingStatusNow({ conversationId, peerAccountDigest, source });
  }
  return null;
}
