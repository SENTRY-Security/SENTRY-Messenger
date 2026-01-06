// /app/features/messages-flow-legacy.js
// Facade for legacy message pipeline entry points.

import { logCapped } from '../core/log.js';
import {
  listSecureAndDecrypt,
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
const LEGACY_OPTION_LOG_CAP = 5;
const LEGACY_LIST_SECURE_ALLOWLIST = new Set([
  'allowReplay',
  'cursorId',
  'cursorTs',
  'limit',
  'mutateState',
  'onMessageDecrypted',
  'prefetchedList',
  'priority',
  'sendReadReceipt',
  'silent',
  'sourceTag'
]);
const LEGACY_ENTER_CONVERSATION_ALLOWLIST = new Set(['silent']);

function pickLegacyOptions(options, allowlist, { source } = {}) {
  if (!options || typeof options !== 'object') return {};
  const allowed = {};
  const dropped = [];
  for (const key of Object.keys(options)) {
    if (allowlist.has(key)) {
      allowed[key] = options[key];
    } else {
      dropped.push(key);
    }
  }
  if (dropped.length) {
    logCapped('legacyFlowOptionDrop', { source: source || null, dropped }, LEGACY_OPTION_LOG_CAP);
  }
  return allowed;
}

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
  loadOptions,
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
    const params = {
      append: false,
      replay,
      reason
    };
    const filteredOptions = pickLegacyOptions(loadOptions, LEGACY_ENTER_CONVERSATION_ALLOWLIST, {
      source: 'onEnterConversation'
    });
    if (Object.prototype.hasOwnProperty.call(filteredOptions, 'silent')) {
      params.silent = filteredOptions.silent;
    }
    return loadActiveConversationMessages(params);
  }
  return null;
}

export function runListSecureAndDecryptLegacy({
  conversationId,
  tokenB64,
  peerAccountDigest,
  peerDeviceId,
  options
} = {}) {
  const filteredOptions = pickLegacyOptions(options, LEGACY_LIST_SECURE_ALLOWLIST, {
    source: 'runListSecureAndDecryptLegacy'
  });
  return listSecureAndDecrypt({
    conversationId,
    tokenB64,
    peerAccountDigest,
    peerDeviceId,
    ...filteredOptions
  });
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
  let errorMessage = null;
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
    errorMessage = err?.message || String(err);
    if (typeof onError === 'function') {
      try {
        onError(err);
      } catch (onErrorErr) {
        if (!errorMessage) {
          errorMessage = onErrorErr?.message || String(onErrorErr);
        }
      }
    }
  } finally {
    if (typeof onFinally === 'function') onFinally();
  }
  if (errorMessage) return { ok: false, errorMessage };
  return { ok: true };
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
