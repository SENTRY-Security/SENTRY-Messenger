import { log, logCapped } from '../../core/log.js';
import { getAccountToken, getAccountDigest, getMkRaw, normalizePeerIdentity, normalizeAccountDigest, ensureDeviceId, normalizePeerDeviceId } from '../../core/store.js';
import { listSecureAndDecrypt, resetProcessedMessages, getMessageReceipt, recordMessageRead, getMessageDelivery, recordMessageDelivered, clearConversationTombstone, clearConversationHistory, getConversationClearAfter, syncOfflineDecryptNow } from '../../features/messages.js';
import { appendUserMessage as timelineAppendUserMessage, getTimeline as timelineGetTimeline, subscribeTimeline } from '../../features/timeline-store.js';
import { sendDrText, sendDrMedia, sendDrCallLog } from '../../features/dr-session.js';
import { flushOutbox, retryOutboxMessage, setOutboxHooks } from '../../features/queue/outbox.js';
import { MessageKeyVault } from '../../features/message-key-vault.js';
import {
  ensureSecureConversationReady,
  subscribeSecureConversation,
  getSecureConversationStatus,
  handleSecureConversationControlMessage,
  SECURE_CONVERSATION_STATUS,
  listSecureConversationStatuses
} from '../../features/secure-conversation-manager.js';
import { CONTROL_MESSAGE_TYPES, normalizeControlMessageType } from '../../features/secure-conversation-signals.js';
import { SEMANTIC_KIND } from '../../features/semantic.js';
import {
  conversationIdFromToken,
  deriveConversationContextFromSecret
} from '../../features/conversation.js';
import { sessionStore, resetMessageState, restorePendingInvites } from './session-store.js';
import { deleteContactSecret, getContactSecret, getCorruptContact } from '../../core/contact-secrets.js';
import { clearDrState } from '../../core/store.js';
import { escapeHtml, fmtSize, shouldNotifyForMessage } from './ui-utils.js';
import { contactCoreCounts, getContactCore, upsertContactCore, listReadyContacts, removeContactCore } from './contact-core-store.js';
import { downloadAndDecrypt } from '../../features/media.js';
import { renderPdfViewer, cleanupPdfViewer, getPdfJsLibrary } from './viewers/pdf-viewer.js';
import { deleteSecureConversation, listSecureMessages as apiListSecureMessages, fetchOutgoingStatus, toDigestOnly } from '../../api/messages.js';
import { createGroup as apiCreateGroup } from '../../api/groups.js';
import {
  CALL_EVENT,
  CALL_REQUEST_KIND,
  CALL_SESSION_DIRECTION,
  CALL_SESSION_STATUS,
  requestOutgoingCall,
  loadCallNetworkConfig,
  sendCallInviteSignal,
  getCallSessionSnapshot,
  getCallCapability,
  getSelfProfileSummary,
  prepareCallKeyEnvelope,
  startOutgoingCallMedia,
  subscribeCallEvent,
  resolveCallPeerProfile
} from '../../features/calls/index.js';
import { buildCallPeerIdentity } from '../../features/calls/identity.js';
import {
  CALL_LOG_OUTCOME,
  describeCallLogForViewer,
  resolveViewerRole
} from '../../features/calls/call-log.js';
import { bytesToB64Url } from './ui-utils.js';
import { logMsgEvent } from '../../lib/logging.js';
import { DEBUG } from './debug-flags.js';
const sentCallLogIds = new Set();
const sentReadReceiptIds = new Set();
const callLogPlaceholders = new Map();
const GROUPS_ENABLED = false;
const decryptBannerLogDedup = new Set();
const setActiveFailLogKeys = new Set();
const renderState = { conversationId: null, renderedIds: [] };
let outboxHooksRegistered = false;
let pendingNewMessageHint = false;
const uiNoiseEnabled = DEBUG.uiNoise === true;
const contactCoreVerbose = DEBUG.contactCoreVerbose === true;
const logReplayCallsite = (name, payload = {}) => {
  try {
    log({ replayCallsite: { name, ...payload } });
  } catch {}
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
  } catch {}
};
const logReplayFetchResult = (payload = {}) => {
  try {
    log({ replayFetchResult: payload });
  } catch {}
};
const CONVERSATION_RESET_TRACE_LIMIT = 5;
let conversationResetTraceCount = 0;
const SECURE_MODAL_GATE_TRACE_LIMIT = 3;
let secureModalGateTraceCount = 0;
const VAULT_GATE_DECISION_TRACE_LIMIT = 3;
let vaultGateDecisionTraceCount = 0;

function logConversationResetTrace(payload = {}) {
  if (conversationResetTraceCount >= CONVERSATION_RESET_TRACE_LIMIT) return;
  conversationResetTraceCount += 1;
  try {
    log({ conversationResetTrace: payload });
  } catch {}
}

function logSecureModalGateTrace(payload = {}) {
  if (secureModalGateTraceCount >= SECURE_MODAL_GATE_TRACE_LIMIT) return;
  secureModalGateTraceCount += 1;
  try {
    log({ secureModalGateTrace: payload });
  } catch {}
}

function logVaultGateDecisionTrace(payload = {}) {
  if (vaultGateDecisionTraceCount >= VAULT_GATE_DECISION_TRACE_LIMIT) return;
  vaultGateDecisionTraceCount += 1;
  try {
    log({ vaultGateDecisionTrace: payload });
  } catch {}
}

function normalizeMsgTypeValue(value) {
  if (!value || typeof value !== 'string') return null;
  return value.trim().toLowerCase();
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
    const msgType = normalizeMsgTypeValue(entry?.subtype || entry?.msgType || entry?.type || null);
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

function makeCallLogPlaceholderKey(peerDigest, callId) {
  if (!peerDigest || !callId) return null;
  return `${peerDigest}:${callId}`;
}

function trackCallLogPlaceholder(peerDigest, callId, message) {
  const key = makeCallLogPlaceholderKey(peerDigest, callId);
  if (!key || !message) return;
  callLogPlaceholders.set(key, message);
}

function resolveCallLogPlaceholder(peerDigest, callId) {
  const key = makeCallLogPlaceholderKey(peerDigest, callId);
  if (!key) return null;
  return callLogPlaceholders.get(key) || null;
}

function releaseCallLogPlaceholder(peerDigest, callId) {
  const key = makeCallLogPlaceholderKey(peerDigest, callId);
  if (!key) return;
  callLogPlaceholders.delete(key);
}

function clearCallLogPlaceholders() {
  callLogPlaceholders.clear();
}

function getMessageState() {
  if (!sessionStore.messageState) {
    resetMessageStateWithPlaceholders();
  }
  return sessionStore.messageState;
}

  function refreshTimelineState(conversationId = null) {
    const state = getMessageState();
    const convId = conversationId || state.conversationId || null;
    if (!convId) {
      state.messages = [];
      return state.messages;
    }
    const timeline = timelineGetTimeline(convId);
    state.messages = timeline;
    return timeline;
  }

function resetMessageStateWithPlaceholders() {
  clearCallLogPlaceholders();
  resetMessageState();
  stopActivePoll();
  renderState.conversationId = null;
  renderState.renderedIds = [];
  pendingNewMessageHint = false;
}

let activePollTimer = null;
const ACTIVE_POLL_INTERVAL_MS = 3_000;

function stopActivePoll() {
  if (activePollTimer) {
    try { clearTimeout(activePollTimer); } catch {}
    activePollTimer = null;
  }
}

const LOCAL_GROUP_STORAGE_KEY = 'groups-drafts-v1';
let localGroups = loadLocalGroups();
let groupBuilderEl = null;

function loadLocalGroups() {
  try {
    const raw = sessionStorage.getItem(LOCAL_GROUP_STORAGE_KEY) || localStorage.getItem(LOCAL_GROUP_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistLocalGroups() {
  try {
    sessionStorage.setItem(LOCAL_GROUP_STORAGE_KEY, JSON.stringify(localGroups));
  } catch {}
  try {
    localStorage.setItem(LOCAL_GROUP_STORAGE_KEY, JSON.stringify(localGroups));
  } catch {}
}
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
    backBtn: dom.messagesBackBtnEl ?? document.getElementById('messagesBackBtn'),
    headerEl: dom.messagesHeaderEl ?? document.querySelector('.messages-header'),
    peerAvatar: dom.messagesPeerAvatarEl ?? document.getElementById('messagesPeerAvatar'),
    composer: dom.messageComposerEl ?? document.getElementById('messageComposer'),
    input: dom.messageInputEl ?? document.getElementById('messageInput'),
    sendBtn: dom.messageSendBtn ?? document.getElementById('messageSend'),
    attachBtn: dom.composerAttachBtn ?? document.getElementById('composerAttach'),
    fileInput: dom.messageFileInputEl ?? document.getElementById('messageFileInput'),
    conversationList: dom.conversationListEl ?? document.getElementById('conversationList'),
    conversationRefreshEl: dom.conversationRefreshEl ?? document.getElementById('conversationRefresh'),
    conversationRefreshLabelEl: dom.conversationRefreshLabelEl ?? document.querySelector('#conversationRefresh .label'),
    createGroupBtn: dom.createGroupBtn ?? document.getElementById('btnCreateGroup'),
    groupDraftsEl: dom.groupDraftsEl ?? document.getElementById('groupDrafts'),
    messagesList: dom.messagesListEl ?? document.getElementById('messagesList'),
    messagesEmpty: dom.messagesEmptyEl ?? document.getElementById('messagesEmpty'),
    peerName: dom.messagesPeerNameEl ?? document.getElementById('messagesPeerName'),
    statusLabel: dom.messagesStatusEl ?? document.getElementById('messagesStatus'),
    scrollEl: dom.messagesScrollEl ?? document.getElementById('messagesScroll'),
    loadMoreBtn: dom.messagesLoadMoreBtn ?? document.getElementById('messagesLoadMore'),
    loadMoreLabel: dom.messagesLoadMoreLabel ?? document.querySelector('#messagesLoadMore .label'),
    loadMoreSpinner: dom.messagesLoadMoreSpinner ?? document.querySelector('#messagesLoadMore .spinner'),
    callBtn: dom.messagesCallBtn ?? document.getElementById('messagesCallBtn'),
    videoBtn: dom.messagesVideoBtn ?? document.getElementById('messagesVideoBtn')
  };
  let pendingWsRefresh = 0;
  let receiptRenderPending = false;
  let keyboardOffsetPx = 0;
  let keyboardActive = false;
  let viewportGuardTimer = null;
  let conversationIndexRestoredFromPending = false;

  const secureStatusCache = new Map();
  let pendingSecureReadyPeer = null;
  let unsubscribeSecureStatus = null;
  let unsubscribeTimeline = null;
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
  const CONV_PULL_THRESHOLD = 60;
  const CONV_PULL_MAX = 140;
  const contactSyncInFlight = new Set();
  unsubscribeTimeline = subscribeTimeline(handleTimelineAppend);

  const normalizeDigestString = (value) => {
    const identity = normalizePeerIdentity(value);
    return identity.key || null;
  };

  function scheduleActivePoll() {
    stopActivePoll();
  }

  function normalizePeerKey(value) {
    return normalizeDigestString(value?.peerAccountDigest ?? value);
  }

  function splitPeerKey(value) {
    const key = typeof value === 'string' ? value : normalizePeerKey(value);
    if (!key || typeof key !== 'string' || !key.includes('::')) {
      return { digest: normalizeAccountDigest(key || null), deviceId: null };
    }
    const [digestPart, devicePart] = key.split('::');
    return {
      digest: normalizeAccountDigest(digestPart),
      deviceId: normalizePeerDeviceId(devicePart)
    };
  }

  function suppressComposerBlurOnce() {
    if (suppressInputBlurOnce) return;
    suppressInputBlurOnce = true;
    const clear = () => {
      suppressInputBlurOnce = false;
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => requestAnimationFrame(clear));
    } else {
      setTimeout(clear, 0);
    }
  }

  function logContactCoreWriteSkip({ callsite, conversationId = null, hasDeviceId = false }) {
    if (!contactCoreVerbose) return;
    try {
      console.warn('[contact-core] ui:write-skip ' + JSON.stringify({
        reason: 'missing-digest',
        callsite,
        conversationId: conversationId || null,
        hasDeviceId: !!hasDeviceId
      }));
    } catch {}
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

  const CALL_LOG_PHONE_ICON = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M2.003 5.884l3.75-1.5a1 1 0 011.316.593l1.2 3.199a1 1 0 01-.232 1.036l-1.516 1.52a11.037 11.037 0 005.516 5.516l1.52-1.516a1 1 0 011.036-.232l3.2 1.2a1 1 0 01.593 1.316l-1.5 3.75a1 1 0 01-1.17.6c-2.944-.73-5.59-2.214-7.794-4.418-2.204-2.204-3.688-4.85-4.418-7.794a1 1 0 01.6-1.17z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path></svg>';

  async function copyGroupSummary(draft) {
    if (!draft) return;
    const summary = [
      `群組ID: ${draft.groupId}`,
      `群組名稱: ${draft.name || '(未命名)'}`,
      `對話ID: ${draft.conversationId}`,
      `會話密鑰(token): ${draft.tokenB64}`,
      `邀請密鑰(seed): ${draft.secretB64Url}`
    ].join('\n');
    try {
      await navigator.clipboard.writeText(summary);
      showToast?.('群組資訊已複製');
    } catch {
      showToast?.('無法複製到剪貼簿，請確認權限', { variant: 'warning' });
      log({ groupCopyClipboardError: 'clipboard-write-failed' });
    }
  }

  function renderGroupDrafts() {
    if (!GROUPS_ENABLED) return;
    const container = elements.groupDraftsEl;
    if (!container) return;
    if (!localGroups.length) {
      container.innerHTML = '';
      return;
    }
    const items = localGroups.map((draft, idx) => {
      const created = draft.createdAt ? new Date(draft.createdAt).toLocaleString() : '';
      const label = escapeHtml(draft.name || draft.groupId);
      const gid = escapeHtml(draft.groupId);
      const cid = escapeHtml(draft.conversationId);
      return `
        <div class="group-draft-item" data-idx="${idx}">
          <div class="group-draft-meta">
            <div class="group-draft-name">${label}</div>
            <div class="group-draft-id">ID ${gid}</div>
            <div class="group-draft-cid">CID ${cid}</div>
            ${created ? `<div class="group-draft-ts">${created}</div>` : ''}
          </div>
          <button type="button" class="group-draft-copy" aria-label="複製群組資訊">複製</button>
        </div>
      `;
    }).join('');
    container.innerHTML = `<div class="group-draft-header">我的群組（僅本機記錄）</div>${items}`;
    container.querySelectorAll('.group-draft-copy').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        const wrapper = event.target.closest('.group-draft-item');
        const idx = Number(wrapper?.dataset?.idx ?? -1);
        if (Number.isInteger(idx) && idx >= 0 && localGroups[idx]) {
          copyGroupSummary(localGroups[idx]);
        }
      });
    });
  }

  async function handleCreateGroup() {
    if (!GROUPS_ENABLED) return;
    const btn = elements.createGroupBtn;
    if (!btn) return;
    if (groupBuilderEl) {
      groupBuilderEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    openGroupBuilder();
  }

  function openGroupBuilder() {
    if (!GROUPS_ENABLED) return;
    closeGroupBuilder();
    const container = document.createElement('div');
    container.className = 'group-builder';
    container.style.padding = '12px';
    container.style.margin = '8px 12px';
    container.style.border = '1px solid rgba(15,23,42,0.08)';
    container.style.borderRadius = '12px';
    container.style.background = '#f8fafc';
    container.style.boxShadow = '0 8px 24px rgba(15,23,42,0.08)';
    container.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;justify-content:space-between;margin-bottom:8px;">
        <strong style="font-size:14px;">建立群組</strong>
        <div style="display:flex;gap:8px;">
          <button type="button" class="group-builder-cancel secondary" style="padding:6px 10px;">取消</button>
          <button type="button" class="group-builder-create primary" style="padding:6px 10px;">建立</button>
        </div>
      </div>
      <label style="display:block;margin-bottom:8px;">
        <div style="font-size:12px;color:#475569;margin-bottom:4px;">群組名稱</div>
        <input type="text" class="group-builder-name" placeholder="輸入群組名稱" style="width:100%;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;"/>
      </label>
      <div style="font-size:12px;color:#475569;margin:4px 0 6px;">選擇成員</div>
      <div class="group-builder-list" style="max-height:220px;overflow:auto;display:flex;flex-direction:column;gap:6px;"></div>
      <div class="group-builder-empty" style="display:none;font-size:13px;color:#64748b;padding:8px 0;">尚無好友可加入，請先建立好友。</div>
    `;
    elements.conversationList?.parentElement?.insertBefore(container, elements.conversationList);
    groupBuilderEl = container;
    renderGroupMemberList();
    container.querySelector('.group-builder-cancel')?.addEventListener('click', closeGroupBuilder);
    container.querySelector('.group-builder-create')?.addEventListener('click', submitGroupBuilder);
  }

  function closeGroupBuilder() {
    if (groupBuilderEl && groupBuilderEl.parentElement) {
      groupBuilderEl.parentElement.removeChild(groupBuilderEl);
    }
    groupBuilderEl = null;
  }

  function renderGroupMemberList() {
    if (!GROUPS_ENABLED) return;
    if (!groupBuilderEl) return;
    const listEl = groupBuilderEl.querySelector('.group-builder-list');
    const emptyEl = groupBuilderEl.querySelector('.group-builder-empty');
    if (!listEl || !emptyEl) return;
    const contacts = Array.isArray(sessionStore.contactState) ? sessionStore.contactState : [];
    if (!contacts.length) {
      listEl.innerHTML = '';
      emptyEl.style.display = 'block';
      return;
    }
    emptyEl.style.display = 'none';
    listEl.innerHTML = contacts.map((c, idx) => {
      const digest = contactPeerKey(c) || '';
      const nickname = escapeHtml(c?.nickname || `好友 ${digest.slice(-4)}`);
      return `
        <label class="group-builder-item" style="display:flex;align-items:center;gap:10px;padding:8px;border:1px solid rgba(148,163,184,0.4);border-radius:10px;cursor:pointer;">
          <input type="checkbox" data-peer-account-digest="${digest}" data-digest="${escapeHtml(digest)}" style="width:16px;height:16px;"/>
          <div style="display:flex;flex-direction:column;gap:2px;">
            <span style="font-size:13px;font-weight:600;">${nickname}</span>
            <span style="font-size:11px;color:#64748b;">${digest}</span>
          </div>
        </label>
      `;
    }).join('');
  }

  async function submitGroupBuilder() {
    if (!GROUPS_ENABLED) return;
    if (!groupBuilderEl) return;
    const nameInput = groupBuilderEl.querySelector('.group-builder-name');
    const checkboxes = groupBuilderEl.querySelectorAll('input[type="checkbox"][data-peer-account-digest]');
    const selected = [];
    checkboxes.forEach((cb) => {
      if (cb.checked) {
        const digest = normalizePeerKey(cb.getAttribute('data-digest') || cb.getAttribute('data-peer-account-digest') || '');
        if (!digest) return;
        selected.push({ accountDigest: digest });
      }
    });
    const nameVal = (nameInput?.value || '').trim();
    const btn = groupBuilderEl.querySelector('.group-builder-create');
    if (btn?.dataset.busy === '1') return;
    btn.dataset.busy = '1';
    btn.disabled = true;
    try {
      const secret = new Uint8Array(32);
      crypto.getRandomValues(secret);
      const secretB64Url = bytesToB64Url(secret);
      const { conversationId, tokenB64 } = await deriveConversationContextFromSecret(secretB64Url, { deviceId: ensureDeviceId() });
      const groupId = `grp-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const { r, data } = await apiCreateGroup({
        groupId,
        conversationId,
        name: nameVal || null,
        members: selected
      });
      if (!r.ok) {
        const msg = typeof data === 'string' ? data : data?.message || data?.error || '建立失敗';
        showToast?.(`建立群組失敗：${msg}`);
        return;
      }
      showToast?.(`群組已建立：${nameVal || groupId}`);
      const draft = {
        groupId,
        name: nameVal || `群組 ${groupId.slice(-4)}`,
        conversationId,
        tokenB64,
        secretB64Url,
        createdAt: Date.now()
      };
      localGroups = [draft, ...localGroups].slice(0, 20);
      persistLocalGroups();
      renderGroupDrafts();
      try {
        const summary = [
          `群組ID: ${groupId}`,
          `對話ID: ${conversationId}`,
          `會話密鑰(token): ${tokenB64}`,
          `邀請密鑰(seed): ${secretB64Url}`
        ].join('\n');
        await navigator.clipboard.writeText(summary);
        showToast?.('群組資訊已複製，可貼給成員');
      } catch {
        showToast?.('群組已建立，複製剪貼簿失敗，請稍後再試', { variant: 'warning' });
        log({ groupCreateClipboardError: 'clipboard-write-failed' });
      }
      log({ groupCreate: { groupId, conversationId, hasClipboard: true } });
    } catch (err) {
      showToast?.(`建立群組失敗：${err?.message || err}`);
      log({ groupCreateError: err?.message || err });
    } finally {
      if (btn) {
        delete btn.dataset.busy;
        btn.disabled = false;
      }
    }
  }

  function createCallLogMessage(entry, { messageDirection = 'outgoing' } = {}) {
    const callLog = {
      callId: entry.callId || null,
      outcome: entry.outcome,
      durationSeconds: entry.durationSeconds,
      authorRole: entry.direction || CALL_SESSION_DIRECTION.OUTGOING,
      reason: entry.reason || null
    };
    const viewerRole = resolveViewerRole(callLog.authorRole, messageDirection);
    const { label, subLabel } = describeCallLogForViewer(callLog, viewerRole);
    return {
      id: entry.id || null,
      ts: entry.ts,
      type: 'call-log',
      direction: messageDirection,
      text: label,
      callLog: {
        ...callLog,
        viewerRole,
        label,
        subLabel
      }
    };
  }

  function updateThreadsWithCallLogDisplay({ peerAccountDigest, label, ts, direction }) {
    const threads = getConversationThreads();
    let touched = false;
    for (const thread of threads.values()) {
      if (threadPeer(thread) === normalizePeerKey(peerAccountDigest)) {
        thread.lastMessageText = label;
        thread.lastMessageTs = ts;
        thread.lastDirection = direction;
        thread.lastReadTs = ts;
        thread.unreadCount = 0;
        thread.needsRefresh = true;
        touched = true;
      }
    }
    if (touched) {
      renderConversationList();
    }
  }

  function updateThreadAvatar(peerAccountDigest, avatarData) {
    const key = normalizePeerKey(peerAccountDigest);
    if (!key) return;
    const threads = getConversationThreads();
    let touched = false;
    for (const thread of threads.values()) {
      if (threadPeer(thread) === key) {
        thread.avatar = avatarData || null;
        touched = true;
      }
    }
    if (touched) {
      renderConversationList();
    }
  }

  function handleCallStateEvent(detail = {}) {
    const session = detail.session || null;
    if (!session) return;
    const status = session.status;
    if (![CALL_SESSION_STATUS.ENDED, CALL_SESSION_STATUS.FAILED].includes(status)) return;
    const peerProfile = resolveCallPeerProfile({
      peerAccountDigest: session.peerAccountDigest,
      peerDeviceId: session.peerDeviceId,
      peerKey: session.peerKey || null
    });
    const peerDigest = peerProfile.peerAccountDigest || ensurePeerAccountDigest(session);
    const peerDeviceId = peerProfile.peerDeviceId
      || normalizePeerDeviceId(session?.peerDeviceId || null)
      || normalizePeerIdentity(session?.peerKey || session)?.deviceId
      || null;
    const identifier = session.callId || session.traceId || `${peerDigest || 'unknown'}-${session.requestedAt || Date.now()}`;
    if (sentCallLogIds.has(identifier)) return;
    sentCallLogIds.add(identifier);
    if (!peerDigest || !peerDeviceId) {
      try {
        console.info('[call] log:skip ' + JSON.stringify({ reason: 'missing-peer', callId: session.callId || identifier }));
      } catch {}
      return;
    }
    const state = getMessageState();
    const conversationId = state.conversationId || peerProfile.conversationId || null;
    if (!conversationId) {
      try {
        console.info('[call] log:skip ' + JSON.stringify({ reason: 'missing-conversation', callId: session.callId || identifier }));
      } catch {}
      return;
    }
    const endedAtMs = session.endedAt || Date.now();
    const startedAtMs = session.connectedAt || session.requestedAt || null;
    const durationSeconds = startedAtMs ? Math.max(0, Math.round((endedAtMs - startedAtMs) / 1000)) : 0;
    const startedAt = startedAtMs ? Math.floor(startedAtMs / 1000) : null;
    const endedAt = Math.floor(endedAtMs / 1000);
    const direction = (() => {
      if (session.direction === CALL_SESSION_DIRECTION.INCOMING || session.direction === CALL_SESSION_DIRECTION.OUTGOING) {
        return session.direction;
      }
      const myAcct = getAccountDigest?.() || null;
      const callerAcct = session.initiatorAccountDigest || session.callerAccountDigest || null;
      if (callerAcct && (!myAcct || String(callerAcct).toUpperCase() !== String(myAcct).toUpperCase())) {
        return CALL_SESSION_DIRECTION.INCOMING;
      }
      return CALL_SESSION_DIRECTION.OUTGOING;
    })();
    const rawReason = detail.reason || session.lastError || '';
    const normalizedReason = typeof rawReason === 'string' ? rawReason : '';
    let outcome = CALL_LOG_OUTCOME.MISSED;
    if (durationSeconds > 0 && status === CALL_SESSION_STATUS.ENDED) {
      outcome = CALL_LOG_OUTCOME.SUCCESS;
    } else if (/cancel/i.test(normalizedReason)) {
      outcome = CALL_LOG_OUTCOME.CANCELLED;
    } else if (/reject/i.test(normalizedReason)) {
      outcome = CALL_LOG_OUTCOME.FAILED;
    } else if (status === CALL_SESSION_STATUS.FAILED && normalizedReason) {
      outcome = CALL_LOG_OUTCOME.FAILED;
    } else {
      outcome = CALL_LOG_OUTCOME.MISSED;
    }
    const messageId = crypto.randomUUID();
    const entry = {
      id: messageId,
      callId: session.callId || identifier,
      ts: endedAt,
      peerAccountDigest: peerDigest,
      peerDeviceId,
      direction,
      durationSeconds,
      outcome,
      reason: normalizedReason || null,
      startedAt,
      endedAt
    };
    const isOutgoing = direction === CALL_SESSION_DIRECTION.OUTGOING;
    const isActive = state.activePeerDigest === peerDigest
      && (!state.activePeerDeviceId || state.activePeerDeviceId === peerDeviceId);
    const exists = hasCallLog(entry.callId);
    const viewerMessage = createCallLogMessage(entry, { messageDirection: isOutgoing ? 'outgoing' : 'incoming' });
    let localMessage = null;
    if (isActive && !exists) {
      localMessage = { ...viewerMessage };
      localMessage.id = localMessage.id || entry.id;
      localMessage.messageId = localMessage.id;
      localMessage.localId = localMessage.id;
      localMessage.serverMessageId = null;
      localMessage.status = 'pending';
      localMessage.pending = true;
      localMessage.failureReason = null;
      localMessage.failureCode = null;
      localMessage.msgType = 'call-log';
      localMessage.direction = isOutgoing ? 'outgoing' : 'incoming';
      localMessage.ts = localMessage.ts || entry.ts;
      localMessage.conversationId = conversationId;
      const appended = timelineAppendUserMessage(conversationId, localMessage);
      if (appended) {
        try {
          console.info('[msg] ' + JSON.stringify({
            event: 'timeline:append',
            conversationId,
            messageId: localMessage.id,
            direction: localMessage.direction,
            msgType: 'call-log',
            ts: localMessage.ts || null
          }));
        } catch {
          /* ignore */
        }
      }
      refreshTimelineState(conversationId);
      updateMessagesUI({ scrollToEnd: outcome === CALL_LOG_OUTCOME.SUCCESS });
      trackCallLogPlaceholder(peerDigest, entry.callId, localMessage);
    }
    updateThreadsWithCallLogDisplay({
      peerAccountDigest: peerDigest,
      label: viewerMessage.text,
      ts: entry.ts,
      direction: isOutgoing ? 'outgoing' : 'incoming'
    });
    if (entry.id && !sentCallLogIds.has(entry.id) && !exists) {
      sentCallLogIds.add(entry.id);
      const logPayload = {
        conversationId,
        callId: entry.callId,
        messageId: entry.id,
        direction: entry.direction
      };
      sendDrCallLog({
        peerAccountDigest: peerDigest,
        peerDeviceId,
        callId: entry.callId,
        outcome,
        durationSeconds,
        direction: entry.direction,
        reason: normalizedReason || null,
        ts: entry.ts,
        startedAt,
        endedAt,
        conversation: { conversation_id: conversationId },
        messageId: entry.id
      }).then((res) => {
        const replacementInfo = getReplacementInfo(res);
        if (localMessage && replacementInfo) {
          applyCounterTooLowReplaced(localMessage);
          updateMessagesStatusUI();
          return;
        }
        if (localMessage && res?.queued) {
          updateMessagesStatusUI();
          return;
        }
        if (localMessage) {
          try {
            applyOutgoingSent(localMessage, res, localMessage.ts || entry.ts);
          } catch (err) {
            applyOutgoingFailure(localMessage, err, '通話記錄傳送失敗');
          }
          updateMessagesStatusUI();
        }
        try {
          console.info('[call] log:send ' + JSON.stringify({ ...logPayload, ok: true }));
        } catch {}
      }).catch((err) => {
        log({ callLogSendError: err?.message || err, peerAccountDigest: peerDigest, peerDeviceId });
        if (localMessage) {
          const replacementInfo = getReplacementInfo(err);
          if (replacementInfo) {
            applyCounterTooLowReplaced(localMessage);
            updateMessagesStatusUI();
          } else if (isCounterTooLowError(err)) {
            applyCounterTooLowReplaced(localMessage);
            updateMessagesStatusUI();
          } else {
            applyOutgoingFailure(localMessage, err, '通話記錄傳送失敗');
            updateMessagesStatusUI();
          }
        }
        try {
          console.info('[call] log:send ' + JSON.stringify({ ...logPayload, ok: false, reason: err?.message || err }));
        } catch {}
      });
    }
    releaseCallLogPlaceholder(peerDigest, entry.callId);
  }

  const showModalLoading = typeof modalOptions.showModalLoading === 'function' ? modalOptions.showModalLoading : null;
  const updateLoadingModal = typeof modalOptions.updateLoadingModal === 'function' ? modalOptions.updateLoadingModal : null;
  const openPreviewModal = typeof modalOptions.openModal === 'function' ? modalOptions.openModal : null;
  const closePreviewModal = typeof modalOptions.closeModal === 'function' ? modalOptions.closeModal : null;
  const setModalObjectUrl = typeof modalOptions.setModalObjectUrl === 'function' ? modalOptions.setModalObjectUrl : null;
  const showSecurityModal = typeof modalOptions.showSecurityModal === 'function' ? modalOptions.showSecurityModal : null;

  loadCallNetworkConfig().catch((err) => {
    log({ callNetworkConfigPrefetchFailed: err?.message || err });
  });

  if (typeof unsubscribeCallState === 'function') {
    unsubscribeCallState();
  }
  unsubscribeCallState = subscribeCallEvent(CALL_EVENT.STATE, handleCallStateEvent);

  for (const info of listSecureConversationStatuses()) {
    const key = normalizePeerKey(info?.peerAccountDigest);
    if (!key) continue;
    secureStatusCache.set(key, { status: info.status, error: info.error });
  }
  if (typeof unsubscribeSecureStatus === 'function') {
    unsubscribeSecureStatus();
  }
  unsubscribeSecureStatus = subscribeSecureConversation(handleSecureStatusEvent);

  function cacheSecureStatus(peerAccountDigest, status, error) {
    const key = normalizePeerKey(peerAccountDigest);
    if (!key) return null;
    const entry = {
      status: status || SECURE_CONVERSATION_STATUS.IDLE,
      error: error || null
    };
    secureStatusCache.set(key, entry);
    return entry;
  }

  function getCachedSecureStatus(peerAccountDigest) {
    const key = normalizePeerKey(peerAccountDigest);
    if (!key) return null;
    const cached = secureStatusCache.get(key);
    if (cached) return cached;
    const managerStatus = getSecureConversationStatus(key);
    if (!managerStatus) return null;
    return cacheSecureStatus(key, managerStatus.status, managerStatus.error);
  }

  function hideSecurityModal() {
    if (!activeSecurityModalPeer) return;
    closePreviewModal?.();
    activeSecurityModalPeer = null;
  }

  function updateSecurityModalForPeer(peerAccountDigest, statusInfo) {
    if (!showSecurityModal) return;
    const status = statusInfo?.status || null;
    const key = normalizePeerKey(peerAccountDigest);
    const state = getMessageState();
    const mkReady = !!getMkRaw();
    const vaultGateReady = !!(state.conversationToken && state.conversationId && mkReady);
    logSecureModalGateTrace({
      peerAccountDigest: key || null,
      conversationId: state.conversationId || null,
      hasToken: !!state.conversationToken,
      mkReady,
      vaultGateReady,
      status
    });
    const shouldShow = status === SECURE_CONVERSATION_STATUS.PENDING;
    if (shouldShow && vaultGateReady) {
      if (activeSecurityModalPeer === key) {
        hideSecurityModal();
      }
      return;
    }
    if (shouldShow) {
      if (activeSecurityModalPeer !== key) {
        showSecurityModal({
          title: '建立安全對話',
          message: '正在與好友建立安全對話，請稍候…'
        });
        activeSecurityModalPeer = key;
      }
      return;
    }
    if (activeSecurityModalPeer && activeSecurityModalPeer === key) {
      hideSecurityModal();
    } else if (activeSecurityModalPeer && !key) {
      hideSecurityModal();
    }
  }

  function applySecureStatusForActivePeer(peerAccountDigest, statusInfo) {
    const state = getMessageState();
    const key = normalizePeerKey(peerAccountDigest);
    if (state.activePeerDigest !== key) {
      if (!state.activePeerDigest) hideSecurityModal();
      return;
    }
    const status = statusInfo?.status || null;
    updateSecurityModalForPeer(key, statusInfo);
    if (status === SECURE_CONVERSATION_STATUS.PENDING) {
      setMessagesStatus('正在建立安全對話…');
    } else if (status === SECURE_CONVERSATION_STATUS.FAILED) {
      const msg = statusInfo?.error ? `建立安全對話失敗：${statusInfo.error}` : '建立安全對話失敗，請稍後再試。';
      setMessagesStatus(msg, true);
    } else if (status === SECURE_CONVERSATION_STATUS.READY) {
      setMessagesStatus('');
    } else {
      setMessagesStatus('');
    }
    updateComposerAvailability();
  }

  function handleSecureStatusEvent(event) {
    const key = normalizePeerKey(event?.peerAccountDigest);
    if (!key) return;
    const entry = cacheSecureStatus(key, event?.status, event?.error);
    if (!entry) return;
    const state = getMessageState();
    if (state.activePeerDigest === key) {
      applySecureStatusForActivePeer(key, entry);
      if (pendingSecureReadyPeer === key && entry.status === SECURE_CONVERSATION_STATUS.READY) {
        pendingSecureReadyPeer = null;
        setMessagesStatus('');
        updateComposerAvailability();
        loadActiveConversationMessages({ append: false, replay: false })
          .catch((err) => log({ secureReadyLoadError: err?.message || err }));
      }
    }
  }

  function isDesktopLayout() {
    if (typeof window === 'undefined') return true;
    return window.innerWidth >= 960;
  }

  function ensureConversationIndex() {
    if (!(sessionStore.conversationIndex instanceof Map)) {
      const entries = sessionStore.conversationIndex && typeof sessionStore.conversationIndex.entries === 'function'
        ? Array.from(sessionStore.conversationIndex.entries())
        : [];
      sessionStore.conversationIndex = new Map(entries);
    }
    if (!conversationIndexRestoredFromPending) {
      conversationIndexRestoredFromPending = true;
      const pendingInvites = restorePendingInvites();
      const nowSec = Math.floor(Date.now() / 1000);
      let restoredCount = 0;
      const sampleConversationIdsPrefix8 = [];
      if (pendingInvites instanceof Map) {
        for (const entry of pendingInvites.values()) {
          const expiresAt = Number(entry?.expiresAt || 0);
          if (!Number.isFinite(expiresAt) || expiresAt <= nowSec) continue;
          const conversationId = typeof entry?.conversationId === 'string' ? entry.conversationId.trim() : '';
          const conversationToken = typeof entry?.conversationToken === 'string' ? entry.conversationToken.trim() : '';
          if (!conversationId || !conversationToken) continue;
          const ownerAccountDigest = normalizeAccountDigest(entry?.ownerAccountDigest || null);
          const ownerDeviceId = normalizePeerDeviceId(entry?.ownerDeviceId || null);
          const prev = sessionStore.conversationIndex.get(conversationId) || {};
          const next = { ...prev };
          let changed = false;
          if (!prev.token_b64) {
            next.token_b64 = conversationToken;
            changed = true;
          }
          if (!prev.peerAccountDigest && ownerAccountDigest) {
            next.peerAccountDigest = ownerAccountDigest;
            changed = true;
          }
          if (!prev.peerDeviceId && ownerDeviceId) {
            next.peerDeviceId = ownerDeviceId;
            changed = true;
          }
          if (!changed) continue;
          sessionStore.conversationIndex.set(conversationId, next);
          restoredCount += 1;
          if (sampleConversationIdsPrefix8.length < 3) {
            sampleConversationIdsPrefix8.push(conversationId.slice(0, 8));
          }
        }
      }
      logCapped('conversationIndexRestoredFromPending', {
        restoredCount,
        sampleConversationIdsPrefix8,
        source: 'pendingInvites'
      }, 5);
    }
    return sessionStore.conversationIndex;
  }

  function getConversationThreads() {
    if (!(sessionStore.conversationThreads instanceof Map)) {
      const entries = sessionStore.conversationThreads && typeof sessionStore.conversationThreads.entries === 'function'
        ? Array.from(sessionStore.conversationThreads.entries())
        : [];
      sessionStore.conversationThreads = new Map(entries);
    }
    return sessionStore.conversationThreads;
  }

  function upsertConversationThread({ peerAccountDigest, peerDeviceId = null, conversationId, tokenB64, nickname, avatar }) {
    const key = normalizePeerKey(peerAccountDigest);
    const convId = String(conversationId || '').trim();
    if (!key || !convId) return null;
    if (sessionStore.deletedConversations?.has?.(convId)) return null;
    const threads = getConversationThreads();
    const prev = threads.get(convId) || {};
    const { digest: digestFromKey, deviceId: deviceFromKey } = splitPeerKey(key);
    const resolvedPeerDeviceId = normalizePeerDeviceId(peerDeviceId || deviceFromKey || prev.peerDeviceId || null);
    const resolvedToken = tokenB64 || prev.conversationToken || null;
    if (!resolvedPeerDeviceId || !resolvedToken) {
      try { log({ conversationThreadSkip: { convId, peerAccountDigest: key, reason: 'missing-core' } }); } catch {}
      return prev || null;
    }
    if (!digestFromKey) {
      logContactCoreWriteSkip({
        callsite: 'messages-pane:thread-upsert',
        conversationId: convId,
        hasDeviceId: !!resolvedPeerDeviceId
      });
      return prev || null;
    }
    upsertContactCore({
      peerAccountDigest: digestFromKey,
      peerDeviceId: resolvedPeerDeviceId,
      conversationId: convId,
      conversationToken: resolvedToken,
      nickname: nickname || null,
      avatar: avatar || null
    }, 'messages-pane:thread-upsert');
    const entry = {
      ...prev,
      peerAccountDigest: key,
      peerDeviceId: resolvedPeerDeviceId,
      conversationId: convId,
      conversationToken: resolvedToken,
      nickname: nickname || prev.nickname || null,
      avatar: avatar || prev.avatar || null,
      lastMessageText: typeof prev.lastMessageText === 'string' ? prev.lastMessageText : '',
      lastMessageTs: typeof prev.lastMessageTs === 'number' ? prev.lastMessageTs : null,
      lastMessageId: prev.lastMessageId || null,
      lastReadTs: typeof prev.lastReadTs === 'number' ? prev.lastReadTs : null,
      unreadCount: typeof prev.unreadCount === 'number' ? prev.unreadCount : 0,
      previewLoaded: !!prev.previewLoaded,
      needsRefresh: !!prev.needsRefresh
    };
    threads.set(convId, entry);
    return entry;
  }

  function resolveTargetDeviceForConv(conversationId, peerAccountDigest = null) {
    const convId = String(conversationId || '').trim();
    if (!convId) return null;
    const threads = getConversationThreads();
    const thread = threads.get(convId) || null;
    if (thread?.peerDeviceId) return thread.peerDeviceId;
    const convIndex = ensureConversationIndex();
    const convEntry = convIndex.get(convId) || null;
    if (convEntry?.peerDeviceId) return convEntry.peerDeviceId;
    if (convEntry?.peerAccountDigest && peerAccountDigest && convEntry.peerAccountDigest !== peerAccountDigest) {
      return null;
    }
    const state = getMessageState();
    if (state.activePeerDigest && (!peerAccountDigest || state.activePeerDigest === peerAccountDigest)) {
      if (state.activePeerDeviceId) return state.activePeerDeviceId;
    }
    return null;
  }

  function syncConversationThreadsFromContacts() {
    const threads = getConversationThreads();
    const contacts = Array.isArray(sessionStore.contactState) ? sessionStore.contactState : [];
    const seen = new Set();
    for (const contact of contacts) {
      const peerDigest = ensurePeerAccountDigest(contact);
      const conversationId = contact?.conversation?.conversation_id;
      const tokenB64 = contact?.conversation?.token_b64;
      const peerDeviceId = contact?.conversation?.peerDeviceId || null;
      if (!peerDigest || !conversationId || !tokenB64) continue;
      seen.add(conversationId);
      upsertConversationThread({
        peerAccountDigest: peerDigest,
        peerDeviceId,
        conversationId,
        tokenB64,
        nickname: contact.nickname,
        avatar: contact.avatar || null
      });
    }
    for (const convId of Array.from(threads.keys())) {
      if (!seen.has(convId)) threads.delete(convId);
    }
    return threads;
  }

  async function refreshConversationPreviews({ force = false } = {}) {
    const threadsMap = getConversationThreads();
    const threads = Array.from(threadsMap.values());
    const tasks = [];
    for (const thread of threads) {
      const peerDigest = threadPeer(thread);
      if (!thread?.conversationId || !thread?.conversationToken || !peerDigest || !thread?.peerDeviceId) {
        if (!thread?.peerDeviceId) {
          try { log({ previewSkipMissingPeerDevice: thread?.conversationId || null }); } catch {}
        }
        continue;
      }
      if (!force && thread.previewLoaded && !thread.needsRefresh) continue;
      tasks.push((async () => {
        try {
          logReplayCallsite('refreshConversationPreviews', {
            conversationId: thread.conversationId,
            replay: false,
            allowReplay: false,
            mutateState: false,
            silent: true,
            limit: 20,
            cursorTs: null,
            cursorId: null
          });
          logReplayGateTrace('messages-pane:listSecureAndDecrypt:refreshConversationPreviews', {
            conversationId: thread.conversationId,
            allowReplay: false,
            mutateState: false,
            replay: false,
            silent: true,
            messageId: null,
            serverMessageId: null
          });
          const previewResult = await listSecureAndDecrypt({
            conversationId: thread.conversationId,
            tokenB64: thread.conversationToken,
            peerAccountDigest: peerDigest,
            peerDeviceId: thread.peerDeviceId,
            limit: 20,
            mutateState: false,
            sendReadReceipt: false,
            onMessageDecrypted: null,
            silent: true
          });
          logReplayFetchResult({
            conversationId: thread.conversationId,
            itemsLength: Array.isArray(previewResult?.items) ? previewResult.items.length : null,
            serverItemCount: previewResult?.serverItemCount ?? null,
            nextCursorTs: previewResult?.nextCursor?.ts ?? previewResult?.nextCursorTs ?? null,
            nextCursorId: previewResult?.nextCursor?.id ?? null,
            errorsLength: Array.isArray(previewResult?.errors) ? previewResult.errors.length : null
          });
          const timeline = timelineGetTimeline(thread.conversationId);
          const list = Array.isArray(timeline) ? timeline : [];
          if (!list.length) {
            thread.lastMessageText = '';
            thread.lastMessageTs = null;
            thread.lastMessageId = null;
            thread.previewLoaded = true;
            thread.unreadCount = 0;
            if (thread.lastReadTs === null) thread.lastReadTs = null;
            thread.needsRefresh = false;
            return;
          }
          const latest = list[list.length - 1];
          thread.lastMessageText = typeof latest.text === 'string' && latest.text.trim() ? latest.text : (latest.error || '(無法解密)');
          thread.lastMessageTs = typeof latest.ts === 'number' ? latest.ts : null;
          thread.lastMessageId = latest.id || latest.messageId || null;
          thread.lastDirection = latest.direction || null;
          thread.previewLoaded = true;
          thread.needsRefresh = false;
          if (thread.lastReadTs === null || thread.lastReadTs === undefined) {
            thread.lastReadTs = thread.lastMessageTs ?? null;
            thread.unreadCount = 0;
          } else if (typeof thread.lastReadTs === 'number') {
            const unread = list.filter((item) => typeof item?.ts === 'number' && item.ts > thread.lastReadTs && item.direction === 'incoming').length;
            thread.unreadCount = unread;
          } else {
            thread.lastReadTs = thread.lastMessageTs ?? null;
            thread.unreadCount = 0;
          }
        } catch (err) {
          thread.previewLoaded = true;
          thread.lastMessageText = '(載入失敗)';
          log({ conversationPreviewError: err?.message || err, conversationId: thread?.conversationId });
        } finally {
          thread.needsRefresh = false;
        }
      })());
    }

    if (!tasks.length) {
      if (force) renderConversationList();
      return;
    }

    await Promise.allSettled(tasks);
    renderConversationList();
  }

  function applyConversationPullTransition(enable) {
    const transition = enable ? 'transform 120ms ease-out, opacity 120ms ease-out' : 'none';
    if (elements.conversationRefreshEl) {
      elements.conversationRefreshEl.style.transition = transition;
    }
    if (elements.conversationList) {
      elements.conversationList.style.transition = enable ? 'transform 120ms ease-out' : 'none';
    }
  }

  function updateConversationPull(offset) {
    const clamped = Math.min(CONV_PULL_MAX, Math.max(0, offset));
    const progress = Math.min(1, clamped / CONV_PULL_THRESHOLD);
    if (elements.conversationRefreshEl) {
      const fadeStart = 5;
      const fadeRange = 25;
      const alpha = Math.min(1, Math.max(0, (clamped - fadeStart) / fadeRange));
      elements.conversationRefreshEl.style.opacity = String(alpha);
      elements.conversationRefreshEl.style.transform = 'translateY(0)';
      const spinner = elements.conversationRefreshEl.querySelector('.icon');
      const labelEl = elements.conversationRefreshLabelEl || elements.conversationRefreshEl.querySelector('.label');
      if (spinner && labelEl) {
        if (conversationsRefreshing) {
          spinner.classList.add('spin');
          labelEl.textContent = '刷新中…';
        } else {
          spinner.classList.remove('spin');
          labelEl.textContent = clamped >= CONV_PULL_THRESHOLD ? '鬆開更新對話列表' : '下拉更新對話';
        }
      }
    }
    if (elements.conversationList) {
      elements.conversationList.style.transform = `translateY(${clamped}px)`;
    }
  }

  function resetConversationPull({ animate = true } = {}) {
    conversationPullDistance = 0;
    applyConversationPullTransition(animate);
    updateConversationPull(0);
  }

  async function handleConversationRefresh() {
    if (conversationsRefreshing) return;
    conversationsRefreshing = true;
    updateConversationPull(CONV_PULL_THRESHOLD);
    try {
      syncConversationThreadsFromContacts();
      await refreshConversationPreviews({ force: true });
      renderConversationList();
    } catch (err) {
      log({ conversationPullRefreshError: err?.message || err });
    } finally {
      conversationsRefreshing = false;
      resetConversationPull({ animate: true });
    }
  }

  function handleConversationPullStart(e) {
    if (!elements.conversationList) return;
    if (elements.conversationList.scrollTop > 0) {
      conversationPullInvalid = true;
      return;
    }
    conversationPullInvalid = false;
    if (e.touches?.length !== 1) return;
    conversationPullTracking = true;
    conversationPullDecided = false;
    conversationPullStartY = e.touches[0].clientY;
    conversationPullStartX = e.touches[0].clientX;
    conversationPullDistance = 0;
    applyConversationPullTransition(false);
  }

  function handleConversationPullMove(e) {
    if (!conversationPullTracking || conversationPullInvalid || conversationsRefreshing) return;
    if (e.touches?.length !== 1) return;
    const dy = e.touches[0].clientY - conversationPullStartY;
    const dx = Math.abs(e.touches[0].clientX - conversationPullStartX);
    if (!conversationPullDecided) {
      if (Math.abs(dy) < 8 && dx < 8) return;
      conversationPullDecided = true;
      if (dy <= 0 || dy < Math.abs(dx)) {
        conversationPullTracking = false;
        conversationPullInvalid = true;
        resetConversationPull({ animate: true });
        return;
      }
    }
    conversationPullDistance = dy;
    if (conversationPullDistance > 0) {
      e.preventDefault();
      updateConversationPull(conversationPullDistance);
    }
  }

  function handleConversationPullEnd() {
    if (!conversationPullTracking) return;
    conversationPullTracking = false;
    if (conversationsRefreshing) return;
    if (conversationPullInvalid) {
      resetConversationPull({ animate: true });
      return;
    }
    if (conversationPullDistance >= CONV_PULL_THRESHOLD) {
      handleConversationRefresh();
    } else {
      resetConversationPull({ animate: true });
    }
  }

  function syncThreadFromActiveMessages() {
    const state = getMessageState();
    if (!state.conversationId || !state.activePeerDigest) return;
    const timelineMessages = refreshTimelineState(state.conversationId);
    const contactEntry = sessionStore.contactIndex?.get?.(state.activePeerDigest) || null;
    const nickname = contactEntry?.nickname || `好友 ${state.activePeerDigest.slice(-4)}`;
    const avatar = contactEntry?.avatar || null;
    const tokenB64 = state.conversationToken || contactEntry?.conversation?.token_b64 || null;
    const thread = upsertConversationThread({
      peerAccountDigest: state.activePeerDigest,
      conversationId: state.conversationId,
      tokenB64,
      nickname,
      avatar
    });
    if (!thread) return;
    thread.previewLoaded = true;
    thread.needsRefresh = false;
    const latest = timelineMessages.length ? timelineMessages[timelineMessages.length - 1] : null;
    if (latest) {
      thread.lastMessageText = latest.text || latest.error || '';
      thread.lastMessageTs = latest.ts || null;
      thread.lastMessageId = latest.id || null;
      thread.lastDirection = latest.direction || thread.lastDirection || null;
      thread.lastReadTs = latest.ts || thread.lastReadTs || null;
      thread.unreadCount = 0;
    } else {
      thread.lastMessageText = '';
      thread.lastMessageTs = null;
      thread.lastMessageId = null;
      thread.lastDirection = null;
    }
    renderConversationList();
  }

  function initialsFromName(name, fallback) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return (fallback || '??').slice(0, 2).toUpperCase();
    const parts = trimmed.split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function formatTimestamp(ts) {
    if (!Number.isFinite(ts)) return '';
    try {
      const date = new Date(ts * 1000);
      const now = new Date();

      const startOfWeek = (input) => {
        const d = new Date(input);
        const day = d.getDay();
        const diff = (day + 6) % 7;
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() - diff);
        return d.getTime();
      };

      const sameWeek = startOfWeek(date) === startOfWeek(now);
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');

      if (sameWeek) {
        const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
        return `週${weekdays[date.getDay()]} ${hours}:${minutes}`;
      }

      const month = date.getMonth() + 1;
      const dayOfMonth = date.getDate();
      return `${month} 月 ${dayOfMonth} 號 ${hours}:${minutes}`;
    } catch {
      return '';
    }
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

  function formatConversationPreviewTime(ts) {
    if (!Number.isFinite(ts)) return '';
    try {
      const date = new Date(ts * 1000);
      const now = new Date();
      const sameDay = date.toDateString() === now.toDateString();
      if (sameDay) return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
      const sameYear = date.getFullYear() === now.getFullYear();
      if (sameYear) return `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;
      return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}`;
    } catch {
      return '';
    }
  }

  function buildConversationSnippet(text) {
    if (!text) return '';
    const cleaned = String(text).replace(/\s+/g, ' ').trim();
    if (!cleaned) return '';
    const MAX_LEN = 42;
    return cleaned.length > MAX_LEN ? `${cleaned.slice(0, MAX_LEN - 1)}…` : cleaned;
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
      if (!msg || msg.type !== 'call-log') return false;
      const mid = msg.id || msg.callId || msg.callLog?.callId || msg.meta?.call_id || null;
      return mid && mid === callId;
    });
  }

  function setMessagesStatus(message, isError = false) {
    if (!elements.statusLabel) return;
    elements.statusLabel.textContent = message || '';
    elements.statusLabel.style.color = isError ? '#dc2626' : '#64748b';
    if (pendingNewMessageHint && message !== '有新訊息') {
      pendingNewMessageHint = false;
    }
  }

  function updateConversationActionsAvailability() {
    const state = getMessageState();
    const enabled = !!(state.activePeerDigest && state.conversationToken && isSubscriptionActive());
    const buttons = [elements.callBtn, elements.videoBtn];
    for (const btn of buttons) {
      if (!btn) continue;
      btn.disabled = !enabled;
      btn.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    }
  }

  function updateComposerAvailability() {
    const state = getMessageState();
    if (!elements.input || !elements.sendBtn) {
      updateConversationActionsAvailability();
      return;
    }
    const subscriptionOk = isSubscriptionActive();
    const key = state.activePeerDigest ? String(state.activePeerDigest).toUpperCase() : null;
    const statusInfo = key ? getCachedSecureStatus(key) : null;
    const status = statusInfo?.status || null;
    const conversationReady = !!(state.conversationToken && state.activePeerDigest);
    const blocked = !subscriptionOk || status === SECURE_CONVERSATION_STATUS.PENDING || status === SECURE_CONVERSATION_STATUS.FAILED;
    const enabled = conversationReady && !blocked;
    elements.input.disabled = !conversationReady || blocked;
    elements.sendBtn.disabled = !conversationReady; // 仍允許過期時點擊觸發 modal
    elements.sendBtn.classList.toggle('disabled', !enabled);
    elements.sendBtn.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    let placeholder = '輸入訊息…';
    if (!state.conversationToken || !state.activePeerDigest) {
      placeholder = '選擇好友開始聊天';
    } else if (!subscriptionOk) {
      placeholder = '帳號已到期，請儲值後再聊天';
    } else if (status === SECURE_CONVERSATION_STATUS.PENDING) {
      placeholder = '正在建立安全對話…';
    } else if (status === SECURE_CONVERSATION_STATUS.FAILED) {
      placeholder = statusInfo?.error ? `安全對話失敗：${statusInfo.error}` : '安全對話建立失敗，請稍後再試。';
    }
    elements.input.placeholder = placeholder;
    updateConversationActionsAvailability();
  }

  function resolveContactAvatarUrl(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const candidates = [
      entry.avatarUrl,
      entry.avatar?.thumbDataUrl,
      entry.avatar?.previewDataUrl,
      entry.avatar?.url,
      entry.avatar?.httpsUrl,
      entry.profile?.avatarUrl,
      entry.profile?.avatar?.thumbUrl
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate;
      }
    }
    return null;
  }

  async function handleConversationAction(type) {
    const state = getMessageState();
    const preconditionMissing = [];
    if (!state.activePeerDigest) preconditionMissing.push('activePeerDigest');
    if (!state.conversationToken) preconditionMissing.push('conversationToken');
    if (preconditionMissing.length) {
      if (uiNoiseEnabled) {
        try { console.log('[call] ui:click-fail ' + JSON.stringify({ reason: 'missing-conversation', missing: preconditionMissing, conversationId: state.conversationId || null, hasConversationToken: !!state.conversationToken })); } catch {}
      }
      return;
    }
    const actionType = type === 'video' ? 'voice' : type; // 視訊暫時停用，強制走語音
    const contactEntry = sessionStore.contactIndex?.get?.(state.activePeerDigest) || null;
    const fallbackName = `好友 ${state.activePeerDigest.slice(-4)}`;
    const displayName = contactEntry?.nickname || contactEntry?.profile?.nickname || fallbackName;
    const avatarUrl = resolveContactAvatarUrl(contactEntry);
    const peerIdentity = normalizePeerIdentity({
      peerAccountDigest: state.activePeerDigest,
      peerDeviceId: state.activePeerDeviceId || contactEntry?.conversation?.peerDeviceId || contactEntry?.peerDeviceId || null
    });
    const peerAccountDigest = peerIdentity.accountDigest || null;
    const peerDeviceId = peerIdentity.deviceId || null;
    const missing = [];
    if (!peerAccountDigest) missing.push('peerAccountDigest');
    if (!peerDeviceId) missing.push('peerDeviceId');
    if (missing.length) {
      if (uiNoiseEnabled) {
        try { console.log('[call] ui:click-fail ' + JSON.stringify({ reason: 'missing-identity', missing, conversationId: state.conversationId || null, hasConversationToken: !!state.conversationToken })); } catch {}
      }
      if (!peerDeviceId) {
        showToast?.('缺少對端裝置資訊，請重新同步好友', { variant: 'warning' });
      } else {
        showToast?.('找不到通話對象', { variant: 'warning' });
      }
      return;
    }
    const { peerKey } = buildCallPeerIdentity({ peerAccountDigest, peerDeviceId });
    try {
      if (uiNoiseEnabled) {
        console.log('[call] ui:click ' + JSON.stringify({
          conversationId: state.conversationId || null,
          peerAccountDigest,
          peerDeviceId,
          peerKey,
          hasConversationToken: !!state.conversationToken
        }));
      }
    } catch {}
    if (!requireSubscriptionActive()) return;
    let result;
    try {
      result = await requestOutgoingCall({
        peerDisplayName: displayName,
        peerAvatarUrl: avatarUrl,
        peerAccountDigest,
        peerDeviceId,
        kind: actionType === 'video' ? CALL_REQUEST_KIND.VIDEO : CALL_REQUEST_KIND.VOICE
      });
    } catch (err) {
      result = { ok: false, error: err?.message || 'call invite failed' };
    }
    if (!result?.ok) {
      if (result?.error === 'CALL_ALREADY_IN_PROGRESS') {
        showToast?.('已有進行中的通話', { variant: 'warning' });
      } else if (result?.error === 'MISSING_PEER') {
        showToast?.('找不到通話對象', { variant: 'warning' });
      } else {
        showToast?.(result?.error || '暫時無法啟動通話', { variant: 'error' });
      }
      return;
    }
    const snapshot = getCallSessionSnapshot();
    const callId = result.callId || snapshot?.callId || null;
    if (!callId) {
      log({ callInviteSignalSkipped: true, reason: 'missing-call-id', peerAccountDigest: state.activePeerDigest });
      showToast?.('無法建立通話：缺少識別碼', { variant: 'error' });
      return;
    }
    let envelope;
    try {
      envelope = await prepareCallKeyEnvelope({
        callId,
        peerAccountDigest,
        peerDeviceId,
        direction: CALL_SESSION_DIRECTION.OUTGOING
      });
    } catch (err) {
      log({ callKeyEnvelopeError: err?.message || err, peerAccountDigest: state.activePeerDigest });
      showToast?.('無法建立通話加密金鑰', { variant: 'error' });
      return;
    }
    const traceId = snapshot?.traceId || result?.session?.metadata?.traceId || null;
    const capabilities = getCallCapability() || null;
    const callerSummary = getSelfProfileSummary() || {};
    const fallbackCallerName = (() => {
      const digest = getAccountDigest();
      return digest ? `好友 ${digest.slice(-4)}` : null;
    })();
    const callerDisplayName = callerSummary.displayName || fallbackCallerName || null;
    const callerAvatarUrl = callerSummary.avatarUrl || sessionStore.currentAvatarUrl || null;
    const metadata = {};
    if (callerDisplayName) {
      metadata.displayName = callerDisplayName;
      metadata.callerDisplayName = callerDisplayName;
    }
    if (callerAvatarUrl) {
      metadata.avatarUrl = callerAvatarUrl;
      metadata.callerAvatarUrl = callerAvatarUrl;
    }
    if (displayName) metadata.peerDisplayName = displayName;
    if (avatarUrl) metadata.peerAvatarUrl = avatarUrl;
    const sent = sendCallInviteSignal({
      callId,
      peerAccountDigest: peerAccountDigest || state.activePeerDigest,
      mode: actionType === 'video' ? 'video' : 'voice',
      metadata,
      capabilities,
      envelope,
      traceId
    });
    if (!sent) {
      log({ callInviteSignalFailed: true, callId, peerAccountDigest: state.activePeerDigest });
      showToast?.('通話信令傳送失敗', { variant: 'error' });
      return;
    }
    try {
      await startOutgoingCallMedia({ callId, peerAccountDigest: state.activePeerDigest });
    } catch (err) {
      log({ callMediaStartError: err?.message || err });
      showToast?.('無法啟動通話媒體：' + (err?.message || err), { variant: 'error' });
    }
    showToast?.('已發起語音通話', { variant: 'success' });
  }

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
    const enabled = !!(state.conversationId && state.conversationToken && state.hasMore && !state.loading);
    setLoadMoreState(enabled ? 'idle' : 'hidden');
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
    if (top <= 0) {
      triggerAutoLoadOlder();
    } else if (top <= 40) {
      setLoadMoreState('armed');
    } else {
      setLoadMoreState('idle');
    }
    if (atBottom) {
      setNewMessageHint(false);
    }
  }

  function handleMessagesTouchEnd() {
    if (!elements.scrollEl) return;
    if (!suppressInputBlurOnce && elements.input && document.activeElement === elements.input && !isNearMessagesBottom()) {
      elements.input.blur();
    }
    if (elements.scrollEl.scrollTop <= 0) {
      triggerAutoLoadOlder();
    }
  }

  function handleMessagesWheel() {
    if (!elements.scrollEl) return;
    if (!suppressInputBlurOnce && elements.input && document.activeElement === elements.input && !isNearMessagesBottom()) {
      elements.input.blur();
    }
    if (elements.scrollEl.scrollTop <= 0) {
      triggerAutoLoadOlder();
    }
  }

  function triggerAutoLoadOlder() {
    const state = getMessageState();
    if (!elements.scrollEl || !state.hasMore || state.loading || autoLoadOlderInProgress) return;
    autoLoadOlderInProgress = true;
    setLoadMoreState('loading');
    loadActiveConversationMessages({ append: true, reason: 'scroll' })
      .catch((err) => log({ loadOlderError: err?.message || err }))
      .finally(() => {
        autoLoadOlderInProgress = false;
        const nextState = state.hasMore ? 'idle' : 'hidden';
        setLoadMoreState(nextState);
      });
  }

  function scrollMessagesToBottom() {
    if (!elements.scrollEl) return;
    elements.scrollEl.scrollTop = elements.scrollEl.scrollHeight;
  }

  function scrollMessagesToBottomSoon() {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => scrollMessagesToBottom());
    } else {
      setTimeout(() => scrollMessagesToBottom(), 0);
    }
  }

  function applyKeyboardOffset() {
    const kbOffset = Math.max(0, Math.min(360, Math.floor(keyboardOffsetPx)));
    keyboardActive = kbOffset > 120;
    document.documentElement.style.setProperty('--kb-offset', `${kbOffset}px`);
    try {
      document.body.classList.toggle('keyboard-open', keyboardActive);
    } catch {}
    if (keyboardActive && elements.scrollEl) {
      // 確保 header 在可視範圍頂部，並避免被拖動
      elements.scrollEl.scrollTop = elements.scrollEl.scrollHeight;
    }
  }

  function startViewportGuard() {
    if (viewportGuardTimer) return;
    const tick = () => {
      applyKeyboardOffset();
      if (elements.headerEl) {
        elements.headerEl.style.transform = 'translateY(0)';
        elements.headerEl.style.top = '0';
      }
      if (elements.composer) {
        elements.composer.style.transform = 'translateY(0)';
        elements.composer.style.bottom = 'env(safe-area-inset-bottom)';
      }
    };
    viewportGuardTimer = setInterval(tick, 100);
    tick();
  }

  function updateMessagesScrollOverflow() {
    const scroller = elements.scrollEl;
    if (!scroller) return;
    scroller.style.overflowY = 'auto';
  }

  function renderConversationList() {
    if (!elements.conversationList) return;
    const openPeer = elements.conversationList.querySelector('.conversation-item.show-delete')?.dataset?.peer || null;
    const contacts = Array.isArray(sessionStore.contactState) ? [...sessionStore.contactState] : [];
    let state = getMessageState();
    if (state.activePeerDigest) {
      const exists = contacts.some((c) => contactPeerKey(c) === state.activePeerDigest);
      if (!exists) {
        const { digest: activeDigest, deviceId: activeDeviceId } = splitPeerKey(state.activePeerDigest || null);
        const hasActiveConversation = !!(state.conversationId && state.conversationToken);
        const isViewingMessages = isDesktopLayout() || state.viewMode === 'detail';
        const activationInFlight = state.loading || pendingSecureReadyPeer === state.activePeerDigest;
        logConversationResetTrace({
          reason: 'ACTIVE_PEER_REMOVED',
          conversationId: state?.conversationId || null,
          peerKey: state?.activePeerDigest || null,
          peerDigest: activeDigest || state?.activePeerDigest || null,
          peerDeviceId: activeDeviceId || state?.activePeerDeviceId || null,
          hasToken: !!state?.conversationToken,
          hasConversationId: !!state?.conversationId,
          'entry.isReady': null,
          sourceTag: 'messages-pane:renderConversationList',
          deferred: hasActiveConversation && (isViewingMessages || activationInFlight)
        });
        if (!hasActiveConversation || (!isViewingMessages && !activationInFlight)) {
          resetMessageStateWithPlaceholders();
          state = getMessageState();
          if (!isDesktopLayout()) state.viewMode = 'list';
          if (elements.peerName) elements.peerName.textContent = '選擇好友開始聊天';
          setMessagesStatus('');
          clearMessagesView();
          updateComposerAvailability();
          applyMessagesLayout();
        }
      }
    }
    syncConversationThreadsFromContacts();
    refreshContactsUnreadBadges();
    elements.conversationList.innerHTML = '';
    const threadEntries = Array.from(getConversationThreads().values())
      .filter((thread) => thread?.conversationId && threadPeer(thread))
      .sort((a, b) => (b.lastMessageTs || 0) - (a.lastMessageTs || 0));
    const totalUnread = threadEntries.reduce((sum, thread) => sum + Number(thread.unreadCount || 0), 0);
    updateNavBadge?.('messages', totalUnread > 0 ? totalUnread : null);
    if (!threadEntries.length) {
      const li = document.createElement('li');
      li.className = 'conversation-item disabled';
      li.innerHTML = `<div class="conversation-empty">尚未有任何訊息</div>`;
      elements.conversationList.appendChild(li);
      return;
    }
    for (const thread of threadEntries) {
      const peerDigest = threadPeer(thread);
      if (!peerDigest) continue;
      const li = document.createElement('li');
      li.className = 'conversation-item';
      li.dataset.peer = peerDigest;
      li.dataset.conversationId = thread.conversationId;
      if (thread.peerDeviceId) li.dataset.peerDeviceId = thread.peerDeviceId;
      const isActivePeer = state.activePeerDigest === peerDigest;
      const isActiveDevice = !state.activePeerDeviceId || !thread.peerDeviceId || state.activePeerDeviceId === thread.peerDeviceId;
      if (isActivePeer && isActiveDevice) li.classList.add('active');
      if (openPeer && openPeer === peerDigest) li.classList.add('show-delete');
      const nickname = thread.nickname || `好友 ${peerDigest.slice(-4)}`;
      const initials = initialsFromName(nickname, peerDigest);
      const avatarSrc = thread.avatar?.thumbDataUrl || thread.avatar?.previewDataUrl || thread.avatar?.url || null;
      const timeLabel = Number.isFinite(thread.lastMessageTs) ? formatConversationPreviewTime(thread.lastMessageTs) : '';
      const snippet = formatThreadPreview(thread);
      const unread = Number.isFinite(thread.unreadCount) ? thread.unreadCount : 0;

      li.innerHTML = `
        <div class="item-content conversation-item-content">
          <div class="conversation-avatar">${avatarSrc ? `<img src="${escapeHtml(avatarSrc)}" alt="${escapeHtml(nickname)}" />` : `<span>${escapeHtml(initials)}</span>`}</div>
          <div class="conversation-content">
            <div class="conversation-row conversation-row-top">
              <span class="conversation-name">${escapeHtml(nickname)}</span>
              <span class="conversation-time">${escapeHtml(timeLabel)}</span>
            </div>
            <div class="conversation-row conversation-row-bottom">
              <span class="conversation-snippet">${escapeHtml(snippet || '尚無訊息')}</span>
              ${unread > 0 ? `<span class="conversation-badge conversation-badge-small">${escapeHtml(unread > 99 ? '99+' : String(unread))}</span>` : ''}
            </div>
          </div>
        </div>
        <div class="conversation-delete-row">
          <button type="button" class="item-delete" aria-label="刪除對話"><i class='bx bx-trash'></i></button>
        </div>
      `;
      const deleteBtn = li.querySelector('.item-delete');
      deleteBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleConversationDelete({ conversationId: thread.conversationId, peerAccountDigest: peerDigest, element: li });
      });

      li.addEventListener('click', (e) => {
        if (e.target.closest('.item-delete')) return;
        if (li.classList.contains('show-delete')) { closeSwipe?.(li); return; }
        setActiveConversation(peerDigest);
      });

      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActiveConversation(peerDigest); }
        if (e.key === 'Delete') {
          e.preventDefault();
          handleConversationDelete({ conversationId: thread.conversationId, peerAccountDigest: peerDigest, element: li });
        }
      });

      setupSwipe?.(li);
      elements.conversationList.appendChild(li);
    }
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
    elements.messagesEmpty?.classList.remove('hidden');
    updateLoadMoreVisibility();
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
    const display = Number(value.toFixed(precision));
    return `${display} ${units[unitIndex]}`;
  }

  function formatFileMeta(media) {
    const parts = [];
    if (Number.isFinite(media?.size)) parts.push(formatBytes(media.size));
    if (media?.contentType) parts.push(media.contentType);
    return parts.join(' · ');
  }

  const toast = typeof showToast === 'function' ? showToast : null;

  function canPreviewMedia(media) {
    if (!media || typeof media !== 'object') return false;
    if (media.previewUrl) return true;
    if (media.preview?.localUrl) return true;
    if (media.preview?.objectKey && media.preview?.envelope) return true;
    if (media.localUrl) return true;
    if (media.objectKey && media.envelope) return true;
    return false;
  }

  async function renderPdfThumbnail(media, canvas) {
    if (!canvas) return;
    canvas.dataset.previewState = 'loading';
    try {
      let buffer = null;
      const directUrl = media?.previewUrl || media?.preview?.localUrl || media?.localUrl || null;
      if (directUrl) {
        const res = await fetch(directUrl);
        if (!res.ok) throw new Error('preview fetch failed');
        buffer = await res.arrayBuffer();
      } else if (media?.objectKey && media?.envelope) {
        const { blob } = await downloadAndDecrypt({
          key: media.objectKey,
          envelope: media.envelope,
          messageKeyB64: media.messageKey_b64 || media.message_key_b64 || null
        });
        buffer = await blob.arrayBuffer();
      } else {
        canvas.dataset.previewState = 'error';
        return;
      }
      const pdfjsLib = await getPdfJsLibrary();
      const doc = await pdfjsLib.getDocument({ data: buffer }).promise;
      const page = await doc.getPage(1);
      const viewport = page.getViewport({ scale: 1 });
      const targetWidth = 220;
      const scale = Math.min(3, Math.max(0.5, targetWidth / viewport.width));
      const vp = page.getViewport({ scale });
      canvas.width = vp.width;
      canvas.height = vp.height;
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      canvas.dataset.previewState = 'ready';
      try { doc.cleanup?.(); doc.destroy?.(); } catch {}
    } catch (err) {
      canvas.dataset.previewState = 'error';
      log({ pdfThumbError: err?.message || err });
    }
  }

  async function openMediaPreview(media) {
    if (!canPreviewMedia(media)) {
      toast?.('無法預覽附件：缺少封套或檔案資訊。');
      return;
    }
    if (!showModalLoading || !openPreviewModal || !setModalObjectUrl) {
      toast?.('預覽模組尚未就緒，請稍後再試。');
      return;
    }
    const displayName = media.name || '附件';
    try {
      let result = null;
      if (media.objectKey && media.envelope) {
        showModalLoading('下載加密檔案中…');
        result = await downloadAndDecrypt({
          key: media.objectKey,
          envelope: media.envelope,
          messageKeyB64: media.messageKey_b64 || media.message_key_b64 || null,
          onStatus: ({ stage, loaded, total }) => {
            if (!updateLoadingModal) return;
            if (stage === 'sign') {
              updateLoadingModal({ percent: 5, text: '取得下載授權中…' });
            } else if (stage === 'download-start') {
              updateLoadingModal({ percent: 10, text: '下載加密檔案中…' });
            } else if (stage === 'download') {
              const pct = total && total > 0 ? Math.round((loaded / total) * 100) : null;
              const percent = pct != null ? Math.min(95, Math.max(15, pct)) : 45;
              const text = pct != null
                ? `下載加密檔案中… ${pct}% (${fmtSize(loaded)} / ${fmtSize(total)})`
                : `下載加密檔案中… (${fmtSize(loaded)})`;
              updateLoadingModal({ percent, text });
            } else if (stage === 'decrypt') {
              updateLoadingModal({ percent: 98, text: '解密檔案中…' });
            }
          }
        });
      } else {
        showModalLoading(`準備 ${displayName}…`);
        const response = await fetch(media.localUrl);
        if (!response.ok) throw new Error('讀取本機預覽失敗');
        const blob = await response.blob();
        result = {
          blob,
          contentType: media.contentType || blob.type || 'application/octet-stream',
          name: displayName
        };
      }
      await renderMediaPreviewModal({
        blob: result.blob,
        contentType: result.contentType || media.contentType || 'application/octet-stream',
        name: result.name || displayName
      });
    } catch (err) {
      closePreviewModal?.();
      toast?.(`附件預覽失敗：${err?.message || err}`);
    }
  }

  async function renderMediaPreviewModal({ blob, contentType, name }) {
    const modalEl = document.getElementById('modal');
    const body = document.getElementById('modalBody');
    const title = document.getElementById('modalTitle');
    if (!modalEl || !body || !title) {
      closePreviewModal?.();
      toast?.('無法顯示附件預覽');
      return;
    }
    cleanupPdfViewer();
    modalEl.classList.remove(
      'loading-modal',
      'progress-modal',
      'folder-modal',
      'upload-modal',
      'confirm-modal',
      'nickname-modal',
      'avatar-modal',
      'avatar-preview-modal',
      'settings-modal'
    );

    body.innerHTML = '';
    const resolvedName = name || '附件';
    title.textContent = resolvedName;
    title.setAttribute('title', resolvedName);

    const url = URL.createObjectURL(blob);
    setModalObjectUrl?.(url);

    const downloadBtn = document.getElementById('modalDownload');
    if (downloadBtn) {
      downloadBtn.style.display = 'none';
      downloadBtn.onclick = null;
    }

    const container = document.createElement('div');
    container.className = 'preview-wrap';
    const wrap = document.createElement('div');
    wrap.className = 'viewer';
    container.appendChild(wrap);
    body.appendChild(container);

    const ct = (contentType || '').toLowerCase();
    if (ct === 'application/pdf' || ct.startsWith('application/pdf')) {
      const handled = await renderPdfViewer({
        url,
        name: resolvedName,
        modalApi: { openModal: openPreviewModal, closeModal: closePreviewModal, showConfirmModal }
      });
      if (handled) return;
      const msg = document.createElement('div');
      msg.className = 'preview-message';
      msg.innerHTML = `PDF 無法內嵌預覽，將直接下載。<br/><br/><a class="primary" href="${url}" download="${escapeHtml(resolvedName)}">下載檔案</a>`;
      wrap.appendChild(msg);
    } else if (ct.startsWith('image/')) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = resolvedName;
      wrap.appendChild(img);
    } else if (ct.startsWith('video/')) {
      const video = document.createElement('video');
      video.src = url;
      video.controls = true;
      video.playsInline = true;
      wrap.appendChild(video);
    } else if (ct.startsWith('audio/')) {
      const audio = document.createElement('audio');
      audio.src = url;
      audio.controls = true;
      wrap.appendChild(audio);
    } else if (ct.startsWith('text/')) {
      try {
        const textContent = await blob.text();
        const pre = document.createElement('pre');
        pre.textContent = textContent;
        wrap.appendChild(pre);
      } catch {
        const msg = document.createElement('div');
        msg.className = 'preview-message';
        msg.textContent = '無法顯示文字內容。';
        wrap.appendChild(msg);
      }
    } else {
      const message = document.createElement('div');
      message.style.textAlign = 'center';
      message.innerHTML = `無法預覽此類型（${escapeHtml(contentType || '未知')}）。<br/><br/>`;
      const link = document.createElement('a');
      link.href = url;
      link.download = resolvedName;
      link.textContent = '下載檔案';
      link.className = 'primary';
      message.appendChild(link);
      wrap.appendChild(message);
    }

    openPreviewModal?.();
  }

  function enableMediaPreviewInteraction(container, media) {
    if (!container || !canPreviewMedia(media)) return;
    container.classList.add('message-file-clickable');
    container.setAttribute('role', 'button');
    container.setAttribute('tabindex', '0');
    const handler = (event) => {
      event.preventDefault();
      event.stopPropagation();
      openMediaPreview(media);
    };
    container.addEventListener('click', handler);
    container.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        handler(event);
      }
    });
  }

  async function ensureMediaPreviewUrl(media) {
    if (!media) return null;
    if (media.previewUrl) return media.previewUrl;
    if (media.preview?.localUrl) {
      media.previewUrl = media.preview.localUrl;
      return media.previewUrl;
    }
    if (media.localUrl) {
      media.previewUrl = media.localUrl;
      return media.previewUrl;
    }
    const preferPreview = media.preview?.objectKey && media.preview?.envelope;
    const targetKey = preferPreview ? media.preview.objectKey : media.objectKey;
    const targetEnvelope = preferPreview ? media.preview.envelope : media.envelope;
    const targetMessageKey = media.messageKey_b64 || media.message_key_b64 || null;
    if (!targetKey || !targetEnvelope) return null;
    if (media.previewPromise) return media.previewPromise;
    media.previewPromise = downloadAndDecrypt({
      key: targetKey,
      envelope: targetEnvelope,
      messageKeyB64: targetMessageKey
    })
      .then((result) => {
        if (!result || !result.blob) return null;
        const url = URL.createObjectURL(result.blob);
        media.previewUrl = url;
        if (preferPreview && media.preview) {
          if (!media.preview.contentType && result.contentType) {
            media.preview.contentType = result.contentType;
          }
        } else if (!preferPreview && !media.contentType && result.contentType) {
          media.contentType = result.contentType;
        }
        return url;
      })
      .catch((err) => {
        log({ mediaPreviewError: err?.message || err, objectKey: targetKey });
        return null;
      })
      .finally(() => {
        media.previewPromise = null;
      });
    return media.previewPromise;
  }

  function setPreviewSource(el, media) {
    if (!el || !media) return;
    const apply = (url) => {
      if (!url || typeof el.src !== 'string') return;
      el.src = url;
      if (el.tagName === 'VIDEO') {
        try { el.load(); } catch {}
      }
    };
    if (media.previewUrl) {
      apply(media.previewUrl);
      return;
    }
    if (media.localUrl) {
      media.previewUrl = media.localUrl;
      apply(media.previewUrl);
      return;
    }
    const hasRemotePreview = (media.preview?.objectKey && media.preview?.envelope) || (media.objectKey && media.envelope);
    if (!hasRemotePreview) return;
    ensureMediaPreviewUrl(media).then((url) => {
      if (url && typeof el.src === 'string' && !el.src) apply(url);
    }).catch(() => {});
  }

  function attachMediaPreview(container, media) {
    const type = (media?.contentType || '').toLowerCase();
    const previewType = (media?.preview?.contentType || '').toLowerCase();
    const hasPreviewImage = previewType.startsWith('image/') || (!!media?.preview && (!!media.preview.objectKey || !!media.preview.localUrl));
    const nameLower = (media?.name || '').toLowerCase();
    container.innerHTML = '';
    container.classList.add('message-file-preview');
    if (hasPreviewImage || type.startsWith('image/')) {
      const img = document.createElement('img');
      img.className = 'message-file-preview-image';
      img.alt = media?.name || 'image preview';
      img.decoding = 'async';
      container.appendChild(img);
      setPreviewSource(img, media);
    } else if (type.startsWith('video/')) {
      const video = document.createElement('video');
      video.className = 'message-file-preview-video';
      video.controls = true;
      video.muted = true;
      video.playsInline = true;
      video.preload = 'metadata';
      container.appendChild(video);
      setPreviewSource(video, media);
    } else if (type === 'application/pdf' || nameLower.endsWith('.pdf')) {
      const pdf = document.createElement('canvas');
      pdf.className = 'message-file-preview-pdf';
      pdf.setAttribute('aria-label', media?.name || 'PDF 預覽');
      pdf.dataset.previewState = 'loading';
      container.appendChild(pdf);
      renderPdfThumbnail(media, pdf);
    } else {
      const generic = document.createElement('div');
      generic.className = 'message-file-preview-generic';
      generic.textContent = '檔案';
      container.appendChild(generic);
    }
  }

  function renderUploadOverlay(wrapper, media) {
    if (!wrapper || !media) return;
    const target = wrapper.querySelector?.('.message-file-preview');
    if (!target) return;
    target.style.position = 'relative';
    const existing = target.querySelector('.message-file-overlay');
    const shouldShow = media.uploading || (Number.isFinite(media.progress) && media.progress < 100) || media.error;
    if (!shouldShow) {
      if (existing) existing.remove();
      return;
    }
    const overlay = existing || document.createElement('div');
    overlay.className = 'message-file-overlay';
    Object.assign(overlay.style, {
      position: 'absolute',
      inset: '0',
      background: media.error ? 'rgba(239,68,68,0.82)' : 'rgba(15,23,42,0.75)',
      color: '#fff',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '8px',
      borderRadius: '12px',
      pointerEvents: 'none',
      padding: '10px',
      textAlign: 'center'
    });
    const pct = Number.isFinite(media.progress) ? Math.min(100, Math.max(0, Math.round(media.progress))) : null;
    overlay.innerHTML = '';
    overlay.style.borderRadius = getComputedStyle(target).borderRadius || '12px';
    overlay.style.pointerEvents = 'auto';
    if (media.error) {
      const label = document.createElement('div');
      label.textContent = '上傳失敗';
      label.style.fontWeight = '600';
      overlay.appendChild(label);
      const detail = document.createElement('div');
      detail.textContent = String(media.error || '').slice(0, 80) || '請稍後再試';
      detail.style.fontSize = '12px';
      detail.style.opacity = '0.9';
      overlay.appendChild(detail);
    } else {
      const label = document.createElement('div');
      label.textContent = pct != null ? `上傳中… ${pct}%` : '準備上傳…';
      label.style.fontWeight = '600';
      overlay.appendChild(label);
      const barWrap = document.createElement('div');
      barWrap.style.width = '80%';
      barWrap.style.height = '6px';
      barWrap.style.borderRadius = '999px';
      barWrap.style.background = 'rgba(255,255,255,0.25)';
      const bar = document.createElement('div');
      bar.style.height = '100%';
      bar.style.borderRadius = '999px';
      bar.style.background = '#22d3ee';
      bar.style.width = `${pct != null ? pct : 10}%`;
      barWrap.appendChild(bar);
      overlay.appendChild(barWrap);
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.textContent = '取消上傳';
      cancelBtn.className = 'upload-cancel-btn';
      Object.assign(cancelBtn.style, {
        background: 'rgba(0,0,0,0.55)',
        color: '#fff',
        border: '1px solid rgba(255,255,255,0.35)',
        padding: '8px 12px',
        borderRadius: '10px',
        cursor: 'pointer',
        fontSize: '13px'
      });
      overlay.appendChild(cancelBtn);
      cancelBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const bubble = overlay.closest('.message-bubble');
        const msgId = bubble?.dataset?.messageId;
        if (msgId) {
          const msg = findMessageById(msgId);
          if (msg?.abortController) {
            try { msg.abortController.abort(); } catch {}
          }
          removeLocalMessageById(msgId);
        }
      });
    }
    if (!existing) target.appendChild(overlay);
  }

  function renderMediaBubble(bubble, msg) {
    const media = msg.media || {};
    bubble.classList.add('message-has-media');
    bubble.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.className = 'message-file';
    const preview = document.createElement('div');
    const info = document.createElement('div');
    info.className = 'message-file-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'message-file-name';
    nameEl.textContent = media.name || '附件';
    const metaEl = document.createElement('div');
    metaEl.className = 'message-file-meta';
    metaEl.textContent = formatFileMeta(media);
    info.appendChild(nameEl);
    info.appendChild(metaEl);
    wrapper.appendChild(preview);
    wrapper.appendChild(info);
    enableMediaPreviewInteraction(wrapper, media);
    bubble.appendChild(wrapper);
    attachMediaPreview(preview, media);
    renderUploadOverlay(wrapper, media);
  }

  function normalizeTimelineMessageId(msg) {
    if (!msg) return null;
    const id = msg.id || msg.messageId || msg.serverMessageId || msg.server_message_id || null;
    return typeof id === 'string' && id.trim() ? id.trim() : null;
  }

  function normalizeRawMessageId(raw) {
    if (!raw) return null;
    const candidates = [raw.id, raw.message_id, raw.messageId];
    for (const val of candidates) {
      if (typeof val === 'string' && val.trim()) return val.trim();
    }
    return null;
  }

  function extractMessageTimestamp(raw) {
    if (!raw) return null;
    const candidates = [raw.created_at, raw.createdAt, raw.ts, raw.timestamp, raw.meta?.ts];
    for (const val of candidates) {
      const n = Number(val);
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
    return null;
  }

  function sortMessagesByTimelineLocal(items = []) {
    if (!Array.isArray(items) || items.length <= 1) return Array.isArray(items) ? items : [];
    const enriched = items.map((item) => ({
      raw: item,
      ts: extractMessageTimestamp(item),
      id: normalizeRawMessageId(item)
    }));
    enriched.sort((a, b) => {
      const aHasTs = Number.isFinite(a.ts);
      const bHasTs = Number.isFinite(b.ts);
      if (aHasTs && bHasTs && a.ts !== b.ts) return a.ts - b.ts;
      if (aHasTs && !bHasTs) return 1;
      if (!aHasTs && bHasTs) return -1;
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

  function captureScrollAnchor() {
    if (!elements.scrollEl || !elements.messagesList) return null;
    const scroller = elements.scrollEl;
    const scrollTop = scroller.scrollTop;
    const scrollTopPx = scroller.getBoundingClientRect().top;
    const bubbles = elements.messagesList.querySelectorAll('.message-bubble[data-message-id]');
    for (const bubble of bubbles) {
      const rect = bubble.getBoundingClientRect();
      const offset = rect.top - scrollTopPx + scrollTop;
      const bottom = offset + rect.height;
      if (bottom >= scrollTop) {
        const id = bubble.dataset.messageId || null;
        if (id) return { id, top: offset };
      }
    }
    return null;
  }

  function restoreScrollFromAnchor(anchor) {
    if (!anchor || !elements.scrollEl || !elements.messagesList) return;
    const selector = `.message-bubble[data-message-id="${escapeSelector(anchor.id)}"]`;
    const bubble = elements.messagesList.querySelector(selector);
    if (!bubble) return;
    const scroller = elements.scrollEl;
    const scrollTop = scroller.scrollTop;
    const scrollTopPx = scroller.getBoundingClientRect().top;
    const rect = bubble.getBoundingClientRect();
    const offset = rect.top - scrollTopPx + scrollTop;
    const delta = offset - anchor.top;
    if (delta !== 0) {
      scroller.scrollTop = Math.max(0, scrollTop + delta);
    }
  }

  function setNewMessageHint(active) {
    if (!elements.statusLabel) return;
    if (active) {
      if (pendingNewMessageHint) return;
      if (elements.statusLabel.textContent && elements.statusLabel.textContent.trim() && elements.statusLabel.textContent !== '有新訊息') return;
      elements.statusLabel.textContent = '有新訊息';
      elements.statusLabel.style.color = '#64748b';
      pendingNewMessageHint = true;
    } else if (pendingNewMessageHint) {
      if (elements.statusLabel.textContent === '有新訊息') {
        elements.statusLabel.textContent = '';
      }
      pendingNewMessageHint = false;
    }
  }

  function updateMessagesUI({ scrollToEnd = false, preserveScroll = false, newMessageIds = null, forceFullRender = false } = {}) {
    if (!elements.messagesList) return;
    const state = getMessageState();
    const appendedIds = [];
    const timelineMessages = refreshTimelineState(state.conversationId);
    const timelineIds = timelineMessages.map((m) => normalizeTimelineMessageId(m));
    const anchorNeeded = preserveScroll || (!scrollToEnd && !isNearMessagesBottom());
    const anchor = anchorNeeded ? captureScrollAnchor() : null;

    if (uiNoiseEnabled) {
      try {
        console.info('[msg] ' + JSON.stringify({
          event: 'ui:render',
          conversationId: state.conversationId || null,
          itemCount: timelineMessages.length
        }));
      } catch {
        /* ignore */
      }
      try {
        logMsgEvent('ui:list', {
          stage: 'ui',
          conversationId: state.conversationId || null,
          itemCount: timelineMessages.length,
          ids: timelineMessages.slice(0, 5).map((m) => (m && (m.id || m.messageId || m.serverMessageId || null))),
          peerDigest: state.activePeerDigest || null,
          peerDeviceId: state.activePeerDeviceId || null
        });
      } catch {}
    }

    if (!timelineMessages.length) {
      elements.messagesList.innerHTML = '';
      elements.messagesEmpty?.classList.remove('hidden');
      renderState.renderedIds = [];
      renderState.conversationId = state.conversationId || null;
      updateLoadMoreVisibility();
      updateMessagesScrollOverflow();
      if (!scrollToEnd && anchor) restoreScrollFromAnchor(anchor);
      return;
    }

    elements.messagesEmpty?.classList.add('hidden');
    const convChanged = renderState.conversationId !== state.conversationId;
    const prefixMatches = !convChanged && renderState.renderedIds.length > 0
      ? renderState.renderedIds.every((id, idx) => id === timelineIds[idx])
      : false;
    const canAppend = !forceFullRender && prefixMatches && renderState.renderedIds.length <= timelineMessages.length;
    const startIndex = canAppend ? renderState.renderedIds.length : 0;
    if (!canAppend) {
      elements.messagesList.innerHTML = '';
    }

    const selfDigest = (() => {
      try {
        return normalizeAccountDigest(getAccountDigest());
      } catch {
        return null;
      }
    })();
    const tickState = computeDoubleTickState({
      timelineMessages,
      conversationId: state.conversationId || null,
      selfDigest
    });
    const lastDoubleTickId = tickState.lastDoubleTickId || null;
    if (uiNoiseEnabled) {
      try {
        if (console?.debug) {
          console.debug('[msg] ' + JSON.stringify({
            event: 'tick:state',
            conversationId: state.conversationId || null,
            lastUserId: tickState.lastUserId || null,
            lastUserFromSelf: tickState.lastUserFromSelf,
            lastDoubleTickId
          }));
        }
      } catch {}
    }
    const logUiAppend = (msg, overrides = {}) => {
      if (!uiNoiseEnabled) return;
      const payload = {
        stage: 'ui',
        action: 'append',
        index: typeof overrides.index === 'number' ? overrides.index : null,
        conversationId: state.conversationId || null,
        serverMessageId: msg.serverMessageId || msg.server_message_id || msg.serverMsgId || msg.messageId || null,
        messageId: msg.id || msg.messageId || null,
        packetKey: msg.packetKey || msg.packet_key || null,
        direction: msg.direction || null,
        msgType: overrides.msgType || msg.type || (msg.media ? 'media' : 'text'),
        ts: msg.ts || null,
        senderDigest: msg.senderDigest || msg.sender_digest || msg.meta?.senderDigest || msg.meta?.sender_digest || null,
        senderDeviceId: msg.senderDeviceId || msg.sender_device_id || msg.meta?.senderDeviceId || msg.meta?.sender_device_id || msg.header?.device_id || null,
        peerDigest: state.activePeerDigest || msg.peerAccountDigest || msg.peerDigest || null,
        peerDeviceId: state.activePeerDeviceId || msg.peerDeviceId || msg.peer_device_id || null
      };
      Object.assign(payload, overrides);
      logMsgEvent('ui:append', payload);
      if (payload.messageId) appendedIds.push(payload.messageId);
    };
    let prevTs = null;
    let prevDateKey = null;
    if (startIndex > 0) {
      const prevMsg = timelineMessages[startIndex - 1];
      const tsVal = Number(prevMsg?.ts ?? null);
      if (Number.isFinite(tsVal)) {
        prevTs = tsVal;
        prevDateKey = new Date(tsVal * 1000).toDateString();
      }
    }
    let renderIndex = startIndex;
    for (let i = startIndex; i < timelineMessages.length; i += 1) {
      const msg = timelineMessages[i];
      const currentIndex = renderIndex;
      renderIndex += 1;
      const tsVal = Number(msg.ts || null);
      const hasTs = Number.isFinite(tsVal);
      const dateKey = hasTs ? new Date(tsVal * 1000).toDateString() : null;
      if (hasTs) {
        const needSeparator = prevTs === null
          || prevDateKey !== dateKey
          || (tsVal - prevTs) >= 300;
        if (needSeparator) {
          const sep = document.createElement('li');
          sep.className = 'message-separator';
          sep.textContent = formatTimestamp(tsVal);
          elements.messagesList.appendChild(sep);
        }
        prevTs = tsVal;
        prevDateKey = dateKey;
      }
      const li = document.createElement('li');
      const messageType = msg.type || (msg.media ? 'media' : 'text');
      if (!msg.type) msg.type = messageType;
      if (messageType === 'call-log' && msg.callLog) {
        li.className = 'call-log-entry';
        const chip = document.createElement('div');
        const outcome = msg.callLog.outcome || 'missed';
        chip.className = `call-log-chip ${outcome}`;
        const icon = document.createElement('span');
        icon.className = 'call-log-icon';
        icon.innerHTML = CALL_LOG_PHONE_ICON;
        chip.appendChild(icon);
        const textGroup = document.createElement('div');
        textGroup.className = 'call-log-text-group';
        const main = document.createElement('div');
        main.className = 'call-log-main';
        const viewerRole = msg.callLog.viewerRole || resolveViewerRole(msg.callLog.authorRole, msg.direction);
        const { label, subLabel } = describeCallLogForViewer(msg.callLog, viewerRole);
        main.textContent = label || '語音通話';
        textGroup.appendChild(main);
        if (subLabel) {
          const sub = document.createElement('div');
          sub.className = 'call-log-sub';
          sub.textContent = subLabel;
          textGroup.appendChild(sub);
        }
        chip.appendChild(textGroup);
        li.appendChild(chip);
        elements.messagesList.appendChild(li);
        try {
          logUiAppend(msg, { msgType: 'call-log', index: currentIndex });
        } catch {}
        continue;
      }
      const row = document.createElement('div');
      row.className = 'message-row';
      if (msg.direction === 'outgoing') {
        row.style.justifyContent = 'flex-end';
      }
      if (msg.direction === 'incoming') {
        const avatar = document.createElement('div');
        avatar.className = 'message-avatar';
        const contact = msg.direction === 'incoming' ? sessionStore.contactIndex?.get?.(state.activePeerDigest || '') : null;
        const name = contact?.nickname || '';
        const initials = name ? name.slice(0, 1) : '好友';
        avatar.textContent = initials;
        if (contact?.avatar?.thumbDataUrl || contact?.avatar?.previewDataUrl || contact?.avatar?.url) {
          const img = document.createElement('img');
          img.src = contact.avatar.thumbDataUrl || contact.avatar.previewDataUrl || contact.avatar.url;
          img.alt = name || 'avatar';
          avatar.textContent = '';
          avatar.appendChild(img);
        }
        row.appendChild(avatar);
      } else {
        row.style.gap = '0';
      }
      const bubble = document.createElement('div');
      bubble.className = 'message-bubble ' + (msg.direction === 'outgoing' ? 'message-me' : 'message-peer');
      if (msg.id) bubble.dataset.messageId = msg.id;
      if (messageType === 'media' && msg.media) {
        renderMediaBubble(bubble, msg);
      } else {
        bubble.textContent = msg.text || msg.error || '(無法解密)';
      }
      row.appendChild(bubble);
      li.appendChild(row);
      const metaRow = document.createElement('div');
      metaRow.className = 'message-meta';
      const ts = document.createElement('span');
      ts.className = 'message-ts hidden';
      ts.textContent = '';
      metaRow.appendChild(ts);
      if (messageType !== 'call-log') {
        const statusSpan = document.createElement('span');
        const status = typeof msg?.status === 'string' ? msg.status : null;
        const pending = status === 'pending' || msg.pending === true;
        const delivered = status === 'delivered' || status === 'read';
        const failed = status === 'failed';
        const statusMessageId = msg?.id || msg?.messageId || msg?.localId || null;
        if (statusMessageId) statusSpan.dataset.messageId = statusMessageId;
        if (msg.direction === 'incoming') {
          statusSpan.className = 'message-status peer';
          statusSpan.textContent = '';
        } else if (pending) {
          statusSpan.className = 'message-status pending';
          statusSpan.textContent = '';
        } else if (failed) {
          statusSpan.className = 'message-status failed';
          statusSpan.textContent = '!';
          const failureTip = msg?.failureReason || msg?.failureCode || '';
          if (failureTip) statusSpan.title = failureTip;
        } else if (delivered) {
          statusSpan.className = 'message-status delivered';
          statusSpan.textContent = '✓✓';
        } else {
          statusSpan.className = 'message-status sent';
          statusSpan.textContent = '✓';
        }
        metaRow.appendChild(statusSpan);
      }
      li.appendChild(metaRow);
      elements.messagesList.appendChild(li);
      try {
        logUiAppend(msg, { index: currentIndex });
      } catch {}
    }

    renderState.conversationId = state.conversationId || null;
    renderState.renderedIds = timelineIds.filter(Boolean);
    updateLoadMoreVisibility();

    if (elements.scrollEl) {
      if (scrollToEnd) {
        scrollMessagesToBottom();
      } else if (anchor) {
        restoreScrollFromAnchor(anchor);
      }
    }
    if (scrollToEnd) {
      setNewMessageHint(false);
    }
    updateMessagesScrollOverflow();
    if (uiNoiseEnabled) {
      try {
        const diagnostics = Array.from(elements.messagesList.querySelectorAll('.message-bubble')).map((el) => ({
          text: el.textContent,
          hidden: el.offsetParent === null
        }));
        log({ messagesRendered: diagnostics, newMessageIds, appendedIds });
      } catch (err) {
        log({ messagesRenderLogError: err?.message || err });
      }
    }
  }
  async function loadActiveConversationMessages({ append = false, replay = false, retryOnError = true, mutateLive = true, silent = false, reason } = {}) {
    const state = getMessageState();
    const startedConversationId = state.conversationId;
    sessionStore.historyReplayDoneByConvId = sessionStore.historyReplayDoneByConvId || {};
    const historyReplayDoneByConvId = sessionStore.historyReplayDoneByConvId;
    if (DEBUG.replay) {
      log({
        probeReplay: {
          where: 'messages-pane:loadActiveConversationMessages:enter',
          hasConvId: !!state.conversationId,
          hasToken: !!state.conversationToken,
          hasPeer: !!state.activePeerDigest,
          hasPeerDevice: !!state.activePeerDeviceId
        }
      });
    }
    if (!state.conversationId || !state.conversationToken || !state.activePeerDigest) return;
    if (!state.activePeerDeviceId) {
      if (!silent) setMessagesStatus('缺少對端裝置資訊，請重新同步好友。', true);
      return;
    }
    if (state.loading) return;
    if (append && (!state.hasMore || !state.nextCursor)) return;

    const debugRelogin = typeof window !== 'undefined' && window.__DEBUG_RELOGIN__ === true;
    if (silent && uiNoiseEnabled) {
      try {
        console.info('[msg] poll:tick', { reason: reason || 'poll' });
      } catch {}
    }

    state.loading = true;
    if (!append && !silent) setMessagesStatus('載入中…');
    const beforeTimeline = refreshTimelineState(state.conversationId);
    const beforeIdSet = collectTimelineIdSet(beforeTimeline);
    const timelineSizeBefore = Array.isArray(beforeTimeline) ? beforeTimeline.length : null;
    const uiLatestKey = latestKeyFromTimeline(beforeTimeline);
    try {
      const historyReplayDone = historyReplayDoneByConvId[startedConversationId] === true;
      const replayMode = replay || !historyReplayDone;
      const cursor = append ? state.nextCursor : undefined;
      const cursorTs = cursor?.ts ?? cursor ?? undefined;
      const cursorId = cursor?.id ?? undefined;
      const fetchLimit = 20;
      const mutateState = mutateLive && !replayMode && !append;
      const requestPriority = replayMode ? 'replay' : 'live';
      const forceReplay = replayMode && !append;
      let prefetch = null;
      let serverLatestKey = null;
      if (debugRelogin) {
        try {
          console.info('[diag][relogin] load-messages:before ' + JSON.stringify({
            trigger: reason || 'enter',
            conversationId: state.conversationId || null,
            cursor: cursor ? { ts: cursorTs ?? null, id: cursorId ?? null } : null,
            nextCursor: state.nextCursor || null,
            limit: fetchLimit,
            timelineSizeBefore: Array.isArray(beforeTimeline) ? beforeTimeline.length : 0
          }));
        } catch {}
      }
      if (DEBUG.replay) {
        try {
          log({
            action: 'replay:before',
            conversationId: state.conversationId || null,
            conversationIdPresent: !!state.conversationId,
            allowReplay: true,
            replay: !!replayMode,
            append: !!append,
            silent: !!silent,
            mutateState,
            limit: fetchLimit,
            nextCursorTs: cursorTs ?? null,
            nextCursorId: cursorId ?? null,
            nextCursor: cursor || null,
            timelineSizeBefore
          });
        } catch {}
      }

      if (!append) {
        try {
          const { r, data } = await apiListSecureMessages({
            conversationId: state.conversationId,
            limit: fetchLimit,
            cursorTs,
            cursorId
          });
          const items = Array.isArray(data?.items) ? data.items : [];
          const sortedItems = sortMessagesByTimelineLocal(items);
          serverLatestKey = latestKeyFromRaw(sortedItems);
          if (silent && latestKeysEqual(uiLatestKey, serverLatestKey) && uiNoiseEnabled) {
            try {
              console.info('[msg] poll:no-op ' + JSON.stringify({
                conversationId: state.conversationId || null,
                uiLatestId: uiLatestKey?.id || null,
                serverLatestId: serverLatestKey?.id || null
              }));
            } catch {}
            return;
          }
          const newItems = sortedItems.filter((item) => {
            const mid = normalizeRawMessageId(item);
            if (!mid) return true;
            return !beforeIdSet.has(mid);
          });
          prefetch = { r, data: { ...(data || {}), items: newItems } };
        } catch (err) {
          log({ prefetchMessagesError: err?.message || err });
        }
      }

      const nearBottom = isNearMessagesBottom();
      logReplayCallsite('loadActiveConversationMessages', {
        conversationId: state.conversationId || null,
        replay: !!replayMode,
        allowReplay: true,
        mutateState,
        silent: !!silent,
        limit: fetchLimit,
        cursorTs: cursorTs ?? null,
        cursorId: cursorId ?? null
      });
      logReplayGateTrace('messages-pane:listSecureAndDecrypt:loadActiveConversationMessages', {
        conversationId: state.conversationId || null,
        allowReplay: true,
        mutateState,
        replay: !!replayMode,
        silent: !!silent,
        messageId: null,
        serverMessageId: null
      });
      const allowReceipts = mutateState !== false;
      const onMessageDecrypted = (payload) => handleMessageDecrypted({ ...payload, allowReceipts });
      const listResult = await listSecureAndDecrypt({
        conversationId: state.conversationId,
        tokenB64: state.conversationToken,
        peerAccountDigest: state.activePeerDigest,
        peerDeviceId: state.activePeerDeviceId || null,
        limit: fetchLimit,
        cursorTs,
        cursorId,
        mutateState,
        allowReplay: true,
        priority: requestPriority,
        silent: !!silent,
        onMessageDecrypted,
        prefetchedList: prefetch
          ? {
              items: Array.isArray(prefetch?.data?.items) ? prefetch.data.items : [],
              nextCursor: prefetch?.data?.nextCursor ?? null,
              nextCursorTs: prefetch?.data?.nextCursorTs ?? null,
              hasMoreAtCursor: !!prefetch?.data?.hasMoreAtCursor
            }
          : null
      });
      const {
        nextCursor,
        nextCursorTs,
        errors,
        receiptUpdates,
        deadLetters,
        hasMoreAtCursor,
        items: resultItems = [],
        serverItemCount = null,
        replayStats = {}
      } = listResult;
      if (reason === 'ws-reconnect' || reason === 'open' || reason === 'scroll') {
        const cursorPayload = cursor
          ? { ts: cursorTs ?? null, id: cursorId ?? null }
          : null;
        logCapped('wsSyncTrace', {
          trigger: reason,
          conversationId: state.conversationId || null,
          count: Array.isArray(resultItems) ? resultItems.length : 0,
          cursor: cursorPayload
        });
      }
      logReplayFetchResult({
        conversationId: state.conversationId || null,
        itemsLength: Array.isArray(resultItems) ? resultItems.length : null,
        serverItemCount: serverItemCount ?? null,
        nextCursorTs: nextCursor?.ts ?? nextCursorTs ?? null,
        nextCursorId: nextCursor?.id ?? null,
        errorsLength: Array.isArray(errors) ? errors.length : null
      });
      if (replayMode && startedConversationId) {
        const decryptFailCount = Number(replayStats?.decryptFail) || 0;
        const outboundVaultMissingCount = Number(replayStats?.outboundVaultMissing) || 0;
        const replayComplete =
          !hasMoreAtCursor &&
          !nextCursor &&
          !(Array.isArray(errors) && errors.length) &&
          decryptFailCount === 0 &&
          outboundVaultMissingCount === 0;
        historyReplayDoneByConvId[startedConversationId] = replayComplete;
      }
      const filteredErrors = Array.isArray(errors)
        ? errors.filter((entry) => !isControlBannerEntry(entry))
        : [];
      const filteredDeadLetters = Array.isArray(deadLetters)
        ? deadLetters.filter((entry) => !isControlBannerEntry(entry))
        : [];
      const errorCounts = countBannerEntries(Array.isArray(errors) ? errors : []);
      const deadLetterCounts = countBannerEntries(Array.isArray(deadLetters) ? deadLetters : []);
      const userFail = errorCounts.userFail + deadLetterCounts.userFail;
      const controlFail = errorCounts.controlFail + deadLetterCounts.controlFail;
      if (userFail || controlFail) {
        try {
          console.info('[msg] ' + JSON.stringify({
            event: 'banner:counts',
            userFail,
            controlFail
          }));
        } catch {}
      }
      state.nextCursor = nextCursor || (nextCursorTs != null ? { ts: nextCursorTs, id: null } : null);
      state.nextCursorTs = state.nextCursor?.ts ?? nextCursorTs ?? null;
      state.hasMore = !!state.nextCursor || !!hasMoreAtCursor;
      if (filteredErrors.length) {
        logDecryptBannerEntries(state.conversationId, filteredErrors);
        if (!silent) setMessagesStatus(`部分訊息無法解密，系統將嘗試重新同步（${filteredErrors.length}）`, true);
        if (!state.replayInProgress && retryOnError) {
          state.replayInProgress = true;
          try {
            await loadActiveConversationMessages({ append: false, replay: true, retryOnError: false });
          } catch (err) {
            if (!silent) setMessagesStatus('重新同步失敗：' + (err?.message || err), true);
          } finally {
            state.replayInProgress = false;
          }
        }
      } else if (filteredDeadLetters.length) {
        logDecryptBannerEntries(state.conversationId, filteredDeadLetters);
        if (!silent) setMessagesStatus('部分訊息解密失敗，已排程重試。', true);
      } else if (!silent) {
        setMessagesStatus('', false);
      }
      let receiptsChanged = false;
      const timelineMessages = refreshTimelineState(state.conversationId);
      let vaultStatusChanged = false;
      if (!append) {
        vaultStatusChanged = await reconstructOutgoingVaultStatus({
          conversationId: state.conversationId,
          peerAccountDigest: toDigestOnly(state.activePeerDigest),
          timelineMessages
        });
      }
      const afterIdSet = collectTimelineIdSet(timelineMessages);
      const newMessageIds = Array.from(afterIdSet).filter((id) => !beforeIdSet.has(id));
      if (DEBUG.replay) {
        try {
          log({
            action: 'replay:after',
            conversationId: state.conversationId || null,
            conversationIdPresent: !!state.conversationId,
            allowReplay: true,
            replay: !!replay,
            append: !!append,
            silent: !!silent,
            mutateState,
            limit: fetchLimit,
            nextCursorTs: nextCursor?.ts ?? nextCursorTs ?? null,
            nextCursorId: nextCursor?.id ?? null,
            nextCursor: nextCursor || null,
            serverItemCount: serverItemCount ?? null,
            itemsLength: Array.isArray(resultItems) ? resultItems.length : null,
            errorsLength: filteredErrors.length,
            errorsPreview: filteredErrors.slice(0, 3).map((entry) => entry?.message || entry?.code || entry),
            timelineSizeBefore,
            timelineSizeAfter: Array.isArray(timelineMessages) ? timelineMessages.length : null
          });
        } catch {}
      }
      if (debugRelogin) {
        try {
          console.info('[diag][relogin] load-messages:after ' + JSON.stringify({
            trigger: reason || 'enter',
            conversationId: state.conversationId || null,
            nextCursor: state.nextCursor || null,
            serverItemCount: serverItemCount ?? null,
            items: Array.isArray(resultItems) ? resultItems.length : null,
            errors: filteredErrors.slice(0, 3).map((entry) => entry?.message || entry),
            timelineSizeAfter: Array.isArray(timelineMessages) ? timelineMessages.length : 0
          }));
        } catch {}
      }
      if (Array.isArray(receiptUpdates)) {
        for (const msg of timelineMessages) {
          if (msg?.id && receiptUpdates.includes(msg.id)) {
            if (msg?.status === 'failed') continue;
            msg.read = true;
            msg.status = 'delivered';
            msg.pending = false;
            receiptsChanged = true;
          }
        }
      }
      const receiptsApplied = applyReceiptsToMessages(timelineMessages);
      const receiptRenderNeeded = receiptsApplied || receiptRenderPending || vaultStatusChanged;
      receiptRenderPending = false;
      const shouldScrollToEnd = !append && !forceReplay && nearBottom;
      const preserveScroll = append || !shouldScrollToEnd;
      updateMessagesUI({ scrollToEnd: shouldScrollToEnd, preserveScroll, newMessageIds });
      if (receiptsChanged || receiptRenderNeeded) {
        updateMessagesUI({ preserveScroll: true, forceFullRender: true });
      }
      if (state.activePeerDigest) {
        for (const msg of timelineMessages) {
          if (msg?.direction === 'incoming') {
            sendReadReceiptForMessage(msg);
          }
        }
      }
      if (silent && newMessageIds.length && uiNoiseEnabled) {
        try {
          console.info('[msg] poll:append ' + JSON.stringify({
            conversationId: state.conversationId || null,
            newCount: newMessageIds.length,
            nearBottom
          }));
        } catch {}
      }
      if (!append && !forceReplay && newMessageIds.length) {
        if (shouldScrollToEnd) {
          setNewMessageHint(false);
        } else {
          setNewMessageHint(true);
        }
      } else if (shouldScrollToEnd) {
        setNewMessageHint(false);
      }
      syncThreadFromActiveMessages();
    } catch (err) {
      if (!silent) setMessagesStatus('載入失敗：' + (err?.message || err), true);
    } finally {
      state.loading = false;
      if (!append && pendingWsRefresh > 0) {
        const queued = pendingWsRefresh;
        pendingWsRefresh = 0;
        // 再執行一次以消化 WS 期間累積的訊息。
        loadActiveConversationMessages({ append: false })
          .then(() => scrollMessagesToBottom())
          .catch((err) => log({ wsRefreshAfterLoadError: err?.message || err }))
          .finally(() => { pendingWsRefresh = 0; });
      }
      updateLoadMoreVisibility();
      scheduleActivePoll();
    }
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
    } catch {}
  }
  async function setActiveConversation(peerAccountDigest) {
    stopActivePoll();
    pendingSecureReadyPeer = null;
    const identity = normalizePeerIdentity(peerAccountDigest);
    const key = identity.key || normalizePeerKey(peerAccountDigest);
    try {
      if (uiNoiseEnabled) {
        console.log('[messages-pane]', { setActiveConversationStart: key });
      }
    } catch {}
    const { digest: digestFromKey, deviceId: deviceFromKey } = splitPeerKey(key);
    const peerDigest = identity.accountDigest || digestFromKey;
    const peerDeviceHint = identity.deviceId || deviceFromKey;
    if (!key) {
      logContactCoreWriteSkip({
        callsite: 'messages-pane:set-active:start',
        conversationId: null,
        hasDeviceId: !!peerDeviceHint
      });
      logSetActiveFail({
        reason: 'MISSING_PEER_KEY',
        peerKey: key,
        peerDigest,
        peerDeviceId: peerDeviceHint,
        entry: null,
        conversation: null
      });
      return;
    }
    if (!peerDigest) {
      logContactCoreWriteSkip({
        callsite: 'messages-pane:set-active:start',
        conversationId: null,
        hasDeviceId: !!peerDeviceHint
      });
      setMessagesStatus('缺少好友識別資訊，請重新同步好友。', true);
      logSetActiveFail({
        reason: 'MISSING_PEER_DIGEST',
        peerKey: key,
        peerDigest,
        peerDeviceId: peerDeviceHint,
        entry: null,
        conversation: null
      });
      return;
    }
    const desktopLayout = isDesktopLayout();
    const threads = getConversationThreads();
    let entry = getContactCore(key);
    let threadForPeer = null;
    if (!entry && threads instanceof Map) {
      for (const thread of threads.values()) {
        if (threadPeer(thread) === key) {
          threadForPeer = thread;
          break;
        }
      }
      if (threadForPeer && threadForPeer.conversationId && threadForPeer.conversationToken && threadForPeer.peerDeviceId) {
        const seeded = upsertContactCore({
          peerAccountDigest: peerDigest,
          peerDeviceId: threadForPeer.peerDeviceId,
          conversationId: threadForPeer.conversationId,
          conversationToken: threadForPeer.conversationToken || threadForPeer.conversation?.token_b64,
          nickname: threadForPeer.nickname || null,
          avatar: threadForPeer.avatar || null,
          conversation: threadForPeer.conversation || null
        }, 'messages-pane:set-active:thread');
        entry = seeded || getContactCore(key);
      }
    }
    if (entry && !entry.isReady && threads instanceof Map) {
      for (const thread of threads.values()) {
        if (threadPeer(thread) !== key) continue;
        if (thread.conversationId && (thread.conversationToken || thread.conversation?.token_b64) && thread.peerDeviceId) {
          const upgraded = upsertContactCore({
            peerAccountDigest: peerDigest,
            peerDeviceId: thread.peerDeviceId,
            conversationId: thread.conversationId,
            conversationToken: thread.conversationToken || thread.conversation?.token_b64,
            nickname: entry?.nickname || thread.nickname || null,
            avatar: entry?.avatar || thread.avatar || null,
            conversation: thread.conversation || null
          }, 'messages-pane:set-active:thread-upgrade');
          entry = upgraded || entry;
          threadForPeer = threadForPeer || thread;
          break;
        }
      }
    }
    if (!entry) {
      try { log({ setActiveConversationMissingEntry: key }); } catch {}
      setMessagesStatus('找不到指定的好友', true);
      if (!desktopLayout) {
        const stateFallback = getMessageState();
        stateFallback.viewMode = 'list';
        applyMessagesLayout();
      }
      logSetActiveFail({
        reason: 'CONTACT_NOT_FOUND',
        peerKey: key,
        peerDigest,
        peerDeviceId: peerDeviceHint,
        entry: null,
        conversation: null
      });
      return;
    }
    if (entry && !entry.isReady) {
      const stateBefore = sessionStore?.messageState || {};
      logConversationResetTrace({
        reason: 'CONTACT_PENDING',
        conversationId: stateBefore?.conversationId || null,
        peerKey: key || null,
        peerDigest: peerDigest || key || null,
        peerDeviceId: peerDeviceHint || entry?.peerDeviceId || null,
        hasToken: !!(entry?.conversationToken || entry?.conversation?.token_b64),
        hasConversationId: !!(entry?.conversationId || entry?.conversation?.conversation_id),
        'entry.isReady': !!entry?.isReady,
        sourceTag: 'messages-pane:set-active'
      });
      resetMessageStateWithPlaceholders();
      const state = getMessageState();
      if (!desktopLayout) state.viewMode = 'list';
      if (elements.peerName) elements.peerName.textContent = entry?.nickname || `好友 ${key.slice(-4)}`;
      setMessagesStatus('此好友尚未建立安全對話，缺少會話資訊。', true);
      clearMessagesView();
      hideSecurityModal();
      updateComposerAvailability();
      renderConversationList();
      applyMessagesLayout();
      logSetActiveFail({
        reason: 'CONTACT_PENDING',
        peerKey: key,
        peerDigest,
        peerDeviceId: peerDeviceHint || entry?.peerDeviceId || null,
        entry,
        conversation: null
      });
      return;
    }
    if (!threadForPeer && threads instanceof Map) {
      for (const thread of threads.values()) {
        if (threadPeer(thread) === key) {
          threadForPeer = thread;
          break;
        }
      }
    }
    const nickname = entry?.nickname || threadForPeer?.nickname || `好友 ${key.slice(-4)}`;
    const conversationFromEntry = entry?.conversationToken && entry?.conversationId
      ? {
          conversation_id: entry.conversationId,
          token_b64: entry.conversationToken,
          peerDeviceId: entry.peerDeviceId || null,
          ...(entry?.drInit ? { dr_init: entry.drInit } : null)
        }
      : entry?.conversation || null;
    if (conversationFromEntry?.conversation_id) {
      clearConversationTombstone(conversationFromEntry.conversation_id);
    }
    const conversationFromThread = threadForPeer?.conversationId && (threadForPeer?.conversationToken || threadForPeer?.conversation?.token_b64)
      ? {
          conversation_id: threadForPeer.conversationId,
          token_b64: threadForPeer.conversationToken || threadForPeer.conversation?.token_b64,
          peerDeviceId: threadForPeer.peerDeviceId || null
        }
      : null;
    const conversation = conversationFromEntry || conversationFromThread;
    if (!conversation?.token_b64 || !conversation?.conversation_id) {
      const stateBefore = sessionStore?.messageState || {};
      logConversationResetTrace({
        reason: 'MISSING_CONVERSATION_TOKEN',
        conversationId: stateBefore?.conversationId || null,
        peerKey: key || null,
        peerDigest: peerDigest || key || null,
        peerDeviceId: peerDeviceHint || entry?.peerDeviceId || conversation?.peerDeviceId || conversation?.peer_device_id || null,
        hasToken: !!(conversation?.token_b64 || entry?.conversationToken || entry?.conversation?.token_b64),
        hasConversationId: !!(conversation?.conversation_id || entry?.conversationId || entry?.conversation?.conversation_id),
        'entry.isReady': !!entry?.isReady,
        sourceTag: 'messages-pane:set-active'
      });
      resetMessageStateWithPlaceholders();
      const state = getMessageState();
      if (!desktopLayout) state.viewMode = 'list';
      if (elements.peerName) elements.peerName.textContent = nickname;
      setMessagesStatus('此好友尚未建立安全對話，缺少會話資訊。', true);
      clearMessagesView();
      hideSecurityModal();
      updateComposerAvailability();
      renderConversationList();
      applyMessagesLayout();
      logSetActiveFail({
        reason: 'MISSING_CONVERSATION_TOKEN',
        peerKey: key,
        peerDigest,
        peerDeviceId: peerDeviceHint || entry?.peerDeviceId || null,
        entry,
        conversation
      });
      return;
    }
    log({ setActiveConversation: { peerAccountDigest: key, conversationId: conversation.conversation_id || null, hasDrInit: !!(conversation.dr_init || conversation.drInit) } });
    const state = getMessageState();
    sessionStore.historyReplayDoneByConvId = sessionStore.historyReplayDoneByConvId || {};
    const historyReplayDone = sessionStore.historyReplayDoneByConvId[conversation.conversation_id] === true;
    // 清掉舊對話的 processed cache，以免略過新訊息
    if (state.conversationId && state.conversationId !== conversation.conversation_id) {
      resetProcessedMessages(state.conversationId);
    }
    const peerDeviceIdFromConversation = normalizePeerDeviceId(conversation?.peerDeviceId || conversation?.peer_device_id || null);
    const peerDeviceIdFromThread = normalizePeerDeviceId(threadForPeer?.peerDeviceId || null);
    const peerDeviceIdFromEntry = normalizePeerDeviceId(entry?.peerDeviceId || null);
    const peerDeviceId = peerDeviceHint
      || peerDeviceIdFromEntry
      || peerDeviceIdFromConversation
      || peerDeviceIdFromThread
      || null;
    if (!peerDeviceId) {
      setMessagesStatus('缺少對端裝置資訊，請重新同步好友。', true);
      logSetActiveFail({
        reason: 'MISSING_PEER_DEVICE',
        peerKey: key,
        peerDigest,
        peerDeviceId: peerDeviceHint || entry?.peerDeviceId || null,
        entry,
        conversation
      });
      return;
    }
    const resolvedPeerKey = normalizePeerKey({ peerAccountDigest: peerDigest, peerDeviceId }) || key;
    if (!peerDigest) {
      logContactCoreWriteSkip({
        callsite: 'messages-pane:set-active',
        conversationId: conversation.conversation_id || null,
        hasDeviceId: !!peerDeviceId
      });
      setMessagesStatus('缺少好友識別資訊，請重新同步好友。', true);
      return;
    }
    upsertContactCore({
      peerAccountDigest: peerDigest,
      peerDeviceId,
      conversationId: conversation.conversation_id,
      conversationToken: conversation.token_b64,
      nickname: entry?.nickname || null,
      avatar: entry?.avatar || null,
      conversation
    }, 'messages-pane:set-active');
    const activePeerKey = resolvedPeerKey || key;
    state.activePeerDigest = activePeerKey;
    state.activePeerDeviceId = peerDeviceId || null;
    state.conversationToken = conversation.token_b64;
    state.conversationId = conversation.conversation_id;
    resetProcessedMessages(state.conversationId);
    const timelineMessages = refreshTimelineState(state.conversationId);
    const timelineSizeBefore = Array.isArray(timelineMessages) ? timelineMessages.length : 0;
    const hasTimelineMessages = timelineSizeBefore > 0;
    state.nextCursor = null;
    state.nextCursorTs = null;
    state.hasMore = true;
    state.loading = false;
    const thread = upsertConversationThread({
      peerAccountDigest: activePeerKey,
      conversationId: state.conversationId,
      tokenB64: state.conversationToken,
      peerDeviceId,
      nickname,
      avatar: entry?.avatar || null
    });
    if (thread) {
      thread.needsRefresh = false;
    }
    if (!desktopLayout) {
      state.viewMode = 'detail';
    } else if (!state.viewMode) {
      state.viewMode = 'detail';
    }
    try {
      console.info('[msg] convo:enter ' + JSON.stringify({
        conversationId: state.conversationId,
        peerKey: activePeerKey,
        peerDeviceId,
        hasToken: !!state.conversationToken
      }));
    } catch {}
    let ensureStatusInfo = null;
    const mkReady = !!getMkRaw();
    const vaultGateReady = !!(state.conversationToken && state.conversationId && mkReady);
    logVaultGateDecisionTrace({
      peerAccountDigest: activePeerKey || null,
      conversationId: state.conversationId || null,
      hasToken: !!state.conversationToken,
      mkReady,
      vaultGateReady
    });
    if (!vaultGateReady) {
      const statusBeforeEnsure = getCachedSecureStatus(activePeerKey);
      let initialStatus = statusBeforeEnsure;
      if (!initialStatus || initialStatus.status === SECURE_CONVERSATION_STATUS.IDLE) {
        initialStatus = cacheSecureStatus(activePeerKey, SECURE_CONVERSATION_STATUS.PENDING, null);
      }
      if (initialStatus) {
        applySecureStatusForActivePeer(activePeerKey, initialStatus);
      }
      try {
        ensureStatusInfo = await ensureSecureConversationReady({
          peerAccountDigest: activePeerKey,
          conversationId: state.conversationId || null,
          reason: 'open-conversation',
          source: 'messages-pane:setActiveConversation',
          skipInitialCheckpoint: true
        });
      } catch (err) {
        const errorMsg = err?.message || err || '建立安全對話失敗，請稍後再試。';
        log({ ensureSecureConversationError: errorMsg, peerAccountDigest: activePeerKey });
        const corruptInfo = getCorruptContact?.({ peerAccountDigest: activePeerKey, peerDeviceId }) || null;
        const failReason = corruptInfo ? 'CONTACT_CORRUPT' : 'ENSURE_SECURE_CONVERSATION_FAILED';
        const cachedWasPending = statusBeforeEnsure?.status === SECURE_CONVERSATION_STATUS.PENDING;
        const isNotReadyError = typeof errorMsg === 'string'
          && (/缺少安全會話狀態/.test(errorMsg) || /逾時/.test(errorMsg) || /timeout/i.test(errorMsg));
        if (!corruptInfo && entry?.isReady && cachedWasPending && isNotReadyError) {
          pendingSecureReadyPeer = activePeerKey;
          ensureStatusInfo = cacheSecureStatus(activePeerKey, SECURE_CONVERSATION_STATUS.PENDING, null);
          log({ ensureSecureConversationPending: { peerAccountDigest: activePeerKey, reason: failReason, error: errorMsg } });
        } else {
          const cached = cacheSecureStatus(activePeerKey, SECURE_CONVERSATION_STATUS.FAILED, String(errorMsg));
          applySecureStatusForActivePeer(activePeerKey, cached || { status: SECURE_CONVERSATION_STATUS.FAILED, error: String(errorMsg) });
          applyMessagesLayout();
          logSetActiveFail({
            reason: failReason,
            peerKey: activePeerKey,
            peerDigest,
            peerDeviceId,
            entry,
            conversation,
            error: errorMsg
          });
          return;
        }
      }
    } else {
      ensureStatusInfo = cacheSecureStatus(activePeerKey, SECURE_CONVERSATION_STATUS.READY, null);
      pendingSecureReadyPeer = null;
      applySecureStatusForActivePeer(activePeerKey, ensureStatusInfo);
    }
    const cachedSecureStatus = getCachedSecureStatus(activePeerKey);
    const statusInfo = ensureStatusInfo
      || cachedSecureStatus
      || cacheSecureStatus(activePeerKey, SECURE_CONVERSATION_STATUS.READY, null);
    if (statusInfo?.status === SECURE_CONVERSATION_STATUS.PENDING) {
      pendingSecureReadyPeer = pendingSecureReadyPeer || activePeerKey;
    } else if (statusInfo?.status === SECURE_CONVERSATION_STATUS.READY) {
      pendingSecureReadyPeer = null;
    }
    applySecureStatusForActivePeer(activePeerKey, statusInfo);
    updateComposerAvailability();
    refreshActivePeerMetadata(activePeerKey, { fallbackName: nickname });
    if (statusInfo?.status === SECURE_CONVERSATION_STATUS.READY) {
      setMessagesStatus('');
    }
    renderConversationList();
    updateComposerAvailability();
    if (hasTimelineMessages) {
      updateMessagesUI({ scrollToEnd: false, forceFullRender: true });
    } else {
      clearMessagesView();
    }
    applyMessagesLayout();
    if (statusInfo?.status === SECURE_CONVERSATION_STATUS.READY) {
      if (typeof window !== 'undefined' && window.__DEBUG_RELOGIN__ === true) {
        try {
          const timeline = timelineGetTimeline(state.conversationId);
          console.info('[diag][relogin] set-active-ready ' + JSON.stringify({
            activePeerKey,
            conversationId: state.conversationId || null,
            hasConversationToken: !!state.conversationToken,
            activePeerDeviceId: state.activePeerDeviceId || null,
            timelineSizeBefore: Array.isArray(timeline) ? timeline.length : 0
          }));
        } catch {}
      }
      await loadActiveConversationMessages({ append: false, replay: !historyReplayDone, reason: 'open' });
      syncOfflineDecryptNow({ source: 'enter_conversation' })
        .catch((err) => log({ offlineDecryptSyncError: err?.message || err, source: 'enter_conversation' }));
    }
  }

  function refreshActivePeerMetadata(peerAccountDigest, { fallbackName } = {}) {
    const key = normalizePeerKey(peerAccountDigest);
    if (!key) return;
    const entry = sessionStore.contactIndex?.get?.(key) || null;
    const nickname = entry?.nickname || fallbackName || `好友 ${key.slice(-4)}`;
    if (elements.peerName) elements.peerName.textContent = nickname;
    if (!elements.peerAvatar) return;
    elements.peerAvatar.innerHTML = '';
    const avatarData = entry?.avatar;
    if (avatarData?.thumbDataUrl || avatarData?.previewDataUrl || avatarData?.url) {
      const img = document.createElement('img');
      img.src = avatarData.thumbDataUrl || avatarData.previewDataUrl || avatarData.url;
      img.alt = nickname;
      elements.peerAvatar.appendChild(img);
    } else {
      elements.peerAvatar.textContent = initialsFromName(nickname, key).slice(0, 2);
    }
    updateThreadAvatar(key, avatarData || null);
  }

  function handleContactEntryUpdated(detail = {}) {
    const peerDigest = normalizePeerKey(detail?.peerAccountDigest);
    if (!peerDigest) return;
    const entry = sessionStore.contactIndex?.get?.(peerDigest) || detail.entry || null;
    if (!entry) return;
    const hasConversation = entry.conversation?.conversation_id && entry.conversation?.token_b64;
    if (hasConversation) {
      upsertConversationThread({
        peerAccountDigest: peerDigest,
        conversationId: entry.conversation.conversation_id,
        tokenB64: entry.conversation.token_b64,
        nickname: entry.nickname,
        avatar: entry.avatar || null
      });
      updateThreadAvatar(peerDigest, entry.avatar || null);
    }
    const state = getMessageState();
    if (state.activePeerDigest === peerDigest) {
      refreshActivePeerMetadata(peerDigest);
    }
    if (!hasConversation) {
      renderConversationList();
    }
  }

  function appendLocalOutgoingMessage({ text, ts, id, type = 'text', media = null }) {
    const state = getMessageState();
    const messageId = typeof id === 'string' && id.trim().length ? id.trim() : null;
    if (!messageId) {
      throw new Error('messageId required for local outgoing message');
    }
    let senderDeviceId = null;
    try { senderDeviceId = ensureDeviceId(); } catch {}
    const message = {
      localId: messageId,
      id: messageId,
      messageId,
      serverMessageId: null,
      ts: ts || Math.floor(Date.now() / 1000),
      text,
      direction: 'outgoing',
      type,
      media: media ? { ...media } : null,
      abortController: null,
      status: 'pending',
      pending: true,
      failureReason: null,
      failureCode: null,
      read: false,
      msgType: type,
      peerAccountDigest: state.activePeerDigest || null,
      peerDeviceId: state.activePeerDeviceId || null,
      senderDeviceId
    };
    if (message.type === 'media' && message.media) {
      if (!message.text) message.text = `[檔案] ${message.media.name || '附件'}`;
    if (message.media.localUrl && !message.media.previewUrl) {
      message.media.previewUrl = message.media.localUrl;
    }
    if (message.media.messageKey_b64 || message.media.message_key_b64) {
      message.media.messageKey_b64 = message.media.messageKey_b64 || message.media.message_key_b64;
    }
  } else {
    message.type = 'text';
  }
    const convId = state.conversationId || null;
    message.conversationId = convId;
    message.msgType = message.type;
    const appended = convId ? timelineAppendUserMessage(convId, message) : false;
    if (appended) {
      try {
        console.info('[msg] ' + JSON.stringify({
          event: 'timeline:append',
          conversationId: convId,
          messageId,
          direction: 'outgoing',
          msgType: message.type || null,
          ts: message.ts || null
        }));
      } catch {
        /* ignore */
      }
      logOutgoingUiStatusTrace({
        message,
        fromStatus: null,
        toStatus: 'pending',
        reasonCode: 'UI_APPEND',
        stage: 'appendLocalOutgoingMessage'
      });
    }
    try {
      logCapped('outgoingSendTrace', {
        stage: 'ui_append',
        localId: message.localId || messageId,
        messageId: message.messageId || messageId,
        serverMessageId: message.serverMessageId || null
      });
    } catch {}
    refreshTimelineState(convId);
    updateMessagesUI({ scrollToEnd: true });
    scrollMessagesToBottom();
    scrollMessagesToBottomSoon();
    syncThreadFromActiveMessages();
    return message;
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

  function handleTimelineAppend({ conversationId, entry, entries, directionalOrder } = {}) {
    const convId = String(conversationId || '').trim();
    const batchEntries = Array.isArray(entries) && entries.length ? entries : (entry ? [entry] : []);
    if (!convId || !batchEntries.length) return;
    const state = getMessageState();
    const convIndex = ensureConversationIndex();
    const convEntry = convIndex.get(convId) || null;
    const threads = getConversationThreads();
    const existingThread = threads.get(convId) || null;
    const lastEntry = batchEntries[batchEntries.length - 1] || null;
    const peerDigest = resolvePeerForConversation(convId, lastEntry?.peerAccountDigest || lastEntry?.senderDigest || null);
    const contactEntry = peerDigest ? sessionStore.contactIndex?.get?.(peerDigest) || null : null;
    const nickname = contactEntry?.nickname || existingThread?.nickname || (peerDigest ? `好友 ${peerDigest.slice(-4)}` : '好友');
    const avatar = contactEntry?.avatar || existingThread?.avatar || null;
    const peerDevice = existingThread?.peerDeviceId || convEntry?.peerDeviceId || lastEntry?.peerDeviceId || lastEntry?.senderDeviceId || null;
    const tokenB64 = convEntry?.token_b64 || existingThread?.conversationToken || null;

    const thread = upsertConversationThread({
      peerAccountDigest: peerDigest || existingThread?.peerAccountDigest || null,
      peerDeviceId: peerDevice,
      conversationId: convId,
      tokenB64,
      nickname,
      avatar
    }) || threads.get(convId);
    if (!thread) return;
    if (peerDigest) ensureThreadPeer(thread, peerDigest);

    let incomingCount = 0;
    for (const item of batchEntries) {
      thread.lastMessageText = item.text || item.error || '';
      thread.lastMessageTs = typeof item.ts === 'number' ? item.ts : thread.lastMessageTs || null;
      thread.lastMessageId = item.messageId || item.id || thread.lastMessageId || null;
      thread.lastDirection = item.direction || thread.lastDirection || null;
      if (item.direction === 'incoming') incomingCount += 1;
    }

    const isActive = state.conversationId === convId && (!peerDigest || state.activePeerDigest === peerDigest);
    const shouldLogBatchRender = Array.isArray(entries);
    const nowMs = () => (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
    const renderStart = shouldLogBatchRender ? nowMs() : null;
    if (isActive) {
      thread.unreadCount = 0;
      thread.lastReadTs = thread.lastMessageTs || thread.lastReadTs || null;
      refreshTimelineState(convId);
      applyReceiptsToMessages(state.messages);
      updateMessagesUI({ scrollToEnd: true });
      syncThreadFromActiveMessages();
    } else if (incomingCount > 0) {
      thread.unreadCount = Math.max(0, Number(thread.unreadCount) || 0) + incomingCount;
    }
    refreshContactsUnreadBadges();
    renderConversationList();

    const renderReason = directionalOrder
      ? `timeline-batch-append:${directionalOrder}`
      : 'timeline-batch-append';
    if (shouldLogBatchRender && renderStart !== null) {
      const renderTookMs = Math.max(0, Math.round(nowMs() - renderStart));
      logCapped('batchRenderTrace', {
        conversationId: convId || null,
        reason: renderReason,
        tookMs: renderTookMs
      }, 5);
    }

    if (!isActive) {
      for (const item of batchEntries) {
        if (item.direction !== 'incoming') continue;
        const shouldNotify = shouldNotifyForMessage({
          computedIsHistoryReplay: !!item?.isHistoryReplay,
          silent: !!item?.silent
        });
        if (shouldNotify) {
          playNotificationSound?.();
          const previewText = buildConversationSnippet(item.text || '') || item.text || '有新訊息';
          const avatarUrlToast = avatar?.thumbDataUrl || avatar?.previewDataUrl || avatar?.url || null;
          const initialsToast = initialsFromName(nickname, peerDigest || '').slice(0, 2);
          const toastPeerDeviceId = thread?.peerDeviceId || peerDevice || null;
          showToast?.(`${nickname}：${previewText}`, {
            onClick: () => openConversationFromToast({ peerAccountDigest: peerDigest, convId, tokenB64, peerDeviceId: toastPeerDeviceId }),
            avatarUrl: avatarUrlToast,
            avatarInitials: initialsToast,
            subtitle: item.ts ? formatTimestamp(item.ts) : ''
          });
        }
      }
    }
  }

  function resolveOutgoingStatusMessageId(message) {
    if (!message) return null;
    return message.id || message.messageId || message.localId || null;
  }

  function logOutgoingStatusTrace(message, fromStatus, toStatus, reasonCode) {
    const messageId = resolveOutgoingStatusMessageId(message);
    if (!messageId) return;
    if (fromStatus === toStatus) return;
    logCapped('outgoingStatusTrace', {
      messageId,
      fromStatus: fromStatus || null,
      toStatus,
      reasonCode
    });
  }

  const OUTGOING_UI_REASON_CODES = new Set([
    'UI_APPEND',
    'SEND_THROW',
    'OUTBOX_SENT',
    'RECEIPT_APPLY'
  ]);

  function normalizeOutgoingUiReasonCode({ reasonCode, toStatus, stage } = {}) {
    const raw = typeof reasonCode === 'string' ? reasonCode.trim() : '';
    if (OUTGOING_UI_REASON_CODES.has(raw)) return raw;
    if (toStatus === 'pending') return 'UI_APPEND';
    if (toStatus === 'sent') return 'OUTBOX_SENT';
    if (toStatus === 'failed') return 'SEND_THROW';
    if (toStatus === 'delivered') return 'RECEIPT_APPLY';
    if (stage === 'applyReceiptState') return 'RECEIPT_APPLY';
    return 'UI_APPEND';
  }

  function logOutgoingUiStatusTrace({
    message,
    fromStatus,
    toStatus,
    reasonCode,
    stage,
    ok = null,
    statusCode = null,
    error = null,
    jobId = null
  } = {}) {
    const messageId = resolveOutgoingStatusMessageId(message);
    if (!messageId) return;
    const normalizedReasonCode = normalizeOutgoingUiReasonCode({ reasonCode, toStatus, stage });
    const rawReason = typeof reasonCode === 'string' ? reasonCode.trim() : '';
    const reasonDetail = rawReason && rawReason !== normalizedReasonCode ? rawReason : null;
    logCapped('outgoingUiStatusTrace', {
      conversationId: message?.conversationId || null,
      messageId,
      jobId: jobId || null,
      stage: stage || null,
      status: toStatus || null,
      fromStatus: fromStatus || null,
      toStatus: toStatus || null,
      ok: typeof ok === 'boolean' ? ok : null,
      statusCode: Number.isFinite(Number(statusCode)) ? Number(statusCode) : null,
      error: error || null,
      reasonCode: normalizedReasonCode || null,
      reasonDetail,
      timestamp: Date.now()
    });
  }

  function updateMessagesStatusUI() {
    updateMessagesUI({ preserveScroll: true, forceFullRender: true });
  }

  function applyReceiptState(message) {
    if (!message || message.direction !== 'outgoing' || !message.id) return false;
    const currentStatus = typeof message.status === 'string' ? message.status : null;
    const state = getMessageState();
    const receipt = state.conversationId ? getMessageReceipt(state.conversationId, message.id) : null;
    const delivered = state.conversationId ? getMessageDelivery(state.conversationId, message.id) : null;
    if (receipt?.read) {
      // read 視為已送達。
      if (currentStatus === 'failed') return false;
      const shouldUpdate = currentStatus !== 'delivered' || message.pending === true || message.read !== true;
      if (shouldUpdate) {
        logCapped('receiptApplyTrace', {
          messageId: message.id,
          currentStatus,
          receiptType: CONTROL_MESSAGE_TYPES.READ_RECEIPT,
          appliedToStatus: 'delivered'
        });
        logOutgoingStatusTrace(message, currentStatus, 'delivered', 'RECEIPT_VAULT_PUT_OK');
        logOutgoingUiStatusTrace({
          message,
          fromStatus: currentStatus,
          toStatus: 'delivered',
          reasonCode: CONTROL_MESSAGE_TYPES.READ_RECEIPT,
          stage: 'applyReceiptState'
        });
      }
      message.read = true;
      message.status = 'delivered';
      message.pending = false;
      if (currentStatus !== 'delivered') {
        logCapped('deliveryAckTrace', {
          stage: 'applied',
          ackedMessageId: message.id,
          conversationId: state.conversationId || null
        });
      }
      return shouldUpdate;
    }
    if (delivered?.delivered) {
      if (currentStatus === 'failed') return false;
      const shouldUpdate = currentStatus !== 'delivered' || message.pending === true || message.read === true;
      if (shouldUpdate) {
        logCapped('receiptApplyTrace', {
          messageId: message.id,
          currentStatus,
          receiptType: CONTROL_MESSAGE_TYPES.DELIVERY_RECEIPT,
          appliedToStatus: 'delivered'
        });
        logOutgoingStatusTrace(message, currentStatus, 'delivered', 'RECEIPT_VAULT_PUT_OK');
        logOutgoingUiStatusTrace({
          message,
          fromStatus: currentStatus,
          toStatus: 'delivered',
          reasonCode: CONTROL_MESSAGE_TYPES.DELIVERY_RECEIPT,
          stage: 'applyReceiptState'
        });
      }
      message.read = false;
      message.status = 'delivered';
      message.pending = false;
      if (currentStatus !== 'delivered') {
        logCapped('deliveryAckTrace', {
          stage: 'applied',
          ackedMessageId: message.id,
          conversationId: state.conversationId || null
        });
      }
      return shouldUpdate;
    }
    if (currentStatus === 'failed') return false;
    if (currentStatus === 'pending' || message.pending === true) return false;
    return false;
  }

  function applyReceiptsToMessages(list) {
    if (!Array.isArray(list)) return false;
    let changed = false;
    for (const msg of list) {
      if (applyReceiptState(msg)) changed = true;
    }
    return changed;
  }

  function applyOutgoingVaultStatus(message, nextStatus, reasonCode = 'VAULT_RECONSTRUCT') {
    if (!message || message.direction !== 'outgoing') return false;
    const fromStatus = typeof message.status === 'string' ? message.status : null;
    if (fromStatus === 'failed') return false;
    if (fromStatus === 'delivered' && nextStatus === 'sent') return false;
    if (fromStatus === nextStatus && message.pending !== true) return false;
    message.status = nextStatus;
    message.pending = false;
    if (nextStatus === 'delivered') {
      if (message.read !== true) message.read = false;
    } else {
      message.read = false;
    }
    logOutgoingUiStatusTrace({
      message,
      fromStatus,
      toStatus: nextStatus,
      reasonCode,
      stage: 'applyOutgoingVaultStatus'
    });
    logOutgoingStatusTrace(message, fromStatus, nextStatus, reasonCode);
    return true;
  }

  async function reconstructOutgoingVaultStatus({ conversationId, peerAccountDigest, timelineMessages } = {}) {
    if (!conversationId || !peerAccountDigest || !Array.isArray(timelineMessages) || !timelineMessages.length) return false;
    let senderDeviceId = null;
    let senderDigest = null;
    try {
      senderDeviceId = ensureDeviceId();
      senderDigest = normalizeAccountDigest(getAccountDigest());
    } catch {
      return false;
    }
    if (!senderDeviceId || !senderDigest) return false;
    const peerDigest = toDigestOnly(peerAccountDigest);
    if (!peerDigest) return false;
    const outgoingMessages = timelineMessages.filter((msg) => msg?.direction === 'outgoing');
    const messageIds = outgoingMessages
      .map((msg) => resolveOutgoingStatusMessageId(msg))
      .filter(Boolean);
    if (!messageIds.length) return false;
    const cappedMessageIds = messageIds.slice(-200);
    try {
      const { r, data } = await fetchOutgoingStatus({
        conversationId,
        senderDeviceId,
        receiverAccountDigest: peerDigest,
        messageIds: cappedMessageIds
      });
      if (!r?.ok || !data?.ok) return false;
      const items = Array.isArray(data?.items) ? data.items : [];
      const statusById = new Map(items.map((item) => [item?.messageId, item]));
      let changed = false;
      for (const msg of outgoingMessages) {
        const messageId = resolveOutgoingStatusMessageId(msg);
        if (!messageId) continue;
        const item = statusById.get(messageId);
        if (!item) continue;
        const outgoingCount = Number(item?.outgoingCount) || 0;
        const incomingCount = Number(item?.incomingCount) || 0;
        let nextStatus = null;
        if (outgoingCount > 0 && incomingCount > 0) {
          nextStatus = 'delivered';
        } else if (outgoingCount > 0) {
          nextStatus = 'sent';
        }
        if (!nextStatus) continue;
        if (applyOutgoingVaultStatus(msg, nextStatus)) changed = true;
      }
      return changed;
    } catch (err) {
      log({ outgoingVaultReconstructError: err?.message || err });
      return false;
    }
  }

  function extractFailureDetails(err, fallbackReason = 'send failed') {
    const reason = typeof err?.message === 'string'
      ? err.message
      : (typeof err === 'string' ? err : fallbackReason);
    let code = err?.code || err?.errorCode || err?.stage || null;
    if (!code && Number.isFinite(err?.status)) code = `HTTP_${Number(err.status)}`;
    if (!code) code = 'Unknown';
    if (code !== null && code !== undefined) code = String(code);
    return { reason, code };
  }

  function isCounterTooLowError(err) {
    if (!err) return false;
    const code = err?.code || err?.errorCode || err?.details?.error || err?.details?.code || err?.error || null;
    if (code && String(code) === 'CounterTooLow') return true;
    const message = typeof err?.message === 'string' ? err.message : '';
    return message.includes('CounterTooLow');
  }

  function applyOutgoingPending(message, reasonCode = 'PENDING_RESET') {
    if (!message) return;
    const fromStatus = typeof message.status === 'string' ? message.status : null;
    message.status = 'pending';
    message.pending = true;
    message.failureReason = null;
    message.failureCode = null;
    logOutgoingUiStatusTrace({
      message,
      fromStatus,
      toStatus: 'pending',
      reasonCode,
      stage: 'applyOutgoingPending'
    });
  }

  function applyOutgoingSent(message, res, fallbackTs, reasonCode = 'ACK_202') {
    if (!message) return;
    const fromStatus = typeof message.status === 'string' ? message.status : null;
    if (fromStatus === 'failed' || fromStatus === 'delivered' || fromStatus === 'read') return;
    if (isCounterTooLowError(res)) return;
    const localId = message.localId || message.messageId || message.id || null;
    const serverId = res?.msg?.id || res?.id || res?.serverMessageId || res?.server_message_id || null;
    if (serverId && localId && serverId !== localId) {
      throw new Error('messageId mismatch from server');
    }
    const finalId = serverId || message.id || localId;
    if (finalId) message.id = finalId;
    message.serverMessageId = serverId || finalId;
    message.status = 'sent';
    message.pending = false;
    message.failureReason = null;
    message.failureCode = null;
    const ts = res?.msg?.ts || res?.created_at || res?.createdAt || fallbackTs;
    if (Number.isFinite(ts)) message.ts = ts;
    logOutgoingUiStatusTrace({
      message,
      fromStatus,
      toStatus: 'sent',
      reasonCode,
      stage: 'applyOutgoingSent',
      ok: true,
      statusCode: res?.status ?? res?.r?.status ?? res?.statusCode ?? null,
      jobId: res?.jobId ?? res?.job?.jobId ?? null
    });
    logOutgoingStatusTrace(message, fromStatus, 'sent', reasonCode);
  }

  function applyOutgoingFailure(message, err, fallbackReason, reasonCode = 'SEND_FAIL') {
    if (!message) return;
    const fromStatus = typeof message.status === 'string' ? message.status : null;
    if (fromStatus === 'delivered' || fromStatus === 'read') return;
    const details = extractFailureDetails(err, fallbackReason);
    const statusCode = Number.isFinite(err?.status) ? Number(err.status) : null;
    const jobId = err?.jobId ?? err?.job?.jobId ?? null;
    const finalReasonCode = reasonCode || err?.stage || err?.code || 'SEND_FAIL';
    message.status = 'failed';
    message.pending = false;
    message.failureReason = details.reason || fallbackReason;
    message.failureCode = details.code || 'Unknown';
    logOutgoingUiStatusTrace({
      message,
      fromStatus,
      toStatus: 'failed',
      reasonCode: finalReasonCode,
      stage: 'applyOutgoingFailure',
      ok: false,
      statusCode,
      error: details.reason || fallbackReason || null,
      jobId
    });
    logOutgoingStatusTrace(message, fromStatus, 'failed', 'SEND_FAIL');
  }

  function buildCounterTooLowReplacementError() {
    const err = new Error('CounterTooLow replaced');
    err.code = 'COUNTER_TOO_LOW_REPLACED';
    return err;
  }

  function applyCounterTooLowReplaced(message, reasonCode = 'COUNTER_TOO_LOW_REPLACED') {
    if (!message) return;
    const err = buildCounterTooLowReplacementError();
    applyOutgoingFailure(message, err, '傳送失敗', reasonCode);
  }

  function getReplacementInfo(payload) {
    const info = payload?.replacement;
    if (!info || !info.newMessageId) return null;
    return info;
  }

  async function resendFailedOutgoingMessage(message) {
    try {
      if (!message || message.direction !== 'outgoing') return;
      if (message.status !== 'failed') return;
      if (message.failureCode === 'COUNTER_TOO_LOW_REPLACED') {
        updateMessagesStatusUI();
        return;
      }
      const state = getMessageState();
      const convId = message.conversationId || state.conversationId || null;
      const messageId = message.localId || message.messageId || message.id || null;
      if (!convId || !messageId) {
        applyOutgoingFailure(message, new Error('missing conversation or message id'), '無法重送：缺少對話資訊');
        updateMessagesStatusUI();
        return;
      }
      applyOutgoingPending(message, 'RESEND');
      updateMessagesStatusUI();
      let retryResult = null;
      try {
        retryResult = await retryOutboxMessage({ conversationId: convId, messageId });
      } catch (err) {
        retryResult = { ok: false, error: err?.message || err, errorCode: err?.code || null };
      }
      if (retryResult?.ok) {
        try {
          applyOutgoingSent(message, retryResult.data, message.ts || Math.floor(Date.now() / 1000));
        } catch (err) {
          applyOutgoingFailure(message, err, '重送失敗');
        }
        updateMessagesStatusUI();
        return;
      }
      if (retryResult?.errorCode === 'COUNTER_TOO_LOW_REPLACED') {
        applyCounterTooLowReplaced(message);
        updateMessagesStatusUI();
        return;
      }
      if (retryResult?.errorCode === 'OutboxInflight') {
        updateMessagesStatusUI();
        return;
      }
      if (isCounterTooLowError(retryResult)) {
        updateMessagesStatusUI();
        return;
      }
      if (retryResult?.errorCode !== 'OutboxJobMissing') {
        applyOutgoingFailure(message, retryResult, '重送失敗');
        updateMessagesStatusUI();
        return;
      }
      let senderDeviceId = message.senderDeviceId || null;
      if (!senderDeviceId) {
        try { senderDeviceId = ensureDeviceId(); } catch {}
      }
      if (!senderDeviceId) {
        applyOutgoingFailure(message, new Error('deviceId missing'), '無法重送：缺少裝置資訊');
        updateMessagesStatusUI();
        return;
      }
      const vaultRes = await MessageKeyVault.getMessageKey({ conversationId: convId, messageId, senderDeviceId });
      if (vaultRes?.ok) {
        applyOutgoingFailure(message, new Error('outbox payload missing'), '無法重送：缺少出站封包');
        updateMessagesStatusUI();
        return;
      }
      if (vaultRes?.error && vaultRes.error !== 'NotFound') {
        applyOutgoingFailure(message, new Error(vaultRes?.message || 'vault get failed'), '無法重送：金鑰讀取失敗');
        updateMessagesStatusUI();
        return;
      }
      if (message.type && message.type !== 'text') {
        applyOutgoingFailure(message, new Error('outbox payload missing for media'), '無法重送：缺少原始內容');
        updateMessagesStatusUI();
        return;
      }
      const peerAccountDigest = message.peerAccountDigest || state.activePeerDigest || resolvePeerForConversation(convId, state.activePeerDigest);
      const peerDeviceId = message.peerDeviceId || resolveTargetDeviceForConv(convId, peerAccountDigest) || state.activePeerDeviceId || null;
      if (!peerAccountDigest || !peerDeviceId) {
        applyOutgoingFailure(message, new Error('peer missing'), '無法重送：缺少對端裝置資訊');
        updateMessagesStatusUI();
        return;
      }
      try {
        const res = await sendDrText({
          peerAccountDigest,
          peerDeviceId,
          text: message.text || '',
          messageId
        });
        const replacementInfo = getReplacementInfo(res);
        const convIdFinal = res?.convId || convId;
        if (replacementInfo) {
          applyCounterTooLowReplaced(message);
          const replacementTs = res?.msg?.ts || message.ts || Math.floor(Date.now() / 1000);
          let replacementMsg = convIdFinal ? findTimelineMessageById(convIdFinal, replacementInfo.newMessageId) : null;
          if (!replacementMsg) {
            replacementMsg = appendLocalOutgoingMessage({
              text: message.text || '',
              ts: replacementTs,
              id: replacementInfo.newMessageId
            });
          }
          if (!res?.queued && replacementMsg) {
            applyOutgoingSent(replacementMsg, res, replacementTs, 'COUNTER_TOO_LOW_REPLACED');
          }
          updateMessagesStatusUI();
          if (!res?.queued && convIdFinal) {
            const targetDeviceId = resolveTargetDeviceForConv(convIdFinal, peerAccountDigest);
            const targetAccountDigest = toDigestOnly(peerAccountDigest);
            let senderDeviceId = null;
            try { senderDeviceId = ensureDeviceId(); } catch {}
            if (targetAccountDigest) {
              wsSendFn({
                type: 'message-new',
                targetAccountDigest,
                conversationId: convIdFinal,
                preview: message.text || '',
                ts: replacementTs,
                targetDeviceId,
                senderDeviceId
              });
            }
          }
          if (convIdFinal && !state.conversationId) state.conversationId = convIdFinal;
          return;
        }
        if (res?.queued) {
          updateMessagesStatusUI();
          return;
        }
        applyOutgoingSent(message, res, message.ts || Math.floor(Date.now() / 1000));
        updateMessagesStatusUI();
        if (convIdFinal && !state.conversationId) state.conversationId = convIdFinal;
        const targetDeviceId = resolveTargetDeviceForConv(convIdFinal, peerAccountDigest);
        const targetAccountDigest = toDigestOnly(peerAccountDigest);
        let senderDeviceId = null;
        try { senderDeviceId = ensureDeviceId(); } catch {}
        if (targetAccountDigest) {
          wsSendFn({
            type: 'message-new',
            targetAccountDigest,
            conversationId: convIdFinal,
            preview: message.text || '',
            ts: message.ts || Math.floor(Date.now() / 1000),
            targetDeviceId,
            senderDeviceId
          });
        }
      } catch (err) {
        const replacementInfo = getReplacementInfo(err);
        if (replacementInfo) {
          applyCounterTooLowReplaced(message);
          const replacementTs = message.ts || Math.floor(Date.now() / 1000);
          let replacementMsg = convId ? findTimelineMessageById(convId, replacementInfo.newMessageId) : null;
          if (!replacementMsg) {
            replacementMsg = appendLocalOutgoingMessage({
              text: message.text || '',
              ts: replacementTs,
              id: replacementInfo.newMessageId
            });
          }
          if (replacementMsg) {
            applyOutgoingFailure(replacementMsg, err, '重送失敗', 'COUNTER_TOO_LOW_REPAIR_FAILED');
          }
          updateMessagesStatusUI();
          return;
        }
        if (isCounterTooLowError(err)) {
          applyCounterTooLowReplaced(message);
          updateMessagesStatusUI();
          return;
        }
        applyOutgoingFailure(message, err, '重送失敗');
        updateMessagesStatusUI();
      }
    } finally {
      flushOutbox({ sourceTag: 'resend' }).catch(() => {});
    }
  }

  function applyAckDeliveryReceipt({ convId, ack, localMessage }) {
    const receipt = ack?.receipt || null;
    if (!receipt || receipt.type !== 'delivery') return;
    const messageId = receipt.message_id || ack?.msg?.id || ack?.id || localMessage?.id || null;
    if (!messageId || !convId) return;
    const deliveredAt = Number.isFinite(receipt.delivered_at) ? receipt.delivered_at : (ack?.msg?.ts || null);
    recordMessageDelivered(convId, messageId, deliveredAt);
    if (localMessage) {
      localMessage.id = localMessage.id || messageId;
      if (applyReceiptState(localMessage)) updateMessagesStatusUI();
    }
  }

  function handleMessageDecrypted({ message, allowReceipts = true } = {}) {
    if (!message) return;
    if (message.direction === 'incoming') {
      if (allowReceipts) {
        sendReadReceiptForMessage(message);
      }
    } else if (message.direction === 'outgoing') {
      if (applyReceiptState(message)) receiptRenderPending = true;
    }
  }

  function isUserTimelineMessage(msg) {
    const msgType = normalizeMsgTypeValue(msg?.type || msg?.msgType || msg?.subtype || msg?.meta?.msg_type);
    return msgType === 'text' || msgType === 'media' || msgType === 'call-log';
  }

  function isOutgoingFromSelf(msg, selfDigest) {
    if (!msg) return false;
    if (msg.direction === 'outgoing') return true;
    if (!selfDigest) return msg.direction === 'outgoing';
    const senderDigest = normalizeAccountDigest(
      msg.senderDigest || msg.sender_digest || msg.meta?.senderDigest || msg.meta?.sender_digest || msg.header?.sender_digest || null
    );
    return senderDigest ? senderDigest === selfDigest : msg.direction === 'outgoing';
  }

  function computeDoubleTickState({ timelineMessages, conversationId, selfDigest } = {}) {
    const normalizedSelf = normalizeAccountDigest(selfDigest || null);
    let lastUserId = null;
    let lastUserFromSelf = false;
    let lastDoubleTickId = null;
    if (!Array.isArray(timelineMessages) || !timelineMessages.length) {
      return { lastUserId, lastUserFromSelf, lastDoubleTickId };
    }
    for (let i = timelineMessages.length - 1; i >= 0; i -= 1) {
      const msg = timelineMessages[i];
      if (!isUserTimelineMessage(msg)) continue;
      const msgId = msg?.id || msg?.messageId || msg?.serverMessageId || null;
      if (!lastUserId) {
        lastUserId = msgId || null;
        lastUserFromSelf = isOutgoingFromSelf(msg, normalizedSelf);
        if (!lastUserFromSelf) break;
      }
      if (!isOutgoingFromSelf(msg, normalizedSelf) || !msgId || !conversationId) continue;
      const receipt = getMessageReceipt(conversationId, msgId);
      const delivered = getMessageDelivery(conversationId, msgId);
      if (receipt?.read || delivered?.delivered) {
        lastDoubleTickId = msgId;
        break;
      }
    }
    return { lastUserId, lastUserFromSelf, lastDoubleTickId };
  }

  function computeDoubleTickMessageId(params = {}) {
    const state = computeDoubleTickState(params);
    return state.lastDoubleTickId || null;
  }


  async function sendReadReceiptForMessage(message) {
    if (!message || message.direction !== 'incoming' || !message.id) return;
    const state = getMessageState();
    if (!state.activePeerDigest || !state.conversationId) return;
    const dedupeKey = `${state.conversationId}:${message.id}`;
    if (sentReadReceiptIds.has(dedupeKey)) return;
    sentReadReceiptIds.add(dedupeKey);
    const peerDeviceId = state.activePeerDeviceId || message.peerDeviceId || null;
    if (!peerDeviceId) {
      sentReadReceiptIds.delete(dedupeKey);
      return;
    }
    try {
      const payload = {
        type: CONTROL_MESSAGE_TYPES.READ_RECEIPT,
        conversationId: state.conversationId,
        messageId: message.id,
        senderAccountDigest: getAccountDigest() || null,
        senderDeviceId: ensureDeviceId(),
        targetAccountDigest: toDigestOnly(state.activePeerDigest),
        targetDeviceId: peerDeviceId,
        ts: Math.floor(Date.now() / 1000)
      };
      const result = wsSendFn(payload);
      if (result && typeof result.then === 'function') {
        await result;
      } else if (result === false) {
        sentReadReceiptIds.delete(dedupeKey);
      }
    } catch (err) {
      log({ readReceiptError: err?.message || err, messageId: message.id });
      sentReadReceiptIds.delete(dedupeKey);
    }
  }

  function findMessageById(id) {
    const state = getMessageState();
    return state.messages.find((msg) => msg.id === id) || null;
  }

  function findTimelineMessageById(conversationId, messageId) {
    if (!conversationId || !messageId) return null;
    const timeline = timelineGetTimeline(conversationId);
    return timeline.find((msg) => normalizeTimelineMessageId(msg) === messageId) || null;
  }

  function applyUploadProgress(message, { percent, error }) {
    if (!message?.media) return;
    if (Number.isFinite(percent)) {
      const pct = Math.min(100, Math.max(0, Math.round(percent)));
      message.media.progress = pct;
      message.media.uploading = pct < 100 && !error;
    }
    if (error) {
      message.media.error = error;
      message.media.uploading = false;
    }
  }

  function removeLocalMessageById(id) {
    const state = getMessageState();
    const idx = state.messages.findIndex((m) => m.id === id);
    if (idx >= 0) {
      state.messages.splice(idx, 1);
      updateMessagesUI({ scrollToEnd: true });
    }
  }

  function escapeSelector(value) {
    const str = String(value || '');
    try {
      if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(str);
    } catch {}
    return str.replace(/["\\]/g, '\\$&');
  }

  function updateUploadOverlayUI(messageId, media) {
    if (!elements.messagesList || !messageId || !media) return false;
    const selector = `.message-bubble[data-message-id="${escapeSelector(messageId)}"] .message-file`;
    const wrapper = elements.messagesList.querySelector(selector);
    if (!wrapper) return false;
    renderUploadOverlay(wrapper, media);
    scrollMessagesToBottomSoon();
    return true;
  }

  async function handleComposerFileSelection(event) {
    if (!requireSubscriptionActive()) return;
    const input = event?.target || event?.currentTarget || elements.fileInput;
    const files = input?.files ? Array.from(input.files).filter(Boolean) : [];
    if (!files.length) return;
    const state = getMessageState();
    if (!state.activePeerDigest || !state.conversationToken) {
      setMessagesStatus('請先選擇已建立安全對話的好友', true);
      return;
    }
    const contactEntry = sessionStore.contactIndex?.get?.(state.activePeerDigest) || null;
    const conversation = contactEntry?.conversation || null;
    try {
      for (const file of files) {
        const localUrl = URL.createObjectURL(file);
        const messageId = crypto.randomUUID();
        const previewText = `[檔案] ${file.name || '附件'}`;
        const localMsg = appendLocalOutgoingMessage({
          text: previewText,
          ts: Math.floor(Date.now() / 1000),
          id: messageId,
          type: 'media',
          media: {
            name: file.name || '附件',
            size: typeof file.size === 'number' ? file.size : null,
            contentType: file.type || 'application/octet-stream',
            localUrl,
            previewUrl: localUrl,
            uploading: true,
            progress: 0
          }
        });

        const progressHandler = (progress) => {
          const msg = findMessageById(localMsg.id);
          if (!msg) return;
          const percent = Number.isFinite(progress?.percent)
            ? progress.percent
            : (progress?.loaded && progress?.total ? (progress.loaded / progress.total) * 100 : null);
          applyUploadProgress(msg, { percent });
          updateUploadOverlayUI(msg.id, msg.media);
        };

        const abortController = new AbortController();
        localMsg.abortController = abortController;

        try {
          const res = await sendDrMedia({
            peerAccountDigest: state.activePeerDigest,
            file,
            conversation,
            convId: state.conversationId,
            dir: state.conversationId ? ['messages', state.conversationId] : 'messages',
            onProgress: progressHandler,
            abortSignal: abortController.signal,
            messageId
          });
          if (res?.convId && !state.conversationId) {
            state.conversationId = res.convId;
          }
          const msg = findMessageById(localMsg.id);
          const convId = res?.convId || state.conversationId;
          const replacementInfo = getReplacementInfo(res);
          if (res?.convId && !state.conversationId) {
            state.conversationId = res.convId;
          }
          const applyMediaMeta = (targetMsg, payload) => {
            if (!targetMsg) return;
            if (!targetMsg.media) targetMsg.media = {};
            targetMsg.text = payload?.msg?.text || targetMsg.text;
            targetMsg.media = {
              ...targetMsg.media,
              ...payload?.msg?.media,
              name: (payload?.msg?.media?.name || targetMsg.media.name || file.name || '附件'),
              size: Number.isFinite(payload?.msg?.media?.size) ? payload.msg.media.size : (typeof file.size === 'number' ? file.size : targetMsg.media.size || null),
              contentType: payload?.msg?.media?.contentType || targetMsg.media.contentType || file.type || 'application/octet-stream',
              localUrl: targetMsg.media.localUrl || localUrl,
              previewUrl: payload?.msg?.media?.previewUrl || targetMsg.media.previewUrl || targetMsg.media.localUrl || localUrl,
              uploading: false,
              progress: 100,
              envelope: payload?.msg?.media?.envelope || targetMsg.media.envelope || null,
              objectKey: payload?.msg?.media?.objectKey || targetMsg.media.objectKey || payload?.upload?.objectKey || null,
              preview: payload?.msg?.media?.preview || targetMsg.media.preview || null
            };
          };
          if (replacementInfo && msg) {
            applyCounterTooLowReplaced(msg);
            const replacementTs = res?.msg?.ts || Math.floor(Date.now() / 1000);
            let replacementMsg = convId ? findTimelineMessageById(convId, replacementInfo.newMessageId) : null;
            if (!replacementMsg) {
              const mediaClone = msg.media ? { ...msg.media } : null;
              if (mediaClone) {
                mediaClone.uploading = false;
                mediaClone.progress = 100;
              }
              replacementMsg = appendLocalOutgoingMessage({
                text: msg.text || previewText,
                ts: replacementTs,
                id: replacementInfo.newMessageId,
                type: 'media',
                media: mediaClone
              });
            }
            applyMediaMeta(replacementMsg, res);
            if (!res?.queued && replacementMsg) {
              applyOutgoingSent(replacementMsg, res, replacementTs, 'COUNTER_TOO_LOW_REPLACED');
            }
            updateMessagesStatusUI();
          } else if (res?.queued) {
            applyMediaMeta(msg, res);
            updateMessagesStatusUI();
          } else if (msg) {
            applyOutgoingSent(msg, res, Math.floor(Date.now() / 1000));
            applyMediaMeta(msg, res);
          }
          if (state.activePeerDigest && !res?.queued) {
            const targetDeviceId = resolveTargetDeviceForConv(convId, state.activePeerDigest);
            const targetAccountDigest = toDigestOnly(state.activePeerDigest);
            if (targetAccountDigest) {
              wsSendFn({
                type: 'message-new',
                targetAccountDigest,
                conversationId: convId,
                preview: msg?.text || previewText,
                ts: msg?.ts || Math.floor(Date.now() / 1000),
                senderDeviceId: ensureDeviceId(),
                targetDeviceId
              });
            }
          }
        } catch (err) {
          const msg = findMessageById(localMsg.id);
          const replacementInfo = getReplacementInfo(err);
          if (replacementInfo && msg) {
            applyCounterTooLowReplaced(msg);
            const replacementTs = Math.floor(Date.now() / 1000);
            let replacementMsg = state.conversationId
              ? findTimelineMessageById(state.conversationId, replacementInfo.newMessageId)
              : null;
            if (!replacementMsg) {
              const mediaClone = msg.media ? { ...msg.media } : null;
              if (mediaClone) {
                mediaClone.uploading = false;
                mediaClone.progress = 100;
              }
              replacementMsg = appendLocalOutgoingMessage({
                text: msg.text || previewText,
                ts: replacementTs,
                id: replacementInfo.newMessageId,
                type: 'media',
                media: mediaClone
              });
            }
            if (replacementMsg) {
              applyOutgoingFailure(replacementMsg, err, '檔案傳送失敗', 'COUNTER_TOO_LOW_REPAIR_FAILED');
              applyUploadProgress(replacementMsg, { percent: replacementMsg.media?.progress ?? 0, error: err?.message || err });
            }
            updateMessagesStatusUI();
            return;
          }
          if (msg && isCounterTooLowError(err)) {
            applyCounterTooLowReplaced(msg);
            updateMessagesStatusUI();
          } else {
            if (msg) {
              applyUploadProgress(msg, { percent: msg.media?.progress ?? 0, error: err?.message || err });
              applyOutgoingFailure(msg, err, '檔案傳送失敗');
              msg.text = `[上傳失敗] ${msg.media?.name || file.name || '附件'}`;
            }
            setMessagesStatus('檔案傳送失敗：' + (err?.message || err), true);
          }
        } finally {
          updateMessagesUI({ scrollToEnd: true, forceFullRender: true });
        }
      }
      setMessagesStatus('');
    } catch (err) {
      if (uiNoiseEnabled) {
        log({ messageComposerUploadError: err?.message || err });
      }
      setMessagesStatus('檔案傳送失敗：' + (err?.message || err), true);
    } finally {
      if (input) input.value = '';
    }
  }

  function applyMessagesLayout() {
    if (!elements.pane) return;
    const state = getMessageState();
    const desktop = isDesktopLayout();
    elements.pane.classList.toggle('is-desktop', desktop);
    if (desktop) {
      elements.pane.classList.remove('list-view');
      elements.pane.classList.remove('detail-view');
    } else {
      const mode = state.viewMode === 'detail' ? 'detail' : 'list';
      elements.pane.classList.toggle('detail-view', mode === 'detail');
      elements.pane.classList.toggle('list-view', mode === 'list');
    }
    if (elements.backBtn) {
      const showBack = !desktop && state.viewMode === 'detail';
      elements.backBtn.classList.toggle('hidden', !showBack);
    }
    if (typeof elements.composer === 'object' && elements.composer) {
      const isDetail = desktop || state.viewMode === 'detail';
      if (isDetail) {
        elements.composer.style.position = 'sticky';
        const kbOffset = Math.max(0, Math.floor(keyboardOffsetPx));
        elements.composer.style.bottom = kbOffset > 0 ? `${kbOffset}px` : '0';
        elements.composer.style.left = '0';
        elements.composer.style.right = '0';
        elements.composer.style.zIndex = '3';
      } else {
        elements.composer.style.position = '';
        elements.composer.style.bottom = '';
        elements.composer.style.left = '';
        elements.composer.style.right = '';
        elements.composer.style.zIndex = '';
      }
    }
    if (getCurrentTab?.() === 'messages') {
      const detail = desktop || state.viewMode === 'detail';
      const topbarEl = document.querySelector('.topbar');
      if (topbarEl) {
        if (detail && !desktop) {
          topbarEl.style.display = 'none';
        } else {
          topbarEl.style.display = '';
        }
      }
      if (!desktop) {
        const topbar = topbarEl && topbarEl.style.display === 'none' ? null : topbarEl;
        const topOffset = topbar ? topbar.offsetHeight : 0;
        elements.pane.style.position = 'fixed';
        elements.pane.style.top = `${topOffset}px`;
        elements.pane.style.left = '0';
        elements.pane.style.right = '0';
        elements.pane.style.bottom = '0';
        elements.pane.style.height = 'auto';
      } else {
        elements.pane.style.position = '';
        elements.pane.style.top = '';
        elements.pane.style.left = '';
        elements.pane.style.right = '';
        elements.pane.style.bottom = '';
        elements.pane.style.height = '';
      }
      if (detail) {
        topbarEl?.classList.add('hidden');
        navbarEl?.classList.add('hidden');
        mainContentEl?.classList.add('fullscreen');
        document.body.classList.add('messages-fullscreen');
        document.body.style.overscrollBehavior = 'contain';
      } else {
        topbarEl?.classList.remove('hidden');
        navbarEl?.classList.remove('hidden');
        mainContentEl?.classList.remove('fullscreen');
        document.body.classList.remove('messages-fullscreen');
        document.body.style.overscrollBehavior = '';
      }
    }
  }

  function updateLayoutMode({ force = false } = {}) {
    const desktop = isDesktopLayout();
    if (!force && lastLayoutIsDesktop === desktop) {
      applyMessagesLayout();
      applyKeyboardOffset();
      return;
    }
    lastLayoutIsDesktop = desktop;
    const state = getMessageState();
    if (!state.viewMode) {
      state.viewMode = state.activePeerDigest ? 'detail' : 'list';
    }
    if (!desktop && !state.activePeerDigest && state.viewMode !== 'list') {
      state.viewMode = 'list';
    }
    applyMessagesLayout();
    applyKeyboardOffset();
  }

  function refreshContactsUnreadBadges() {
    if (!sessionStore.contactState?.length) return;
    for (const contact of sessionStore.contactState) {
      const key = contactPeerKey(contact);
      if (!key) continue;
      const thread = getConversationThreads().get(contact?.conversation?.conversation_id || '') || null;
      const unread = thread?.unreadCount || 0;
      const contactEntry = sessionStore.contactIndex?.get?.(key);
      if (contactEntry && typeof contactEntry.unreadCount !== 'number') contactEntry.unreadCount = 0;
      if (contactEntry) contactEntry.unreadCount = unread;
    }
  }

  function showDeleteForPeer(peerAccountDigest) {
    const key = normalizePeerKey(peerAccountDigest);
    if (!key || !elements.conversationList) return false;
    const item = elements.conversationList.querySelector(`.conversation-item[data-peer="${key}"]`);
    if (!item) return false;
    const others = elements.conversationList.querySelectorAll('.conversation-item.show-delete');
    others.forEach((el) => {
      if (el !== item) {
        if (typeof closeSwipe === 'function') closeSwipe(el);
        else el.classList.remove('show-delete');
      }
    });
    item.classList.add('show-delete');
    try {
      item.scrollIntoView({ block: 'center', behavior: 'auto' });
    } catch {}
    return true;
  }

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
          const peerDigest = toDigestOnly(key);
          await deleteSecureConversation({ conversationId, peerAccountDigest: peerDigest, targetDeviceId: peerDeviceId });
          sessionStore.deletedConversations?.add?.(conversationId);
          getConversationThreads().delete(conversationId);
          sessionStore.conversationIndex?.delete?.(conversationId);
          removeContactCore(key, 'messages-pane:delete-conversation');
          if (element) closeSwipe?.(element);
          const state = getMessageState();
          if (state.activePeerDigest === key) {
            logConversationResetTrace({
              reason: 'DELETE_ACTIVE',
              conversationId: state?.conversationId || conversationId || null,
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
            updateComposerAvailability();
            applyMessagesLayout();
          }
          syncConversationThreadsFromContacts();
          refreshContactsUnreadBadges();
          renderConversationList();
          wsSendFn({
            type: 'conversation-deleted',
            targetAccountDigest: peerDigest,
            conversationId,
            senderDeviceId: ensureDeviceId(),
            targetDeviceId: peerDeviceId
          });
        } catch (err) {
          log({ conversationDeleteError: err?.message || err });
          alert(err?.message || '刪除對話失敗，請稍後再試。');
        }
      },
      onCancel: () => { if (element) closeSwipe?.(element); }
    });
  }

  async function syncContactConversation({ convId, peerDigest, peerDeviceId, tokenB64, reason }) {
    const key = `${convId || ''}::${peerDigest || ''}`;
    if (!convId || !peerDigest) return;
    if (contactSyncInFlight.has(key)) {
      try { log({ contactSyncSkip: { convId, peerDigest, reason: reason || null, cause: 'in-flight' } }); } catch {}
      return;
    }
    contactSyncInFlight.add(key);
    try {
      try {
        if (DEBUG.ws) {
          console.log('[contact-sync:start]', { convId, peerDigest, peerDeviceId, reason: reason || null });
        }
        log({ contactSyncStart: { convId, peerDigest, peerDeviceId: peerDeviceId || null, reason: reason || null } });
      } catch {}
      const normIdentity = normalizePeerIdentity({ peerAccountDigest: peerDigest, peerDeviceId: peerDeviceId });
      const resolvedPeerDeviceId = normIdentity.deviceId || peerDeviceId || null;
      logReplayCallsite('handleIncomingSecureMessage', {
        conversationId: convId || null,
        replay: false,
        allowReplay: false,
        mutateState: true,
        silent: true,
        limit: 20,
        cursorTs: null,
        cursorId: null
      });
      logReplayGateTrace('messages-pane:listSecureAndDecrypt:handleIncomingSecureMessage', {
        conversationId: convId || null,
        allowReplay: false,
        mutateState: true,
        replay: false,
        silent: true,
        messageId: null,
        serverMessageId: null
      });
      const syncResult = await listSecureAndDecrypt({
        conversationId: convId,
        tokenB64: tokenB64 || null,
        peerAccountDigest: peerDigest,
        peerDeviceId: resolvedPeerDeviceId,
        sendReadReceipt: false,
        onMessageDecrypted: () => {},
        silent: true
      });
      logReplayFetchResult({
        conversationId: convId || null,
        itemsLength: Array.isArray(syncResult?.items) ? syncResult.items.length : null,
        serverItemCount: syncResult?.serverItemCount ?? null,
        nextCursorTs: syncResult?.nextCursor?.ts ?? syncResult?.nextCursorTs ?? null,
        nextCursorId: syncResult?.nextCursor?.id ?? null,
        errorsLength: Array.isArray(syncResult?.errors) ? syncResult.errors.length : null
      });
      try {
        if (DEBUG.ws) {
          console.log('[contact-sync:done]', { convId, peerDigest, reason: reason || null });
        }
        log({ contactSyncDone: { convId, peerDigest, reason: reason || null } });
      } catch {}
    } catch (err) {
      log({ contactSyncError: err?.message || err, convId, peerDigest, reason: reason || null });
    } finally {
      contactSyncInFlight.delete(key);
    }
  }

  function handleIncomingSecureMessage(event) {
    const convId = String(event?.conversationId || event?.conversation_id || '').trim();
    if (convId && (convId.startsWith('profile-') || convId.startsWith('profile:'))) {
      // 自己的 profile 更新訊息，略過以免影響聯絡同步流程
      return;
    }
    const state = getMessageState();
    let existingConvEntry = null;
    try {
      try {
        if (DEBUG.ws) {
          console.log('[ws-secure-message]', {
            convId,
            senderAccountDigest: event?.senderAccountDigest || null,
            senderDeviceId: event?.senderDeviceId || null,
            targetDeviceId: event?.targetDeviceId || null,
            targetAccountDigest: event?.targetAccountDigest || event?.target_account_digest || null,
            peerAccountDigest: event?.peerAccountDigest || null,
            type: event?.type || null
          });
        }
        log({
          wsSecureMessage: {
            convId,
            senderAccountDigest: event?.senderAccountDigest || null,
            senderDeviceId: event?.senderDeviceId || null,
            targetDeviceId: event?.targetDeviceId || null,
            targetAccountDigest: event?.targetAccountDigest || event?.target_account_digest || null,
            peerAccountDigest: event?.peerAccountDigest || null,
            type: event?.type || null
          }
        });
      } catch {}
      if (!convId) return;
      const targetDeviceId = typeof event?.targetDeviceId === 'string' && event.targetDeviceId.trim().length
        ? event.targetDeviceId.trim()
        : null;
      const selfDeviceId = ensureDeviceId();
      if (!selfDeviceId || targetDeviceId !== String(selfDeviceId).trim()) {
        try {
          if (DEBUG.ws) {
            console.log('[messages-pane] skip secure-message (target mismatch)', { convId, targetDeviceId, selfDeviceId });
          }
          log({ secureMessageSkipTarget: { convId, targetDeviceId, selfDeviceId } });
        } catch {}
        return;
      }
      const senderDeviceId = typeof event?.senderDeviceId === 'string' && event.senderDeviceId.trim().length
        ? event.senderDeviceId.trim()
        : null;
      if (!senderDeviceId) return;
      const peerDeviceId = senderDeviceId;

      let tsRaw = Number(event?.ts ?? event?.timestamp);
      if (!Number.isFinite(tsRaw) || tsRaw <= 0) tsRaw = Math.floor(Date.now() / 1000);
      const clearAfter = getConversationClearAfter(convId);
      if (Number.isFinite(clearAfter) && tsRaw < clearAfter) {
        return;
      }

      if (event?.type === 'conversation-deleted') {
        const peerDigest = ensurePeerAccountDigest(event);
        sessionStore.deletedConversations?.add?.(convId);
        getConversationThreads().delete(convId);
        sessionStore.conversationIndex?.delete?.(convId);
        if (peerDigest) {
          removeContactCore(peerDigest, 'messages-pane:conversation-deleted');
        }
        if (convId) {
          clearConversationHistory(convId, tsRaw);
        }
        clearDrState(
          { peerAccountDigest: peerDigest, peerDeviceId: peerDeviceId || null },
          { __drDebugTag: 'web/src/app/ui/mobile/messages-pane.js:3107:conversation-deleted-clear' }
        );
        deleteContactSecret(peerDigest, { deviceId: ensureDeviceId() });
        const state = getMessageState();
        if (state.activePeerDigest === peerDigest || state.conversationId === convId) {
          logConversationResetTrace({
            reason: 'CONVERSATION_DELETED_WS',
            conversationId: state?.conversationId || convId || null,
            peerKey: peerDigest || null,
            peerDigest: peerDigest || null,
            peerDeviceId: peerDeviceId || null,
            hasToken: !!tokenB64,
            hasConversationId: !!convId,
            'entry.isReady': null,
            sourceTag: 'messages-pane:ws-conversation-deleted'
          });
          resetMessageStateWithPlaceholders();
          if (elements.peerName) elements.peerName.textContent = '選擇好友開始聊天';
          clearMessagesView();
          hideSecurityModal();
          updateComposerAvailability();
          applyMessagesLayout();
        }
        syncConversationThreadsFromContacts();
        refreshContactsUnreadBadges();
        renderConversationList();
        return;
      }

      const convIndex = ensureConversationIndex();
      existingConvEntry = convIndex.get(convId) || null;
      const tokenB64 = existingConvEntry?.token_b64 || null;
      const convEntryPeerDevice = existingConvEntry?.peerDeviceId || null;
      logCapped('incomingTokenLookupTrace', {
        conversationIdPrefix8: convId ? convId.slice(0, 8) : null,
        hasConvEntry: !!existingConvEntry,
        hasToken: !!tokenB64,
        peerDeviceSuffix4: convEntryPeerDevice ? String(convEntryPeerDevice).slice(-4) : null
      }, 5);
      if (!tokenB64) {
        const err = new Error('INVITE_SESSION_TOKEN_MISSING');
        err.code = 'INVITE_SESSION_TOKEN_MISSING';
        throw err;
      }
      const contactPeerFromConvId = (convId && convId.startsWith('contacts-'))
        ? convId.slice('contacts-'.length).trim().toUpperCase()
        : null;
      const peerFromEvent = ensurePeerAccountDigest(event);
      const peerDigestRaw = contactPeerFromConvId
        || peerFromEvent
        || existingConvEntry?.peerAccountDigest
        || null;
      const { digest: peerDigestForWrite } = splitPeerKey(peerDigestRaw);
      const resolvedPeerDeviceId = normalizePeerDeviceId(senderDeviceId || existingConvEntry?.peerDeviceId || peerDeviceId || null);
      if (!peerDigestForWrite || !resolvedPeerDeviceId) {
        console.warn('[secure-message] missing core', { convId, peerDigest: peerDigestRaw, resolvedPeerDeviceId, hasToken: !!tokenB64 });
        log({ secureMessageMissingCore: { convId, peerDigest: peerDigestRaw, resolvedPeerDeviceId, hasToken: !!tokenB64 } });
        if (!peerDigestForWrite) {
          logContactCoreWriteSkip({
            callsite: 'messages-pane:ws-incoming',
            conversationId: convId,
            hasDeviceId: !!resolvedPeerDeviceId
          });
        }
        return;
      }
      const peerKey = normalizePeerKey({ peerAccountDigest: peerDigestForWrite, peerDeviceId: resolvedPeerDeviceId }) || peerDigestRaw;
      const activePeerKey = normalizePeerKey(state.activePeerDigest);
      if (activePeerKey && peerKey && activePeerKey === peerKey) {
        if (!state.conversationId && convId) state.conversationId = convId;
        if (!state.conversationToken && tokenB64) state.conversationToken = tokenB64;
        if (!state.activePeerDeviceId && resolvedPeerDeviceId) state.activePeerDeviceId = resolvedPeerDeviceId;
      }
      upsertContactCore({
        peerAccountDigest: peerDigestForWrite,
        peerDeviceId: resolvedPeerDeviceId,
        conversationId: convId,
        conversationToken: tokenB64
      }, 'messages-pane:ws-incoming');

      // 立即觸發同步解密，避免後續分支提前 return。
      try {
        if (DEBUG.ws) {
          console.log('[contact-sync:enqueue]', { convId, peerDigest: peerDigestForWrite, senderDeviceId, reason: 'ws-incoming' });
        }
        log({ contactSyncEnqueue: { convId, peerDigest: peerDigestForWrite, senderDeviceId, reason: 'ws-incoming' } });
      } catch {}
      syncContactConversation({
        convId,
        peerDigest: peerDigestForWrite,
        peerDeviceId: resolvedPeerDeviceId,
        tokenB64,
        reason: 'ws-incoming'
      });
      const contactEntry = getContactCore(peerKey) || getContactCore(peerDigestForWrite) || null;
      const nickname = contactEntry?.nickname || `好友 ${peerDigestForWrite.slice(-4)}`;
      const avatar = contactEntry?.avatar || null;

      const thread = upsertConversationThread({
        peerAccountDigest: peerKey,
        peerDeviceId: resolvedPeerDeviceId,
        conversationId: convId,
        tokenB64,
        nickname,
        avatar
      }) || getConversationThreads().get(convId);
    if (!thread) return;

    const myAcctRaw = getAccountDigest();
    const myAcct = myAcctRaw ? String(myAcctRaw).toUpperCase() : null;
    const senderAcctRaw = event?.senderAccountDigest || null;
    const senderAcct = senderAcctRaw ? String(senderAcctRaw).replace(/[^0-9a-f]/gi, '').toUpperCase() : null;
    const isSelf = !!(myAcct && senderAcct && myAcct === senderAcct);

    const peerDigest = normalizeAccountDigest(event?.peerAccountDigest || event?.senderAccountDigest || null);
    if (!peerDigest) {
      try {
        console.warn('[secure-message] missing peerAccountDigest', { convId, senderAccountDigest: event?.senderAccountDigest || null });
        log({ secureMessageMissingPeerDigest: { convId, senderAccountDigest: event?.senderAccountDigest || null } });
      } catch {}
      return;
    }

    const rawMsgType = event?.meta?.msg_type || event?.meta?.msgType || event?.messageType || event?.msgType || null;
    const normalizedControlType = normalizeControlMessageType(rawMsgType);
    if (normalizedControlType) {
      if (normalizedControlType === CONTROL_MESSAGE_TYPES.READ_RECEIPT) {
        const targetId = event?.meta?.targetMessageId || event?.targetMessageId || null;
        if (targetId && state.conversationId) {
          recordMessageRead(state.conversationId, targetId, tsRaw);
          const msg = findMessageById(targetId);
          if (msg && applyReceiptState(msg)) {
            updateMessagesStatusUI();
          }
        }
      } else if (normalizedControlType === CONTROL_MESSAGE_TYPES.DELIVERY_RECEIPT) {
        const targetId = event?.meta?.targetMessageId || event?.targetMessageId || null;
        if (targetId && state.conversationId) {
          recordMessageDelivered(state.conversationId, targetId, tsRaw);
          const msg = findMessageById(targetId);
          if (msg && applyReceiptState(msg)) {
            updateMessagesStatusUI();
          }
        }
      } else {
        handleSecureConversationControlMessage({
          peerAccountDigest: peerKey,
          messageType: normalizedControlType,
          direction: isSelf ? 'outgoing' : 'incoming',
          source: 'ws:message-new'
        });
      }
      return;
    }

    const active = state.conversationId === convId && activePeerKey === peerKey;
    if (active) {
      if (!state.conversationId && convId) state.conversationId = convId;
      if (!state.conversationToken && tokenB64) state.conversationToken = tokenB64;
      if (!state.activePeerDigest && peerDigest) state.activePeerDigest = peerDigest;
      if (peerDeviceId && !state.activePeerDeviceId) state.activePeerDeviceId = peerDeviceId;
    }

    if (active) {
      pendingWsRefresh += 1;
      if (!state.loading) {
        pendingWsRefresh = 0;
        loadActiveConversationMessages({ append: false })
          .then(() => scrollMessagesToBottom())
          .catch((err) => log({ wsMessageSyncError: err?.message || err }))
          .finally(() => { pendingWsRefresh = 0; });
      }
      return;
    }
  } catch (err) {
    const isInviteTokenMissing = err?.code === 'INVITE_SESSION_TOKEN_MISSING'
      || err?.message === 'INVITE_SESSION_TOKEN_MISSING';
    if (isInviteTokenMissing) {
      const peerDigestFromEvent = normalizeAccountDigest(
        event?.peerAccountDigest
        || event?.senderAccountDigest
        || event?.targetAccountDigest
        || null
      );
      const peerDigestFromEntry = existingConvEntry?.peerAccountDigest
        ? splitPeerKey(existingConvEntry.peerAccountDigest).digest
        : null;
      const peerAccountDigest = peerDigestFromEvent || peerDigestFromEntry || null;
      const peerDeviceId = normalizePeerDeviceId(
        event?.senderDeviceId
        || event?.peerDeviceId
        || existingConvEntry?.peerDeviceId
        || null
      );
      logCapped('inviteSessionTokenMissingDropped', {
        conversationId: convId || null,
        peerAccountDigest,
        peerDeviceId,
        reasonCode: 'INVITE_SESSION_TOKEN_MISSING',
        callsite: 'messages-pane:incomingSecureMessage'
      }, 5);
      return;
    }
    try {
      console.error('[secure-message] handler error', err);
      log({ secureMessageHandlerError: { convId, error: err?.message || String(err) } });
    } catch {}
  }

  }

  function handleVaultAckEvent(event) {
    const convId = String(event?.conversationId || event?.conversation_id || '').trim();
    const messageId = String(event?.messageId || event?.message_id || '').trim();
    if (!convId || !messageId) return;
    let tsRaw = Number(event?.ts ?? event?.timestamp);
    if (Number.isFinite(tsRaw) && tsRaw > 10_000_000_000) {
      tsRaw = Math.floor(tsRaw / 1000);
    }
    if (!Number.isFinite(tsRaw) || tsRaw <= 0) tsRaw = Math.floor(Date.now() / 1000);
    recordMessageDelivered(convId, messageId, tsRaw);
    logCapped('vaultAckWsRecvTrace', { conversationId: convId || null, messageId: messageId || null }, 5);
    const state = getMessageState();
    if (state.conversationId !== convId) return;
    const localMessage = findMessageById(messageId) || findTimelineMessageById(convId, messageId);
    if (localMessage && applyReceiptState(localMessage)) {
      updateMessagesStatusUI();
    }
  }

  function handleContactOpenConversation(detail) {
    const identity = normalizePeerIdentity({
      peerAccountDigest: detail?.peerAccountDigest,
      peerDeviceId: detail?.peerDeviceId || detail?.conversation?.peerDeviceId || null
    });
    const peerDigest = identity.key
      || (identity.accountDigest && identity.deviceId ? `${identity.accountDigest}::${identity.deviceId}` : null)
      || normalizePeerKey(detail?.peerAccountDigest);
    try {
      if (uiNoiseEnabled) {
        console.log('[messages-pane]', { contactOpenDetail: detail, peerDigest });
      }
    } catch {}
    if (!peerDigest) return;
    syncConversationThreadsFromContacts();
    const conversation = detail?.conversation;
    if (conversation?.conversation_id && conversation?.token_b64) {
      const threads = getConversationThreads();
      const prev = threads.get(conversation.conversation_id) || {};
      threads.set(conversation.conversation_id, {
        ...prev,
        conversationId: conversation.conversation_id,
        conversationToken: conversation.token_b64,
        peerAccountDigest: peerDigest,
        peerDeviceId: detail?.peerDeviceId || identity.deviceId || prev.peerDeviceId || null,
        nickname: prev.nickname || detail?.nickname || `好友 ${peerDigest.slice(-4)}`,
        avatar: prev.avatar || detail?.avatar || null,
        lastMessageText: typeof prev.lastMessageText === 'string' ? prev.lastMessageText : '',
        lastMessageTs: typeof prev.lastMessageTs === 'number' ? prev.lastMessageTs : null,
        lastMessageId: prev.lastMessageId || null,
        lastReadTs: typeof prev.lastReadTs === 'number' ? prev.lastReadTs : null,
        unreadCount: typeof prev.unreadCount === 'number' ? prev.unreadCount : 0,
        previewLoaded: !!prev.previewLoaded
      });
    }
    switchTab?.('messages');
    setActiveConversation(peerDigest);
  }

  function openConversationFromToast({ peerAccountDigest, convId, tokenB64, peerDeviceId }) {
    if (uiNoiseEnabled) {
      try { log({ toastNavigate: { peerAccountDigest, convId } }); } catch {}
    }
    switchTab?.('messages');
    syncConversationThreadsFromContacts();
    const threads = getConversationThreads();
    const threadByConv = convId ? threads.get(convId) : null;
    const targetPeer = normalizePeerKey(peerAccountDigest ?? threadPeer(threadByConv));
    const contactStateEntry = Array.isArray(sessionStore.contactState)
      ? sessionStore.contactState.find((c) => contactPeerKey(c) === targetPeer)
      : null;
    const contactStatePeerDeviceId = contactStateEntry?.peerDeviceId || null;
    const targetPeerDeviceId = peerDeviceId || threadByConv?.peerDeviceId || contactStatePeerDeviceId || null;
    const contactStateConv = contactStateEntry?.conversation || null;
    const state = getMessageState();
    const token = tokenB64
      || threadByConv?.conversationToken
      || contactStateConv?.token_b64
      || contactStateConv?.tokenB64
      || null;
    const conversationId = convId
      || threadByConv?.conversationId
      || contactStateConv?.conversation_id
      || contactStateConv?.conversationId
      || null;
    const { digest: targetPeerDigest } = splitPeerKey(targetPeer);
    const resolvedDeviceId = normalizePeerDeviceId(targetPeerDeviceId);
    if (targetPeer && conversationId && token && resolvedDeviceId && targetPeerDigest) {
      upsertContactCore({
        peerAccountDigest: targetPeerDigest,
        peerDeviceId: resolvedDeviceId,
        conversationId,
        conversationToken: token,
        nickname: threadByConv?.nickname || contactStateEntry?.nickname || null,
        avatar: threadByConv?.avatar || contactStateEntry?.avatar || null
      }, 'messages-pane:open-from-toast');
    } else if (targetPeer && (!targetPeerDigest)) {
      logContactCoreWriteSkip({
        callsite: 'messages-pane:open-from-toast',
        conversationId,
        hasDeviceId: !!resolvedDeviceId
      });
    }
    if (targetPeer) {
      const p = setActiveConversation(targetPeer);
      if (p?.catch && uiNoiseEnabled) p.catch((err) => log({ toastOpenConversationError: err?.message || err }));
      return;
    }
    if (conversationId && token) {
      state.activePeerDigest = null;
      state.conversationId = conversationId;
      state.conversationToken = token;
      loadActiveConversationMessages({ append: false })
        .then(() => scrollMessagesToBottom())
        .catch((err) => {
          if (uiNoiseEnabled) log({ toastOpenConversationError: err?.message || err });
        });
      renderConversationList();
      return;
    }
    if (uiNoiseEnabled) {
      log({ toastOpenConversationError: 'missing conversation info', peerAccountDigest: targetPeer, convId });
    }
    showToast?.('同步中，請稍後再試', { variant: 'warning' });
    refreshConversationPreviews({ force: true }).catch((err) => {
      if (uiNoiseEnabled) log({ toastRefreshPreviewError: err?.message || err });
    });
  }

  function attachDomEvents() {
    elements.backBtn?.addEventListener('click', () => {
      const state = getMessageState();
      state.viewMode = 'list';
      applyMessagesLayout();
      elements.input?.blur();
      switchTab?.('messages', { fromBack: true });
      hideSecurityModal();
      stopActivePoll();
    });

    elements.attachBtn?.addEventListener('click', () => {
      if (!elements.fileInput) {
        showToast?.('找不到檔案上傳元件', { variant: 'warning' });
        return;
      }
      if (!requireSubscriptionActive()) return;
      elements.fileInput.click();
    });

    elements.fileInput?.addEventListener('change', (event) => {
      handleComposerFileSelection(event);
    });

    elements.callBtn?.addEventListener('click', () => handleConversationAction('voice'));
    elements.videoBtn?.addEventListener('click', () => handleConversationAction('video'));
    elements.createGroupBtn?.addEventListener('click', handleCreateGroup);

    if (elements.scrollEl) {
      elements.scrollEl.addEventListener('scroll', handleMessagesScroll, { passive: true });
      elements.scrollEl.addEventListener('touchend', handleMessagesTouchEnd, { passive: true });
      elements.scrollEl.addEventListener('touchcancel', handleMessagesTouchEnd, { passive: true });
      elements.scrollEl.addEventListener('wheel', handleMessagesWheel, { passive: true });
    }

    elements.messagesList?.addEventListener('click', (event) => {
      const target = event.target?.closest?.('.message-status.failed');
      if (!target) return;
      const messageId = target.dataset?.messageId || null;
      if (!messageId) return;
      const msg = findMessageById(messageId);
      if (!msg || msg.status !== 'failed') return;
      resendFailedOutgoingMessage(msg).catch((err) => {
        applyOutgoingFailure(msg, err, '重送失敗');
        updateMessagesStatusUI();
      });
    });

    elements.loadMoreBtn?.addEventListener('click', () => {
      loadActiveConversationMessages({ append: true, reason: 'scroll' });
    });

    elements.createGroupBtn?.addEventListener('click', handleCreateGroup);

    if (elements.conversationList) {
      elements.conversationList.addEventListener('touchstart', handleConversationPullStart, { passive: true });
      elements.conversationList.addEventListener('touchmove', handleConversationPullMove, { passive: false });
      elements.conversationList.addEventListener('touchend', handleConversationPullEnd, { passive: true });
      elements.conversationList.addEventListener('touchcancel', handleConversationPullEnd, { passive: true });
    }

    elements.conversationList?.addEventListener('click', (event) => {
      const target = event.target.closest('.conversation-item');
      if (!target || target.classList.contains('disabled')) return;
      const peer = target.dataset.peer;
      if (peer) setActiveConversation(peer);
    });

    elements.composer?.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!requireSubscriptionActive()) {
        setMessagesStatus('帳號已到期，請先儲值', true);
        return;
      }
      const text = (elements.input?.value || '').trim();
      if (!text) return;
      const state = getMessageState();
      const contactEntryLog = state.activePeerDigest ? sessionStore.contactIndex?.get?.(state.activePeerDigest) : null;
      if (uiNoiseEnabled) {
        log({
          messageComposerSubmit: {
            peer: state.activePeerDigest,
            hasToken: !!state.conversationToken,
            contactHasToken: !!contactEntryLog?.conversation?.token_b64
          }
        });
      }
      if (!state.conversationToken || !state.activePeerDigest) {
        setMessagesStatus('請先選擇已建立安全對話的好友', true);
        return;
      }
      if (elements.sendBtn) elements.sendBtn.disabled = true;
      const ts = Math.floor(Date.now() / 1000);
      const messageId = crypto.randomUUID();
      suppressComposerBlurOnce();
      const localMsg = appendLocalOutgoingMessage({ text, ts, id: messageId });
      if (elements.input) {
        elements.input.value = '';
        elements.input.focus();
      }
      try {
        const res = await sendDrText({
          peerAccountDigest: state.activePeerDigest,
          peerDeviceId: state.activePeerDeviceId || null,
          text,
          messageId
        });
        if (uiNoiseEnabled) {
          log({
            messageComposerSent: {
              peer: state.activePeerDigest,
              convId: res?.convId || null,
              msgId: res?.msg?.id || res?.id || null
            }
          });
        }
        const replacementInfo = getReplacementInfo(res);
        const convId = res?.convId || state.conversationId;
        if (res?.convId) state.conversationId = res.convId;
        if (replacementInfo && localMsg) {
          applyCounterTooLowReplaced(localMsg);
          const replacementTs = res?.msg?.ts || ts;
          let replacementMsg = convId ? findTimelineMessageById(convId, replacementInfo.newMessageId) : null;
          if (!replacementMsg) {
            replacementMsg = appendLocalOutgoingMessage({ text, ts: replacementTs, id: replacementInfo.newMessageId });
          }
          if (!res?.queued && replacementMsg) {
            applyOutgoingSent(replacementMsg, res, replacementTs, 'COUNTER_TOO_LOW_REPLACED');
          }
          updateMessagesStatusUI();
        } else if (res?.queued) {
          updateMessagesStatusUI();
        } else if (localMsg) {
          applyOutgoingSent(localMsg, res, ts);
          updateMessagesStatusUI();
        }
        const targetDeviceId = resolveTargetDeviceForConv(convId, state.activePeerDigest);
        setMessagesStatus('');
        if (convId && state.activePeerDigest && !res?.queued) {
          const targetAccountDigest = toDigestOnly(state.activePeerDigest);
          if (targetAccountDigest) {
            wsSendFn({
              type: 'message-new',
              targetAccountDigest,
              conversationId: convId,
              preview: text,
              ts,
              targetDeviceId,
              senderDeviceId: ensureDeviceId()
            });
          }
        }
      } catch (err) {
        if (uiNoiseEnabled) {
          log({ messageComposerError: err?.message || err });
        }
        const replacementInfo = getReplacementInfo(err);
        if (replacementInfo && localMsg) {
          applyCounterTooLowReplaced(localMsg);
          const replacementTs = ts || Math.floor(Date.now() / 1000);
          let replacementMsg = state.conversationId
            ? findTimelineMessageById(state.conversationId, replacementInfo.newMessageId)
            : null;
          if (!replacementMsg) {
            replacementMsg = appendLocalOutgoingMessage({ text, ts: replacementTs, id: replacementInfo.newMessageId });
          }
          if (replacementMsg) {
            applyOutgoingFailure(replacementMsg, err, '傳送失敗', 'COUNTER_TOO_LOW_REPAIR_FAILED');
          }
          updateMessagesStatusUI();
          return;
        }
        if (localMsg && isCounterTooLowError(err)) {
          applyCounterTooLowReplaced(localMsg);
          updateMessagesStatusUI();
          return;
        }
        setMessagesStatus('傳送失敗：' + (err?.message || err), true);
        if (localMsg) {
          applyOutgoingFailure(localMsg, err, '傳送失敗', 'UI_SEND_THROW');
          updateMessagesStatusUI();
        }
      } finally {
        if (elements.sendBtn) elements.sendBtn.disabled = false;
      }
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
    if (outboxHooksRegistered) return;
    outboxHooksRegistered = true;
    setOutboxHooks({
      onSent: async (job, response) => {
        if (!job || job.type !== 'message') return;
        const convId = job?.conversationId || null;
        const messageId = job?.messageId || null;
        if (!convId || !messageId) return;
        const message = findTimelineMessageById(convId, messageId);
        if (!message || message.direction !== 'outgoing') return;
        const status = typeof message.status === 'string' ? message.status : null;
        if (status === 'failed' || status === 'delivered' || status === 'read') return;
        const payload = response?.data || job?.lastResponse || null;
        const payloadWithJobId = payload && typeof payload === 'object'
          ? { ...payload, jobId: job?.jobId || null }
          : { jobId: job?.jobId || null };
        const fallbackTs = Number.isFinite(Number(job?.createdAt))
          ? Math.floor(Number(job.createdAt))
          : (Number.isFinite(Number(message.ts)) ? Number(message.ts) : Math.floor(Date.now() / 1000));
        try {
          applyOutgoingSent(message, payloadWithJobId, fallbackTs, 'OUTBOX_SENT_HOOK');
        } catch (err) {
          applyOutgoingFailure(message, err, '傳送失敗', 'OUTBOX_SENT_HOOK_ERROR');
        }
        const state = getMessageState();
        if (state.conversationId === convId) updateMessagesStatusUI();
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
        const isCounterTooLow = isCounterTooLowError(errWithJob);
        const failureErr = isCounterTooLow ? buildCounterTooLowReplacementError() : errWithJob;
        if (failureErr && typeof failureErr === 'object' && errWithJob && typeof errWithJob === 'object') {
          if (errWithJob.status) failureErr.status = errWithJob.status;
          if (errWithJob.jobId && !failureErr.jobId) failureErr.jobId = errWithJob.jobId;
        }
        const reasonCode = isCounterTooLow
          ? 'COUNTER_TOO_LOW_REPLACED'
          : 'OUTBOX_FAILED_HOOK';
        applyOutgoingFailure(message, failureErr, '傳送失敗', reasonCode);
        const state = getMessageState();
        if (state.conversationId === convId) updateMessagesStatusUI();
      }
    });
  }

  function initKeyboardListeners() {
    if (typeof window === 'undefined' || !window.visualViewport) return;
    const onViewportChange = () => {
      try {
        const vv = window.visualViewport;
        if (!vv) return;
        const heightDiff = window.innerHeight - vv.height;
        const offset = Math.max(0, heightDiff - (vv.offsetTop || 0));
        keyboardOffsetPx = offset;
        applyKeyboardOffset();
        if (elements.scrollEl) {
          elements.scrollEl.scrollTop = elements.scrollEl.scrollHeight;
        }
      } catch (err) {
        log({ keyboardOffsetError: err?.message || err });
      }
    };
    window.visualViewport.addEventListener('resize', onViewportChange);
    window.visualViewport.addEventListener('scroll', onViewportChange);
    window.addEventListener('orientationchange', onViewportChange);
    onViewportChange();
  }

  function ensureSetup() {
    if (!elements.pane) elements.pane = document.querySelector('.messages-pane');
    if (elements.pane) elements.pane.style.overscrollBehavior = 'contain';
    if (!elements.messagesList) elements.messagesList = document.getElementById('messagesList');
    if (!elements.messagesEmpty) elements.messagesEmpty = document.getElementById('messagesEmpty');
    if (!elements.scrollEl) elements.scrollEl = document.getElementById('messagesScroll');
    if (elements.scrollEl) elements.scrollEl.style.overscrollBehavior = 'contain';
    if (!elements.loadMoreBtn) elements.loadMoreBtn = document.getElementById('messagesLoadMore');
    if (!elements.loadMoreLabel) elements.loadMoreLabel = document.querySelector('#messagesLoadMore .label');
    if (!elements.loadMoreSpinner) elements.loadMoreSpinner = document.querySelector('#messagesLoadMore .spinner');
    startViewportGuard();
  }

  registerOutboxHooks();
  ensureSetup();
  initKeyboardListeners();
  renderGroupDrafts();

  return {
    attachDomEvents,
    refreshAfterReconnect: async () => {
      try { await refreshConversationPreviews({ force: true }); } catch (err) { log({ refreshAfterReconnectPreviewError: err?.message || err }); }
      const state = getMessageState();
      if (state.activePeerDigest && state.conversationToken) {
        try {
          await loadActiveConversationMessages({ append: false, replay: false, silent: true, reason: 'ws-reconnect' });
        } catch (err) {
          log({ refreshAfterReconnectLoadError: err?.message || err });
        }
      }
    },
    updateLayoutMode,
    renderConversationList,
    refreshConversationPreviews,
    syncConversationThreadsFromContacts,
    refreshContactsUnreadBadges,
    clearMessagesView,
    updateComposerAvailability,
    loadActiveConversationMessages,
    setActiveConversation,
    appendLocalOutgoingMessage,
    handleIncomingSecureMessage,
    handleVaultAckEvent,
    handleContactOpenConversation,
    handleContactEntryUpdated,
    setMessagesStatus,
    getMessageState,
    ensureConversationIndex,
    getConversationThreads,
    setWsSend(fn) { wsSendFn = typeof fn === 'function' ? fn : () => false; },
    updateMessagesUI,
    applyMessagesLayout,
    triggerAutoLoadOlder,
    setLoadMoreState,
    showDeleteForPeer
  };
}
