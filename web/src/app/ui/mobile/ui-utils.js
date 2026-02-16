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

const MSG_TYPE_LABELS = {
  'call-log': '通話紀錄',
  'call_log': '通話紀錄',
  'conversation-deleted': '',
  'conversation_deleted': '',
  'session-init': '安全連線已建立',
  'session_init': '安全連線已建立',
  'session-ack': '安全連線已建立',
  'session_ack': '安全連線已建立',
  'system': '系統訊息'
};

const CONTACT_SHARE_REASON_LABELS = {
  nickname: '已更新暱稱',
  avatar: '已更新頭像',
  profile: '已更新個人資料',
  update: '已更新個人資料',
  manual: '已更新個人資料'
};

function resolveContactSharePreview(item) {
  // 1. Try reason from spread content fields (live-decrypt path)
  const directReason = item?.reason;
  if (directReason && CONTACT_SHARE_REASON_LABELS[directReason]) {
    return CONTACT_SHARE_REASON_LABELS[directReason];
  }
  // 2. Try parsing text JSON (formatThreadPreview path — text is raw JSON)
  const text = typeof item?.text === 'string' ? item.text : '';
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      const reason = parsed?.reason;
      if (reason && CONTACT_SHARE_REASON_LABELS[reason]) {
        return CONTACT_SHARE_REASON_LABELS[reason];
      }
    } catch { /* not JSON */ }
  }
  return '已建立安全連線';
}

/**
 * Resolve human-readable preview text from a message item.
 * This is the SINGLE source of truth for all preview text generation.
 *
 * Accepts either a timeline message object or a plain { text, msgType, media, callLog } bag.
 */
export function resolveMessagePreview(item) {
  if (!item) return '有新訊息';
  const msgType = item.msgType || item.type || item.subtype || null;

  // 1a. Contact-share — reason-aware preview
  if (msgType === 'contact-share' || msgType === 'contact_share') {
    return resolveContactSharePreview(item);
  }

  // 1b. Static type labels (non-media)
  if (msgType && MSG_TYPE_LABELS[msgType] !== undefined) {
    return MSG_TYPE_LABELS[msgType] || '';
  }

  // 2. Media — resolve by MIME when available
  if (msgType === 'media' || item.media) {
    const media = item.media || item;
    const mime = (media.contentType || media.mimeType || '').toLowerCase();
    if (mime.startsWith('image/')) return '[圖片]';
    if (mime.startsWith('video/')) return '[影片]';
    const name = media.name || media.filename || '附件';
    return `[檔案] ${name}`;
  }

  // 3. Call log
  if (msgType === 'call-log' || msgType === 'call_log') {
    const kind = item.callLog?.kind || item.kind || '';
    return kind === 'video' ? '[視訊通話]' : '[語音通話]';
  }

  // 4. Plain text — check for raw JSON payloads
  const text = typeof item.text === 'string' ? item.text : '';
  if (text === 'CONTROL_SKIP') return '系統訊息';
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      const innerType = parsed?.type || parsed?.msgType || null;
      if (innerType === 'contact-share' || innerType === 'contact_share') {
        return resolveContactSharePreview(parsed);
      }
      if (innerType && MSG_TYPE_LABELS[innerType] !== undefined) {
        return MSG_TYPE_LABELS[innerType];
      }
      if (innerType === 'media') {
        const mime = (parsed.contentType || parsed.mimeType || '').toLowerCase();
        if (mime.startsWith('image/')) return '[圖片]';
        if (mime.startsWith('video/')) return '[影片]';
        return `[檔案] ${parsed.name || parsed.filename || '附件'}`;
      }
      return '有新訊息';
    } catch { /* not JSON, fall through */ }
  }
  return buildConversationSnippet(text) || '有新訊息';
}

/**
 * Degraded preview strings that should not overwrite a good decrypted preview.
 */
const DEGRADED_PREVIEWS = new Set([
  '訊息尚未解密🔐',
  '(載入失敗)',
  '🔒 加密訊息'
]);

export function isDegradedPreview(text) {
  return !text || DEGRADED_PREVIEWS.has(text);
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
  return true;
}

/**
 * Single formatThreadPreview — render a thread object into a display snippet.
 */
export function formatThreadPreview(thread) {
  if (!thread) return '尚無訊息';
  if (thread.lastMsgType === 'conversation-deleted' || thread.lastMsgType === 'conversation_deleted') {
    return '尚無訊息';
  }
  // contact-share preview is already reason-resolved when stored; re-resolving
  // would lose the reason field and fall back to the generic label.
  if ((thread.lastMsgType === 'contact-share' || thread.lastMsgType === 'contact_share')
      && thread.lastMessageText && !isDegradedPreview(thread.lastMessageText)) {
    const csPreview = thread.lastMessageText;
    if (thread.lastDirection === 'outgoing') return `你：${csPreview}`;
    return csPreview;
  }
  const preview = resolveMessagePreview({
    text: thread.lastMessageText || '',
    msgType: thread.lastMsgType || null
  });
  if (!preview || preview === '有新訊息') {
    return thread.lastMessageTs ? '' : '尚無訊息';
  }
  if (thread.lastDirection === 'outgoing') {
    return `你：${preview}`;
  }
  return preview;
}
