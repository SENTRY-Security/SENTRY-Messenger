/**
 * SECURITY POLICY – SINGLE DECRYPT PIPELINE.
 *
 * DR decryption/state advancement must go through the decrypt pipeline queue.
 * No parallel decrypt entry points, no state rollback. Counter gaps are filled
 * only by gapFill items in the same pipeline.
 */

// This file contains the message pipeline logic.

// /app/features/messages.js
// Feature: list conversation messages and decrypt DR packets using secure conversation tokens.
// Updated: 2026-01-11 Force Refresh

import {
  listSecureMessages as apiListSecureMessages,
  getSecureMessageByCounter as apiGetSecureMessageByCounter,
  fetchSecureMaxCounter as apiFetchSecureMaxCounter
} from '../api/messages.js';
import * as drCrypto from '../crypto/dr.js';
import {
  drState as storeDrState,
  getAccountDigest as storeGetAccountDigest,
  normalizePeerIdentity as storeNormalizePeerIdentity,
  clearDrState as storeClearDrState,
  getMkRaw as storeGetMkRaw,
} from '../core/store.js';
import {
  persistDrSnapshot as sessionPersistDrSnapshot,
  snapshotDrState as sessionSnapshotDrState,
  cloneDrStateHolder as sessionCloneDrStateHolder,
  hydrateDrStatesFromContactSecrets as sessionHydrateDrStatesFromContactSecrets
} from './dr-session.js';
import {
  sessionStore
} from '../ui/mobile/session-store.js';
import { b64UrlToBytes as uiB64UrlToBytes } from '../ui/mobile/ui-utils.js';
import { b64u8 as naclB64u8, b64 as naclB64 } from '../crypto/nacl.js';
import { saveEnvelopeMeta as mediaSaveEnvelopeMeta } from './media.js';
import {
  ensureSecureConversationReady as managerEnsureSecureConversationReady,
  ensureDrReceiverState as managerEnsureDrReceiverState,
} from './secure-conversation-manager.js';

import { logCapped } from '../core/log.js';
import { DEBUG } from '../ui/mobile/debug-flags.js';
import {
  markConversationTombstone as cacheMarkConversationTombstone,
  clearConversationTombstone as cacheClearConversationTombstone,
  clearConversationHistory as cacheClearConversationHistory,
  getConversationClearAfter as cacheGetConversationClearAfter,
} from './messages/cache.js';
import {
  secureFetchBackoff,
  secureFetchLocks,
} from './messages/pipeline-state.js';
import {
  fetchServerMaxCounter
} from './messages/gap.js';

// Init Live Repair Runner
import {
  registerLiveRepairRunner,
  runLiveDecryptRepair
} from './messages/live-repair.js';

import {
  enqueueDecryptPipelineItem
} from './messages/pipeline.js';

import {
  emitBRouteResultEvent,
  resolveLocalIncomingCounter
} from './messages/entry-incoming.js';
import {
  buildCounterMessageId
} from './messages/counter.js';

import {
  processOfflineSync
} from './messages/sync-offline.js';
import { triggerServerCatchup as triggerServerCatchupV2 } from './messages/sync-server.js';
import {
  processDecryptPipelineForConversation,
  listSecureAndDecrypt as listSecureAndDecryptV2
} from './messages/entry-fetch.js';

import {
  wasMessageProcessed,
  markMessageProcessed,
  markMessagesProcessedForUi,
  resetProcessedMessages as resetProcessedMessagesV2,
  resetAllProcessedMessages as resetAllProcessedMessagesV2
} from './messages/cache.js';

import {
  resetReceiptStore as resetReceiptStoreV2,
  getMessageReceipt,
  getMessageDelivery,
  getVaultAckCounter as getVaultAckCounterV2,
  recordVaultAckCounter as recordVaultAckCounterV2,
  recordMessageRead as recordMessageReadV2,
  maybeSendReadReceipt,
  recordMessageDelivered as recordMessageDeliveredV2,
  maybeSendDeliveryReceipt,
  maybeSendVaultAckWs
} from './messages/receipts.js';

import {
  enqueuePendingVaultPut as vaultEnqueuePendingVaultPut,
  flushPendingVaultPutsNow as vaultFlushPendingVaultPutsNow,
  getPendingVaultPutForMessage as vaultGetPendingVaultPutForMessage,
  removePendingVaultPut as vaultRemovePendingVaultPut
} from './messages/vault.js';

// Actually timeline-store.js is where they are defined. messages-pane.js imports them.
// Let's import directly from timeline-store.js to avoid circular deps if messages-pane depends on messages.js (it does).
import {
  upsertTimelineEntry as storeUpsertTimelineEntry,
  appendBatch as storeAppendBatch
} from './timeline-store.js';
import { normalizeMsgTypeValue } from './messages/parser.js';

function ensurePlaceholderEntry({ conversationId, counter, senderDeviceId, direction = 'incoming', ts = null, tsMs = null }) {
  if (!conversationId || !Number.isFinite(counter)) return false;
  return storeUpsertTimelineEntry(conversationId, {
    messageId: `${conversationId}:${counter}:placeholder`,
    counter,
    msgType: 'placeholder', // Key for Shimmer
    placeholder: true,
    status: 'pending',
    senderDeviceId,
    direction,
    ts: ts || Date.now() / 1000,
    tsMs: tsMs || Date.now()
  });
}

const defaultDeps = {
  listSecureMessages: apiListSecureMessages,
  getSecureMessageByCounter: apiGetSecureMessageByCounter,
  fetchSecureMaxCounter: apiFetchSecureMaxCounter,
  drDecryptText: drCrypto.drDecryptText,
  buildDrAadFromHeader: drCrypto.buildDrAadFromHeader,
  drState: storeDrState,
  getAccountDigest: storeGetAccountDigest,
  persistDrSnapshot: sessionPersistDrSnapshot,
  snapshotDrState: sessionSnapshotDrState,
  cloneDrStateHolder: sessionCloneDrStateHolder,
  hydrateDrStatesFromContactSecrets: sessionHydrateDrStatesFromContactSecrets,
  getMkRaw: storeGetMkRaw,
  b64UrlToBytes: uiB64UrlToBytes,
  b64u8: naclB64u8,
  b64: naclB64,
  saveEnvelopeMeta: mediaSaveEnvelopeMeta,
  ensureSecureConversationReady: managerEnsureSecureConversationReady,
  ensureDrReceiverState: managerEnsureDrReceiverState,
  clearDrState: storeClearDrState,
  wsSend: null,
  // Added State & Receipts deps
  wasMessageProcessed,
  markMessageProcessed,
  markMessagesProcessedForUi,
  resetProcessedMessages: resetProcessedMessagesV2,
  resetAllProcessedMessages: resetAllProcessedMessagesV2,
  resetReceiptStore: resetReceiptStoreV2,
  getMessageReceipt,
  getMessageDelivery,
  getVaultAckCounter: getVaultAckCounterV2,
  recordVaultAckCounter: recordVaultAckCounterV2,
  recordMessageRead: recordMessageReadV2,
  maybeSendReadReceipt,
  recordMessageDelivered: recordMessageDeliveredV2,
  maybeSendDeliveryReceipt,
  maybeSendVaultAckWs,
  enqueuePendingVaultPut: vaultEnqueuePendingVaultPut,
  flushPendingVaultPutsNow: vaultFlushPendingVaultPutsNow,
  getPendingVaultPutForMessage: vaultGetPendingVaultPutForMessage,
  removePendingVaultPut: vaultRemovePendingVaultPut,
  // Injected for Shimmer Restoration
  ensurePlaceholderEntry,
  timelineAppendBatch: storeAppendBatch,
  markPlaceholderStatus: (convId, counter, status, reason) => { /* simplified placeholder status update if needed later */ }
};

const deps = { ...defaultDeps };

function __setMessagesTestOverrides(overrides = {}) {
  Object.assign(deps, overrides);
}

function __resetMessagesTestOverrides() {
  Object.assign(deps, defaultDeps);
}

export function setMessagesWsSender(fn) {
  deps.wsSend = typeof fn === 'function' ? fn : null;
}

function wipeSecureFetchLocks(key) {
  secureFetchLocks.delete(key);
  secureFetchBackoff.delete(key);
}

export function markConversationTombstone(conversationId) {
  return cacheMarkConversationTombstone(conversationId, wipeSecureFetchLocks);
}

export function clearConversationTombstone(conversationId) {
  return cacheClearConversationTombstone(conversationId);
}

export function clearConversationHistory(conversationId, ts = null) {
  return cacheClearConversationHistory(conversationId, ts, wipeSecureFetchLocks);
}

function _localRunLiveDecryptRepair(convId) {
  return runLiveDecryptRepair(convId, {
    logBRouteGapTaskTrace: logCapped ? (p) => logCapped('bRouteGapTaskTrace', p, 10) : null,
    sessionStore: deps.sessionStore || null,
    storeNormalizePeerIdentity: deps.storeNormalizePeerIdentity || null,
    resolveLocalIncomingCounter, // Imported
    fetchServerMaxCounter, // Imported
    enqueueDecryptPipelineItem, // Imported
    processDecryptPipelineForConversation: processInboxForConversation, // Alias below
    emitBRouteResultEvent, // Imported
    buildCounterMessageId // Imported
  });
}

registerLiveRepairRunner(_localRunLiveDecryptRepair);

async function _localProcessDecryptPipelineForConversation(params = {}) {
  return processDecryptPipelineForConversation(params, deps);
}

// Alias for backward compatibility (used by live repair runner)
function processInboxForConversation(params) {
  return _localProcessDecryptPipelineForConversation(params);
}

export async function listSecureAndDecrypt(params = {}) {
  return listSecureAndDecryptV2(params, deps);
}

// Facades for State & Receipts
export function resetProcessedMessages(conversationId) {
  return resetProcessedMessagesV2(conversationId);
}

export function resetAllProcessedMessages() {
  return resetAllProcessedMessagesV2();
}

export function resetReceiptStore() {
  return resetReceiptStoreV2();
}

export function getVaultAckCounter(conversationId) {
  return getVaultAckCounterV2(conversationId);
}

export function recordVaultAckCounter(conversationId, counter, ts = null) {
  return recordVaultAckCounterV2(conversationId, counter, ts);
}

export function getConversationClearAfter(conversationId) {
  return cacheGetConversationClearAfter(conversationId);
}

export function recordMessageRead(conversationId, messageId, ts = null) {
  return recordMessageReadV2(conversationId, messageId, ts);
}

export function recordMessageDelivered(conversationId, messageId, ts = null) {
  return recordMessageDeliveredV2(conversationId, messageId, ts);
}

// Wrapper for Sync & Recovery
export async function syncOfflineDecryptNow(params = {}) {
  return processOfflineSync(params, deps);
}

export async function triggerServerCatchup(params = {}) {
  return triggerServerCatchupV2(params, deps);
}

export function enqueuePendingVaultPut(item) {
  return vaultEnqueuePendingVaultPut(item);
}

export async function flushPendingVaultPutsNow() {
  return vaultFlushPendingVaultPutsNow(deps);
}
