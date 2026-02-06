// UI only. Do not add message pipeline logic; call messages-flow-legacy facade.

import { log, logCapped } from '../../core/log.js';
import { getAccountToken, getAccountDigest, getMkRaw, normalizePeerIdentity, normalizeAccountDigest, ensureDeviceId, normalizePeerDeviceId } from '../../core/store.js';
import { resetProcessedMessages } from '../../features/messages-support/processed-messages-store.js';
import { clearConversationTombstone } from '../../features/messages-support/conversation-tombstone-store.js';
import { clearConversationHistory, getConversationClearAfter } from '../../features/messages-support/conversation-clear-store.js';
import { messagesFlowFacade } from '../../features/messages-flow-facade.js';
import {
  getTimeline as timelineGetTimeline,
  subscribeTimeline
} from '../../features/timeline-store.js';

import { setOutboxHooks } from '../../features/queue/outbox.js';
import {
  ensureSecureConversationReady,
  subscribeSecureConversation,
  getSecureConversationStatus,
  SECURE_CONVERSATION_STATUS,
  listSecureConversationStatuses
} from '../../features/secure-conversation-manager.js';
import { CONTROL_MESSAGE_TYPES, normalizeControlMessageType } from '../../features/secure-conversation-signals.js';
import { SEMANTIC_KIND, CONTROL_STATE_SUBTYPES, TRANSIENT_SIGNAL_SUBTYPES, normalizeSemanticSubtype, MSG_SUBTYPE } from '../../features/semantic.js';
import {
  deriveConversationContextFromSecret
} from '../../features/conversation.js'; // If conversationIdFromToken unused, remove it.
// Actually grep showed "conversationIdFromToken," in import.
// I will replace the whole block.
import { sessionStore, resetMessageState, restorePendingInvites } from './session-store.js';
import { deleteContactSecret, getContactSecret, getCorruptContact, hideContactSecret, unhideContactSecret } from '../../core/contact-secrets.js';
import { setDeletionCursor, setPeerDeletionCursor } from '../../features/soft-deletion/deletion-store.js';
import { clearDrState, drState } from '../../core/store.js';
import { sendDrPlaintext } from '../../features/dr-session.js';
import { escapeHtml, fmtSize, shouldNotifyForMessage, escapeSelector } from './ui-utils.js';
import {
  getContactCore,
  findContactCoreByAccountDigest,
  upsertContactCore,
  listReadyContacts,
  removeContactCore,
  normalizeDigestString,
  normalizePeerKey,
  splitPeerKey,
  resolveContactCoreEntry,
  resolveReadyContactCoreEntry,
  isCoreVaultReady,
  resolveContactAvatarUrl
} from './contact-core-store.js';

import { renderPdfViewer, cleanupPdfViewer, getPdfJsLibrary } from './viewers/pdf-viewer.js';
import { deleteSecureConversation, listSecureMessages as apiListSecureMessages, toDigestOnly } from '../../api/messages.js';

import {
  normalizeTimelineMessageId,
  normalizeCounterValue,
  normalizeRawMessageId,
  hashMessageId,
  deriveMessageOffsetMs,
  extractMessageTimestamp,
  extractMessageTimestampMs,
  extractMessageTimestampSeq,
  normalizeMsgTypeValue,
  resolveDecryptUnableReason,
  buildPlaceholderCounterId,
  normalizePlaceholderCounter,
  normalizePlaceholderRawMessageId,
  normalizePlaceholderKey,
  sliceConversationIdPrefix,
  sliceDeviceIdSuffix4,
  resolvePlaceholderSenderDeviceId,
  deriveMessageDirectionFromEnvelopeMeta,
  resolvePlaceholderSubtype,
  buildPlaceholderEntriesFromRaw
} from '../../features/messages/parser.js';


import {
  getGapPlaceholderEntries,
  markGapPlaceholderFailures,
  resetPlaceholderState
} from '../../features/messages/placeholder-store.js';

import { logMsgEvent } from '../../lib/logging.js';
import { PLACEHOLDER_SHIMMER_MAX_ACTIVE, PLACEHOLDER_REVEAL_MS, PLACEHOLDER_TEXT } from './messages-ui-policy.js';
import { DEBUG } from './debug-flags.js';
import { isLatestOutgoingForStatus, resolveRenderEntryCounter } from '../../features/messages/ui/renderer.js';
import {
  scrollToBottom,
  scrollToBottomSoon,
  isNearBottom,
  captureScrollAnchor as captureScrollAnchorUtil,
  restoreScrollFromAnchor as restoreScrollAnchorUtil,
  updateScrollOverflow,
  createKeyboardOffsetManager,
  syncWsIndicator,
  createWsIndicatorMirror
} from '../../features/messages/ui/interactions.js';
// import { createConversationThreadsManager } from './conversation-threads.js';
import { createMediaPreviewManager } from '../../features/messages/ui/media-preview.js';
import {
  isCounterTooLowError,
  extractFailureDetails,
  getReplacementInfo,
  createOutboxStatusManager
} from '../../features/messages/ui/outbox-hooks.js';
import {
  sortMessagesByTimelineLocal,
  latestKeyFromTimeline,
  latestKeyFromRaw,
  latestKeysEqual,
  collectTimelineIdSet
} from '../../features/messages/ui/timeline-handler.js';
import {
  loadCallNetworkConfig,
  subscribeCallEvent,
  CALL_EVENT
} from '../../features/calls/index.js';

import { createControllerDeps } from './controllers/base-controller.js';
import { ConversationListController } from './controllers/conversation-list-controller.js';
import { SecureStatusController } from './controllers/secure-status-controller.js';
import { CallLogController } from './controllers/call-log-controller.js';
import { MessageFlowController } from './controllers/message-flow-controller.js';
import { GroupBuilderController } from './controllers/group-builder-controller.js';
import { LayoutController } from './controllers/layout-controller.js';
import { ComposerController } from './controllers/composer-controller.js';
import { MessageStatusController } from './controllers/message-status-controller.js';
import { ActiveConversationController } from './controllers/active-conversation-controller.js';
import { MessageSendingController } from './controllers/message-sending-controller.js';
import { MediaHandlingController } from './controllers/media-handling-controller.js';

// sentCallLogIds, callLogPlaceholders removed (managed by CallLogController)

// Moved PLACEHOLDER_* constants to renderer.js
const GROUPS_ENABLED = false;
const decryptBannerLogDedup = new Set();
const setActiveFailLogKeys = new Set();
const renderState = { conversationId: null, renderedIds: [], placeholderCount: 0 };
let messageRenderer = null;
let outboxHooksRegistered = false;

// [FIX] Delegate pattern to avoid stale closures if messagesPane is re-initialized (e.g. navigation/HMR)
let messagesPaneHooksDelegate = null;
const messagesPaneHooksProxy = {
  onSent: (job, response) => messagesPaneHooksDelegate?.onSent?.(job, response),
  onFailed: (job, err) => messagesPaneHooksDelegate?.onFailed?.(job, err)
};

let pendingNewMessageHint = false;
let bRouteResultListenerInstalled = false;
const uiNoiseEnabled = DEBUG.uiNoise === true;
const contactCoreVerbose = DEBUG.contactCoreVerbose === true;
const logReplayCallsite = (name, payload = {}) => {
  try {
    log({ replayCallsite: { name, ...payload } });
  } catch { }
};
const logReplayGateTrace = (where, payload = {}) => {
  if (!DEBUG.replay) return;
  const allowReplayRaw = payload?.allowReplay;
  const mutateStateRaw = payload?.mutateState;
  const computedIsHistoryReplay = allowReplayRaw === true && mutateStateRaw === false;
  try {
    log({
      replayGateTrace: {
        where,
        conversationId: payload.conversationId ?? null,
        messageId: payload.messageId ?? null,
        serverMessageId: payload.serverMessageId ?? null,
        allowReplayRaw,
        mutateStateRaw,
        computedIsHistoryReplay,
        replay: payload.replay ?? null,
        silent: payload.silent ?? null
      }
    });
  } catch { }
};
const logReplayFetchResult = (payload = {}) => {
  try {
    log({ replayFetchResult: payload });
  } catch { }
};
const CONVERSATION_RESET_TRACE_LIMIT = 5;
let conversationResetTraceCount = 0;
const ACTIVE_PEER_RESET_GUARD_TRACE_LIMIT = 5;
let activePeerResetGuardTraceCount = 0;
const ACTIVE_PEER_STATE_REHYDRATE_TRACE_LIMIT = 5;
let activePeerStateRehydrateTraceCount = 0;
const SECURE_MODAL_GATE_TRACE_LIMIT = 3;
let secureModalGateTraceCount = 0;
const VAULT_GATE_DECISION_TRACE_LIMIT = 3;
let vaultGateDecisionTraceCount = 0;
const outgoingTsSeqByConvId = new Map();

// Function definitions removed and imported from parser.js



function logConversationResetTrace(payload = {}) {
  if (conversationResetTraceCount >= CONVERSATION_RESET_TRACE_LIMIT) return;
  conversationResetTraceCount += 1;
  try {
    log({ conversationResetTrace: payload });
  } catch { }
}

function logDecryptUnableTrace({ conversationId, reasonCode, errorMessage, sourceTag } = {}) {
  if (!reasonCode) return;
  logCapped('decryptUnableTrace', {
    conversationId: conversationId || null,
    reasonCode,
    error: errorMessage || null,
    source: sourceTag || null
  }, 5);
}

function isUserBannerEntry(entry) {
  return entry?.kind === SEMANTIC_KIND.USER_MESSAGE;
}

function isControlBannerEntry(entry) {
  if (!entry) return true;
  if (isUserBannerEntry(entry)) return false;
  if (entry.kind) return true;
  if (entry.control === true) return true;
  return true;
}

function countBannerEntries(entries = []) {
  let userFail = 0;
  let controlFail = 0;
  for (const entry of entries) {
    if (!entry) {
      controlFail += 1;
      continue;
    }
    if (isUserBannerEntry(entry)) {
      userFail += 1;
    } else {
      controlFail += 1;
    }
  }
  return { userFail, controlFail };
}

function logDecryptBannerEntries(conversationId, entries = []) {
  for (const entry of entries) {
    if (isControlBannerEntry(entry)) continue;
    const messageId = entry?.messageId || entry?.id || entry?.jobId || null;
    const msgType = normalizeMsgTypeValue(entry?.msgType || entry?.subtype || entry?.type || null);
    if (!messageId && !msgType) continue;
    const dedupKey = `banner:${conversationId || 'unknown'}:${messageId || msgType || 'unknown'}`;
    if (decryptBannerLogDedup.has(dedupKey)) continue;
    decryptBannerLogDedup.add(dedupKey);
    try {
      console.info('[msg] ' + JSON.stringify({
        event: 'decrypt-banner',
        conversationId: conversationId || null,
        messageId: messageId || null,
        msgType: msgType || null,
        control: false
      }));
    } catch {
      /* ignore */
    }
  }
}

// clearCallLogPlaceholders shim for module scope access
let _clearCallLogPlaceholdersShim = () => { /* no-op until init */ };

function clearCallLogPlaceholders() {
  _clearCallLogPlaceholdersShim();
}

// Placeholder builder functions imported from parser.js
// Function definitions moved to parser.js and placeholder-store.js

function getMessageState() {
  if (!sessionStore.messageState) {
    resetMessageStateWithPlaceholders();
  }
  return sessionStore.messageState;
}


function resetMessageStateWithPlaceholders() {
  clearCallLogPlaceholders();
  resetPlaceholderState();
  resetMessageState();
  stopActivePoll();
  renderState.conversationId = null;
  renderState.renderedIds = [];
  renderState.placeholderCount = 0;
  pendingNewMessageHint = false;
}

let activePollTimer = null;
const ACTIVE_POLL_INTERVAL_MS = 3_000;

function stopActivePoll() {
  if (activePollTimer) {
    try { clearTimeout(activePollTimer); } catch { }
    activePollTimer = null;
  }
}

const LOCAL_GROUP_STORAGE_KEY = 'groups-drafts-v1';
// localGroups and groupBuilderEl removed (managed by GroupBuilderController)

// Removed loadLocalGroups and persistLocalGroups
export function initMessagesPane({
  dom = {},
  navbarEl,
  mainContentEl,
  updateNavBadge,
  showToast,
  playNotificationSound,
  switchTab,
  getCurrentTab,
  showConfirmModal,
  removeContactLocal,
  setupSwipe,
  closeSwipe,
  modal: modalOptions = {}
}) {
  const elements = {
    pane: dom.messagesPaneEl ?? document.querySelector('.messages-pane'),
    backBtn: dom.messagesBackBtnEl ?? document.querySelector('.messages-back'),
    headerEl: dom.messagesHeaderEl ?? document.querySelector('.messages-header'),
    peerAvatar: dom.messagesPeerAvatarEl ?? document.querySelector('.messages-peer-avatar'),
    composer: dom.messageComposerEl ?? document.querySelector('.messages-composer'),
    input: dom.messageInputEl ?? document.querySelector('.messages-composer textarea'),
    sendBtn: dom.messageSendBtn ?? document.querySelector('.composer-send'),
    attachBtn: dom.composerAttachBtn ?? document.querySelector('.composer-attach'),
    fileInput: dom.messageFileInputEl ?? document.getElementById('messageFileInput'),
    conversationList: dom.conversationListEl ?? document.querySelector('.conversation-list'),
    conversationRefreshEl: dom.conversationRefreshEl ?? document.querySelector('.conversation-refresh'),
    conversationRefreshLabelEl: dom.conversationRefreshLabelEl ?? document.querySelector('.conversation-refresh .label'),
    createGroupBtn: dom.createGroupBtn ?? document.getElementById('btnCreateGroup'),
    groupDraftsEl: dom.groupDraftsEl ?? document.getElementById('groupDrafts'),
    messagesWsIndicator: dom.messagesWsIndicatorEl ?? document.querySelector('.messages-ws-indicator'),
    messagesPlaceholders: dom.messagesPlaceholdersEl ?? document.getElementById('messagePlaceholders'),
    messagesList: dom.messagesListEl ?? document.getElementById('messagesList'),
    messagesEmpty: dom.messagesEmptyEl ?? document.getElementById('messagesEmpty'),
    peerName: dom.messagesPeerNameEl ?? document.querySelector('.messages-header strong'),
    statusLabel: dom.messagesStatusEl ?? document.querySelector('.messages-header .status'),
    scrollEl: dom.messagesScrollEl ?? document.querySelector('.messages-scroll'),
    loadMoreBtn: dom.messagesLoadMoreBtn ?? document.querySelector('.messages-load-more'),
    loadMoreLabel: dom.messagesLoadMoreLabel ?? document.querySelector('.messages-load-more .label'),
    loadMoreSpinner: dom.messagesLoadMoreSpinner ?? document.querySelector('.messages-load-more .spinner'),
    callBtn: dom.messagesCallBtn ?? document.getElementById('messagesCallBtn'),
    videoBtn: dom.messagesVideoBtn ?? document.getElementById('messagesVideoBtn')
  };

  console.log('[messages-pane] init elements check:', {
    hasPane: !!elements.pane,
    hasList: !!elements.messagesList,
    hasComposer: !!elements.composer,
    hasAvatar: !!elements.peerAvatar,
    hasInput: !!elements.input
  });

  if (!elements.messagesList || !elements.peerAvatar) {
    console.error('[messages-pane] Critical elements missing', elements);
    try {
      // Force visual feedback for debugging
      // dom.showToast?.('System Error: UI Elements Missing');
      alert('System Error: Message UI Elements Missing. Please screenshot console.');
    } catch { }
  }

  let pendingWsRefresh = 0;
  let receiptRenderPending = false;
  let keyboardOffsetPx = 0;
  let keyboardActive = false;
  let viewportGuardTimer = null;
  let conversationIndexRestoredFromPending = false;

  // secureStatusCache, pendingSecureReadyPeer removed (in controller)
  let unsubscribeSecureStatus = null;
  let unsubscribeTimeline = null;

  // --- Controller System Integration ---
  const deps = createControllerDeps({
    elements,
    sessionStore,
    getMessageState,
    log,
    logCapped,
    showToast,
    playNotificationSound,
    updateNavBadge,
    switchTab,
    getCurrentTab,
    showConfirmModal,
    removeContactLocal,
    setupSwipe,
    closeSwipe,
    normalizePeerKey,
    normalizePeerIdentity,
    ensureConversationIndex: () => controllers.conversationList.ensureConversationIndex(),
    getConversationThreads: () => controllers.conversationList.getThreads(), // Lazy access
    renderConversationList: () => controllers.conversationList.renderConversationList(),
    syncConversationThreadsFromContacts: () => controllers.conversationList.syncFromContacts(),
    refreshConversationPreviews: (args) => controllers.conversationList.refreshPreviews(args),
    refreshContactsUnreadBadges: () => controllers.conversationList.refreshUnreadBadges(),
    isDesktopLayout: () => controllers.layout.isDesktopLayout(),
    get pendingSecureReadyPeer() { return controllers.secureStatus.pendingSecureReadyPeer; },
    // [FIX] Pass conversationId and token args
    setActiveConversation: (...args) => controllers.activeConversation.setActiveConversation(...args), // Route via controller if poss, or keep local
    // MessageFlow facade deps:
    loadActiveConversationMessages: (args) => controllers.messageFlow.loadActiveConversationMessages(args),
    handleTimelineAppend: (args) => controllers.messageFlow.handleTimelineAppend(args),
    handleIncomingSecureMessage: (args) => controllers.messageFlow.handleIncomingSecureMessage(args),
    handleVaultAckEvent: (args) => controllers.messageFlow.handleVaultAckEvent(args),
    handleMessageDecrypted: (args) => controllers.messageFlow.handleMessageDecrypted(args),
    updateMessagesUI: (args) => controllers.messageFlow.updateMessagesUI(args),
    updateMessagesStatusUI: () => controllers.messageFlow.updateMessagesUI({ preserveScroll: true, forceFullRender: true }),
    upsertConversationThread: (args) => controllers.conversationList.upsertThread(args),
    threadPeer: (t) => threadPeer(t),
    updateThreadAvatar: (key, avatar) => controllers.callLog.updateThreadAvatar(key, avatar),
    isLatestOutgoingForStatus: (convId, msgId) => isLatestOutgoingForStatus(convId, msgId),
    resolveRenderEntryCounter: (msg) => resolveRenderEntryCounter(msg),
    closePreviewModal: modalOptions?.closePreviewModal,
    showSecurityModal: modalOptions?.showSecurityModal,
    handleConversationDelete: (args) => handleConversationDelete(args), // Keep local for now
    requireSubscriptionActive: () => requireSubscriptionActive(),
    isSubscriptionActive: () => isSubscriptionActive(),
    resolveSecureStatusForUi: (k, i, s) => controllers.secureStatus.resolveSecureStatusForUi(k, i, s),
    getCachedSecureStatus: (k) => controllers.secureStatus.getCachedSecureStatus(k),
    // messageStatus & getMessageRenderer: injected via Object.defineProperty below to avoid TDZ
    scrollMessagesToBottomSoon: () => scrollToBottomSoon(elements.scrollEl),
    setMessagesStatus: (msg, isError) => controllers.composer.setMessagesStatus(msg, isError),
    appendLocalOutgoingMessage: (args) => {
      return controllers.messageSending.appendLocalOutgoingMessage(args);
    },
    syncMessagesWsIndicator: () => syncMessagesWsIndicator(),
    updateMessagesScrollOverflow: () => updateMessagesScrollOverflow(),
    // Missing deps added:
    updateComposerAvailability: () => controllers.composer.updateComposerAvailability(),
    focusComposerInput: () => controllers.composer.focusInput(),
    applyMessagesLayout: () => controllers.layout.applyMessagesLayout(),
    // [FIX] Pass wsSend for Receipts
    wsSend: (data) => wsSendFn(data),
    navbarEl,
    mainContentEl
  });

  const controllers = {
    groupBuilder: new GroupBuilderController(deps),
    secureStatus: new SecureStatusController(deps),
    layout: new LayoutController(deps),
    conversationList: new ConversationListController(deps),
    composer: new ComposerController(deps),
    messageStatus: new MessageStatusController(deps),
    callLog: new CallLogController(deps),
    messageFlow: new MessageFlowController(deps), // Note: internal logic updated, bumping main dep later if needed, but import is static in module scope
    activeConversation: new ActiveConversationController(deps),
    messageSending: new MessageSendingController(deps),
    mediaHandling: new MediaHandlingController(deps)
  };

  // Inject circular dependencies into deps
  Object.defineProperties(deps, {
    messageStatus: {
      get: () => controllers.messageStatus
    },
    getMessageRenderer: {
      value: () => controllers.messageFlow.messageRenderer
    },
    applyMessagesLayout: {
      value: () => controllers.layout.applyMessagesLayout()
    }
  });

  // Initialize controllers
  Object.values(controllers).forEach(c => c.init?.());

  // Hook module-scope shim to controller
  _clearCallLogPlaceholdersShim = () => controllers.callLog.clearCallLogPlaceholders();
  let activeSecurityModalPeer = null;

  let wsSendFn = () => false;
  let loadMoreState = 'hidden';
  let autoLoadOlderInProgress = false;
  let lastLayoutIsDesktop = null;
  let unsubscribeCallState = null;
  let conversationPullTracking = false;
  let conversationPullDecided = false;
  let conversationPullInvalid = false;
  let conversationPullStartY = 0;
  let conversationPullStartX = 0;
  let conversationPullDistance = 0;
  let conversationsRefreshing = false;
  let suppressInputBlurOnce = false;
  let wsIndicatorObserver = null;
  const CONV_PULL_THRESHOLD = 60;
  const CONV_PULL_MAX = 140;
  console.log('[messages-pane] calling subscribeTimeline');
  unsubscribeTimeline = subscribeTimeline((e) => {
    try {
      if (!controllers?.messageFlow) {
        console.error('[messages-pane] FATAL: controllers.messageFlow is missing during event', e);
        return;
      }
      console.log('[messages-pane] dispatching to messageFlow', { hasHandler: typeof controllers.messageFlow.handleTimelineAppend === 'function' });
      controllers.messageFlow.handleTimelineAppend(e);
    } catch (err) {
      console.error('[messages-pane] FATAL: error in timeline listener wrapper', err);
    }
  });
  if (!bRouteResultListenerInstalled && typeof document !== 'undefined') {
    bRouteResultListenerInstalled = true;
    document.addEventListener('b-route-result', (event) => {
      const detail = event?.detail || {};
      const convId = detail?.conversationId || null;
      if (!convId) return;
      const failReason = typeof detail?.failReason === 'string' ? detail.failReason : null;
      const errorMessage = typeof detail?.errorMessage === 'string' ? detail.errorMessage : null;
      const locked = failReason === 'LOCKED' || (errorMessage && errorMessage.startsWith('LOCKED:'));
      if (locked || (!failReason && !errorMessage)) return;
      const placeholders = getGapPlaceholderEntries(convId);
      if (!placeholders.length) return;
      const result = markGapPlaceholderFailures(convId, placeholders);
      if (result.updated > 0) {
        const state = getMessageState();
        if (state.conversationId === convId) {
          updateMessagesUI({ preserveScroll: true, forceFullRender: true });
        }
      }
    });
  }
  // normalizeDigestString moved to contact-core-store.js

  function scheduleActivePoll() {
    stopActivePoll();
  }

  // Contact core helpers imported from contact-core-store.js

  // resolveSecureStatusForUi moved to SecureStatusController



  function logContactCoreWriteSkip({ callsite, conversationId = null, hasDeviceId = false }) {
    if (!contactCoreVerbose) return;
    try {
      console.warn('[contact-core] ui:write-skip ' + JSON.stringify({
        reason: 'missing-digest',
        callsite,
        conversationId: conversationId || null,
        hasDeviceId: !!hasDeviceId
      }));
    } catch { }
  }

  function ensurePeerAccountDigest(source) {
    if (!source || typeof source !== 'object') return null;
    if (source.peerAccountDigest) {
      source.peerAccountDigest = normalizePeerKey(source.peerAccountDigest);
      return source.peerAccountDigest || null;
    }
    return null;
  }

  function threadPeer(thread) {
    if (!thread) return null;
    return normalizePeerKey(thread.peerAccountDigest ?? thread);
  }

  function ensureThreadPeer(thread, value) {
    const key = normalizePeerKey(value);
    if (!thread || !key) return null;
    thread.peerAccountDigest = key;
    return key;
  }

  function contactPeerKey(contact) {
    const digest = ensurePeerAccountDigest(contact);
    return digest ? normalizePeerKey(digest) : null;
  }

  function normalizeContactsStore() {
    sessionStore.contactState = listReadyContacts();
  }

  normalizeContactsStore();

  // CallLog logic moved to CallLogController

  const showModalLoading = typeof modalOptions.showModalLoading === 'function' ? modalOptions.showModalLoading : null;
  const updateLoadingModal = typeof modalOptions.updateLoadingModal === 'function' ? modalOptions.updateLoadingModal : null;
  const openPreviewModal = typeof modalOptions.openModal === 'function' ? modalOptions.openModal : null;
  const closePreviewModal = typeof modalOptions.closeModal === 'function' ? modalOptions.closeModal : null;
  const setModalObjectUrl = typeof modalOptions.setModalObjectUrl === 'function' ? modalOptions.setModalObjectUrl : null;
  const showSecurityModal = typeof modalOptions.showSecurityModal === 'function' ? modalOptions.showSecurityModal : null;
  const hideSecurityModal = typeof modalOptions.hideSecurityModal === 'function' ? modalOptions.hideSecurityModal : () => { };

  loadCallNetworkConfig().catch((err) => {
    log({ callNetworkConfigPrefetchFailed: err?.message || err });
  });

  if (typeof unsubscribeCallState === 'function') {
    unsubscribeCallState();
  }
  unsubscribeCallState = subscribeCallEvent(CALL_EVENT.STATE, (e) => controllers.callLog.handleCallStateEvent(e));

  for (const info of listSecureConversationStatuses()) {
    const key = normalizePeerKey(info?.peerAccountDigest);
    if (!key) continue;
    secureStatusCache.set(key, { status: info.status, error: info.error });
  }
  if (typeof unsubscribeSecureStatus === 'function') {
    unsubscribeSecureStatus();
  }
  unsubscribeSecureStatus = subscribeSecureConversation((e) => controllers.secureStatus.handleSecureStatusEvent(e));

  // SecureStatus logic moved to SecureStatusController

  function isDesktopLayout() {
    if (typeof window === 'undefined') return true;
    return window.innerWidth >= 960;
  }











  function formatTimeShort(ts) {
    if (!Number.isFinite(ts)) return '';
    try {
      const date = new Date(ts * 1000);
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      return `${hours}:${minutes}`;
    } catch {
      return '';
    }
  }



  function cleanPreviewText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function isSubscriptionActive() {
    return true; // DEV: 硬解鎖訂閱
  }

  function requireSubscriptionActive() {
    if (isSubscriptionActive()) return true;
    document.dispatchEvent(new CustomEvent('subscription:gate'));
    return false;
  }

  function hasCallLog(callId) {
    if (!callId) return false;
    const state = getMessageState();
    return Array.isArray(state.messages) && state.messages.some((msg) => {
      if (!msg || msg.msgType !== 'call-log') return false;
      const mid = msg.id || msg.callId || msg.callLog?.callId || msg.meta?.call_id || null;
      return mid && mid === callId;
    });
  }







  // resolveContactAvatarUrl moved to contact-core-store.js



  function setLoadMoreState(next) {
    if (!elements.loadMoreBtn) return;
    if (loadMoreState === next) return;
    loadMoreState = next;
    if (next === 'hidden') {
      elements.loadMoreBtn.classList.add('hidden');
      elements.loadMoreBtn.classList.remove('loading');
      if (elements.loadMoreLabel) elements.loadMoreLabel.textContent = '載入更多';
      return;
    }
    elements.loadMoreBtn.classList.remove('hidden');
    if (next === 'loading') {
      elements.loadMoreBtn.classList.add('loading');
      if (elements.loadMoreLabel) elements.loadMoreLabel.textContent = '載入中…';
    } else if (next === 'armed') {
      elements.loadMoreBtn.classList.remove('loading');
      if (elements.loadMoreLabel) elements.loadMoreLabel.textContent = '釋放以載入更多';
    } else {
      elements.loadMoreBtn.classList.remove('loading');
      if (elements.loadMoreLabel) elements.loadMoreLabel.textContent = '載入更多';
    }
  }

  function updateLoadMoreVisibility() {
    if (!elements.loadMoreBtn) return;
    const state = getMessageState();
    if (!state.conversationId || !state.conversationToken) {
      setLoadMoreState('hidden');
      return;
    }
    if (state.loading) {
      setLoadMoreState('loading');
      return;
    }
    if (state.hasMore) {
      // Preserve 'armed' state if currently set by scroll logic?
      // Actually, if we are calling this, it's usually state change.
      // Default to 'idle' -> handleMessagesScroll can upgrade to 'armed' if needed.
      if (loadMoreState !== 'armed') {
        setLoadMoreState('idle');
      }
      return;
    }
    setLoadMoreState('hidden');
  }

  function handleMessagesScroll() {
    if (!elements.scrollEl) return;
    const atBottom = isNearMessagesBottom();
    if (!suppressInputBlurOnce && elements.input && document.activeElement === elements.input && !atBottom) {
      elements.input.blur();
    }
    const state = getMessageState();
    if (!state.hasMore || state.loading) return;
    if (autoLoadOlderInProgress) return;
    const top = elements.scrollEl.scrollTop;
    // Relaxed threshold to 20px to catch near-top scrolls
    if (top <= 20) {
      triggerAutoLoadOlder();
    } else if (top <= 40) {
      setLoadMoreState('armed');
    } else {
      setLoadMoreState('idle');
    }
    // if (atBottom) {
    //   setNewMessageHint(false); // Removed: ReferenceError
    // }
  }

  function handleMessagesTouchEnd() {
    if (!elements.scrollEl) return;
    if (!suppressInputBlurOnce && elements.input && document.activeElement === elements.input && !isNearMessagesBottom()) {
      elements.input.blur();
    }
    if (elements.scrollEl.scrollTop <= 20) {
      triggerAutoLoadOlder();
    }
  }

  function handleMessagesWheel() {
    if (!elements.scrollEl) return;
    if (!suppressInputBlurOnce && elements.input && document.activeElement === elements.input && !isNearMessagesBottom()) {
      elements.input.blur();
    }
    if (elements.scrollEl.scrollTop <= 20) {
      triggerAutoLoadOlder();
    }
  }

  function triggerAutoLoadOlder() {
    const state = getMessageState();
    if (!elements.scrollEl || !state.hasMore || state.loading || autoLoadOlderInProgress) return;
    autoLoadOlderInProgress = true;
    setLoadMoreState('loading');
    log({ triggerAutoLoadOlder: { conversationId: state.conversationId, cursor: state.nextCursor } });
    controllers.messageFlow.loadActiveConversationMessages({ append: true, reason: 'scroll' })
      .catch((err) => log({ loadOlderError: err?.message || err }))
      .finally(() => {
        autoLoadOlderInProgress = false;
        const nextState = state.hasMore ? 'idle' : 'hidden';
        setLoadMoreState(nextState);
      });
  }

  function scrollMessagesToBottom() {
    scrollToBottom(elements.scrollEl);
  }

  function scrollMessagesToBottomSoon() {
    scrollToBottomSoon(elements.scrollEl);
  }

  // startViewportGuard & applyKeyboardOffset logic moved to LayoutController

  function updateMessagesScrollOverflow() {
    updateScrollOverflow(elements.scrollEl);
  }

  function syncMessagesWsIndicator() {
    const source = document.getElementById('connectionIndicator');
    syncWsIndicator(elements.messagesWsIndicator, source);
  }

  function ensureMessagesWsIndicatorMirror() {
    if (wsIndicatorObserver) return;
    const source = document.getElementById('connectionIndicator');
    wsIndicatorObserver = createWsIndicatorMirror(elements.messagesWsIndicator, source);
  }


  function formatThreadPreview(thread) {
    const raw = thread.lastMessageText || '';
    const snippet = buildConversationSnippet(raw) || (thread.lastMessageTs ? '' : '尚無訊息');
    if (!snippet) return '';
    if (thread.lastDirection === 'outgoing') {
      return `你：${snippet}`;
    }
    return snippet;
  }

  function clearMessagesView() {
    if (elements.messagesList) elements.messagesList.innerHTML = '';
    if (elements.messagesPlaceholders) elements.messagesPlaceholders.innerHTML = '';
    elements.messagesEmpty?.classList.remove('hidden');
    updateLoadMoreVisibility();
  }

  // formatBytes and formatFileMeta moved to renderer.js

  const toast = typeof showToast === 'function' ? showToast : null;

  // canPreviewMedia moved to renderer.js but still used here
  // so I should keep it? No I imported it.
  // So I can remove the local definition.

  // renderPdfThumbnail moved to renderer.js



  // enableMediaPreviewInteraction moved to renderer.js

  // ensureMediaPreviewUrl moved to renderer.js

  // setPreviewSource and attachMediaPreview moved to renderer.js

  // Method moved to renderer.js (renderUploadOverlay, renderMediaBubble)

  function sortMessagesByTimelineLocal(items = []) {
    if (!Array.isArray(items) || items.length <= 1) return Array.isArray(items) ? items : [];
    const enriched = items.map((item) => ({
      raw: item,
      tsMs: extractMessageTimestampMs(item),
      seq: extractMessageTimestampSeq(item),
      id: normalizeRawMessageId(item)
    }));
    enriched.sort((a, b) => {
      const aHasTs = Number.isFinite(a.tsMs);
      const bHasTs = Number.isFinite(b.tsMs);
      if (aHasTs && bHasTs && a.tsMs !== b.tsMs) return a.tsMs - b.tsMs;
      if (aHasTs && !bHasTs) return 1;
      if (!aHasTs && bHasTs) return -1;
      const aHasSeq = Number.isFinite(a.seq);
      const bHasSeq = Number.isFinite(b.seq);
      if (aHasSeq && bHasSeq && a.seq !== b.seq) return a.seq - b.seq;
      if (a.id && b.id && a.id !== b.id) return a.id.localeCompare(b.id);
      if (a.id && !b.id) return 1;
      if (!a.id && b.id) return -1;
      return 0;
    });
    return enriched.map((entry) => entry.raw);
  }

  function latestKeyFromTimeline(messages = []) {
    if (!Array.isArray(messages) || !messages.length) return null;
    const last = messages[messages.length - 1];
    const id = normalizeTimelineMessageId(last);
    const tsVal = Number(last?.ts ?? null);
    const ts = Number.isFinite(tsVal) ? tsVal : null;
    if (!id && !Number.isFinite(ts)) return null;
    return { id, ts };
  }

  function latestKeyFromRaw(items = []) {
    const sorted = sortMessagesByTimelineLocal(items);
    if (!sorted.length) return null;
    const last = sorted[sorted.length - 1];
    const id = normalizeRawMessageId(last);
    const tsVal = extractMessageTimestamp(last);
    const ts = Number.isFinite(tsVal) ? tsVal : null;
    if (!id && !Number.isFinite(ts)) return null;
    return { id, ts };
  }

  function latestKeysEqual(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return (a.id || null) === (b.id || null) && (a.ts || null) === (b.ts || null);
  }

  function collectTimelineIdSet(messages = []) {
    const set = new Set();
    if (!Array.isArray(messages)) return set;
    for (const msg of messages) {
      const mid = normalizeTimelineMessageId(msg);
      if (mid) set.add(mid);
    }
    return set;
  }

  function isNearMessagesBottom(threshold = 32) {
    const scroller = elements.scrollEl;
    if (!scroller) return true;
    const distance = scroller.scrollHeight - (scroller.scrollTop + scroller.clientHeight);
    return distance <= threshold;
  }







  function summarizeTokenForDiag(token) {
    if (!token) return { len: 0 };
    const raw = String(token);
    return { len: raw.length, prefix6: raw.slice(0, 6), suffix6: raw.slice(-6) };
  }

  function logSetActiveFail({ reason, peerKey, peerDigest, peerDeviceId, entry, conversation, error = null }) {
    const logKey = `${reason}:${peerKey || peerDigest || 'unknown'}`;
    if (setActiveFailLogKeys.has(logKey)) return;
    setActiveFailLogKeys.add(logKey);
    const counts = contactCoreCounts();
    const corruptCount = (sessionStore?.corruptContacts instanceof Map) ? sessionStore.corruptContacts.size : 0;
    const corruptInfo = getCorruptContact?.({ peerAccountDigest: peerDigest || peerKey || null, peerDeviceId }) || null;
    const convId = conversation?.conversation_id || entry?.conversationId || null;
    const tokenRaw = conversation?.token_b64 || entry?.conversationToken || null;
    const missing = [];
    if (entry) {
      if (!entry.peerKey) missing.push('peerKey');
      if (!entry.peerAccountDigest) missing.push('peerAccountDigest');
      if (!entry.peerDeviceId) missing.push('peerDeviceId');
      if (!entry.conversationId) missing.push('conversationId');
      if (!entry.conversationToken) missing.push('conversationToken');
    }
    try {
      console.info('[diag] ' + JSON.stringify({
        event: 'set-active-fail',
        reason,
        peerKey: peerKey || null,
        peerAccountDigest: peerDigest || null,
        peerDeviceId: peerDeviceId || entry?.peerDeviceId || null,
        conversationId: convId,
        conversationToken: summarizeTokenForDiag(tokenRaw),
        contactCore: {
          isReady: entry?.isReady ?? null,
          isPending: entry ? !entry.isReady : null,
          isCorrupt: !!corruptInfo
        },
        contactCoreCounts: {
          ready: counts.ready,
          pending: counts.pending,
          corrupt: corruptCount
        },
        error: error || null,
        missingCoreFields: missing,
        corruptReason: corruptInfo?.reason || null
      }));
    } catch { }
  }


  // refreshActivePeerMetadata logic moved to ActiveConversationController

  function nextOutgoingTsSeq(conversationId, tsMs) {
    const key = conversationId || 'unknown';
    const entry = outgoingTsSeqByConvId.get(key);
    if (entry && entry.tsMs === tsMs) {
      entry.seq += 1;
      return entry.seq;
    }
    outgoingTsSeqByConvId.set(key, { tsMs, seq: 0 });
    return 0;
  }

  // handleContactEntryUpdated logic moved to ActiveConversationController

  function pruneNotifyRetryQueueForConversation(conversationId) {
    const convId = typeof conversationId === 'string' ? conversationId.trim() : '';
    if (!convId) return;

    const messageState = sessionStore?.messageState || null;
    const root = typeof globalThis !== 'undefined' ? globalThis : null;
    const candidates = [
      messageState?.notifyRetryQueue,
      messageState?.notifyRetryQueueByConvId,
      messageState?.notifyRetryStateByConvId,
      sessionStore?.notifyRetryQueue,
      sessionStore?.notifyRetryQueueByConvId,
      sessionStore?.notifyRetryStateByConvId,
      root?.notifyRetryQueue,
      root?.notifyRetryQueueByConvId,
      root?.notifyRetryStateByConvId
    ].filter(Boolean);

    if (!candidates.length) return;

    for (const queue of candidates) {
      if (queue instanceof Map) {
        for (const [key, value] of queue.entries()) {
          const itemConvId = value?.conversationId || value?.convId || null;
          if (key === convId || itemConvId === convId) {
            queue.delete(key);
          }
        }
        continue;
      }
      if (queue instanceof Set) {
        for (const item of queue) {
          const itemConvId = item?.conversationId || item?.convId || null;
          if (item === convId || itemConvId === convId) {
            queue.delete(item);
          }
        }
        continue;
      }
      if (Array.isArray(queue)) {
        for (let i = queue.length - 1; i >= 0; i -= 1) {
          const item = queue[i];
          const itemConvId = item?.conversationId || item?.convId || null;
          if (itemConvId === convId) {
            queue.splice(i, 1);
          }
        }
        continue;
      }
      if (queue && typeof queue === 'object') {
        if (Object.prototype.hasOwnProperty.call(queue, convId)) {
          delete queue[convId];
          continue;
        }
        for (const key of Object.keys(queue)) {
          const value = queue[key];
          const itemConvId = value?.conversationId || value?.convId || null;
          if (itemConvId === convId) {
            delete queue[key];
          }
        }
      }
    }
  }


  function resolvePeerForConversation(convId, fallbackPeer = null) {
    const convIndex = ensureConversationIndex();
    const entry = convId ? convIndex.get(convId) : null;
    const threads = getConversationThreads();
    const thread = convId ? threads.get(convId) : null;
    return normalizePeerKey(
      threadPeer(thread) ||
      entry?.peerAccountDigest ||
      fallbackPeer
    );
  }



  // Legacy status functions removed (moved to MessageStatusController)

  function handleMessageDecrypted({ message, allowReceipts = true } = {}) {
    if (!message) return;
    if (message.direction === 'incoming') {
      if (allowReceipts) {
        controllers.messageStatus.sendReadReceiptForMessage(message);
      }
    } else if (message.direction === 'outgoing') {
      if (controllers.messageStatus.applyReceiptState(message)) receiptRenderPending = true;
    }
  }

  // Methods moved to renderer.js (isUserTimelineMessage, isOutgoingFromSelf, resolveLatestOutgoingMessage, computeDoubleTickState, computeDoubleTickMessageId, resolveLatestOutgoingMessageIdForConversation, isLatestOutgoingForStatus)

  // sendReadReceiptForMessage legacy removed



  function findTimelineMessageById(conversationId, messageId) {
    if (!conversationId || !messageId) return null;
    const timeline = timelineGetTimeline(conversationId);
    return timeline.find((msg) => normalizeTimelineMessageId(msg) === messageId) || null;
  }


  // applyMessagesLayout & updateLayoutMode moved to LayoutController



  // showDeleteForPeer removed (moved to ActiveConversationController)

  function handleConversationDelete({ conversationId, peerAccountDigest, element }) {
    const key = normalizePeerKey(peerAccountDigest);
    if (!key) return;
    const contactEntry = getContactCore(key);
    const nickname = contactEntry?.nickname || `好友 ${key.slice(-4)}`;
    const threadEntry = getConversationThreads().get(conversationId) || null;
    const convIndexEntry = sessionStore.conversationIndex?.get?.(conversationId) || null;
    const peerDeviceId =
      threadEntry?.peerDeviceId ||
      convIndexEntry?.peerDeviceId ||
      contactEntry?.peerDeviceId ||
      null;
    showConfirmModal({
      title: '刪除對話',
      message: `確定要刪除與「${escapeHtml(nickname)}」的對話？此操作也會從對方的對話列表中移除。`,
      confirmLabel: '刪除',
      onConfirm: async () => {
        try {
          if (!peerDeviceId) throw new Error('缺少對方 deviceId，請重新同步好友後再試');

          const state = getMessageState();
          const lastMsg = state.messages && state.messages.length > 0 ? state.messages[state.messages.length - 1] : null;
          const currentCounter = lastMsg ? (lastMsg.counter || 0) : 0;

          // 1. Set Deletion Cursor (Server filters future fetches)
          if (currentCounter > 0) {
            // Update Self Cursor
            await setDeletionCursor(conversationId, currentCounter);

            // Update Peer Cursor (Bi-directional)
            if (key) {
              // Fire and forget peer update to avoid blocking UI? Or await?
              // Await ensures consistency but might be slow.
              // We will await.
              try {
                await setPeerDeletionCursor(conversationId, key, currentCounter);

                // Send Signal (Control Message)
                // This ensures the peer knows to refresh/clear their view immediately.
                await sendDrPlaintext({
                  text: 'conversation-deleted',
                  // We must resolve peer info. 'key' is digest if normalized.
                  peerAccountDigest: key,
                  peerDeviceId: peerDeviceId, // Use cached peerDeviceId
                  conversationId: conversationId,
                  messageId: crypto.randomUUID(),
                  metaOverrides: {
                    msgType: CONTROL_MESSAGE_TYPES.CONVERSATION_DELETED
                  }
                });
              } catch (err) {
                console.warn('[messages-pane] bi-directional delete incomplete', err);
                // Don't block local delete on peer failure
              }
            }
          }

          // 2. Clear Local View (Immediate UI Feedback)
          sessionStore.deletedConversations?.add?.(conversationId);
          // Don't delete thread metadata, just hide it? 
          // User asked for "Hide" behavior previously.
          // But here we are "Deleting".
          // If we want "Delete for Me", we usually hide the contact too.
          hideContactSecret(key);
          if (typeof window !== 'undefined') window.__refreshContacts?.();
          if (typeof window !== 'undefined') window.__refreshContacts?.();
          if (element) closeSwipe?.(element);
          const refetchedState = getMessageState();
          if (refetchedState.activePeerDigest === key) {
            logConversationResetTrace({
              reason: 'DELETE_ACTIVE',
              conversationId: refetchedState?.conversationId || conversationId || null,
              peerKey: key || null,
              peerDigest: key || null,
              peerDeviceId,
              hasToken: !!(state?.conversationToken || convIndexEntry?.token_b64 || threadEntry?.conversationToken || contactEntry?.conversationToken),
              hasConversationId: !!(state?.conversationId || conversationId),
              'entry.isReady': contactEntry?.isReady ?? null,
              sourceTag: 'messages-pane:delete-conversation'
            });
            resetMessageStateWithPlaceholders();
            if (elements.peerName) elements.peerName.textContent = '選擇好友開始聊天';
            clearMessagesView();
            hideSecurityModal();
            deps.updateComposerAvailability();
            deps.applyMessagesLayout();
          }
          deps.syncConversationThreadsFromContacts();
          deps.refreshContactsUnreadBadges();
          deps.renderConversationList();
          // Removed legacy wsSendFn call (RefError peerDigest).
          // We already sent the encrypted signal via sendDrPlaintext above.
        } catch (err) {
          log({ conversationDeleteError: err?.message || err });
          alert(err?.message || '刪除對話失敗，請稍後再試。');
        }
      },
      onCancel: () => { if (element) closeSwipe?.(element); }
    });
  }







  function attachDomEvents() {
    elements.backBtn?.addEventListener('click', () => {
      const state = getMessageState();
      state.viewMode = 'list';
      controllers.layout.applyMessagesLayout();
      elements.input?.blur();
      switchTab?.('messages', { fromBack: true });
      hideSecurityModal();
      stopActivePoll();
    });

    elements.attachBtn?.addEventListener('click', () => {
      if (!requireSubscriptionActive()) return;
      elements.fileInput.click();
    });

    elements.fileInput?.addEventListener('change', (event) => {
      controllers.messageSending.handleComposerFileSelection(event);
    });

    elements.callBtn?.addEventListener('click', () => controllers.composer.handleConversationAction('voice'));
    elements.videoBtn?.addEventListener('click', () => controllers.composer.handleConversationAction('video'));
    elements.createGroupBtn?.addEventListener('click', () => controllers.groupBuilder.handleCreateGroup());

    if (elements.scrollEl) {
      elements.scrollEl.addEventListener('scroll', handleMessagesScroll, { passive: true });
      elements.scrollEl.addEventListener('touchend', handleMessagesTouchEnd, { passive: true });
      elements.scrollEl.addEventListener('touchcancel', handleMessagesTouchEnd, { passive: true });
      elements.scrollEl.addEventListener('wheel', handleMessagesWheel, { passive: true });
    }


    elements.messagesList?.addEventListener('click', (event) => {
      const target = event.target?.closest?.('.message-status.failed');
      if (!target) return;

      const isRetry = target.dataset.retry === 'true';
      const msgId = target.dataset.messageId;

      if (isRetry && msgId) {
        // Trigger manual retry
        controllers.messageSending.retryMessage(msgId).catch(err => {
          console.error('Retry failed', err);
          showToast?.('重試失敗', { variant: 'error' });
        });
        return;
      }

      showToast?.('訊息傳送失敗，請重新發送', { variant: 'warning' });
    });

    elements.loadMoreBtn?.addEventListener('click', () => {
      controllers.messageFlow.loadActiveConversationMessages({ append: true, reason: 'scroll' });
    });

    elements.createGroupBtn?.addEventListener('click', () => controllers.groupBuilder.handleCreateGroup());





    elements.composer?.addEventListener('submit', (event) => {
      controllers.composer.handleComposerSubmit(event);
    });

    elements.input?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        elements.composer?.requestSubmit();
      }
    });

    const blockDragIfKeyboard = (event) => {
      if (!keyboardActive) return;
      const inScroll = event.target && elements.scrollEl && elements.scrollEl.contains(event.target);
      if (!inScroll) {
        event.preventDefault();
      }
    };
    elements.pane?.addEventListener('touchmove', blockDragIfKeyboard, { passive: false });
    elements.composer?.addEventListener('touchmove', blockDragIfKeyboard, { passive: false });
    elements.headerEl?.addEventListener('touchmove', blockDragIfKeyboard, { passive: false });
  }

  function registerOutboxHooks() {
    // 1. Always update the delegate to point to the current closure's logic
    messagesPaneHooksDelegate = {
      onSent: async (job, response) => {
        console.log('[messages-pane] onSent:hook triggered', { jobId: job?.jobId, messageId: job?.messageId });
        if (!job || job.type !== 'message') return;
        const convId = job?.conversationId || null;
        const messageId = job?.messageId || null;
        if (!convId || !messageId) return;

        let message = findTimelineMessageById(convId, messageId);
        console.log('[messages-pane] onSent:message_found', {
          found: !!message,
          status: message?.status
        });

        if (!message || message.direction !== 'outgoing') return;
        const status = typeof message.status === 'string' ? message.status : null;
        if (status === 'failed' || status === 'delivered' || status === 'read') return;

        const payload = response?.data || job?.lastResponse || null;
        const payloadWithJobId = payload && typeof payload === 'object'
          ? { ...payload, jobId: job?.jobId || null }
          : { jobId: job?.jobId || null };
        const fallbackTs = Number.isFinite(Number(job?.createdAt))
          ? Math.floor(Number(job.createdAt))
          : (Number.isFinite(Number(message.ts)) ? Number(message.ts) : Date.now());

        try {
          controllers.messageStatus.applyOutgoingSent(message, payloadWithJobId, fallbackTs, 'OUTBOX_SENT_HOOK');
          console.log('[messages-pane] onSent:apply_done', {
            newStatus: message.status,
            serverId: message.serverMessageId
          });
        } catch (err) {
          console.error('[messages-pane] onSent:apply_error', err);
          controllers.messageStatus.applyOutgoingFailure(message, err, '傳送失敗', 'OUTBOX_SENT_HOOK_ERROR');
        }

        const state = getMessageState();
        if (state.conversationId === convId) {
          console.log('[messages-pane] onSent:trigger_ui_update');
          controllers.messageFlow.updateMessagesUI({ preserveScroll: true, forceFullRender: true });
        } else {
          console.log('[messages-pane] onSent:ui_update_skipped', {
            stateConvId: state.conversationId,
            jobConvId: convId
          });
        }
      },
      onFailed: async (job, err) => {
        if (!job || job.type !== 'message') return;
        const convId = job?.conversationId || null;
        const messageId = job?.messageId || null;
        if (!convId || !messageId) return;
        const message = findTimelineMessageById(convId, messageId);
        if (!message || message.direction !== 'outgoing') return;
        const status = typeof message.status === 'string' ? message.status : null;
        if (status === 'delivered' || status === 'read') return;
        const errWithJob = err || new Error('outbox send failed');
        if (job?.jobId && errWithJob && typeof errWithJob === 'object' && !errWithJob.jobId) {
          errWithJob.jobId = job.jobId;
        }
        const isCounterTooLow = controllers.messageStatus.isCounterTooLowError(errWithJob);
        const failureErr = isCounterTooLow ? controllers.messageStatus.buildCounterTooLowReplacementError() : errWithJob;
        if (failureErr && typeof failureErr === 'object' && errWithJob && typeof errWithJob === 'object') {
          if (errWithJob.status) failureErr.status = errWithJob.status;
          if (errWithJob.jobId && !failureErr.jobId) failureErr.jobId = errWithJob.jobId;
        }
        const reasonCode = isCounterTooLow
          ? 'COUNTER_TOO_LOW_REPLACED'
          : 'OUTBOX_FAILED_HOOK';
        controllers.messageStatus.applyOutgoingFailure(message, failureErr, '傳送失敗', reasonCode);
        const state = getMessageState();
        if (state.conversationId === convId) controllers.messageFlow.updateMessagesUI({ preserveScroll: true, forceFullRender: true });
      }
    };

    // 2. Register the PROXY once (safe to call multiple times, Set deduplicates)
    // Removed guard to ensure specific proxy object is always registered
    // if (outboxHooksRegistered) return; 
    outboxHooksRegistered = true;
    console.log('[messages-pane] Registering outbound hooks proxy');
    setOutboxHooks(messagesPaneHooksProxy);
  }

  // initKeyboardListeners removed (moved to LayoutController)

  function getConversationThreads() {
    if (!(sessionStore.conversationThreads instanceof Map)) {
      const entries = sessionStore.conversationThreads && typeof sessionStore.conversationThreads.entries === 'function'
        ? Array.from(sessionStore.conversationThreads.entries())
        : [];
      sessionStore.conversationThreads = new Map(entries);
    }
    return sessionStore.conversationThreads;
  }

  function ensureSetup() {
    const isStale = (el) => !el || !el.isConnected;

    if (isStale(elements.pane)) elements.pane = document.querySelector('.messages-pane');
    if (elements.pane) elements.pane.style.overscrollBehavior = 'contain';

    if (isStale(elements.messagesWsIndicator)) elements.messagesWsIndicator = document.getElementById('messagesWsIndicator');

    if (isStale(elements.messagesList)) {
      console.log('[messages-pane] ensureSetup: refreshing messagesList DOM ref');
      elements.messagesList = document.getElementById('messagesList');
    }

    if (isStale(elements.messagesEmpty)) elements.messagesEmpty = document.getElementById('messagesEmpty');

    if (isStale(elements.scrollEl)) {
      elements.scrollEl = document.getElementById('messagesScroll');
      if (elements.scrollEl) elements.scrollEl.style.overscrollBehavior = 'contain';
    }

    if (isStale(elements.input)) elements.input = document.getElementById('composerInput'); // Ensure input is also refreshed
    if (isStale(elements.sendBtn)) elements.sendBtn = document.getElementById('composerSendBtn');

    if (isStale(elements.loadMoreBtn)) elements.loadMoreBtn = document.getElementById('messagesLoadMore');
    if (isStale(elements.loadMoreLabel)) elements.loadMoreLabel = document.querySelector('#messagesLoadMore .label');
    if (isStale(elements.loadMoreSpinner)) elements.loadMoreSpinner = document.querySelector('#messagesLoadMore .spinner');
    ensureMessagesWsIndicatorMirror();
  }

  registerOutboxHooks();
  ensureSetup();
  controllers.groupBuilder.renderGroupDrafts();


  // [DEBUG-TOOL] Long Press for Debug Modal
  const openModal = modalOptions.openModal || (typeof document !== 'undefined' ? (window.openModalShim || null) : null);

  function showDebugModal(msgId) {
    const state = getMessageState();
    if (!state.conversationId || !msgId || !openModal) return;

    // Find msg in current timeline or state messages
    const timeline = timelineGetTimeline(state.conversationId) || [];
    const msg = timeline.find(m => {
      const mid = normalizeTimelineMessageId(m);
      return mid === msgId;
    });

    if (!msg) return;

    const dr = drState(state.activePeerDigest || state.activePeerDeviceId || null) || {};

    // Group 1: Basic
    const basics = [
      ['Internal ID', msg.id || msg.messageId || 'N/A'],
      ['Server ID', msg.serverMessageId || 'N/A'],
      ['Type', msg.msgType || msg.subtype || 'N/A'],
      ['Status', msg.status || '<span style="color:#10b981; font-weight:600;">Normal</span>'],
      ['Timestamp', new Date((msg.ts || 0) * 1000).toLocaleString()]
    ];

    // Group 2: Counters
    const counters = [
      ['Internal Counter', msg.counter ?? 'N/A'],
      ['Header Counter', msg.header?.n ?? msg.header?.counter ?? 'N/A']
    ];

    // Group 3: DR State
    const drData = [
      ['Ns / Nr', `${dr.Ns || 0} / ${dr.Nr || 0}`],
      ['PN', dr.PN || 0]
    ];

    const modalTitle = document.getElementById('modalTitle');
    if (modalTitle) modalTitle.textContent = 'Message Debug';

    const renderRow = ([k, v]) => {
      const isHtml = typeof v === 'string' && v.startsWith('<span style="color:#10b981;');
      return `
      <div class="version-row">
        <span class="version-label">${escapeHtml(String(k))}</span>
        <span class="version-value">${isHtml ? v : escapeHtml(String(v))}</span>
      </div>`;
    };

    let headerSection = '';
    if (msg.header) {
      const headerJson = JSON.stringify(msg.header, null, 2);
      headerSection = `
        <div class="version-section-title">Header Payload</div>
        <div style="margin-top:8px;">
          <details style="border: 1px solid rgba(15, 23, 42, 0.1); border-radius: 10px; background: #f8fafc;">
             <summary style="padding: 10px 12px; cursor:pointer; font-weight:700; font-size:13px; color:#0f172a;">檢視 Header JSON</summary>
             <div style="padding: 0 12px 12px 12px;">
               <pre style="margin:0; padding:10px; color:#334155; word-break:break-all; white-space:pre-wrap; font-family:monospace; font-size:12px; background:#f1f5f9; border-radius:8px; overflow-x: auto;">${escapeHtml(headerJson)}</pre>
             </div>
          </details>
        </div>
      `;
    } else {
      headerSection = `
        <div class="version-section-title">Header Payload</div>
        ${renderRow(['Header', 'N/A (Outgoing/Local)'])}
       `;
    }

    const html = `
      <div class="version-modal">
        <div class="version-section-title">Message Details</div>
        ${basics.map(renderRow).join('')}
        ${counters.map(renderRow).join('')}
        
        <div style="margin: 16px 0; border-top: 1px dashed rgba(0,0,0,0.1);"></div>
        
        <div class="version-section-title">Session State (Global)</div>
        <div style="font-size: 11px; color: #64748b; margin-bottom: 8px;">當前最新的加密會話狀態</div>
        ${drData.map(renderRow).join('')}
        
        <div style="margin: 16px 0; border-top: 1px dashed rgba(0,0,0,0.1);"></div>


        
        ${headerSection}
        
      </div>
    `;

    const body = document.getElementById('modalBody');
    if (body) {
      body.innerHTML = html;
      openModal();
    }
  }

  let pressTimer = null;
  const PRESS_DURATION = 600;

  function cancelLongPress() {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  }

  if (elements.messagesList) {
    elements.messagesList.addEventListener('touchstart', (e) => {
      // Don't cancel immediately? Standard is restart.
      cancelLongPress();
      const bubble = e.target.closest('.message-bubble');
      if (!bubble) return;
      const msgId = bubble.dataset.messageId;
      if (!msgId) return;

      pressTimer = setTimeout(() => {
        showDebugModal(msgId);
        try { if (navigator.vibrate) navigator.vibrate(50); } catch { }
      }, PRESS_DURATION);
    }, { passive: true });

    elements.messagesList.addEventListener('touchend', cancelLongPress, { passive: true });
    // touchmove tolerance? For now just strict cancel on move to avoid scroll conflict
    elements.messagesList.addEventListener('touchmove', cancelLongPress, { passive: true });
    elements.messagesList.addEventListener('touchcancel', cancelLongPress, { passive: true });

    // [FIX] Enable Debug Modal on Desktop via Right Click
    elements.messagesList.addEventListener('contextmenu', (e) => {
      const bubble = e.target.closest('.message-bubble');
      if (bubble && bubble.dataset.messageId) {
        e.preventDefault();
        showDebugModal(bubble.dataset.messageId);
      }
    });
  }

  return {
    attachDomEvents,
    refreshAfterReconnect: async () => {
      try { await controllers.conversationList.refreshPreviews({ force: true }); } catch (err) { log({ refreshAfterReconnectPreviewError: err?.message || err }); }
      const state = getMessageState();
      if (state.activePeerDigest && state.conversationToken) {
        try {
          await messagesFlowFacade.onEnterConversation({
            conversationId: state.conversationId,
            peerKey: state.activePeerDigest,
            loadActiveConversationMessages: (args) => controllers.messageFlow.loadActiveConversationMessages(args),
            replay: false,
            reason: 'ws-reconnect',
            loadOptions: { silent: true },
            runCatchup: false
          });
        } catch (err) {
          log({ refreshAfterReconnectLoadError: err?.message || err });
        }
      }
    },
    reconcileOutgoingStatusNow: ({ conversationId, peerAccountDigest, source } = {}) => {
      triggerOutgoingStatusReconcile({ conversationId, peerAccountDigest, source });
    },
    updateLayoutMode: (args) => controllers.layout.updateLayoutMode(args),
    renderConversationList: () => controllers.conversationList.renderConversationList(),
    refreshConversationPreviews: (args) => controllers.conversationList.refreshPreviews(args),
    syncConversationThreadsFromContacts: () => controllers.conversationList.syncFromContacts(),
    refreshContactsUnreadBadges: () => controllers.conversationList.refreshUnreadBadges(),
    clearMessagesView,
    updateComposerAvailability: () => controllers.composer.updateComposerAvailability(),
    loadActiveConversationMessages: (args) => controllers.messageFlow.loadActiveConversationMessages(args),
    setActiveConversation: (digest) => controllers.activeConversation.setActiveConversation(digest), // Internal facade dep, exposed directly
    appendLocalOutgoingMessage: (args) => controllers.messageSending.appendLocalOutgoingMessage(args),
    handleIncomingSecureMessage: (e) => controllers.messageFlow.handleIncomingSecureMessage(e),
    handleVaultAckEvent: (e) => controllers.messageFlow.handleVaultAckEvent(e),
    handleContactOpenConversation: (d) => controllers.activeConversation.handleContactOpenConversation(d),
    handleContactEntryUpdated: (d) => controllers.activeConversation.handleContactEntryUpdated(d),
    setMessagesStatus: (msg, isError) => controllers.composer.setMessagesStatus(msg, isError),
    getMessageState,
    ensureConversationIndex: () => controllers.conversationList.ensureConversationIndex(),
    getConversationThreads: () => controllers.conversationList.getThreads(),
    setWsSend(fn) { wsSendFn = typeof fn === 'function' ? fn : () => false; },
    updateMessagesUI: (args) => controllers.messageFlow.updateMessagesUI(args),
    applyMessagesLayout: (args) => controllers.layout.applyMessagesLayout(args),
    triggerAutoLoadOlder: () => controllers.messageFlow.triggerAutoLoadOlder(),
    setLoadMoreState: (state) => controllers.messageFlow.setLoadMoreState(state),
    showDeleteForPeer: (d) => controllers.activeConversation.showDeleteForPeer(d)
  };
}
