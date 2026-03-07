export function escapeHtml(input) {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function escapeSelector(value) {
  if (!value) return '';
  return String(value).replace(/["\\]/g, '\\$&');
}

export function fmtSize(bytes) {
  if (!Number.isFinite(bytes)) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let idx = 0;
  let value = Number(bytes);
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return idx ? `${value.toFixed(1)} ${units[idx]}` : `${value} ${units[idx]}`;
}

export function safeJSON(source) {
  try {
    return typeof source === 'string' ? JSON.parse(source) : source;
  } catch {
    return null;
  }
}

export function bytesToB64(u8) {
  let out = '';
  for (let i = 0; i < u8.length; i += 1) {
    out += String.fromCharCode(u8[i]);
  }
  return btoa(out);
}

export function bytesToB64Url(u8) {
  return bytesToB64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function toB64Url(str) {
  return String(str || '').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function fromB64Url(str) {
  const normalized = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4;
  return normalized + (pad ? '='.repeat(4 - pad) : '');
}

export function b64ToBytes(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export function b64UrlToBytes(str) {
  const cleaned = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const mod = cleaned.length % 4;
  const padded = mod ? cleaned + '='.repeat(4 - mod) : cleaned;
  return b64ToBytes(padded);
}

export function b64u8(str) {
  return b64ToBytes(str);
}

export function shouldNotifyForMessage({ computedIsHistoryReplay = false, silent = false } = {}) {
  if (computedIsHistoryReplay) return false;
  if (silent) return false;
  return true;
}

// Re-export i18n utilities for convenience
export { t, getCurrentLang, setLang, applyDOMTranslations } from '/locales/index.js';

export async function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(blob);
  });
}

const SNIPPET_MAX_LEN = 42;

export function buildConversationSnippet(text) {
  if (!text) return '';
  const cleaned = String(text).replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned.length > SNIPPET_MAX_LEN ? `${cleaned.slice(0, SNIPPET_MAX_LEN - 1)}…` : cleaned;
}

import { t } from '/locales/index.js';

function getMsgTypeLabels() {
  return {
    'call-log': t('calls.callLog'),
    'call_log': t('calls.callLog'),
    'conversation-deleted': '',
    'conversation_deleted': '',
    'session-init': t('messages.secureConnectionEstablished'),
    'session_init': t('messages.secureConnectionEstablished'),
    'session-ack': t('messages.secureConnectionEstablished'),
    'session_ack': t('messages.secureConnectionEstablished'),
    'system': t('messages.systemMessage')
  };
}

function getContactShareReasonLabels() {
  return {
    nickname: t('profile.updatedNickname'),
    avatar: t('profile.updatedAvatar'),
    profile: t('profile.updatedProfile'),
    update: t('profile.updatedProfile'),
    manual: t('profile.updatedProfile')
  };
}

function resolveContactSharePreview(item) {
  const labels = getContactShareReasonLabels();
  // 1. Try reason from spread content fields (live-decrypt path)
  const directReason = item?.reason;
  if (directReason && labels[directReason]) {
    return labels[directReason];
  }
  // 2. Try parsing text JSON (formatThreadPreview path — text is raw JSON)
  const text = typeof item?.text === 'string' ? item.text : '';
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      const reason = parsed?.reason;
      if (reason && labels[reason]) {
        return labels[reason];
      }
    } catch { /* not JSON */ }
  }
  return t('messages.secureConnectionEstablished');
}

/**
 * Resolve human-readable preview text from a message item.
 * This is the SINGLE source of truth for all preview text generation.
 *
 * Accepts either a timeline message object or a plain { text, msgType, media, callLog } bag.
 */
export function resolveMessagePreview(item) {
  if (!item) return t('messages.newMessage');
  const msgType = item.msgType || item.type || item.subtype || null;
  const msgTypeLabels = getMsgTypeLabels();

  // 1a. Contact-share — reason-aware preview
  if (msgType === 'contact-share' || msgType === 'contact_share') {
    return resolveContactSharePreview(item);
  }

  // 1b. Static type labels (non-media)
  if (msgType && msgTypeLabels[msgType] !== undefined) {
    return msgTypeLabels[msgType] || '';
  }

  // 2. Media — resolve by MIME when available
  if (msgType === 'media' || item.media) {
    const media = item.media || item;
    const mime = (media.contentType || media.mimeType || '').toLowerCase();
    if (mime.startsWith('image/')) return `[${t('common.image')}]`;
    if (mime.startsWith('video/')) return `[${t('common.video')}]`;
    const name = media.name || media.filename || t('common.attachment');
    return `${t('fileSending.filePrefix')}${name}`;
  }

  // 3. Call log
  if (msgType === 'call-log' || msgType === 'call_log') {
    const kind = item.callLog?.kind || item.kind || '';
    return kind === 'video' ? `[${t('calls.videoCall')}]` : `[${t('calls.voiceCall')}]`;
  }

  // 4. Plain text — check for raw JSON payloads
  const text = typeof item.text === 'string' ? item.text : '';
  if (text === 'CONTROL_SKIP') return t('messages.systemMessage');
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      const innerType = parsed?.type || parsed?.msgType || null;
      if (innerType === 'contact-share' || innerType === 'contact_share') {
        return resolveContactSharePreview(parsed);
      }
      if (innerType && msgTypeLabels[innerType] !== undefined) {
        return msgTypeLabels[innerType];
      }
      if (innerType === 'media') {
        const mime = (parsed.contentType || parsed.mimeType || '').toLowerCase();
        if (mime.startsWith('image/')) return `[${t('common.image')}]`;
        if (mime.startsWith('video/')) return `[${t('common.video')}]`;
        return `${t('fileSending.filePrefix')}${parsed.name || parsed.filename || t('common.attachment')}`;
      }
      return t('messages.newMessage');
    } catch { /* not JSON, fall through */ }
  }
  return buildConversationSnippet(text) || t('messages.newMessage');
}

/**
 * Degraded preview strings that should not overwrite a good decrypted preview.
 */
function getDegradedPreviews() {
  return new Set([
    t('messages.notDecrypted'),
    t('messages.loadFailed'),
    t('messages.encryptedMessage')
  ]);
}

export function isDegradedPreview(text) {
  return !text || getDegradedPreviews().has(text);
}

/**
 * Single entry-point to update a thread's preview fields with guard logic.
 * Returns true if the thread was actually updated.
 */
export function updateThreadPreview(thread, { text, ts, messageId, direction, msgType } = {}, { force = false } = {}) {
  if (!thread) return false;
  const newTs = Number(ts) || 0;
  const existingTs = Number(thread.lastMessageTs) || 0;

  if (thread.previewLoaded && existingTs > 0 && !force) {
    // Don't overwrite with older message
    if (newTs > 0 && newTs < existingTs) return false;
    // Don't overwrite a good preview with a degraded one for the same message
    if (thread.lastMessageId === messageId
        && thread.lastMessageText
        && !isDegradedPreview(thread.lastMessageText)
        && isDegradedPreview(text)) {
      return false;
    }
  }

  thread.lastMessageText = text ?? '';
  thread.lastMessageTs = Number.isFinite(Number(ts)) ? Number(ts) : null;
  thread.lastMessageId = messageId || null;
  thread.lastDirection = direction || null;
  thread.lastMsgType = msgType || null;
  thread.previewLoaded = true;
  thread.needsRefresh = false;

  // Conversation-deleted tombstone: reset unread as a safety net
  if (msgType === 'conversation-deleted') {
    thread.unreadCount = 0;
    thread.offlineUnreadCount = 0;
  }

  return true;
}

/**
 * Single formatThreadPreview — render a thread object into a display snippet.
 */
export function formatThreadPreview(thread) {
  if (!thread) return t('messages.noMessages');
  if (thread.lastMsgType === 'conversation-deleted' || thread.lastMsgType === 'conversation_deleted') {
    return t('messages.noMessages');
  }
  // contact-share preview is already reason-resolved when stored; re-resolving
  // would lose the reason field and fall back to the generic label.
  if ((thread.lastMsgType === 'contact-share' || thread.lastMsgType === 'contact_share')
      && thread.lastMessageText && !isDegradedPreview(thread.lastMessageText)) {
    const csPreview = thread.lastMessageText;
    if (thread.lastDirection === 'outgoing') return `${t('common.you')}：${csPreview}`;
    return csPreview;
  }
  const preview = resolveMessagePreview({
    text: thread.lastMessageText || '',
    msgType: thread.lastMsgType || null
  });
  if (!preview || preview === t('messages.newMessage')) {
    return thread.lastMessageTs ? '' : t('messages.noMessages');
  }
  if (thread.lastDirection === 'outgoing') {
    return `${t('common.you')}：${preview}`;
  }
  return preview;
}
