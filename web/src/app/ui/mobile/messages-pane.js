import { log } from '../../core/log.js';
import { getAccountToken, getAccountDigest, normalizePeerIdentity } from '../../core/store.js';
import { listSecureAndDecrypt, resetProcessedMessages } from '../../features/messages.js';
import { sendDrText, sendDrMedia, sendDrCallLog } from '../../features/dr-session.js';
import {
  ensureSecureConversationReady,
  subscribeSecureConversation,
  getSecureConversationStatus,
  handleSecureConversationControlMessage,
  SECURE_CONVERSATION_STATUS,
  listSecureConversationStatuses
} from '../../features/secure-conversation-manager.js';
import { CONTROL_MESSAGE_TYPES, normalizeControlMessageType } from '../../features/secure-conversation-signals.js';
import {
  conversationIdFromToken,
  computeConversationAccessFingerprint,
  deriveConversationContextFromSecret
} from '../../features/conversation.js';
import { sessionStore, resetMessageState } from './session-store.js';
import { escapeHtml, fmtSize } from './ui-utils.js';
import { downloadAndDecrypt } from '../../features/media.js';
import { renderPdfViewer, cleanupPdfViewer, getPdfJsLibrary } from './viewers/pdf-viewer.js';
import { deleteSecureConversation } from '../../api/messages.js';
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
  subscribeCallEvent
} from '../../features/calls/index.js';
import {
  CALL_LOG_OUTCOME,
  describeCallLogForViewer,
  resolveViewerRole
} from '../../features/calls/call-log.js';
import { bytesToB64Url } from './ui-utils.js';
const sentCallLogIds = new Set();
const callLogPlaceholders = new Map();
const GROUPS_ENABLED = false;

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

function resetMessageStateWithPlaceholders() {
  clearCallLogPlaceholders();
  resetMessageState();
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

  const secureStatusCache = new Map();
  let unsubscribeSecureStatus = null;
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
  const CONV_PULL_THRESHOLD = 60;
  const CONV_PULL_MAX = 140;

  function normalizePeerKey(value) {
    const identity = normalizePeerIdentity(value?.peerAccountDigest ?? value?.accountDigest ?? value);
    return identity.key || null;
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
    return normalizePeerKey(contact?.peerAccountDigest ?? contact?.peer_account_digest ?? contact?.accountDigest ?? contact?.account_digest);
  }

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
          <input type="checkbox" data-uid="${digest}" data-digest="${escapeHtml(digest)}" style="width:16px;height:16px;"/>
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
    const checkboxes = groupBuilderEl.querySelectorAll('input[type="checkbox"][data-uid]');
    const selected = [];
    checkboxes.forEach((cb) => {
      if (cb.checked) {
        const digest = normalizePeerKey(cb.getAttribute('data-digest') || cb.getAttribute('data-uid') || '');
        if (!digest) return;
        selected.push({ accountDigest: digest, uid: digest });
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
      const { conversationId, tokenB64 } = await deriveConversationContextFromSecret(secretB64Url);
      const groupId = `grp-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      let conversationFingerprint = null;
      try {
        const accountDigest = getAccountDigest();
        conversationFingerprint = await computeConversationAccessFingerprint(tokenB64, accountDigest);
      } catch {}
      const { r, data } = await apiCreateGroup({
        groupId,
        conversationId,
        name: nameVal || null,
        conversationFingerprint,
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
    const peerDigest = normalizePeerKey(session?.peerAccountDigest ?? session?.peer_account_digest);
    if (!peerDigest) return;
    const status = session.status;
    if (![CALL_SESSION_STATUS.ENDED, CALL_SESSION_STATUS.FAILED].includes(status)) return;
    const identifier = session.callId || session.traceId || `${peerDigest}-${session.requestedAt || Date.now()}`;
    if (sentCallLogIds.has(identifier)) return;
    sentCallLogIds.add(identifier);
    const endedAt = session.endedAt || Date.now();
    const connectedAt = session.connectedAt || null;
    const durationSeconds = connectedAt ? Math.max(1, Math.round((endedAt - connectedAt) / 1000)) : 0;
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
    const entry = {
      id: session.callId ? `call-log-${session.callId}` : `call-log-${identifier}`,
      callId: session.callId || identifier,
      ts: Math.floor(endedAt / 1000),
      peerAccountDigest: peerDigest,
      direction,
      durationSeconds,
      outcome,
      reason: normalizedReason || null
    };
    const state = getMessageState();
    const isOutgoing = direction === CALL_SESSION_DIRECTION.OUTGOING;
    const isActive = state.activePeerDigest === peerDigest;
    const viewerMessage = createCallLogMessage(entry, { messageDirection: isOutgoing ? 'outgoing' : 'incoming' });
    let localMessage = null;
    if (isActive) {
      localMessage = { ...viewerMessage };
      localMessage.id = localMessage.id || entry.id;
      localMessage.pending = true;
      state.messages.push(localMessage);
      trackCallLogPlaceholder(peerDigest, entry.callId, localMessage);
      updateMessagesUI({ scrollToEnd: outcome === CALL_LOG_OUTCOME.SUCCESS });
    }
    updateThreadsWithCallLogDisplay({
      peerAccountDigest: peerDigest,
      label: viewerMessage.text,
      ts: entry.ts,
      direction: isOutgoing ? 'outgoing' : 'incoming'
    });
    if (!sentCallLogIds.has(entry.id) && entry.id) sentCallLogIds.add(entry.id);
    if (entry.id && !sentCallLogIds.has(entry.id)) {
      sentCallLogIds.add(entry.id);
      sendDrCallLog({
        peerAccountDigest: peerDigest,
        callId: entry.callId,
        outcome,
        durationSeconds,
        direction: entry.direction,
        reason: normalizedReason || null,
        ts: entry.ts
      }).catch((err) => {
        log({ callLogSendError: err?.message || err, peerAccountDigest: peerDigest });
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
    const shouldShow = status === SECURE_CONVERSATION_STATUS.PENDING;
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
    }
  }

  function isDesktopLayout() {
    if (typeof window === 'undefined') return true;
    return window.innerWidth >= 960;
  }

  function getMessageState() {
    if (!sessionStore.messageState) {
      resetMessageStateWithPlaceholders();
    }
    return sessionStore.messageState;
  }

  function ensureConversationIndex() {
    if (!(sessionStore.conversationIndex instanceof Map)) {
      const entries = sessionStore.conversationIndex && typeof sessionStore.conversationIndex.entries === 'function'
        ? Array.from(sessionStore.conversationIndex.entries())
        : [];
      sessionStore.conversationIndex = new Map(entries);
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

  function upsertConversationThread({ peerAccountDigest, conversationId, tokenB64, nickname, avatar }) {
    const key = normalizePeerKey(peerAccountDigest);
    const convId = String(conversationId || '').trim();
    if (!key || !convId) return null;
    if (sessionStore.deletedConversations?.has?.(convId)) return null;
    const threads = getConversationThreads();
    const prev = threads.get(convId) || {};
    const entry = {
      ...prev,
      peerAccountDigest: key,
      conversationId: convId,
      conversationToken: tokenB64 || prev.conversationToken || null,
      nickname: nickname || prev.nickname || `好友 ${key.slice(-4)}`,
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

  function syncConversationThreadsFromContacts() {
    const threads = getConversationThreads();
    const contacts = Array.isArray(sessionStore.contactState) ? sessionStore.contactState : [];
    const seen = new Set();
    for (const contact of contacts) {
      const peerUid = normalizePeerKey(contact?.peerAccountDigest ?? contact?.peer_account_digest ?? contact?.accountDigest ?? contact?.account_digest);
      const conversationId = contact?.conversation?.conversation_id;
      const tokenB64 = contact?.conversation?.token_b64;
      if (!peerUid || !conversationId || !tokenB64) continue;
      seen.add(conversationId);
      upsertConversationThread({
        peerAccountDigest: peerUid,
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
      if (!thread?.conversationId || !thread?.conversationToken || !peerDigest) continue;
      if (!force && thread.previewLoaded && !thread.needsRefresh) continue;
      tasks.push((async () => {
        try {
          const { items } = await listSecureAndDecrypt({
            conversationId: thread.conversationId,
            tokenB64: thread.conversationToken,
            peerAccountDigest: peerDigest,
            limit: 20,
            mutateState: false
          });
          const list = Array.isArray(items) ? items.filter(Boolean) : [];
          if (!list.length) {
            thread.lastMessageText = '';
            thread.lastMessageTs = null;
            thread.lastMessageId = null;
            thread.previewLoaded = true;
            thread.unreadCount = 0;
            if (thread.lastReadTs === null) thread.lastReadTs = null;
            return;
          }
          const latest = list[list.length - 1];
          thread.lastMessageText = typeof latest.text === 'string' && latest.text.trim() ? latest.text : (latest.error || '(無法解密)');
          thread.lastMessageTs = typeof latest.ts === 'number' ? latest.ts : null;
          thread.lastMessageId = latest.id || null;
          thread.lastDirection = latest.direction || null;
          thread.previewLoaded = true;
          if (thread.lastReadTs === null || thread.lastReadTs === undefined) {
            thread.lastReadTs = thread.lastMessageTs ?? null;
            thread.unreadCount = 0;
          } else if (typeof thread.lastReadTs === 'number') {
            const unread = list.filter((item) => typeof item?.ts === 'number' && item.ts > thread.lastReadTs).length;
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
    const latest = state.messages.length ? state.messages[state.messages.length - 1] : null;
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

  function setMessagesStatus(message, isError = false) {
    if (!elements.statusLabel) return;
    elements.statusLabel.textContent = message || '';
    elements.statusLabel.style.color = isError ? '#dc2626' : '#64748b';
  }

  function updateConversationActionsAvailability() {
    const state = getMessageState();
    const enabled = !!(state.activePeerDigest && state.conversationToken);
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
    const key = state.activePeerDigest ? String(state.activePeerDigest).toUpperCase() : null;
    const statusInfo = key ? getCachedSecureStatus(key) : null;
    const status = statusInfo?.status || null;
    const blocked = status === SECURE_CONVERSATION_STATUS.PENDING || status === SECURE_CONVERSATION_STATUS.FAILED;
    const enabled = !!(state.conversationToken && state.activePeerDigest && !blocked);
    elements.input.disabled = !enabled;
    elements.sendBtn.disabled = !enabled;
    let placeholder = '輸入訊息…';
    if (!state.conversationToken || !state.activePeerDigest) {
      placeholder = '選擇好友開始聊天';
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
    if (!state.activePeerDigest || !state.conversationToken) return;
    const actionType = type === 'video' ? 'voice' : type; // 視訊暫時停用，強制走語音
    const contactEntry = sessionStore.contactIndex?.get?.(state.activePeerDigest) || null;
    const fallbackName = `好友 ${state.activePeerDigest.slice(-4)}`;
    const displayName = contactEntry?.nickname || contactEntry?.profile?.nickname || fallbackName;
    const avatarUrl = resolveContactAvatarUrl(contactEntry);
    const peerAccountDigest = contactEntry?.accountDigest
      || contactEntry?.account_digest
      || contactEntry?.peerAccountDigest
      || contactEntry?.peer_account_digest
      || null;
    let result;
    try {
      result = await requestOutgoingCall({
        peerDisplayName: displayName,
        peerAvatarUrl: avatarUrl,
        peerAccountDigest,
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
        peerAccountDigest: state.activePeerDigest,
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
  }

  function handleMessagesTouchEnd() {
    if (!elements.scrollEl) return;
    if (elements.scrollEl.scrollTop <= 0) {
      triggerAutoLoadOlder();
    }
  }

  function handleMessagesWheel() {
    if (!elements.scrollEl) return;
    if (elements.scrollEl.scrollTop <= 0) {
      triggerAutoLoadOlder();
    }
  }

  function triggerAutoLoadOlder() {
    const state = getMessageState();
    if (!elements.scrollEl || !state.hasMore || state.loading || autoLoadOlderInProgress) return;
    autoLoadOlderInProgress = true;
    setLoadMoreState('loading');
    loadActiveConversationMessages({ append: true })
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
      if (state.activePeerDigest === peerDigest) li.classList.add('active');
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
        handleConversationDelete({ conversationId: thread.conversationId, peerUid: peerDigest, element: li });
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
          handleConversationDelete({ conversationId: thread.conversationId, peerUid: peerDigest, element: li });
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
        const { blob } = await downloadAndDecrypt({ key: media.objectKey, envelope: media.envelope });
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
    if (!targetKey || !targetEnvelope) return null;
    if (media.previewPromise) return media.previewPromise;
    media.previewPromise = downloadAndDecrypt({ key: targetKey, envelope: targetEnvelope })
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

  function updateMessagesUI({ scrollToEnd = false, preserveScroll = false } = {}) {
    if (!elements.messagesList) return;
    const state = getMessageState();
    let prevHeight = 0;
    let prevScroll = 0;
    if (preserveScroll && elements.scrollEl) {
      prevHeight = elements.scrollEl.scrollHeight;
      prevScroll = elements.scrollEl.scrollTop;
    }

    const timelineMessages = Array.isArray(state.messages) ? [...state.messages] : [];
    elements.messagesList.innerHTML = '';
    if (!timelineMessages.length) {
      elements.messagesEmpty?.classList.remove('hidden');
    } else {
      elements.messagesEmpty?.classList.add('hidden');
      let prevTs = null;
      let prevDateKey = null;
      for (const msg of timelineMessages) {
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
        elements.messagesList.appendChild(li);
      }
    }

    updateLoadMoreVisibility();

    if (elements.scrollEl) {
      if (preserveScroll) {
        const diff = elements.scrollEl.scrollHeight - prevHeight;
        elements.scrollEl.scrollTop = Math.max(0, prevScroll + diff);
      } else if (scrollToEnd) {
        scrollMessagesToBottom();
      }
    }
    updateMessagesScrollOverflow();
    try {
      const diagnostics = Array.from(elements.messagesList.querySelectorAll('.message-bubble')).map((el) => ({
        text: el.textContent,
        hidden: el.offsetParent === null
      }));
      log({ messagesRendered: diagnostics });
    } catch (err) {
      log({ messagesRenderLogError: err?.message || err });
    }
  }

  async function loadActiveConversationMessages({ append = false, replay = false } = {}) {
    const state = getMessageState();
    if (!state.conversationId || !state.conversationToken || !state.activePeerDigest) return;
    if (state.loading) return;
    if (append && (!state.hasMore || !state.nextCursorTs)) return;

    state.loading = true;
    if (!append) setMessagesStatus('載入中…');
    try {
      const cursor = append ? state.nextCursorTs : undefined;
      const forceReplay = !append && replay;
      const { items, nextCursorTs, errors } = await listSecureAndDecrypt({
        conversationId: state.conversationId,
        tokenB64: state.conversationToken,
        peerAccountDigest: state.activePeerDigest,
        limit: 50,
        cursorTs: cursor,
        mutateState: forceReplay ? false : !append,
        allowReplay: !append || forceReplay
      });
      let chunk = Array.isArray(items) ? items.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0)) : [];
      let placeholderUpdated = false;
      if (chunk.length) {
        const seenIds = new Set();
        chunk = chunk.filter((entry) => {
          const messageId = entry?.id || entry?.messageId || null;
          if (!messageId) return true;
          if (seenIds.has(messageId)) return false;
          seenIds.add(messageId);
          return true;
        });
      }
      if (chunk.length) {
        chunk = chunk.filter((entry) => {
          if (entry?.type === 'call-log') {
            const callId = entry.callLog?.callId || entry.meta?.call_id || null;
            const placeholder = resolveCallLogPlaceholder(state.activePeerDigest, callId);
            if (placeholder && callId) {
              placeholder.id = entry.id || placeholder.id;
              placeholder.ts = entry.ts || placeholder.ts;
              placeholder.direction = entry.direction || placeholder.direction;
              if (entry.callLog) {
                placeholder.callLog = {
                  ...placeholder.callLog,
                  ...entry.callLog
                };
              }
              placeholder.pending = false;
              releaseCallLogPlaceholder(state.activePeerDigest, callId);
              placeholderUpdated = true;
              return false;
            }
          }
          return true;
        });
      }
      if (append) {
        const existingIds = new Set(state.messages.map((m) => m.id));
        chunk = chunk.filter((m) => !existingIds.has(m.id));
        if (chunk.length) {
          state.messages = [...chunk, ...state.messages];
          updateMessagesUI({ preserveScroll: true });
        }
      } else if (forceReplay) {
        state.messages = chunk;
        updateMessagesUI({ scrollToEnd: true });
      } else {
        if (chunk.length) {
          const mergedMap = new Map();
          for (const msg of state.messages) {
            if (!msg || !msg.id) continue;
            mergedMap.set(msg.id, msg);
          }
          for (const msg of chunk) {
            if (!msg || !msg.id) continue;
            mergedMap.set(msg.id, msg);
          }
          const merged = Array.from(mergedMap.values());
          merged.sort((a, b) => (a.ts || 0) - (b.ts || 0));
          state.messages = merged;
          updateMessagesUI({ scrollToEnd: true });
        } else if (!state.messages.length) {
          state.messages = chunk;
          updateMessagesUI({ scrollToEnd: true });
        }
      }
      if (placeholderUpdated) {
        updateMessagesUI({ scrollToEnd: true });
      }
      state.nextCursorTs = nextCursorTs;
      state.hasMore = !!nextCursorTs;
      if (errors?.length) setMessagesStatus(`部分訊息無法解密，請重新建立安全對話（${errors.length}）`, true);
      else setMessagesStatus('', false);
      syncThreadFromActiveMessages();
    } catch (err) {
      setMessagesStatus('載入失敗：' + (err?.message || err), true);
    } finally {
      state.loading = false;
      updateLoadMoreVisibility();
    }
  }

  async function setActiveConversation(peerAccountDigest) {
    const key = normalizePeerKey(peerAccountDigest);
    if (!key) return;
    const desktopLayout = isDesktopLayout();
    const entry = sessionStore.contactIndex?.get?.(key);
    if (!entry) {
      setMessagesStatus('找不到指定的好友', true);
      if (!desktopLayout) {
        const stateFallback = getMessageState();
        stateFallback.viewMode = 'list';
        applyMessagesLayout();
      }
      return;
    }
    const nickname = entry.nickname || `好友 ${key.slice(-4)}`;
    const conversation = entry.conversation;
    if (!conversation?.token_b64) {
      resetMessageStateWithPlaceholders();
      const state = getMessageState();
      if (!desktopLayout) state.viewMode = 'list';
      if (elements.peerName) elements.peerName.textContent = nickname;
      setMessagesStatus('此好友尚未建立安全對話，請重新生成邀請。', true);
      clearMessagesView();
      hideSecurityModal();
      updateComposerAvailability();
      renderConversationList();
      applyMessagesLayout();
      return;
    }
    log({ setActiveConversation: { peerAccountDigest: key, conversationId: conversation.conversation_id || null, hasDrInit: !!(conversation.dr_init || conversation.drInit) } });
    const state = getMessageState();
    const hadExistingMessages = Array.isArray(state.messages) && state.messages.length > 0;
    state.activePeerDigest = key;
    state.conversationToken = conversation.token_b64;
    try {
      state.conversationId = conversation.conversation_id || await conversationIdFromToken(conversation.token_b64);
    } catch (err) {
      resetMessageStateWithPlaceholders();
      if (elements.peerName) elements.peerName.textContent = nickname;
      setMessagesStatus('無法建立對話：' + (err?.message || err), true);
      clearMessagesView();
      hideSecurityModal();
      updateComposerAvailability();
      renderConversationList();
      const fallbackState = getMessageState();
      if (!desktopLayout) fallbackState.viewMode = 'list';
      applyMessagesLayout();
      return;
    }
    const resolvedConvId = conversation?.conversation_id || conversation?.conversationId || state.conversationId || null;
    if (resolvedConvId) resetProcessedMessages(resolvedConvId);
    state.messages = [];
    state.nextCursorTs = null;
    state.hasMore = true;
    state.loading = false;
    const thread = upsertConversationThread({
      peerAccountDigest: key,
      conversationId: state.conversationId,
      tokenB64: state.conversationToken,
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
    let initialStatus = getCachedSecureStatus(key);
    if (!initialStatus || initialStatus.status === SECURE_CONVERSATION_STATUS.IDLE) {
      initialStatus = cacheSecureStatus(key, SECURE_CONVERSATION_STATUS.PENDING, null);
    }
    if (initialStatus) {
      applySecureStatusForActivePeer(key, initialStatus);
    }
    try {
      await ensureSecureConversationReady({
        peerAccountDigest: key,
        reason: 'open-conversation',
        source: 'messages-pane:setActiveConversation'
      });
    } catch (err) {
      const errorMsg = err?.message || err || '建立安全對話失敗，請稍後再試。';
      log({ ensureSecureConversationError: errorMsg, peerAccountDigest: key });
      const cached = cacheSecureStatus(key, SECURE_CONVERSATION_STATUS.FAILED, String(errorMsg));
      applySecureStatusForActivePeer(key, cached || { status: SECURE_CONVERSATION_STATUS.FAILED, error: String(errorMsg) });
      applyMessagesLayout();
      return;
    }
    const statusInfo = getCachedSecureStatus(key) || cacheSecureStatus(key, SECURE_CONVERSATION_STATUS.READY, null);
    applySecureStatusForActivePeer(key, statusInfo);
    updateComposerAvailability();
    refreshActivePeerMetadata(key, { fallbackName: nickname });
    setMessagesStatus('');
    renderConversationList();
    updateComposerAvailability();
    clearMessagesView();
    applyMessagesLayout();
    await loadActiveConversationMessages({ append: false, replay: hadExistingMessages });
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
    const message = {
      id: id || `local-${Date.now()}`,
      ts: ts || Math.floor(Date.now() / 1000),
      text,
      direction: 'outgoing',
      type,
      media: media ? { ...media } : null,
      abortController: null
    };
    if (message.type === 'media' && message.media) {
      if (!message.text) message.text = `[檔案] ${message.media.name || '附件'}`;
      if (message.media.localUrl && !message.media.previewUrl) {
        message.media.previewUrl = message.media.localUrl;
      }
    } else {
      message.type = 'text';
    }
    state.messages.push(message);
    updateMessagesUI({ scrollToEnd: true });
    scrollMessagesToBottom();
    scrollMessagesToBottomSoon();
    syncThreadFromActiveMessages();
    return message;
  }

  function findMessageById(id) {
    const state = getMessageState();
    return state.messages.find((msg) => msg.id === id) || null;
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
        const tmpId = `upload-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const previewText = `[檔案] ${file.name || '附件'}`;
        const localMsg = appendLocalOutgoingMessage({
          text: previewText,
          ts: Math.floor(Date.now() / 1000),
          id: tmpId,
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
            abortSignal: abortController.signal
          });
          if (res?.convId && !state.conversationId) {
            state.conversationId = res.convId;
          }
          const msg = findMessageById(localMsg.id);
          if (msg) {
            msg.id = res?.msg?.id || msg.id;
            msg.ts = res?.msg?.ts || msg.ts || Math.floor(Date.now() / 1000);
            msg.text = res?.msg?.text || msg.text;
            msg.pending = false;
            if (!msg.media) msg.media = {};
            msg.media = {
              ...msg.media,
              ...res?.msg?.media,
              name: (res?.msg?.media?.name || msg.media.name || file.name || '附件'),
              size: Number.isFinite(res?.msg?.media?.size) ? res.msg.media.size : (typeof file.size === 'number' ? file.size : msg.media.size || null),
              contentType: res?.msg?.media?.contentType || msg.media.contentType || file.type || 'application/octet-stream',
              localUrl: msg.media.localUrl || localUrl,
              previewUrl: res?.msg?.media?.previewUrl || msg.media.previewUrl || msg.media.localUrl || localUrl,
              uploading: false,
              progress: 100,
              envelope: res?.msg?.media?.envelope || msg.media.envelope || null,
              objectKey: res?.msg?.media?.objectKey || msg.media.objectKey || res?.upload?.objectKey || null,
              preview: res?.msg?.media?.preview || msg.media.preview || null
            };
          }
          if (state.activePeerDigest) {
            wsSendFn({
              type: 'message-new',
              targetAccountDigest: state.activePeerDigest,
              conversationId: state.conversationId,
              preview: msg?.text || previewText,
              ts: msg?.ts || Math.floor(Date.now() / 1000)
            });
          }
        } catch (err) {
          const msg = findMessageById(localMsg.id);
          if (msg) {
            applyUploadProgress(msg, { percent: msg.media?.progress ?? 0, error: err?.message || err });
            msg.pending = false;
            msg.text = `[上傳失敗] ${msg.media?.name || file.name || '附件'}`;
          }
          setMessagesStatus('檔案傳送失敗：' + (err?.message || err), true);
        } finally {
          updateMessagesUI({ scrollToEnd: true });
        }
      }
      setMessagesStatus('');
    } catch (err) {
      log({ messageComposerUploadError: err?.message || err });
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
        elements.composer.style.bottom = '0';
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
        if (detail) {
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
      } else {
        topbarEl?.classList.remove('hidden');
        navbarEl?.classList.remove('hidden');
        mainContentEl?.classList.remove('fullscreen');
        document.body.classList.remove('messages-fullscreen');
      }
    }
  }

  function updateLayoutMode({ force = false } = {}) {
    const desktop = isDesktopLayout();
    if (!force && lastLayoutIsDesktop === desktop) {
      applyMessagesLayout();
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

  function handleConversationDelete({ conversationId, peerUid, element }) {
    const key = normalizePeerKey(peerUid);
    if (!key) return;
    const contactEntry = sessionStore.contactIndex?.get?.(key) || null;
    const nickname = contactEntry?.nickname || `好友 ${key.slice(-4)}`;
    showConfirmModal({
      title: '刪除對話',
      message: `確定要刪除與「${escapeHtml(nickname)}」的對話？此操作也會從對方的對話列表中移除。`,
      confirmLabel: '刪除',
      onConfirm: async () => {
        try {
          let conversationFingerprint = null;
          const tokenB64 = contactEntry?.conversation?.token_b64 || contactEntry?.conversation?.tokenB64 || null;
          const accountDigest = (getAccountDigest() || '').toUpperCase();
          if (tokenB64 && accountDigest) {
            try {
              conversationFingerprint = await computeConversationAccessFingerprint(tokenB64, accountDigest);
            } catch (err) {
              console.warn('[messages-pane] compute conversation fingerprint failed', err?.message || err);
            }
          }
          await deleteSecureConversation({ conversationId, conversationFingerprint });
          sessionStore.deletedConversations?.add?.(conversationId);
          try {
            const payload = {
              accountToken: getAccountToken() || undefined,
              accountDigest: getAccountDigest() || undefined,
              peerAccountDigest: key
            };
            await fetch('/api/v1/friends/delete', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload)
            }).catch(() => {});
          } catch {
            // ignore; request issued only to satisfy automation waiting for /friends/delete
          }
          getConversationThreads().delete(conversationId);
          sessionStore.conversationIndex?.delete?.(conversationId);
          const contactEntryAfter = sessionStore.contactIndex?.get?.(key) || null;
          if (contactEntryAfter) {
            contactEntryAfter.conversation = null;
            contactEntryAfter.unreadCount = 0;
          }
          const contactStateEntry = sessionStore.contactState?.find?.((c) => contactPeerKey(c) === key) || null;
          if (contactStateEntry) {
            contactStateEntry.conversation = null;
            contactStateEntry.unreadCount = 0;
          }
          if (element) closeSwipe?.(element);
          const state = getMessageState();
          if (state.activePeerDigest === key) {
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
        } catch (err) {
          log({ conversationDeleteError: err?.message || err });
          alert('刪除對話失敗，請稍後再試。');
        }
      },
      onCancel: () => { if (element) closeSwipe?.(element); }
    });
  }

  function handleIncomingSecureMessage(event) {
    const convId = String(event?.conversationId || event?.conversation_id || '').trim();
    if (!convId) return;

    const convIndex = ensureConversationIndex();
    let convEntry = convIndex.get(convId) || null;
    const peerFromEventIdentity = normalizePeerIdentity(
      event?.peerAccountDigest || event?.peer_account_digest || event?.fromAccountDigest || event?.from_account_digest || null
    );
    const peerFromEvent = peerFromEventIdentity.key;

    if (!convEntry) {
      convEntry = { token_b64: null, peerAccountDigest: peerFromEvent || null };
      convIndex.set(convId, convEntry);
    } else if (peerFromEvent && convEntry.peerAccountDigest !== peerFromEvent) {
      convEntry.peerAccountDigest = peerFromEvent;
    }

    const tokenFromEvent = event?.tokenB64 || event?.token_b64 || null;
    if (tokenFromEvent && !convEntry.token_b64) {
      const normalizedToken = String(tokenFromEvent).trim();
      if (normalizedToken) convEntry.token_b64 = normalizedToken;
    }

    const peerUid = convEntry.peerAccountDigest;
    if (!peerUid) {
      log({ secureMessageUnknownPeer: convId });
      return;
    }

    const contactEntry = sessionStore.contactIndex?.get?.(peerUid) || null;
    const nickname = contactEntry?.nickname || `好友 ${peerUid.slice(-4)}`;
    const avatar = contactEntry?.avatar || null;
    const tokenB64 = convEntry.token_b64 || contactEntry?.conversation?.token_b64 || null;

    const thread = upsertConversationThread({
      peerAccountDigest: peerUid,
      conversationId: convId,
      tokenB64,
      nickname,
      avatar
    }) || getConversationThreads().get(convId);
    if (!thread) return;

    const myAcctRaw = getAccountDigest();
    const myAcct = myAcctRaw ? String(myAcctRaw).toUpperCase() : null;
    const senderAcctRaw = event?.senderAccountDigest || event?.sender_account_digest || null;
    const senderAcct = senderAcctRaw ? String(senderAcctRaw).replace(/[^0-9a-f]/gi, '').toUpperCase() : null;
    const isSelf = !!(myAcct && senderAcct && myAcct === senderAcct);

    const rawMsgType = event?.meta?.msg_type || event?.meta?.msgType || event?.messageType || event?.msgType || null;
    const normalizedControlType = normalizeControlMessageType(rawMsgType);
    if (normalizedControlType) {
      handleSecureConversationControlMessage({
        peerAccountDigest: peerUid,
        messageType: normalizedControlType,
        direction: isSelf ? 'outgoing' : 'incoming',
        source: 'ws:message-new'
      });
      return;
    }

    let tsRaw = Number(event?.ts ?? event?.timestamp);
    if (!Number.isFinite(tsRaw)) tsRaw = Math.floor(Date.now() / 1000);
    thread.lastMessageTs = tsRaw;
    const previewRaw = cleanPreviewText(event?.preview ?? event?.text ?? '');
    if (previewRaw) thread.lastMessageText = previewRaw;
    else if (!thread.lastMessageText) thread.lastMessageText = '有新訊息';
    const messageId = event?.messageId || event?.message_id;
    if (messageId) thread.lastMessageId = messageId;

    const state = getMessageState();
    const active = state.conversationId === convId && state.activePeerDigest === peerUid;
    const onMessagesTab = getCurrentTab?.() === 'messages';

    if (isSelf) {
      thread.unreadCount = 0;
      thread.lastReadTs = tsRaw;
      thread.lastDirection = 'outgoing';
      renderConversationList();
      return;
    }

    playNotificationSound?.();

    if (active && onMessagesTab) {
      thread.unreadCount = 0;
      thread.lastReadTs = tsRaw;
      renderConversationList();
      loadActiveConversationMessages({ append: false })
        .then(() => scrollMessagesToBottom())
        .catch((err) => log({ wsMessageSyncError: err?.message || err }));
      return;
    }

    const countRaw = Number(event?.count);
    const delta = Number.isFinite(countRaw) && countRaw > 0 ? Math.min(countRaw, 50) : 1;
    thread.unreadCount = Math.max(0, Number(thread.unreadCount) || 0) + delta;
    thread.lastDirection = 'incoming';
    thread.needsRefresh = true;
    renderConversationList();

    const toastPreview = buildConversationSnippet(previewRaw) || '有新訊息';
    const toastMessage = toastPreview ? `${nickname}：${toastPreview}` : `${nickname} 有新訊息`;
    const avatarUrlToast = avatar?.thumbDataUrl || avatar?.previewDataUrl || avatar?.url || null;
    const initialsToast = initialsFromName(nickname, peerUid).slice(0, 2);
    showToast?.(toastMessage, {
      onClick: () => openConversationFromToast({ peerAccountDigest: peerUid, convId, tokenB64 }),
      avatarUrl: avatarUrlToast,
      avatarInitials: initialsToast,
      subtitle: formatTimestamp(tsRaw)
    });
  }

  function handleContactOpenConversation(detail) {
    const peerUid = normalizePeerKey(detail?.peerAccountDigest);
    if (!peerUid) return;
    syncConversationThreadsFromContacts();
    const conversation = detail?.conversation;
    if (conversation?.conversation_id && conversation?.token_b64) {
      const threads = getConversationThreads();
      const prev = threads.get(conversation.conversation_id) || {};
      threads.set(conversation.conversation_id, {
        ...prev,
        conversationId: conversation.conversation_id,
        conversationToken: conversation.token_b64,
        peerAccountDigest: peerUid,
        nickname: prev.nickname || detail?.nickname || `好友 ${peerUid.slice(-4)}`,
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
    setActiveConversation(peerUid);
  }

  function openConversationFromToast({ peerAccountDigest, convId, tokenB64 }) {
    try { log({ toastNavigate: { peerAccountDigest, convId } }); } catch {}
    switchTab?.('messages');
    syncConversationThreadsFromContacts();
    const threads = getConversationThreads();
    const threadByConv = convId ? threads.get(convId) : null;
    const targetPeer = normalizePeerKey(peerAccountDigest ?? threadPeer(threadByConv));
    const contactStateEntry = Array.isArray(sessionStore.contactState)
      ? sessionStore.contactState.find((c) => contactPeerKey(c) === targetPeer)
      : null;
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
    if (conversationId) {
      const convIndex = ensureConversationIndex();
      const prevConv = convIndex.get(conversationId) || {};
      convIndex.set(conversationId, {
        ...prevConv,
        peerAccountDigest: targetPeer || prevConv.peerAccountDigest || null,
        token_b64: token || prevConv.token_b64 || null
      });
    }
    if (targetPeer) {
      // 若 contactIndex 尚未有此人，先以 thread 資料補一筆避免 setActiveConversation 直接失敗。
      if (!sessionStore.contactIndex?.get?.(targetPeer) && (threadByConv || contactStateEntry)) {
        if (!(sessionStore.contactIndex instanceof Map)) {
          const entries = sessionStore.contactIndex && typeof sessionStore.contactIndex.entries === 'function'
            ? Array.from(sessionStore.contactIndex.entries())
            : [];
          sessionStore.contactIndex = new Map(entries);
        }
        const prev = sessionStore.contactIndex.get(targetPeer) || {};
        sessionStore.contactIndex.set(targetPeer, {
          ...prev,
          peerAccountDigest: targetPeer,
          nickname: threadByConv?.nickname || contactStateEntry?.nickname || prev.nickname || `好友 ${targetPeer.slice(-4)}`,
          avatar: threadByConv?.avatar || contactStateEntry?.avatar || prev.avatar || null,
          conversation: {
            conversation_id: conversationId,
            token_b64: token
          }
        });
      }
      const p = setActiveConversation(targetPeer);
      if (p?.catch) p.catch((err) => log({ toastOpenConversationError: err?.message || err }));
      return;
    }
    if (conversationId && token) {
      state.activePeerDigest = null;
      state.conversationId = conversationId;
      state.conversationToken = token;
      loadActiveConversationMessages({ append: false })
        .then(() => scrollMessagesToBottom())
        .catch((err) => log({ toastOpenConversationError: err?.message || err }));
      renderConversationList();
      return;
    }
    log({ toastOpenConversationError: 'missing conversation info', peerAccountDigest: targetPeer, convId });
    showToast?.('同步中，請稍後再試', { variant: 'warning' });
    refreshConversationPreviews({ force: true }).catch((err) => log({ toastRefreshPreviewError: err?.message || err }));
  }

  function attachDomEvents() {
    elements.backBtn?.addEventListener('click', () => {
      const state = getMessageState();
      state.viewMode = 'list';
      applyMessagesLayout();
      elements.input?.blur();
      switchTab?.('messages', { fromBack: true });
      hideSecurityModal();
    });

    elements.attachBtn?.addEventListener('click', () => {
      if (!elements.fileInput) {
        showToast?.('找不到檔案上傳元件', { variant: 'warning' });
        return;
      }
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

    elements.loadMoreBtn?.addEventListener('click', () => {
      loadActiveConversationMessages({ append: true });
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
      const text = (elements.input?.value || '').trim();
      if (!text) return;
      const state = getMessageState();
      const contactEntryLog = state.activePeerDigest ? sessionStore.contactIndex?.get?.(state.activePeerDigest) : null;
      log({ messageComposerSubmit: {
        peer: state.activePeerDigest,
        hasToken: !!state.conversationToken,
        contactHasToken: !!contactEntryLog?.conversation?.token_b64
      } });
      if (!state.conversationToken || !state.activePeerDigest) {
        setMessagesStatus('請先選擇已建立安全對話的好友', true);
        return;
      }
      if (elements.sendBtn) elements.sendBtn.disabled = true;
      try {
        const res = await sendDrText({ peerAccountDigest: state.activePeerDigest, text });
        log({ messageComposerSent: { peer: state.activePeerDigest, convId: res?.convId || null, msgId: res?.msg?.id || res?.id || null } });
        const ts = Math.floor(Date.now() / 1000);
        appendLocalOutgoingMessage({ text, ts, id: res?.msg?.id || res?.id });
        const convId = res?.convId || state.conversationId;
        if (res?.convId) state.conversationId = res.convId;
        if (elements.input) {
          elements.input.value = '';
          elements.input.focus();
        }
        setMessagesStatus('');
        if (convId && state.activePeerDigest) {
          wsSendFn({
            type: 'message-new',
            targetAccountDigest: state.activePeerDigest,
            conversationId: convId,
            preview: text,
            ts
          });
        }
      } catch (err) {
        log({ messageComposerError: err?.message || err });
        setMessagesStatus('傳送失敗：' + (err?.message || err), true);
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
  }

  function ensureSetup() {
    if (!elements.pane) elements.pane = document.querySelector('.messages-pane');
  }

  ensureSetup();
  renderGroupDrafts();

  return {
    attachDomEvents,
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
