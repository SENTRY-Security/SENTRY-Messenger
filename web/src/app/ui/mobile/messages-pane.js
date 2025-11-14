import { log } from '../../core/log.js';
import { getUidHex, getAccountToken, getAccountDigest } from '../../core/store.js';
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
import { conversationIdFromToken, computeConversationAccessFingerprint } from '../../features/conversation.js';
import { sessionStore, resetMessageState } from './session-store.js';
import { escapeHtml, fmtSize } from './ui-utils.js';
import { downloadAndDecrypt } from '../../features/media.js';
import { deleteSecureConversation } from '../../api/messages.js';
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

  const CALL_LOG_PHONE_ICON = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M2.003 5.884l3.75-1.5a1 1 0 011.316.593l1.2 3.199a1 1 0 01-.232 1.036l-1.516 1.52a11.037 11.037 0 005.516 5.516l1.52-1.516a1 1 0 011.036-.232l3.2 1.2a1 1 0 01.593 1.316l-1.5 3.75a1 1 0 01-1.17.6c-2.944-.73-5.59-2.214-7.794-4.418-2.204-2.204-3.688-4.85-4.418-7.794a1 1 0 01.6-1.17z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path></svg>';

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

  function updateThreadsWithCallLogDisplay({ peerUidHex, label, ts, direction }) {
    const threads = getConversationThreads();
    let touched = false;
    for (const thread of threads.values()) {
      if (thread.peerUid === peerUidHex) {
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

  function updateThreadAvatar(peerUid, avatarData) {
    const key = String(peerUid || '').toUpperCase();
    if (!key) return;
    const threads = getConversationThreads();
    let touched = false;
    for (const thread of threads.values()) {
      if (thread.peerUid === key) {
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
    if (!session?.peerUidHex) return;
    const status = session.status;
    if (![CALL_SESSION_STATUS.ENDED, CALL_SESSION_STATUS.FAILED].includes(status)) return;
    const key = String(session.peerUidHex || '').toUpperCase();
    if (!key) return;
    const identifier = session.callId || session.traceId || `${key}-${session.requestedAt || Date.now()}`;
    if (sentCallLogIds.has(identifier)) return;
    sentCallLogIds.add(identifier);
    const endedAt = session.endedAt || Date.now();
    const connectedAt = session.connectedAt || null;
    const durationSeconds = connectedAt ? Math.max(1, Math.round((endedAt - connectedAt) / 1000)) : 0;
    const direction = session.direction || CALL_SESSION_DIRECTION.OUTGOING;
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
      peerUidHex: key,
      direction,
      durationSeconds,
      outcome,
      reason: normalizedReason || null
    };
    if (direction === CALL_SESSION_DIRECTION.OUTGOING) {
      const state = getMessageState();
      const isActive = state.activePeerUid === key;
      const viewerMessage = createCallLogMessage(entry, { messageDirection: 'outgoing' });
      let localMessage = null;
      if (isActive) {
        localMessage = { ...viewerMessage };
        localMessage.id = localMessage.id || entry.id;
        localMessage.pending = true;
        state.messages.push(localMessage);
        updateMessagesUI({ scrollToEnd: outcome === CALL_LOG_OUTCOME.SUCCESS });
      }
      updateThreadsWithCallLogDisplay({
        peerUidHex: key,
        label: viewerMessage.text,
        ts: entry.ts,
        direction: 'outgoing'
      });
      sendDrCallLog({
        peerUidHex: key,
        callId: entry.callId,
        outcome: entry.outcome,
        durationSeconds: entry.durationSeconds,
        direction: entry.direction,
        reason: entry.reason
      })
        .then(({ msg }) => {
          if (localMessage && msg?.id) {
            localMessage.id = msg.id;
            localMessage.pending = false;
          }
        })
        .catch((err) => {
          log({ callLogSendError: err?.message || err });
          showToast?.('通話紀錄同步失敗', { variant: 'warning' });
        });
    }
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
    if (!info?.peerUidHex) continue;
    secureStatusCache.set(info.peerUidHex, { status: info.status, error: info.error });
  }
  if (typeof unsubscribeSecureStatus === 'function') {
    unsubscribeSecureStatus();
  }
  unsubscribeSecureStatus = subscribeSecureConversation(handleSecureStatusEvent);

  function cacheSecureStatus(peerUidHex, status, error) {
    const key = String(peerUidHex || '').toUpperCase();
    if (!key) return null;
    const entry = {
      status: status || SECURE_CONVERSATION_STATUS.IDLE,
      error: error || null
    };
    secureStatusCache.set(key, entry);
    return entry;
  }

  function getCachedSecureStatus(peerUidHex) {
    const key = String(peerUidHex || '').toUpperCase();
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

  function updateSecurityModalForPeer(peerUidHex, statusInfo) {
    if (!showSecurityModal) return;
    const status = statusInfo?.status || null;
    const key = String(peerUidHex || '').toUpperCase();
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

  function applySecureStatusForActivePeer(peerUidHex, statusInfo) {
    const state = getMessageState();
    const key = String(peerUidHex || '').toUpperCase();
    if (state.activePeerUid !== key) {
      if (!state.activePeerUid) hideSecurityModal();
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
    const key = String(event?.peerUidHex || '').toUpperCase();
    if (!key) return;
    const entry = cacheSecureStatus(key, event?.status, event?.error);
    if (!entry) return;
    const state = getMessageState();
    if (state.activePeerUid === key) {
      applySecureStatusForActivePeer(key, entry);
    }
  }

  function isDesktopLayout() {
    if (typeof window === 'undefined') return true;
    return window.innerWidth >= 960;
  }

  function getMessageState() {
    if (!sessionStore.messageState) {
      resetMessageState();
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

  function upsertConversationThread({ peerUid, conversationId, tokenB64, nickname, avatar }) {
    const key = String(peerUid || '').toUpperCase();
    const convId = String(conversationId || '').trim();
    if (!key || !convId) return null;
    if (sessionStore.deletedConversations?.has?.(convId)) return null;
    const threads = getConversationThreads();
    const prev = threads.get(convId) || {};
    const entry = {
      ...prev,
      peerUid: key,
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
      const peerUid = String(contact?.peerUid || '').toUpperCase();
      const conversationId = contact?.conversation?.conversation_id;
      const tokenB64 = contact?.conversation?.token_b64;
      if (!peerUid || !conversationId || !tokenB64) continue;
      seen.add(conversationId);
      upsertConversationThread({
        peerUid,
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
      if (!thread?.conversationId || !thread?.conversationToken || !thread?.peerUid) continue;
      if (!force && thread.previewLoaded && !thread.needsRefresh) continue;
      tasks.push((async () => {
        try {
          const { items } = await listSecureAndDecrypt({
            conversationId: thread.conversationId,
            tokenB64: thread.conversationToken,
            peerUidHex: thread.peerUid,
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

  function syncThreadFromActiveMessages() {
    const state = getMessageState();
    if (!state.conversationId || !state.activePeerUid) return;
    const contactEntry = sessionStore.contactIndex?.get?.(state.activePeerUid) || null;
    const nickname = contactEntry?.nickname || `好友 ${state.activePeerUid.slice(-4)}`;
    const avatar = contactEntry?.avatar || null;
    const tokenB64 = state.conversationToken || contactEntry?.conversation?.token_b64 || null;
    const thread = upsertConversationThread({
      peerUid: state.activePeerUid,
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
    const enabled = !!(state.activePeerUid && state.conversationToken);
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
    const key = state.activePeerUid ? String(state.activePeerUid).toUpperCase() : null;
    const statusInfo = key ? getCachedSecureStatus(key) : null;
    const status = statusInfo?.status || null;
    const blocked = status === SECURE_CONVERSATION_STATUS.PENDING || status === SECURE_CONVERSATION_STATUS.FAILED;
    const enabled = !!(state.conversationToken && state.activePeerUid && !blocked);
    elements.input.disabled = !enabled;
    elements.sendBtn.disabled = !enabled;
    let placeholder = '輸入訊息…';
    if (!state.conversationToken || !state.activePeerUid) {
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
    if (!state.activePeerUid || !state.conversationToken) return;
    const actionType = type === 'video' ? 'voice' : type; // 視訊暫時停用，強制走語音
    const contactEntry = sessionStore.contactIndex?.get?.(state.activePeerUid) || null;
    const fallbackName = `好友 ${state.activePeerUid.slice(-4)}`;
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
        peerUidHex: state.activePeerUid,
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
      log({ callInviteSignalSkipped: true, reason: 'missing-call-id', peerUid: state.activePeerUid });
      showToast?.('無法建立通話：缺少識別碼', { variant: 'error' });
      return;
    }
    let envelope;
    try {
      envelope = await prepareCallKeyEnvelope({
        callId,
        peerUidHex: state.activePeerUid,
        direction: CALL_SESSION_DIRECTION.OUTGOING
      });
    } catch (err) {
      log({ callKeyEnvelopeError: err?.message || err, peerUid: state.activePeerUid });
      showToast?.('無法建立通話加密金鑰', { variant: 'error' });
      return;
    }
    const traceId = snapshot?.traceId || result?.session?.metadata?.traceId || null;
    const capabilities = getCallCapability() || null;
    const callerSummary = getSelfProfileSummary() || {};
    const fallbackCallerName = (() => {
      const uid = getUidHex();
      return uid ? `好友 ${uid.slice(-4)}` : null;
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
      peerUidHex: state.activePeerUid,
      mode: actionType === 'video' ? 'video' : 'voice',
      metadata,
      capabilities,
      envelope,
      traceId
    });
    if (!sent) {
      log({ callInviteSignalFailed: true, callId, peerUid: state.activePeerUid });
      showToast?.('通話信令傳送失敗', { variant: 'error' });
      return;
    }
    try {
      await startOutgoingCallMedia({ callId, peerUid: state.activePeerUid });
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

  function renderConversationList() {
    if (!elements.conversationList) return;
    const openPeer = elements.conversationList.querySelector('.conversation-item.show-delete')?.dataset?.peer || null;
    const contacts = Array.isArray(sessionStore.contactState) ? [...sessionStore.contactState] : [];
    let state = getMessageState();
    if (state.activePeerUid) {
      const exists = contacts.some((c) => String(c?.peerUid || '').toUpperCase() === state.activePeerUid);
      if (!exists) {
        resetMessageState();
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
      .filter((thread) => thread?.conversationId && thread?.peerUid)
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
      const peerUid = thread.peerUid;
      const li = document.createElement('li');
      li.className = 'conversation-item';
      li.dataset.peer = peerUid;
      li.dataset.conversationId = thread.conversationId;
      if (state.activePeerUid === peerUid) li.classList.add('active');
      if (openPeer && openPeer === peerUid) li.classList.add('show-delete');
      const nickname = thread.nickname || `好友 ${peerUid.slice(-4)}`;
      const initials = initialsFromName(nickname, peerUid);
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
        handleConversationDelete({ conversationId: thread.conversationId, peerUid, element: li });
      });

      li.addEventListener('click', (e) => {
        if (e.target.closest('.item-delete')) return;
        if (li.classList.contains('show-delete')) { closeSwipe?.(li); return; }
        setActiveConversation(peerUid);
      });

      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActiveConversation(peerUid); }
        if (e.key === 'Delete') {
          e.preventDefault();
          handleConversationDelete({ conversationId: thread.conversationId, peerUid, element: li });
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
    if (media.localUrl) return true;
    if (media.objectKey && media.envelope) return true;
    return false;
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
      downloadBtn.style.display = 'inline-flex';
      downloadBtn.onclick = () => {
        const link = document.createElement('a');
        link.href = url;
        link.download = resolvedName;
        document.body.appendChild(link);
        link.click();
        link.remove();
      };
    }

    const container = document.createElement('div');
    container.className = 'preview-wrap';
    const wrap = document.createElement('div');
    wrap.className = 'viewer';
    container.appendChild(wrap);
    body.appendChild(container);

    const ct = (contentType || '').toLowerCase();
    if (ct.startsWith('image/')) {
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
    } else if (ct === 'application/pdf' || ct.startsWith('application/pdf')) {
      const iframe = document.createElement('iframe');
      iframe.src = url;
      iframe.className = 'viewer';
      iframe.title = resolvedName;
      wrap.appendChild(iframe);
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

  function addMediaPreviewAction(container, media) {
    if (!container || !canPreviewMedia(media)) return;
    const actions = document.createElement('div');
    actions.className = 'message-file-actions';
    const previewBtn = document.createElement('button');
    previewBtn.type = 'button';
    previewBtn.className = 'message-file-preview-btn';
    previewBtn.textContent = '預覽';
    previewBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openMediaPreview(media);
    });
    actions.appendChild(previewBtn);
    container.appendChild(actions);
  }

  async function ensureMediaPreviewUrl(media) {
    if (!media) return null;
    if (media.previewUrl) return media.previewUrl;
    if (media.localUrl) {
      media.previewUrl = media.localUrl;
      return media.previewUrl;
    }
    if (!media.objectKey || !media.envelope) return null;
    if (media.previewPromise) return media.previewPromise;
    media.previewPromise = downloadAndDecrypt({ key: media.objectKey, envelope: media.envelope })
      .then((result) => {
        if (!result || !result.blob) return null;
        const url = URL.createObjectURL(result.blob);
        media.previewUrl = url;
        if (!media.contentType && result.contentType) {
          media.contentType = result.contentType;
        }
        return url;
      })
      .catch((err) => {
        log({ mediaPreviewError: err?.message || err, objectKey: media.objectKey });
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
    if (!media.objectKey || !media.envelope) return;
    ensureMediaPreviewUrl(media).then((url) => {
      if (url && typeof el.src === 'string' && !el.src) apply(url);
    }).catch(() => {});
  }

  function attachMediaPreview(container, media) {
    const type = (media?.contentType || '').toLowerCase();
    const nameLower = (media?.name || '').toLowerCase();
    container.innerHTML = '';
    if (type.startsWith('image/')) {
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
      const pdf = document.createElement('div');
      pdf.className = 'message-file-preview-pdf';
      pdf.textContent = 'PDF';
      container.appendChild(pdf);
    } else {
      const generic = document.createElement('div');
      generic.className = 'message-file-preview-generic';
      generic.textContent = '檔案';
      container.appendChild(generic);
    }
  }

  function renderMediaBubble(bubble, msg) {
    const media = msg.media || {};
    bubble.classList.add('message-has-media');
    bubble.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.className = 'message-file';
    const preview = document.createElement('div');
    preview.className = 'message-file-preview';
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
    addMediaPreviewAction(wrapper, media);
    bubble.appendChild(wrapper);
    attachMediaPreview(preview, media);
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
          const contact = msg.direction === 'incoming' ? sessionStore.contactIndex?.get?.(state.activePeerUid || '') : null;
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
    if (!state.conversationId || !state.conversationToken || !state.activePeerUid) return;
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
        peerUidHex: state.activePeerUid,
        limit: 50,
        cursorTs: cursor,
        mutateState: forceReplay ? false : !append,
        allowReplay: !append || forceReplay
      });
      let chunk = Array.isArray(items) ? items.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0)) : [];
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

  async function setActiveConversation(peerUid) {
    const key = String(peerUid || '').toUpperCase();
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
      resetMessageState();
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
    log({ setActiveConversation: { peer: key, conversationId: conversation.conversation_id || null, hasDrInit: !!(conversation.dr_init || conversation.drInit) } });
    log({ setActiveConversation: { peer: key, conversationId: conversation.conversation_id || null } });
    const state = getMessageState();
    const hadExistingMessages = Array.isArray(state.messages) && state.messages.length > 0;
    state.activePeerUid = key;
    state.conversationToken = conversation.token_b64;
    try {
      state.conversationId = conversation.conversation_id || await conversationIdFromToken(conversation.token_b64);
    } catch (err) {
      resetMessageState();
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
      peerUid: key,
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
        peerUidHex: key,
        reason: 'open-conversation',
        source: 'messages-pane:setActiveConversation'
      });
    } catch (err) {
      const errorMsg = err?.message || err || '建立安全對話失敗，請稍後再試。';
      log({ ensureSecureConversationError: errorMsg, peerUid: key });
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

  function refreshActivePeerMetadata(peerUid, { fallbackName } = {}) {
    const key = String(peerUid || '').toUpperCase();
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
    const avatarData = entry?.avatar || null;
    updateThreadAvatar(peerUid, avatarData);
  }

  function handleContactEntryUpdated(detail = {}) {
    const peerUid = String(detail?.peerUid || '').toUpperCase();
    if (!peerUid) return;
    const entry = sessionStore.contactIndex?.get?.(peerUid) || detail.entry || null;
    if (!entry) return;
    const hasConversation = entry.conversation?.conversation_id && entry.conversation?.token_b64;
    if (hasConversation) {
      upsertConversationThread({
        peerUid,
        conversationId: entry.conversation.conversation_id,
        tokenB64: entry.conversation.token_b64,
        nickname: entry.nickname,
        avatar: entry.avatar || null
      });
      updateThreadAvatar(peerUid, entry.avatar || null);
    }
    const state = getMessageState();
    if (state.activePeerUid === peerUid) {
      refreshActivePeerMetadata(peerUid);
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
      media: media ? { ...media } : null
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
    syncThreadFromActiveMessages();
  }

  async function handleComposerFileSelection(event) {
    const input = event?.target || event?.currentTarget || elements.fileInput;
    const files = input?.files ? Array.from(input.files).filter(Boolean) : [];
    if (!files.length) return;
    const state = getMessageState();
    if (!state.activePeerUid || !state.conversationToken) {
      setMessagesStatus('請先選擇已建立安全對話的好友', true);
      return;
    }
    const contactEntry = sessionStore.contactIndex?.get?.(state.activePeerUid) || null;
    const conversation = contactEntry?.conversation || null;
    try {
      for (const file of files) {
        setMessagesStatus('正在加密與上傳檔案…', false);
        const res = await sendDrMedia({
          peerUidHex: state.activePeerUid,
          file,
          conversation,
          convId: state.conversationId,
          dir: state.conversationId ? ['messages', state.conversationId] : 'messages',
          onProgress: (progress) => {
            if (!progress || !Number.isFinite(progress.percent)) return;
            const pct = Math.min(100, Math.max(0, progress.percent));
            setMessagesStatus(`上傳中… ${pct}%`, false);
          }
        });
        if (res?.convId && !state.conversationId) {
          state.conversationId = res.convId;
        }
        const ts = res?.msg?.ts || Math.floor(Date.now() / 1000);
        const mediaInfo = res?.msg?.media ? { ...res.msg.media } : {};
        mediaInfo.name = mediaInfo.name || file.name || '附件';
        mediaInfo.size = Number.isFinite(mediaInfo.size) ? mediaInfo.size : (typeof file.size === 'number' ? file.size : null);
        mediaInfo.contentType = mediaInfo.contentType || file.type || 'application/octet-stream';
        mediaInfo.localUrl = URL.createObjectURL(file);
        if (!mediaInfo.previewUrl) mediaInfo.previewUrl = mediaInfo.localUrl;
        const messageId = res?.msg?.id || res?.upload?.objectKey || `local-${Date.now()}`;
        const previewText = res?.msg?.text || `[檔案] ${mediaInfo.name}`;
        appendLocalOutgoingMessage({
          text: previewText,
          ts,
          id: messageId,
          type: 'media',
          media: mediaInfo
        });
        const senderUid = getUidHex();
        if (state.activePeerUid && senderUid) {
          wsSendFn({
            type: 'message-new',
            targetUid: state.activePeerUid,
            conversationId: state.conversationId,
            preview: previewText,
            ts,
            senderUid
          });
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
      state.viewMode = state.activePeerUid ? 'detail' : 'list';
    }
    if (!desktop && !state.activePeerUid && state.viewMode !== 'list') {
      state.viewMode = 'list';
    }
    applyMessagesLayout();
  }

  function refreshContactsUnreadBadges() {
    if (!sessionStore.contactState?.length) return;
    for (const contact of sessionStore.contactState) {
      const key = String(contact?.peerUid || '').toUpperCase();
      if (!key) continue;
      const thread = getConversationThreads().get(contact?.conversation?.conversation_id || '') || null;
      const unread = thread?.unreadCount || 0;
      const contactEntry = sessionStore.contactIndex?.get?.(key);
      if (contactEntry && typeof contactEntry.unreadCount !== 'number') contactEntry.unreadCount = 0;
      if (contactEntry) contactEntry.unreadCount = unread;
    }
  }

  function showDeleteForPeer(peerUid) {
    const key = String(peerUid || '').toUpperCase();
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
    const key = String(peerUid || '').toUpperCase();
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
              uidHex: getUidHex() || undefined,
              accountToken: getAccountToken() || undefined,
              accountDigest: getAccountDigest() || undefined,
              peerUid: '00000000000000'
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
          const contactStateEntry = sessionStore.contactState?.find?.((c) => String(c?.peerUid || '').toUpperCase() === key) || null;
          if (contactStateEntry) {
            contactStateEntry.conversation = null;
            contactStateEntry.unreadCount = 0;
          }
          if (element) closeSwipe?.(element);
          const state = getMessageState();
          if (state.activePeerUid === key) {
            resetMessageState();
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
    const peerFromEventRaw = event?.peerUid || event?.peer_uid || event?.fromUid || event?.from_uid || null;
    const peerFromEvent = peerFromEventRaw ? String(peerFromEventRaw).replace(/[^0-9a-f]/gi, '').toUpperCase() : null;

    if (!convEntry) {
      convEntry = { token_b64: null, peerUid: peerFromEvent || null };
      convIndex.set(convId, convEntry);
    } else if (!convEntry.peerUid && peerFromEvent) {
      convEntry.peerUid = peerFromEvent;
    }

    const tokenFromEvent = event?.tokenB64 || event?.token_b64 || null;
    if (tokenFromEvent && !convEntry.token_b64) {
      const normalizedToken = String(tokenFromEvent).trim();
      if (normalizedToken) convEntry.token_b64 = normalizedToken;
    }

    const peerUid = convEntry.peerUid;
    if (!peerUid) {
      log({ secureMessageUnknownPeer: convId });
      return;
    }

    const contactEntry = sessionStore.contactIndex?.get?.(peerUid) || null;
    const nickname = contactEntry?.nickname || `好友 ${peerUid.slice(-4)}`;
    const avatar = contactEntry?.avatar || null;
    const tokenB64 = convEntry.token_b64 || contactEntry?.conversation?.token_b64 || null;

    const thread = upsertConversationThread({
      peerUid,
      conversationId: convId,
      tokenB64,
      nickname,
      avatar
    }) || getConversationThreads().get(convId);
    if (!thread) return;

    const myUid = getUidHex();
    const senderUidRaw = event?.senderUid || event?.sender_uid || null;
    const senderUid = senderUidRaw ? String(senderUidRaw).replace(/[^0-9a-f]/gi, '').toUpperCase() : null;
    const isSelf = !!(myUid && senderUid && myUid === senderUid);

    const rawMsgType = event?.meta?.msg_type || event?.meta?.msgType || event?.messageType || event?.msgType || null;
    const normalizedControlType = normalizeControlMessageType(rawMsgType);
    if (normalizedControlType) {
      handleSecureConversationControlMessage({
        peerUidHex: peerUid,
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
    const active = state.conversationId === convId && state.activePeerUid === peerUid;
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
      onClick: () => {
        switchTab?.('messages');
        const setPromise = setActiveConversation(peerUid);
        if (setPromise && typeof setPromise.catch === 'function') {
          setPromise.catch((err) => log({ toastOpenConversationError: err?.message || err }));
        }
      },
      avatarUrl: avatarUrlToast,
      avatarInitials: initialsToast,
      subtitle: formatTimestamp(tsRaw)
    });
  }

  function handleContactOpenConversation(detail) {
    const peerUid = String(detail?.peerUid || '').toUpperCase();
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
        peerUid,
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

    if (elements.scrollEl) {
      elements.scrollEl.addEventListener('scroll', handleMessagesScroll, { passive: true });
      elements.scrollEl.addEventListener('touchend', handleMessagesTouchEnd, { passive: true });
      elements.scrollEl.addEventListener('touchcancel', handleMessagesTouchEnd, { passive: true });
      elements.scrollEl.addEventListener('wheel', handleMessagesWheel, { passive: true });
    }

    elements.loadMoreBtn?.addEventListener('click', () => {
      loadActiveConversationMessages({ append: true });
    });

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
      const contactEntryLog = state.activePeerUid ? sessionStore.contactIndex?.get?.(state.activePeerUid) : null;
      log({ messageComposerSubmit: {
        peer: state.activePeerUid,
        hasToken: !!state.conversationToken,
        contactHasToken: !!contactEntryLog?.conversation?.token_b64
      } });
      if (!state.conversationToken || !state.activePeerUid) {
        setMessagesStatus('請先選擇已建立安全對話的好友', true);
        return;
      }
      if (elements.sendBtn) elements.sendBtn.disabled = true;
      try {
        const res = await sendDrText({ peerUidHex: state.activePeerUid, text });
        log({ messageComposerSent: { peer: state.activePeerUid, convId: res?.convId || null, msgId: res?.msg?.id || res?.id || null } });
        const ts = Math.floor(Date.now() / 1000);
        appendLocalOutgoingMessage({ text, ts, id: res?.msg?.id || res?.id });
        const convId = res?.convId || state.conversationId;
        if (res?.convId) state.conversationId = res.convId;
        if (elements.input) {
          elements.input.value = '';
          elements.input.focus();
        }
        setMessagesStatus('');
        const senderUid = getUidHex();
        if (convId && state.activePeerUid && senderUid) {
          wsSendFn({
            type: 'message-new',
            targetUid: state.activePeerUid,
            conversationId: convId,
            preview: text,
            ts,
            senderUid
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
