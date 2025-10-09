// /app/ui/app-mobile.js
// Mobile-first App UI with bottom navigation: Contacts, Messages, Drive, Profile.
// Implements Drive tab using existing encrypted media features.

import { log, setLogSink } from '../core/log.js';
import { AUDIO_PERMISSION_KEY } from './login-ui.js';
import {
  getUidHex, getMkRaw,
  setMkRaw, setUidHex,
  setAccountToken, setAccountDigest, setUidDigest,
  resetAll, clearSecrets,
  getDevicePriv, setDevicePriv
} from '../core/store.js';
import { encryptAndPutWithProgress, deleteEncryptedObjects, downloadAndDecrypt, loadEnvelopeMeta } from '../features/media.js';
import { listMessages } from '../api/messages.js';
import { getAccountDigest } from '../core/store.js';
import { listSecureAndDecrypt } from '../features/messages.js';
import { friendsDeleteContact } from '../api/friends.js';
import { loadContacts, saveContact } from '../features/contacts.js';
import { ensureSettings, saveSettings, DEFAULT_SETTINGS } from '../features/settings.js';
import { getSimStoragePrefix, getSimStorageKey } from '../../libs/ntag424-sim.js';
import { setupShareController } from './mobile/share-controller.js';
import { sessionStore, resetMessageState } from './mobile/session-store.js';
import { setupModalController } from './mobile/modal-utils.js';
import { createSwipeManager } from './mobile/swipe-utils.js';
import { initProfileCard } from './mobile/profile-card.js';
import { escapeHtml, fmtSize, safeJSON, blobToDataURL, b64u8 } from './mobile/ui-utils.js';
import { initContactsView } from './mobile/contacts-view.js';
import { createPresenceManager } from './mobile/presence-manager.js';
import { sendDrText } from '../features/dr-session.js';
import { conversationIdFromToken } from '../features/conversation.js';

const $ = (sel) => document.querySelector(sel);
const out = $('#out'); setLogSink(out);

const toastEl = document.getElementById('appToast');
let toastTimerId = null;
let toastClickHandler = null;

const navbarEl = document.querySelector('.navbar');
const mainContentEl = document.querySelector('main.content');

let pendingServerOps = 0;
let waitOverlayTimer = null;
const AUDIO_PERMISSION_KEY_APP = AUDIO_PERMISSION_KEY;
let notifyAudioCtx = null;
let notifyAudioBuffer = null;
let notifyAudioLoadPromise = null;
const navBadges = typeof document !== 'undefined' ? Array.from(document.querySelectorAll('.nav-badge')) : [];

function getAudioContext() {
  if (typeof window === 'undefined') return null;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  if (!notifyAudioCtx) {
    try {
      notifyAudioCtx = new AudioCtx();
    } catch (err) {
      log({ audioCtxError: err?.message || err });
      notifyAudioCtx = null;
    }
  }
  return notifyAudioCtx;
}

async function resumeNotifyAudioContext() {
  const ctx = getAudioContext();
  if (!ctx) return null;
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch (err) {
      log({ audioResumeError: err?.message || err });
    }
  }
  return ctx;
}

async function loadNotifyAudioBuffer() {
  if (notifyAudioBuffer) return notifyAudioBuffer;
  if (notifyAudioLoadPromise) return notifyAudioLoadPromise;
  const ctx = await resumeNotifyAudioContext();
  if (!ctx) return null;
  notifyAudioLoadPromise = (async () => {
    try {
      const res = await fetch('/assets/audio/notify.wav');
      const arrayBuf = await res.arrayBuffer();
      const decoded = await ctx.decodeAudioData(arrayBuf.slice(0));
      notifyAudioBuffer = decoded;
      return notifyAudioBuffer;
    } catch (err) {
      log({ audioLoadError: err?.message || err });
      notifyAudioLoadPromise = null;
      return null;
    }
  })();
  return notifyAudioLoadPromise;
}

async function playNotificationSound() {
  try {
    const ctx = await resumeNotifyAudioContext();
    if (!ctx) return;
    const buffer = await loadNotifyAudioBuffer();
    if (!buffer) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
  } catch (err) {
    log({ audioPlayError: err?.message || err });
  }
}

function handleServerOpStart() {
  pendingServerOps += 1;
}

function handleServerOpEnd() {
  pendingServerOps = Math.max(0, pendingServerOps - 1);
}

function hideToast() {
  if (!toastEl) return;
  toastEl.classList.remove('show');
  toastEl.innerHTML = '';
  toastClickHandler = null;
}

function showToast(message, { duration = 2600, onClick, avatarUrl, avatarInitials, subtitle } = {}) {
  if (!toastEl) return;
  const text = String(message || '').trim();
  if (!text) {
    hideToast();
    return;
  }
  toastClickHandler = typeof onClick === 'function' ? onClick : null;
  const parts = [];
  if (avatarUrl || avatarInitials) {
    const avatarContent = avatarUrl
      ? `<img src="${escapeHtml(avatarUrl)}" alt="avatar" />`
      : escapeHtml((avatarInitials || '').slice(0, 2) || '好友');
    parts.push(`<div class="toast-avatar">${avatarContent}</div>`);
  }
  const body = [`<div class="toast-text">${escapeHtml(text)}</div>`];
  if (subtitle) body.push(`<div class="toast-sub">${escapeHtml(String(subtitle))}</div>`);
  parts.push(`<div class="toast-body">${body.join('')}</div>`);
  toastEl.innerHTML = parts.join('');
  toastEl.classList.add('show');
  if (toastTimerId) clearTimeout(toastTimerId);
  toastTimerId = setTimeout(() => {
    hideToast();
    toastTimerId = null;
  }, Math.max(1200, Number(duration) || 0));
}

toastEl?.addEventListener('click', () => {
  hideToast();
  if (toastTimerId) {
    clearTimeout(toastTimerId);
    toastTimerId = null;
  }
  const handler = toastClickHandler;
  toastClickHandler = null;
  if (typeof handler === 'function') {
    try { handler(); } catch (err) { log({ toastCallbackError: err?.message || err }); }
  }
});

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('app:fetch-start', handleServerOpStart);
  window.addEventListener('app:fetch-end', handleServerOpEnd);
  const resumeOnce = () => {
    resumeNotifyAudioContext();
  };
  window.addEventListener('pointerdown', resumeOnce, { once: true, passive: true });
  window.addEventListener('touchstart', resumeOnce, { once: true, passive: true });
  window.addEventListener('keydown', resumeOnce, { once: true });
  if (sessionStorage.getItem(AUDIO_PERMISSION_KEY_APP) === 'granted') {
    resumeNotifyAudioContext();
  }
}

const SIM_STORAGE_PREFIX = (() => {
  try { return getSimStoragePrefix(); } catch { return 'ntag424-sim:'; }
})();
const SIM_STORAGE_KEY = (() => {
  try { return getSimStorageKey(); } catch { return null; }
})();

function isSimStorageKey(key) {
  if (!key) return false;
  if (SIM_STORAGE_KEY && key === SIM_STORAGE_KEY) return true;
  if (SIM_STORAGE_PREFIX && key.startsWith(SIM_STORAGE_PREFIX)) return true;
  return false;
}

let currentMessages = [];
let currentConvId = '';
let shareController = null;
let messagesPaneEl = null;
let messagesBackBtnEl = null;
let messagesHeaderEl = null;
let messagesPeerAvatarEl = null;
let messageComposerEl = null;
let messageInputEl = null;
let messageSendBtn = null;
let composerAttachBtn = null;
let loadMoreState = 'hidden';
let autoLoadOlderInProgress = false;
let lastLayoutIsDesktop = null;

function ensureMessagesElements() {
  if (typeof document === 'undefined') return;
  if (!messagesPaneEl) messagesPaneEl = document.querySelector('.messages-pane');
  if (!messagesBackBtnEl) messagesBackBtnEl = document.getElementById('messagesBackBtn');
  if (!messagesHeaderEl) messagesHeaderEl = document.querySelector('.messages-header');
  if (!messagesPeerAvatarEl) messagesPeerAvatarEl = document.getElementById('messagesPeerAvatar');
  if (!messageComposerEl) messageComposerEl = document.getElementById('messageComposer');
  if (!messageInputEl) messageInputEl = document.getElementById('messageInput');
  if (!messageSendBtn) messageSendBtn = document.getElementById('messageSend');
  if (!composerAttachBtn) composerAttachBtn = document.getElementById('composerAttach');
}

function isDesktopLayout() {
  if (typeof window === 'undefined') return true;
  return window.innerWidth >= 960;
}

function applyMessagesLayout() {
  ensureMessagesElements();
  if (!messagesPaneEl) return;
  const state = getMessageState();
  const desktop = isDesktopLayout();
  messagesPaneEl.classList.toggle('is-desktop', desktop);
  if (desktop) {
    messagesPaneEl.classList.remove('list-view');
    messagesPaneEl.classList.remove('detail-view');
  } else {
    const mode = state.viewMode === 'detail' ? 'detail' : 'list';
    messagesPaneEl.classList.toggle('detail-view', mode === 'detail');
    messagesPaneEl.classList.toggle('list-view', mode === 'list');
  }
  if (messagesBackBtnEl) {
    const showBack = !desktop && state.viewMode === 'detail';
    messagesBackBtnEl.classList.toggle('hidden', !showBack);
  }
  if (typeof messageComposerEl === 'object' && messageComposerEl) {
    const isDetail = desktop || state.viewMode === 'detail';
    if (isDetail) {
      messageComposerEl.style.position = 'sticky';
      messageComposerEl.style.bottom = '0';
      messageComposerEl.style.left = '0';
      messageComposerEl.style.right = '0';
      messageComposerEl.style.zIndex = '3';
    } else {
      messageComposerEl.style.position = '';
      messageComposerEl.style.bottom = '';
      messageComposerEl.style.left = '';
      messageComposerEl.style.right = '';
      messageComposerEl.style.zIndex = '';
    }
  }
  if (currentTab === 'messages') {
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
        messagesPaneEl.style.position = 'fixed';
        messagesPaneEl.style.top = `${topOffset}px`;
        messagesPaneEl.style.left = '0';
        messagesPaneEl.style.right = '0';
        messagesPaneEl.style.bottom = '0';
        messagesPaneEl.style.height = 'auto';
      } else {
        messagesPaneEl.style.position = '';
        messagesPaneEl.style.top = '';
        messagesPaneEl.style.left = '';
        messagesPaneEl.style.right = '';
        messagesPaneEl.style.bottom = '';
        messagesPaneEl.style.height = '';
      }
    } else {
      messagesPaneEl.style.position = '';
      messagesPaneEl.style.top = '';
      messagesPaneEl.style.left = '';
      messagesPaneEl.style.right = '';
      messagesPaneEl.style.bottom = '';
      messagesPaneEl.style.height = '';
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

function updateLayoutMode(force = false) {
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
          limit: 20
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
      const diff = (day + 6) % 7; // shift so Monday is the first day of the week
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

function fileIconForName(name, contentType) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  const ct = String(contentType || '').toLowerCase();
  if (ct.startsWith('image/') || ['jpg','jpeg','png','gif','webp','bmp','svg','heic','heif','avif'].includes(ext)) return 'bx bx-image';
  if (ct.startsWith('video/') || ['mp4','mov','m4v','webm','avi','mkv'].includes(ext)) return 'bx bx-video';
  if (ct.startsWith('audio/') || ['mp3','wav','m4a','aac','flac','ogg'].includes(ext)) return 'bx bx-music';
  if (ext === 'pdf') return 'bx bxs-file-pdf';
  if (['doc','docx','rtf','odt','pages'].includes(ext)) return 'bx bx-file';
  if (['xls','xlsx','csv','ods','numbers'].includes(ext)) return 'bx bx-spreadsheet';
  if (['ppt','pptx','odp','key'].includes(ext)) return 'bx bx-slideshow';
  if (['zip','rar','7z','gz','tar','tgz','bz2'].includes(ext)) return 'bx bx-archive';
  if (['txt','md','log','json','xml','yml','yaml'].includes(ext) || ct.startsWith('text/')) return 'bx bx-file';
  return 'bx bx-file';
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

function cleanPreviewText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function setMessagesStatus(message, isError = false) {
  if (!messagesStatusEl) return;
  messagesStatusEl.textContent = message || '';
  messagesStatusEl.style.color = isError ? '#dc2626' : '#64748b';
}

function updateComposerAvailability() {
  if (!messageInputEl || !messageSendBtn) return;
  const state = getMessageState();
  const enabled = !!(state.conversationToken && state.activePeerUid);
  messageInputEl.disabled = !enabled;
  messageSendBtn.disabled = !enabled;
  if (!enabled) {
    messageInputEl.placeholder = '尚未建立安全對話';
  } else {
    messageInputEl.placeholder = '輸入訊息…';
  }
}

function updateLoadMoreVisibility() {
  if (!messagesLoadMoreBtn) return;
  const state = getMessageState();
  const enabled = !!(state.conversationId && state.conversationToken && state.hasMore && !state.loading);
  setLoadMoreState(enabled ? 'idle' : 'hidden');
}

function setLoadMoreState(next) {
  if (!messagesLoadMoreBtn) return;
  if (loadMoreState === next) return;
  loadMoreState = next;
  if (next === 'hidden') {
    messagesLoadMoreBtn.classList.add('hidden');
    messagesLoadMoreBtn.classList.remove('loading');
    if (messagesLoadMoreLabel) messagesLoadMoreLabel.textContent = '載入更多';
    return;
  }
  messagesLoadMoreBtn.classList.remove('hidden');
  if (next === 'loading') {
    messagesLoadMoreBtn.classList.add('loading');
    if (messagesLoadMoreLabel) messagesLoadMoreLabel.textContent = '載入中…';
  } else if (next === 'armed') {
    messagesLoadMoreBtn.classList.remove('loading');
    if (messagesLoadMoreLabel) messagesLoadMoreLabel.textContent = '釋放以載入更多';
  } else {
    messagesLoadMoreBtn.classList.remove('loading');
    if (messagesLoadMoreLabel) messagesLoadMoreLabel.textContent = '載入更多';
  }
}

function handleMessagesScroll() {
  if (!messagesScrollEl) return;
  const state = getMessageState();
  if (!state.hasMore || state.loading) return;
  if (autoLoadOlderInProgress) return;
  const top = messagesScrollEl.scrollTop;
  if (top <= 0) {
    triggerAutoLoadOlder();
  } else if (top <= 40) {
    setLoadMoreState('armed');
  } else {
    setLoadMoreState('idle');
  }
}

function handleMessagesTouchEnd() {
  if (!messagesScrollEl) return;
  if (messagesScrollEl.scrollTop <= 0) {
    triggerAutoLoadOlder();
  }
}

function handleMessagesWheel() {
  if (!messagesScrollEl) return;
  if (messagesScrollEl.scrollTop <= 0) {
    triggerAutoLoadOlder();
  }
}

function triggerAutoLoadOlder() {
  const state = getMessageState();
  if (!messagesScrollEl || !state.hasMore || state.loading || autoLoadOlderInProgress) return;
  autoLoadOlderInProgress = true;
  setLoadMoreState('loading');
  const previousScrollHeight = messagesScrollEl.scrollHeight;
  loadActiveConversationMessages({ append: true })
    .catch((err) => log({ loadOlderError: err?.message || err }))
    .finally(() => {
      autoLoadOlderInProgress = false;
      const nextState = state.hasMore ? 'idle' : 'hidden';
      setLoadMoreState(nextState);
    });
}

function updateNavBadge(tab, value) {
  if (!navBadges?.length) return;
  for (const badge of navBadges) {
    if (badge?.dataset?.tab !== tab) continue;
    const parent = badge.closest('.navbtn');
    if (value && Number(value) > 0) {
      badge.textContent = String(value > 99 ? '99+' : value);
      badge.style.display = 'inline-flex';
      parent?.classList.add('has-badge');
    } else {
      badge.textContent = '';
      badge.style.display = 'none';
      parent?.classList.remove('has-badge');
    }
  }
}

function scrollMessagesToBottom() {
  if (!messagesScrollEl) return;
  messagesScrollEl.scrollTop = messagesScrollEl.scrollHeight;
}

function renderConversationList() {
  if (!conversationListEl) return;
  const contacts = Array.isArray(sessionStore.contactState) ? [...sessionStore.contactState] : [];
  let state = getMessageState();
  if (state.activePeerUid) {
    const exists = contacts.some((c) => String(c?.peerUid || '').toUpperCase() === state.activePeerUid);
    if (!exists) {
      resetMessageState();
      state = getMessageState();
      if (!isDesktopLayout()) state.viewMode = 'list';
      messagesPeerNameEl.textContent = '選擇好友開始聊天';
      setMessagesStatus('');
      clearMessagesView();
      updateComposerAvailability();
      applyMessagesLayout();
    }
  }
  syncConversationThreadsFromContacts();
  refreshContactsUnreadBadges();
  conversationListEl.innerHTML = '';
  const threadEntries = Array.from(getConversationThreads().values())
    .filter((thread) => thread?.conversationId && thread?.peerUid)
    .sort((a, b) => (b.lastMessageTs || 0) - (a.lastMessageTs || 0));
  const totalUnread = threadEntries.reduce((sum, thread) => sum + Number(thread.unreadCount || 0), 0);
  updateNavBadge('messages', totalUnread > 0 ? totalUnread : null);
  if (!threadEntries.length) {
    const li = document.createElement('li');
    li.className = 'conversation-item disabled';
    li.innerHTML = `<div class="conversation-empty">尚未有任何訊息</div>`;
    conversationListEl.appendChild(li);
    return;
  }
  for (const thread of threadEntries) {
    const peerUid = thread.peerUid;
    const li = document.createElement('li');
    li.className = 'conversation-item';
    li.dataset.peer = peerUid;
    li.dataset.conversationId = thread.conversationId;
    if (state.activePeerUid === peerUid) li.classList.add('active');
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
      <button type="button" class="item-delete" aria-label="刪除對話"><i class='bx bx-trash'></i></button>
    `;
    const deleteBtn = li.querySelector('.item-delete');
    deleteBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleConversationDelete({ conversationId: thread.conversationId, peerUid, element: li });
    });

    li.addEventListener('click', (e) => {
      if (e.target.closest('.item-delete')) return;
      if (li.classList.contains('show-delete')) { closeSwipe(li); return; }
      setActiveConversation(peerUid);
    });

    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActiveConversation(peerUid); }
      if (e.key === 'Delete') {
        e.preventDefault();
        handleConversationDelete({ conversationId: thread.conversationId, peerUid, element: li });
      }
    });

    setupSwipe(li);
    conversationListEl.appendChild(li);
  }
}

function clearMessagesView() {
  if (messagesListEl) messagesListEl.innerHTML = '';
  messagesEmptyEl?.classList.remove('hidden');
  updateLoadMoreVisibility();
}

function updateMessagesUI({ scrollToEnd = false, preserveScroll = false } = {}) {
  if (!messagesListEl) return;
  const state = getMessageState();
  let prevHeight = 0;
  let prevScroll = 0;
  if (preserveScroll && messagesScrollEl) {
    prevHeight = messagesScrollEl.scrollHeight;
    prevScroll = messagesScrollEl.scrollTop;
  }

  messagesListEl.innerHTML = '';
  if (!state.messages.length) {
    messagesEmptyEl?.classList.remove('hidden');
  } else {
    messagesEmptyEl?.classList.add('hidden');
    let prevTs = null;
    let prevDateKey = null;
    for (const msg of state.messages) {
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
          messagesListEl.appendChild(sep);
        }
        prevTs = tsVal;
        prevDateKey = dateKey;
      }
      const li = document.createElement('li');
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
        const initials = name ? name.slice(0,1) : '好友';
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
      bubble.textContent = msg.text || msg.error || '(無法解密)';
      row.appendChild(bubble);
      li.appendChild(row);
      messagesListEl.appendChild(li);
    }
  }

  updateLoadMoreVisibility();

  if (messagesScrollEl) {
    if (preserveScroll) {
      const diff = messagesScrollEl.scrollHeight - prevHeight;
      messagesScrollEl.scrollTop = Math.max(0, prevScroll + diff);
    } else if (scrollToEnd) {
      scrollMessagesToBottom();
    }
  }
}

async function loadActiveConversationMessages({ append = false } = {}) {
  const state = getMessageState();
  if (!state.conversationId || !state.conversationToken || !state.activePeerUid) return;
  if (state.loading) return;
  if (append && (!state.hasMore || !state.nextCursorTs)) return;

  state.loading = true;
  if (!append) setMessagesStatus('載入中…');
  try {
    const cursor = append ? state.nextCursorTs : undefined;
    const { items, nextCursorTs, errors } = await listSecureAndDecrypt({
      conversationId: state.conversationId,
      tokenB64: state.conversationToken,
      peerUidHex: state.activePeerUid,
      limit: 50,
      cursorTs: cursor
    });
    let chunk = Array.isArray(items) ? items.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0)) : [];
    if (append) {
      const existingIds = new Set(state.messages.map((m) => m.id));
      chunk = chunk.filter((m) => !existingIds.has(m.id));
      state.messages = [...chunk, ...state.messages];
      updateMessagesUI({ preserveScroll: true });
    } else {
      state.messages = chunk;
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
    messagesPeerNameEl.textContent = nickname;
    setMessagesStatus('此好友尚未建立安全對話，請重新生成邀請。', true);
    clearMessagesView();
    updateComposerAvailability();
    renderConversationList();
    applyMessagesLayout();
    return;
  }
 const state = getMessageState();
 state.activePeerUid = key;
 state.conversationToken = conversation.token_b64;
 try {
    state.conversationId = conversation.conversation_id || await conversationIdFromToken(conversation.token_b64);
  } catch (err) {
    resetMessageState();
    messagesPeerNameEl.textContent = nickname;
    setMessagesStatus('無法建立對話：' + (err?.message || err), true);
    clearMessagesView();
    updateComposerAvailability();
    renderConversationList();
    const fallbackState = getMessageState();
    if (!desktopLayout) fallbackState.viewMode = 'list';
    applyMessagesLayout();
    return;
  }
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
  messagesPeerNameEl.textContent = nickname;
  if (messagesPeerAvatarEl) {
    messagesPeerAvatarEl.innerHTML = '';
    const avatarData = entry?.avatar;
    if (avatarData?.thumbDataUrl || avatarData?.previewDataUrl || avatarData?.url) {
      const img = document.createElement('img');
      img.src = avatarData.thumbDataUrl || avatarData.previewDataUrl || avatarData.url;
      img.alt = nickname;
      messagesPeerAvatarEl.appendChild(img);
    } else {
      messagesPeerAvatarEl.textContent = initialsFromName(nickname, key).slice(0, 2);
    }
  }
  setMessagesStatus('');
  renderConversationList();
  updateComposerAvailability();
  clearMessagesView();
  applyMessagesLayout();
  await loadActiveConversationMessages({ append: false });
}

function appendLocalOutgoingMessage({ text, ts, id }) {
  const state = getMessageState();
  const message = {
    id: id || `local-${Date.now()}`,
    ts: ts || Math.floor(Date.now() / 1000),
    text,
    direction: 'outgoing'
  };
  state.messages.push(message);
  updateMessagesUI({ scrollToEnd: true });
  syncThreadFromActiveMessages();
}

// --- Hard-disable zoom gestures (reinforce meta viewport) ---
(function disableZoom(){
  try {
    // iOS Safari pinch gesture
    const stop = (e) => { e.preventDefault(); };
    ['gesturestart','gesturechange','gestureend'].forEach(t => {
      document.addEventListener(t, stop, { passive: false });
    });
    // Prevent double-tap zoom
    let lastTouch = 0;
    document.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - lastTouch < 350) { e.preventDefault(); }
      lastTouch = now;
    }, { passive: false });
    // Ctrl/Meta + wheel zoom (desktop browsers)
    window.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    }, { passive: false });
    // Ctrl/Cmd + +/-/0
    window.addEventListener('keydown', (e) => {
      const k = e.key;
      if ((e.ctrlKey || e.metaKey) && (k === '+' || k === '-' || k === '=' || k === '0')) {
        e.preventDefault();
      }
    });
  } catch {}
})();

// Restore MK/UID from sessionStorage handoff (login → app)
(function restoreMkAndUidFromSession() {
  try {
    const mkb64 = sessionStorage.getItem('mk_b64');
    const uid = sessionStorage.getItem('uid_hex');
    const accountToken = sessionStorage.getItem('account_token');
    const accountDigest = sessionStorage.getItem('account_digest');
    const uidDigest = sessionStorage.getItem('uid_digest');
    if (uid) setUidHex(uid);
    if (accountToken) setAccountToken(accountToken);
    if (accountDigest) setAccountDigest(accountDigest);
    if (uidDigest) setUidDigest(uidDigest);
    if (mkb64 && !getMkRaw()) setMkRaw(b64u8(mkb64));
    sessionStorage.removeItem('mk_b64');
    sessionStorage.removeItem('uid_hex');
    sessionStorage.removeItem('account_token');
    sessionStorage.removeItem('account_digest');
    sessionStorage.removeItem('uid_digest');
  } catch (e) { log({ restoreError: String(e?.message || e) }); }
})();

// Guard: require MK
(function ensureUnlockedOrRedirect(){
  if (!getMkRaw()) {
    log('Not unlocked: redirecting to /pages/login.html …');
    setTimeout(() => location.replace('/pages/login.html'), 200);
  }
})();

// Navigation
const tabs = ['contacts','messages','drive','profile'];
let currentTab = 'drive';
function switchTab(name, options = {}){
  currentTab = name;
  tabs.forEach(t => {
    const page = document.getElementById('tab-'+t);
    const btn  = document.getElementById('nav-'+t);
    if (page) page.style.display = (t===name?'block':'none');
    if (btn) btn.classList.toggle('active', t===name);
  });
  if (name === 'drive') refreshDriveList().catch(e=>log({ driveListError:String(e?.message||e) }));
  if (name === 'messages') {
    const state = getMessageState();
    if (!isDesktopLayout() && !state.viewMode) {
      state.viewMode = state.activePeerUid ? 'detail' : 'list';
    }
    syncConversationThreadsFromContacts();
    refreshConversationPreviews({ force: true }).catch((err) => log({ conversationPreviewRefreshError: err?.message || err }));
    renderConversationList();
    updateComposerAvailability();
    updateMessagesUI({ scrollToEnd: true });
    updateLayoutMode(true);
    if (options.fromBack && !isDesktopLayout()) {
      state.viewMode = 'list';
      applyMessagesLayout();
    }
  } else if (name !== 'messages') {
    updateLayoutMode(true);
    navbarEl?.classList.remove('hidden');
    mainContentEl?.classList.remove('fullscreen');
    document.body.classList.remove('messages-fullscreen');
    const topbarEl = document.querySelector('.topbar');
    if (topbarEl) topbarEl.style.display = '';
  }
}
tabs.forEach(t => {
  const el = document.getElementById('nav-'+t);
  if (el) el.addEventListener('click', ()=>switchTab(t));
});

// Default tab
switchTab('drive');

// Topbar actions (avatar menu)
const headerAvatarImg = document.getElementById('headerAvatarImg');
const userMenu = document.getElementById('userMenu');
const userMenuBtn = document.getElementById('btnUserMenu');
const userMenuDropdown = document.getElementById('userMenuDropdown');
const userMenuSettingsBtn = userMenuDropdown?.querySelector('[data-action="settings"]') || null;
const userMenuLogoutBtn = userMenuDropdown?.querySelector('[data-action="logout"]') || null;

let userMenuOpen = false;
function setUserMenuOpen(next) {
  userMenuOpen = !!next;
  if (!userMenuDropdown || !userMenuBtn) return;
  userMenuDropdown.classList.toggle('open', userMenuOpen);
  userMenuDropdown.setAttribute('aria-hidden', userMenuOpen ? 'false' : 'true');
  userMenuBtn.setAttribute('aria-expanded', userMenuOpen ? 'true' : 'false');
}

userMenuBtn?.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  const next = !userMenuOpen;
  setUserMenuOpen(next);
  if (next) {
    setTimeout(() => {
      userMenuSettingsBtn?.focus({ preventScroll: true });
    }, 20);
  }
});

userMenuDropdown?.addEventListener('click', (event) => {
  event.stopPropagation();
});

userMenuSettingsBtn?.addEventListener('click', (event) => {
  event.preventDefault();
  setUserMenuOpen(false);
  openSystemSettingsModal().catch((err) => {
    log({ settingsModalError: err?.message || err });
  });
});

userMenuLogoutBtn?.addEventListener('click', (event) => {
  event.preventDefault();
  setUserMenuOpen(false);
  secureLogout('已登出');
});

document.addEventListener('click', (event) => {
  if (!userMenuOpen) return;
  if (userMenu && event.target instanceof Node && userMenu.contains(event.target)) return;
  setUserMenuOpen(false);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && userMenuOpen) {
    setUserMenuOpen(false);
    userMenuBtn?.focus({ preventScroll: true });
  }
});

function applyHeaderAvatar(src, hasCustom = false) {
  if (!headerAvatarImg) return;
  if (typeof src === 'string' && src.trim()) {
    headerAvatarImg.src = src;
  } else {
    headerAvatarImg.src = '/assets/images/avatar.png';
  }
  if (hasCustom) {
    headerAvatarImg.dataset.avatarState = 'custom';
  } else if (headerAvatarImg.dataset.avatarState) {
    delete headerAvatarImg.dataset.avatarState;
  }
}

const btnUploadOpen = document.getElementById('btnUploadOpen');
if (btnUploadOpen) btnUploadOpen.addEventListener('click', openUploadModal);
const inviteBtn = document.getElementById('btnInviteQr');
const inviteCountdownEl = document.getElementById('inviteCountdown');
const inviteQrBox = document.getElementById('inviteQrBox');
const inviteScanVideo = document.getElementById('inviteScanVideo');
const inviteScanStatus = document.getElementById('inviteScanStatus');
const btnShareModal = document.getElementById('btnShareModal');
const shareModal = document.getElementById('shareModal');
const shareModalBackdrop = document.querySelector('[data-share-close]');
const btnShareSwitchScan = document.getElementById('btnShareSwitchScan');
const btnShareSwitchQr = document.getElementById('btnShareSwitchQr');
const shareFlip = document.getElementById('shareFlip');
const statContactsEl = document.getElementById('statContacts');
const statFilesEl = document.getElementById('statFiles');
const statInvitesEl = document.getElementById('statInvites');
const profileNicknameEl = document.getElementById('profileNickname');
const btnProfileNickEdit = document.getElementById('btnProfileNickEdit');
const btnProfileEdit = document.getElementById('btnProfileEdit');
const profileAvatarImg = document.getElementById('profileAvatarImg');
const contactsListEl = document.getElementById('contactsList');
const contactsScrollEl = document.getElementById('contactsScroll');
const contactsRefreshEl = document.getElementById('contactsRefreshHint');
const contactsRefreshLabel = contactsRefreshEl?.querySelector('.label') || null;
const connectionIndicator = document.getElementById('connectionIndicator');
const btnUp = document.getElementById('btnUp');
const btnNewFolder = document.getElementById('btnNewFolder');
const { inviteSecrets, shareState } = sessionStore;

const conversationListEl = document.getElementById('conversationList');
const messagesListEl = document.getElementById('messagesList');
const messagesEmptyEl = document.getElementById('messagesEmpty');
const messagesPeerNameEl = document.getElementById('messagesPeerName');
const messagesStatusEl = document.getElementById('messagesStatus');
const messagesScrollEl = document.getElementById('messagesScroll');
const messagesLoadMoreBtn = document.getElementById('messagesLoadMore');
const messagesLoadMoreLabel = messagesLoadMoreBtn?.querySelector('.label') || null;
const messagesLoadMoreSpinner = messagesLoadMoreBtn?.querySelector('.spinner') || null;

ensureMessagesElements();

messagesBackBtnEl?.addEventListener('click', () => {
  const state = getMessageState();
  state.viewMode = 'list';
  applyMessagesLayout();
  messageInputEl?.blur();
  switchTab('messages', { fromBack: true });
});

composerAttachBtn?.addEventListener('click', () => {
  showToast('檔案傳送功能尚未開放，敬請期待！');
});
if (messagesScrollEl) {
  messagesScrollEl.addEventListener('scroll', handleMessagesScroll, { passive: true });
  messagesScrollEl.addEventListener('touchend', handleMessagesTouchEnd, { passive: true });
  messagesScrollEl.addEventListener('touchcancel', handleMessagesTouchEnd, { passive: true });
  messagesScrollEl.addEventListener('wheel', handleMessagesWheel, { passive: true });
}

ensureConversationIndex();
renderConversationList();
updateComposerAvailability();
clearMessagesView();
setMessagesStatus('');
updateLayoutMode(true);
if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => updateLayoutMode());
}
document.addEventListener('contacts:rendered', renderConversationList);

document.addEventListener('contacts:open-conversation', (event) => {
  const detail = event?.detail || {};
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
  switchTab('messages');
  setActiveConversation(peerUid);
});

conversationListEl?.addEventListener('click', (event) => {
  const target = event.target.closest('.conversation-item');
  if (!target || target.classList.contains('disabled')) return;
  const peer = target.dataset.peer;
  if (peer) setActiveConversation(peer);
});

messagesLoadMoreBtn?.addEventListener('click', () => {
  loadActiveConversationMessages({ append: true });
});

messageComposerEl?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = (messageInputEl?.value || '').trim();
  if (!text) return;
  const state = getMessageState();
  if (!state.conversationToken || !state.activePeerUid) {
    setMessagesStatus('請先選擇已建立安全對話的好友', true);
    return;
  }
  if (messageSendBtn) messageSendBtn.disabled = true;
  try {
    const res = await sendDrText({ peerUidHex: state.activePeerUid, text });
    const ts = Math.floor(Date.now() / 1000);
    appendLocalOutgoingMessage({ text, ts, id: res?.msg?.id || res?.id });
    const convId = res?.convId || state.conversationId;
    if (res?.convId) state.conversationId = res.convId;
    if (messageInputEl) {
      messageInputEl.value = '';
      messageInputEl.focus();
    }
    setMessagesStatus('');
    const senderUid = getUidHex();
    if (convId && state.activePeerUid && senderUid) {
      wsSend({
        type: 'message-new',
        targetUid: state.activePeerUid,
        conversationId: convId,
        preview: text,
        ts,
        senderUid
      });
    }
  } catch (err) {
    setMessagesStatus('傳送失敗：' + (err?.message || err), true);
  } finally {
    if (messageSendBtn) messageSendBtn.disabled = false;
  }
});

messageInputEl?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    messageComposerEl?.requestSubmit();
  }
});

let wsConn = null;
let wsReconnectTimer = null;
const pendingWsMessages = [];
let _autoLoggedOut = false;
const modalController = setupModalController({ shareButtonProvider: () => btnShareModal });
const {
  openModal,
  closeModal,
  showModalLoading,
  updateLoadingModal,
  showConfirmModal,
  showProgressModal,
  updateProgressModal,
  completeProgressModal,
  failProgressModal,
  setModalObjectUrl
} = modalController;

const { setupSwipe, closeSwipe, closeOpenSwipe } = createSwipeManager();

const presenceManager = createPresenceManager({
  contactsListEl,
  wsSend
});

const contactsView = initContactsView({
  dom: { contactsListEl, contactsScrollEl, contactsRefreshEl, contactsRefreshLabel },
  loadContactsApi: loadContacts,
  saveContactApi: saveContact,
  friendsDeleteContact,
  modal: modalController,
  swipe: { setupSwipe, closeSwipe },
  presenceManager,
  updateStats: () => updateProfileStats()
});

const { loadInitialContacts, renderContacts, addContactEntry: addContactEntryRaw, removeContactLocal: removeContactLocalRaw } = contactsView;

if (typeof window !== 'undefined') {
  try {
    window.__refreshContacts = async () => {
      await loadInitialContacts();
      renderContacts();
    };
  } catch {}
}

async function addContactEntry(contact) {
  const result = await addContactEntryRaw(contact);
  syncConversationThreadsFromContacts();
  renderConversationList();
  refreshConversationPreviews({ force: true }).catch((err) => log({ conversationPreviewRefreshError: err?.message || err }));
  return result;
}

function removeContactLocal(peerUid) {
  removeContactLocalRaw?.(peerUid);
  shareController?.removeContactSecret?.(peerUid);
  syncConversationThreadsFromContacts();
  renderConversationList();
}

const profileCard = initProfileCard({
  dom: {
    profileNicknameEl,
    btnProfileNickEdit,
    btnProfileEdit,
    profileAvatarImg
  },
  modal: modalController,
  shareButton: btnShareModal,
  updateStats: () => updateProfileStats(),
  onAvatarUpdate: ({ src, hasCustom }) => applyHeaderAvatar(src, hasCustom),
  broadcastContactUpdate: (...args) => shareController?.broadcastContactUpdate?.(...args)
});

const {
  loadProfile,
  ensureAvatarThumbnail,
  buildLocalContactPayload
} = profileCard;

const profileInitPromise = loadProfile().catch((err) => {
  log({ profileInitError: err?.message || err });
  throw err;
});

shareController = setupShareController({
  dom: {
    inviteBtn,
    inviteCountdownEl,
    inviteQrBox,
    btnShareModal,
    shareModal,
    shareModalBackdrop,
    btnShareSwitchScan,
    btnShareSwitchQr,
    shareFlip,
    inviteScanVideo,
    inviteScanStatus
  },
  inviteSecrets,
  shareState,
  getProfileState: () => sessionStore.profileState,
  profileInitPromise,
  ensureAvatarThumbnail,
  buildLocalContactPayload,
  addContactEntry,
  switchTab,
  updateProfileStats,
  getCurrentTab: () => currentTab,
  showToast
});

if (typeof window !== 'undefined') {
  try { window.__shareController = shareController; } catch {}
}

const {
  restoreInviteSecrets,
  clearInviteSecrets,
  handleContactShareEvent,
  closeShareModal
} = shareController;

restoreInviteSecrets();

profileInitPromise
  .then(() => {
    const state = sessionStore.profileState;
    if (sessionStore.currentAvatarUrl) {
      applyHeaderAvatar(sessionStore.currentAvatarUrl, !!state?.avatar?.objKey);
    } else {
      applyHeaderAvatar('/assets/images/avatar.png', false);
    }
  })
  .catch(() => {});

const settingsInitPromise = ensureSettings()
  .then((settings) => {
    sessionStore.settingsState = settings;
    return settings;
  })
  .catch((err) => {
    log({ settingsInitError: err?.message || err });
    const fallback = { ...DEFAULT_SETTINGS, updatedAt: Math.floor(Date.now() / 1000) };
    sessionStore.settingsState = fallback;
    return fallback;
  });

function getEffectiveSettingsState() {
  return { ...DEFAULT_SETTINGS, ...(sessionStore.settingsState || {}) };
}

async function persistSettingsPatch(partial) {
  const previous = getEffectiveSettingsState();
  const next = { ...previous, ...partial };
  const noChange =
    previous.showOnlineStatus === next.showOnlineStatus &&
    previous.autoLogoutOnBackground === next.autoLogoutOnBackground;
  if (noChange) return previous;
  sessionStore.settingsState = next;
  try {
    const saved = await saveSettings(next);
    sessionStore.settingsState = saved;
    log({ settingsSaved: { showOnlineStatus: saved.showOnlineStatus, autoLogoutOnBackground: saved.autoLogoutOnBackground } });
    return saved;
  } catch (err) {
    sessionStore.settingsState = previous;
    throw err;
  }
}

async function openSystemSettingsModal() {
  let settings = sessionStore.settingsState;
  if (!settings) {
    try {
      settings = await settingsInitPromise;
    } catch (err) {
      log({ settingsLoadError: err?.message || err });
    }
  }
  const current = { ...DEFAULT_SETTINGS, ...(settings || {}) };

  const modalElement = document.getElementById('modal');
  const body = document.getElementById('modalBody');
  const title = document.getElementById('modalTitle');
  if (!modalElement || !body) return;

  modalElement.classList.remove(
    'security-modal',
    'progress-modal',
    'folder-modal',
    'upload-modal',
    'loading-modal',
    'confirm-modal',
    'nickname-modal',
    'avatar-modal',
    'avatar-preview-modal'
  );
  modalElement.classList.add('settings-modal');
  if (title) title.textContent = '系統設定';

  body.innerHTML = `
    <div id="systemSettings" class="settings-form">
      <div class="settings-item">
        <div class="settings-text">
          <strong>顯示我的上線狀態</strong>
          <p>好友可以看到你目前是否在線上。</p>
        </div>
        <label class="settings-switch">
          <input type="checkbox" id="settingsShowOnline" ${current.showOnlineStatus ? 'checked' : ''} />
          <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
        </label>
      </div>
      <div class="settings-item">
        <div class="settings-text">
          <strong>當畫面不在前台時自動登出</strong>
          <p>離開或縮小瀏覽器時自動清除登入狀態。</p>
        </div>
        <label class="settings-switch">
          <input type="checkbox" id="settingsAutoLogout" ${current.autoLogoutOnBackground ? 'checked' : ''} />
          <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
        </label>
      </div>
      <div class="settings-actions">
        <button type="button" class="secondary" id="settingsClose">關閉</button>
      </div>
    </div>`;

  openModal();

  const closeBtn = body.querySelector('#settingsClose');
  const showOnlineInput = body.querySelector('#settingsShowOnline');
  const autoLogoutInput = body.querySelector('#settingsAutoLogout');
  closeBtn?.addEventListener('click', () => {
    closeModal();
  }, { once: true });

  const registerToggle = (input, key) => {
    if (!input) return;
    input.addEventListener('change', async () => {
      const previous = getEffectiveSettingsState();
      const nextValue = !!input.checked;
      if (previous[key] === nextValue) return;
      input.disabled = true;
      try {
        await persistSettingsPatch({ [key]: nextValue });
        if (key === 'autoLogoutOnBackground') {
          _autoLoggedOut = false;
        }
      } catch (err) {
        log({ settingsAutoSaveError: err?.message || err });
        alert('儲存設定失敗，請稍後再試。');
        input.checked = !!previous[key];
      } finally {
        input.disabled = false;
      }
    });
  };

  registerToggle(showOnlineInput, 'showOnlineStatus');
  registerToggle(autoLogoutInput, 'autoLogoutOnBackground');
}

loadInitialContacts()
  .then(() => {
    syncConversationThreadsFromContacts();
    return refreshConversationPreviews({ force: true });
  })
  .catch((err) => log({ contactsInitError: err?.message || err }))
  .finally(() => {
    renderConversationList();
    ensureWebSocket();
  });

btnNewFolder?.addEventListener('click', openFolderModal);
btnUp?.addEventListener('click', () => {
  if (!cwd.length) return;
  cwd.pop();
  refreshDriveList().catch(() => {});
});

// Drive: cwd + UI
let cwd = [];
function cwdPath(){ return cwd.join('/'); }
function renderCrumb(){
  const el = document.getElementById('driveCrumb'); if (!el) return;
  const parts = [{ name:'根目錄', path:'' }, ...cwd.map((seg,idx)=>({ name:seg, path: cwd.slice(0,idx+1).join('/') }))];
  el.innerHTML = '';
  parts.forEach((p,i)=>{
    const isLast = i === parts.length - 1;
    const node = document.createElement(isLast ? 'span' : 'button');
    node.textContent = p.name;
    node.className = isLast ? 'crumb-current' : 'crumb-link';
    if (!isLast) {
      node.type = 'button';
      node.addEventListener('click', (e)=>{
        e.preventDefault();
        cwd = p.path ? p.path.split('/') : [];
        refreshDriveList().catch(()=>{});
      });
    }
    el.appendChild(node);
    if (!isLast || i === 0) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '/';
      el.appendChild(sep);
    }
  });
}

function updateProfileStats() {
  if (statContactsEl) {
    const count = sessionStore.contactIndex.size || sessionStore.contactState.length || 0;
    statContactsEl.textContent = String(count);
  }
}

function sanitizeFolderName(raw) {
  if (raw === undefined || raw === null) return '';
  const cleaned = String(raw)
    .replace(/[\u0000-\u001F\u007F]/gu, '')
    .replace(/[\\/]/g, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return '';
  return cleaned.slice(0, 96);
}

function getDirSegmentsFromHeader(header) {
  if (!header) return [];
  const dir = header.dir;
  if (Array.isArray(dir)) {
    return dir.map((seg) => String(seg || '').trim()).filter(Boolean);
  }
  if (typeof dir === 'string') {
    return String(dir)
      .split('/')
      .map((seg) => String(seg || '').trim())
      .filter(Boolean);
  }
  return [];
}

function pathStartsWith(pathSegments, prefixSegments) {
  if (prefixSegments.length > pathSegments.length) return false;
  for (let i = 0; i < prefixSegments.length; i += 1) {
    if (pathSegments[i] !== prefixSegments[i]) return false;
  }
  return true;
}

function ensureWebSocket() {
  if (wsConn || wsReconnectTimer) return;
  const uid = getUidHex();
  if (!uid) return;
  connectWebSocket();
}

function connectWebSocket() {
  const uid = getUidHex();
  if (!uid) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const baseHost = connectionIndicator?.dataset?.wsHost || location.host;
  const path = connectionIndicator?.dataset?.wsPath || '/api/ws';
  const ws = new WebSocket(`${proto}//${baseHost}${path}`);
  wsConn = ws;
  updateConnectionIndicator('connecting');
  ws.onopen = () => {
    log({ wsState: 'open' });
    wsReconnectTimer = null;
    try { ws.send(JSON.stringify({ type: 'auth', uid })); } catch {}
    if (pendingWsMessages.length) {
      for (const msg of pendingWsMessages.splice(0)) {
        try { ws.send(JSON.stringify(msg)); } catch (err) { log({ wsSendError: err?.message || err }); }
      }
    }
  };
  ws.onmessage = (event) => {
    log({ wsMessageRaw: event.data });
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    handleWebSocketMessage(msg);
  };
  ws.onclose = (evt) => {
    log({ wsClose: { code: evt.code, reason: evt.reason } });
    wsConn = null;
    updateConnectionIndicator('offline');
    presenceManager.clearPresenceState();
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(() => {
      wsReconnectTimer = null;
      connectWebSocket();
    }, 2000);
  };
  ws.onerror = () => {
    log({ wsError: true });
    updateConnectionIndicator('offline');
    try { ws.close(); } catch {}
  };
}

function wsSend(payload) {
  if (!wsConn || wsConn.readyState !== WebSocket.OPEN) {
    pendingWsMessages.push(payload);
    ensureWebSocket();
    return false;
  }
  try {
    wsConn.send(JSON.stringify(payload));
    return true;
  } catch (err) {
    log({ wsSendError: err?.message || err });
    pendingWsMessages.push(payload);
    ensureWebSocket();
    return false;
  }
}

function updateConnectionIndicator(state) {
  if (!connectionIndicator) return;
  connectionIndicator.classList.remove('online', 'connecting');
  if (state === 'online') {
    connectionIndicator.classList.add('online');
    connectionIndicator.innerHTML = `<span class="dot" aria-hidden="true"></span>在線`;
    return;
  }
  if (state === 'connecting') {
    connectionIndicator.classList.add('connecting');
    connectionIndicator.innerHTML = `<span class="dot" aria-hidden="true"></span>連線中…`;
    return;
  }
  connectionIndicator.innerHTML = `<span class="dot" aria-hidden="true"></span>離線`;
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

  let tsRaw = Number(event?.ts ?? event?.timestamp);
  if (!Number.isFinite(tsRaw)) tsRaw = Math.floor(Date.now() / 1000);
  thread.lastMessageTs = tsRaw;
  const previewRaw = cleanPreviewText(event?.preview ?? event?.text ?? '');
  if (previewRaw) thread.lastMessageText = previewRaw;
  else if (!thread.lastMessageText) thread.lastMessageText = '有新訊息';
  const messageId = event?.messageId || event?.message_id;
  if (messageId) thread.lastMessageId = messageId;

  const myUid = getUidHex();
  const senderUidRaw = event?.senderUid || event?.sender_uid || null;
  const senderUid = senderUidRaw ? String(senderUidRaw).replace(/[^0-9a-f]/gi, '').toUpperCase() : null;
  const isSelf = !!(myUid && senderUid && myUid === senderUid);

  const state = getMessageState();
  const active = state.conversationId === convId && state.activePeerUid === peerUid;
  const onMessagesTab = currentTab === 'messages';

  if (isSelf) {
    thread.unreadCount = 0;
    thread.lastReadTs = tsRaw;
    thread.lastDirection = 'outgoing';
    renderConversationList();
    return;
  }

  playNotificationSound();

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
  showToast(toastMessage, {
    onClick: () => {
      switchTab('messages');
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

function handleWebSocketMessage(msg) {
    const type = msg?.type;
    if (type === 'hello') return;
    if (type === 'auth') {
      if (msg?.ok) updateConnectionIndicator('online');
      else updateConnectionIndicator('offline');
      if (msg?.ok) presenceManager.sendPresenceSubscribe();
      return;
    }
    if (type === 'invite-accepted') {
      if (msg?.inviteId && msg?.fromUid) {
        log({ inviteAcceptedEvent: msg });
      }
      return;
    }
    if (type === 'contact-share') {
      handleContactShareEvent(msg).catch((err) => log({ contactShareError: err?.message || err }));
      return;
    }
    if (type === 'contacts-reload') {
      loadInitialContacts().catch((err) => log({ contactsInitError: err?.message || err }));
      return;
    }
    if (type === 'presence') {
      const online = Array.isArray(msg?.online) ? msg.online : [];
      presenceManager.applyPresenceSnapshot(online);
      return;
    }
    if (type === 'presence-update') {
      const uid = String(msg?.uid || '').trim().toUpperCase();
      if (!uid) return;
      presenceManager.setContactPresence(uid, !!msg?.online);
      return;
    }
    if (type === 'secure-message' || type === 'message-new') {
      handleIncomingSecureMessage(msg);
      return;
    }
}

// Drive: list
const driveList = $('#driveList');
async function refreshDriveList(){
  const acct = (getAccountDigest() || '').toUpperCase(); if (!acct) throw new Error('Account missing');
  const convId = `drive-${acct}`;
  const { r, data } = await listMessages({ convId, limit: 50 });
  if (!r.ok) throw new Error(typeof data==='string'?data:JSON.stringify(data));
  const items = Array.isArray(data?.items) ? data.items : [];
  currentMessages = items;
  currentConvId = convId;
  renderDriveList(items, convId);
  updateProfileStats();
}

if (typeof window !== 'undefined') {
  try {
    window.__refreshDrive = async () => {
      try {
        await refreshDriveList();
      } catch (err) {
        log({ driveRefreshError: err?.message || err });
      }
    };
    window.__getContactState = () => {
      try {
        return Array.isArray(sessionStore.contactState) ? sessionStore.contactState.map((c) => ({ ...c })) : [];
      } catch (err) {
        log({ contactStateSnapshotError: err?.message || err });
        return [];
      }
    };
    window.__refreshConversations = async () => {
      try {
        await refreshConversationPreviews({ force: true });
        renderConversationList();
      } catch (err) {
        log({ conversationRefreshError: err?.message || err });
      }
    };
  } catch {}
}

function renderDriveList(items, convId){
  if (!driveList) return;
  closeOpenSwipe();
  renderCrumb();
  driveList.innerHTML = '';
  // toggle back button visibility
  if (btnUp) btnUp.style.display = cwd.length ? 'inline-flex' : 'none';
  // Build current-level folders and files
  const folderSet = new Map();
  const files = [];
  const prefix = convId + '/' + (cwdPath() ? cwdPath() + '/' : '');
  const currentPath = [...cwd];
  for (const it of items) {
    const header = safeJSON(it.header_json || it.header || '{}');
    const dirSegments = getDirSegmentsFromHeader(header);
    const objKey = typeof it?.obj_key === 'string' && it.obj_key ? it.obj_key : (typeof header?.obj === 'string' ? header.obj : '');
    const key = objKey;

    if (dirSegments.length) {
      if (!pathStartsWith(dirSegments, currentPath)) continue;
      if (dirSegments.length > currentPath.length) {
        const next = dirSegments[currentPath.length];
        if (next) folderSet.set(next, (folderSet.get(next) || 0) + 1);
        continue;
      }
      files.push({ header, ts: it.ts, obj_key: objKey });
      continue;
    }

    if (!key || !key.startsWith(prefix)) continue; // legacy items without dir metadata
    const rel = key.slice(prefix.length);
    if (rel.includes('/')) {
      const first = rel.split('/')[0];
      folderSet.set(first, (folderSet.get(first)||0)+1);
    } else {
      files.push({ header, ts: it.ts, obj_key: objKey });
    }
  }
  // render folders
  const folders = Array.from(folderSet.entries()).sort((a,b)=>a[0].localeCompare(b[0]));
  for (const [name,count] of folders) {
    const li = document.createElement('li'); li.className='file-item folder';
    li.dataset.type = 'folder';
    li.dataset.folderName = name;
    li.setAttribute('role','button');
    li.tabIndex = 0;
    li.innerHTML = `
      <div class="item-content">
        <div class="meta">
          <div class="name"><i class='bx bx-folder' aria-hidden="true"></i><span class="label">${escapeHtml(name)}</span></div>
          <div class="sub">${count} 項</div>
        </div>
      </div>
      <button type="button" class="item-delete" aria-label="刪除"><i class='bx bx-trash'></i></button>`;
    const open = () => {
      if (li.classList.contains('show-delete')) {
        closeSwipe(li);
        return;
      }
      closeOpenSwipe();
      cwd.push(name);
      refreshDriveList().catch(()=>{});
    };
    li.addEventListener('click', (e)=>{
      if (e.target.closest('.item-delete')) return;
      if (li.classList.contains('show-delete')) { closeSwipe(li); return; }
      e.preventDefault();
      open();
    });
    li.addEventListener('keydown', (e)=>{
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      if (e.key === 'Delete') { handleItemDelete({ type: 'folder', name, element: li }); }
    });
    li.querySelector('.item-delete')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleItemDelete({ type: 'folder', name, element: li });
    });
    li.querySelector('.label')?.setAttribute('title', name);
  setupSwipe(li);
  driveList.appendChild(li);
}
  // render files
  for (const f of files) {
    const key  = f.obj_key || f.header?.obj || '';
    const name = f.header?.name || key.split('/').pop() || 'file.bin';
    const size = f.header?.size || 0;
    const ct   = f.header?.contentType || 'application/octet-stream';
    const ts   = f.ts ? new Date(f.ts*1000).toLocaleString() : '';
    const iconClass = fileIconForName(name, ct);
    const li = document.createElement('li');
    li.className = 'file-item file';
    li.dataset.type = 'file';
    li.dataset.key = key || '';
    li.dataset.name = name;
    li.setAttribute('role','button');
    li.tabIndex = 0;
    li.innerHTML = `
      <div class="item-content">
        <div class="meta">
          <div class="name"><i class='${iconClass}' aria-hidden="true"></i><span class="label">${escapeHtml(name)}</span></div>
          <div class="sub">${fmtSize(size)} · ${escapeHtml(ct)} · ${escapeHtml(ts)}</div>
        </div>
      </div>
      <button type="button" class="item-delete" aria-label="刪除"><i class='bx bx-trash'></i></button>`;
    const preview = () => {
      if (li.classList.contains('show-delete')) {
        closeSwipe(li);
        return;
      }
      closeOpenSwipe();
      doPreview(key, ct, name).catch(err => {
        closeModal();
        log({ previewError: String(err?.message || err) });
      });
    };
    li.addEventListener('click', (e)=>{
      if (e.target.closest('.item-delete')) return;
      if (li.classList.contains('show-delete')) { closeSwipe(li); return; }
      e.preventDefault(); preview();
    });
    li.addEventListener('keydown', (e)=>{
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); preview(); }
      if (e.key === 'Delete') { handleItemDelete({ type: 'file', key, name, element: li }); }
    });
    li.querySelector('.item-delete')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleItemDelete({ type: 'file', key, name, element: li });
    });
    li.querySelector('.label')?.setAttribute('title', name);
    setupSwipe(li);
    driveList.appendChild(li);
  }
  if (!folders.length && !files.length) {
    driveList.innerHTML = '<li class="empty">（此資料夾沒有內容）</li>';
  }
}

function openUploadModal(){
  const modal = document.getElementById('modal');
  const body = document.getElementById('modalBody');
  const title = document.getElementById('modalTitle');
  if (!modal || !body) return;
  modal.classList.remove('security-modal', 'progress-modal', 'folder-modal', 'nickname-modal');
  modal.classList.add('upload-modal');
  if (title) title.textContent = '上傳檔案';
  body.innerHTML = `
    <form id="uploadForm" class="upload-form">
      <div class="upload-field">
        <input id="uploadFileInput" type="file" class="upload-input" />
        <label for="uploadFileInput" class="upload-callout">
          <i class='bx bx-cloud-upload'></i>
          <span>點擊選擇檔案</span>
        </label>
      </div>
      <div id="uploadFileName" class="upload-name">尚未選擇檔案</div>
      <p class="upload-hint">支援 iOS Safari：會開啟照片、檔案選擇器。</p>
      <p class="upload-error" role="alert"></p>
      <div class="upload-actions">
        <button type="button" id="uploadCancel" class="secondary">取消</button>
        <button type="submit" class="primary">上傳</button>
      </div>
    </form>`;
  openModal();
  const input = body.querySelector('#uploadFileInput');
  const nameEl = body.querySelector('#uploadFileName');
  const errorEl = body.querySelector('.upload-error');
  const cancelBtn = body.querySelector('#uploadCancel');
  const form = body.querySelector('#uploadForm');
  cancelBtn?.addEventListener('click', () => closeModal(), { once: true });
  input?.addEventListener('change', () => {
    if (nameEl) nameEl.textContent = input?.files?.[0]?.name || '尚未選擇檔案';
    if (errorEl) errorEl.textContent = '';
  });
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = input?.files?.[0];
    if (!file) {
      if (errorEl) errorEl.textContent = '請先選擇要上傳的檔案。';
      return;
    }
    closeModal();
    await startUpload(file);
  }, { once: true });
}

function openFolderModal(){
  const modal = document.getElementById('modal');
  const body = document.getElementById('modalBody');
  const title = document.getElementById('modalTitle');
  if (!modal || !body) return;
  modal.classList.remove('security-modal', 'progress-modal', 'upload-modal', 'nickname-modal');
  modal.classList.add('folder-modal');
  if (title) title.textContent = '新增資料夾';
  body.innerHTML = `
    <form id="folderForm" class="folder-form">
      <label for="folderNameInput">資料夾名稱</label>
      <input id="folderNameInput" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="例如：旅行紀錄 ✈️" />
      <p class="folder-hint">可輸入中文或 emoji，僅禁止使用 / 等分隔符號。</p>
      <p class="folder-error" role="alert"></p>
      <div class="folder-actions">
        <button type="button" id="folderCancel" class="secondary">取消</button>
        <button type="submit" class="primary">建立</button>
      </div>
    </form>`;
  openModal();
  const input = body.querySelector('#folderNameInput');
  const form = body.querySelector('#folderForm');
  const cancelBtn = body.querySelector('#folderCancel');
  const errorEl = body.querySelector('.folder-error');
  setTimeout(() => input?.focus(), 40);
  cancelBtn?.addEventListener('click', () => closeModal(), { once: true });
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const safe = sanitizeFolderName(input?.value || '');
    if (!safe) {
      if (errorEl) errorEl.textContent = '資料夾名稱不可為空，且不可包含 / 或控制字元。';
      input?.focus();
      input?.select?.();
      return;
    }
    if (input) input.value = safe;
    if (errorEl) errorEl.textContent = '';
    cwd.push(safe);
    closeModal();
    try {
      await refreshDriveList();
    } catch (err) {
      log({ driveListError: String(err?.message || err) });
    }
  });
}

async function startUpload(file) {
  if (!file) return;
  const acct = (getAccountDigest() || '').toUpperCase();
  if (!acct) {
    alert('尚未登入，請重新登入後再試。');
    return;
  }
  const convId = currentConvId || `drive-${acct}`;
  showProgressModal(file.name || '檔案');
  try {
    await encryptAndPutWithProgress({
      convId,
      file,
      dir: [...cwd],
      onProgress: (p) => updateProgressModal(p)
    });
    completeProgressModal();
    await refreshDriveList();
  } catch (err) {
    log({ driveUploadError: err?.message || err });
    failProgressModal(err?.message || String(err));
  }
}

async function doPreview(key, contentTypeHint, nameHint) {
  showModalLoading('下載加密檔案中…');
  try {
    const { blob, contentType, name } = await downloadAndDecrypt({
      key,
      onProgress: ({ stage, loaded, total }) => {
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

    const ct = contentType || contentTypeHint || 'application/octet-stream';
    const resolvedName = name || nameHint || key.split('/').pop() || 'download.bin';
    const body = document.getElementById('modalBody');
    const title = document.getElementById('modalTitle');
    if (!body || !title) {
      closeModal();
      return;
    }

    body.innerHTML = '';
    title.textContent = resolvedName;
    title.setAttribute('title', resolvedName);

    const downloadBtn = document.getElementById('modalDownload');
    if (downloadBtn) {
      downloadBtn.style.display = 'inline-flex';
      downloadBtn.onclick = () => onDownloadByKey(key, resolvedName);
    }

    const url = URL.createObjectURL(blob);
    setModalObjectUrl(url);

    const container = document.createElement('div');
    container.className = 'preview-wrap';
    const wrap = document.createElement('div');
    wrap.className = 'viewer';
    container.appendChild(wrap);
    body.appendChild(container);

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
      } catch (err) {
        const msg = document.createElement('div');
        msg.className = 'preview-message';
        msg.textContent = '無法顯示文字內容。';
        wrap.appendChild(msg);
      }
    } else {
      const message = document.createElement('div');
      message.style.textAlign = 'center';
      message.innerHTML = `無法預覽此類型（${escapeHtml(ct)}）。<br/><br/>`;
      const link = document.createElement('a');
      link.href = url;
      link.download = resolvedName;
      link.textContent = '下載檔案';
      link.className = 'primary';
      message.appendChild(link);
      wrap.appendChild(message);
    }

    openModal();
  } catch (err) {
    closeModal();
    throw err;
  }
}

async function handleItemDelete({ type, key, name, element }) {
  if (!currentConvId) return;

  if (type === 'file') {
    if (!key) return;
    const matches = currentMessages
      .filter((msg) => {
        const direct = typeof msg?.obj_key === 'string' ? msg.obj_key : '';
        if (direct && direct === key) return true;
        const header = safeJSON(msg?.header_json || msg?.header || '{}');
        return typeof header?.obj === 'string' && header.obj === key;
      });
    const ids = matches.map((msg) => String(msg?.id || '')).filter(Boolean);

    if (element) closeSwipe(element);
    showConfirmModal({
      title: '確認刪除',
      message: `確定刪除「${escapeHtml(name || key)}」？`,
      confirmLabel: '刪除',
      onConfirm: async () => {
        try {
          await performDelete({ keys: [key], ids });
          await refreshDriveList();
        } catch (err) {
          log({ deleteError: String(err?.message || err) });
        }
      },
      onCancel: () => { if (element) closeSwipe(element); }
    });
    return;
  }

  const folderName = String(name || '').trim();
  if (!folderName) return;
  const rel = cwdPath();
  const folderRel = rel ? `${rel}/${folderName}` : folderName;
  const prefix = `${currentConvId}/${folderRel}`;
  const targetMessages = currentMessages
    .map((it) => {
      const direct = typeof it?.obj_key === 'string' ? it.obj_key : '';
      if (direct) return direct;
      const header = safeJSON(it?.header_json || it?.header || '{}');
      return typeof header?.obj === 'string' ? header.obj : '';
    })
    .map((objKey, idx) => ({ objKey, id: String(currentMessages[idx]?.id || '') }))
    .filter(({ objKey }) => objKey && objKey.startsWith(`${prefix}/`));

  if (!targetMessages.length) {
    log({ deleteInfo: `資料夾「${folderName}」內沒有檔案` });
    return;
  }

  const keys = Array.from(new Set(targetMessages.map(m => m.objKey)));
  const ids = Array.from(new Set(targetMessages.map(m => m.id).filter(Boolean)));

  if (element) closeSwipe(element);
  showConfirmModal({
    title: '確認刪除',
    message: `刪除資料夾「${escapeHtml(folderName)}」及其 ${keys.length} 個檔案？`,
    confirmLabel: '刪除',
    onConfirm: async () => {
      try {
        await performDelete({ keys, ids });
        await refreshDriveList();
      } catch (err) {
        log({ deleteError: String(err?.message || err) });
      }
    },
    onCancel: () => { if (element) closeSwipe(element); }
  });
}

if (typeof window !== 'undefined') {
  try {
    window.__deleteDriveObject = async (key) => {
      if (!currentConvId || !key) return false;
      const matches = currentMessages
        .filter((msg) => {
          const direct = typeof msg?.obj_key === 'string' ? msg.obj_key : '';
          if (direct && direct === key) return true;
          const header = safeJSON(msg?.header_json || msg?.header || '{}');
          return typeof header?.obj === 'string' && header.obj === key;
        });
      const ids = matches.map((msg) => String(msg?.id || '')).filter(Boolean);
      try {
        log({ driveDeleteAttempt: { key, ids, matches: matches.length } });
        await performDelete({ keys: [key], ids });
        await refreshDriveList();
        return true;
      } catch (err) {
        log({ deleteError: String(err?.message || err), key });
        return false;
      }
    };
  } catch {}
}

async function performDelete({ keys = [], ids = [] }) {
  if (!keys.length && !ids.length) return;
  const { deleted, failed } = await deleteEncryptedObjects({ keys, ids });
  log({ driveDeleteResult: { keys, ids, deleted, failed } });
  if (deleted?.length) log({ deleted });
  if (failed?.length) log({ deleteFailed: failed });
}

async function onDownloadByKey(key, nameHint){
  try {
    const meta = await getEnvelopeForKey(key);
    const outObj = await downloadAndDecrypt({ key, envelope: meta });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(outObj.blob);
    a.download = outObj.name || nameHint || 'download.bin';
    document.body.appendChild(a);
    a.click();
    URL.revokeObjectURL(a.href);
    a.remove();
    log({ downloaded: { bytes: outObj.bytes, name: outObj.name, type: outObj.contentType } });
  } catch (err) { log({ downloadError: String(err?.message||err) }); }
}

function shouldAutoLogoutOnBackground() {
  const state = sessionStore.settingsState;
  if (state && typeof state.autoLogoutOnBackground === 'boolean') {
    return state.autoLogoutOnBackground;
  }
  return DEFAULT_SETTINGS.autoLogoutOnBackground;
}

function secureLogout(reason){
  if (shareState.open) {
    closeShareModal();
  }
  try {
    sessionStorage.removeItem('mk_b64');
    sessionStorage.removeItem('uid_hex');
    sessionStorage.removeItem('account_token');
    sessionStorage.removeItem('account_digest');
    sessionStorage.removeItem('uid_digest');
  } catch {}
  try { clearInviteSecrets(); } catch {}
  sessionStore.settingsState = null;
  presenceManager.clearPresenceState();
  try {
    const del = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || isSimStorageKey(k)) continue;
      if (k.startsWith('env_v1:')) del.push(k);
    }
    for (const k of del) {
      try { localStorage.removeItem(k); } catch {}
    }
  } catch {}
  try { resetAll(); } catch { try { clearSecrets(); } catch {} }
  // show modal message and freeze UI; user must re-tap tag to login again
  const modal = document.getElementById('modal');
  if (modal) {
    modal.classList.remove('progress-modal', 'folder-modal', 'upload-modal');
    modal.classList.add('security-modal');
  }
  setUserMenuOpen(false);
  if (userMenu) userMenu.style.display = 'none';
  const body = document.getElementById('modalBody');
  const title = document.getElementById('modalTitle');
  if (body) {
    const msg = reason || '偵測到畫面不在前台，已清除所有資料。';
    body.innerHTML = `
      <div class="security-message">
        <div>${escapeHtml(msg)}</div>
        <strong>請關閉此頁面，重新感應晶片再次登入。</strong>
      </div>`;
  }
  if (title) title.textContent = '安全提醒';
  openModal();
  try {
    const main = document.querySelector('main.content');
    if (main) {
      main.setAttribute('aria-hidden', 'true');
      main.classList.add('security-locked');
    }
  } catch {}
}

function onHidden(){
  if (!shouldAutoLogoutOnBackground()) return;
  if (_autoLoggedOut) return;
  _autoLoggedOut = true;
  secureLogout('偵測到畫面不在前台，已清除所有資料。');
}
function onVisible(){ /* no-op */ }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') onHidden(); else onVisible(); });
window.addEventListener('pagehide', () => {
  const state = document.visibilityState;
  if (state === 'hidden' || state === 'prerender' || typeof state !== 'string') {
    onHidden();
  }
});
// initial crumb render
renderCrumb();

// Cross-device: locate envelope from conversation index when local cache missing
async function getEnvelopeForKey(key){
  // 1) local cache
  const local = loadEnvelopeMeta(key);
  if (local && local.iv_b64 && local.hkdf_salt_b64) return local;
  // 2) fetch from index (header.env)
  const acct = (getAccountDigest() || '').toUpperCase();
  if (!acct) throw new Error('Account missing');
  const convId = `drive-${acct}`;
  const { r, data } = await listMessages({ convId, limit: 100 });
  if (!r.ok) throw new Error(typeof data==='string'?data:JSON.stringify(data));
  const arr = Array.isArray(data?.items) ? data.items : [];
  for (const it of arr) {
    const header = safeJSON(it.header_json || it.header || '{}');
    if (header && header.obj === key && header.env && header.env.iv_b64 && header.env.hkdf_salt_b64) {
      // normalize to meta format used by downloadAndDecrypt
      return {
        iv_b64: header.env.iv_b64,
        hkdf_salt_b64: header.env.hkdf_salt_b64,
        contentType: header.contentType || 'application/octet-stream',
        name: header.name || 'decrypted.bin'
      };
    }
  }
  throw new Error('找不到封套資料（此物件可能來自尚未更新索引格式的舊版本）');
}

// Harden autofill: disable autocomplete/autocapitalize/spellcheck on all inputs
(function hardenAutofill(){
  try {
    const els = document.querySelectorAll('input, textarea');
    els.forEach(el => {
      el.setAttribute('autocomplete','off');
      el.setAttribute('autocapitalize','off');
      el.setAttribute('autocorrect','off');
      el.setAttribute('spellcheck','false');
    });
  } catch {}
})();
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
        await friendsDeleteContact({ peerUid: key });
        removeContactLocal(key);
        if (element) closeSwipe(element);
        const state = getMessageState();
        if (state.activePeerUid === key) {
          resetMessageState();
          messagesPeerNameEl.textContent = '選擇好友開始聊天';
          clearMessagesView();
          updateComposerAvailability();
          applyMessagesLayout();
        }
        renderConversationList();
      } catch (err) {
        log({ conversationDeleteError: err?.message || err });
        alert('刪除對話失敗，請稍後再試。');
      }
    },
    onCancel: () => { if (element) closeSwipe(element); }
  });
}
