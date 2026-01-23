// /app/features/messages-flow/normalize.js
// Normalize replay items into UI message objects.

import {
  classifyDecryptedPayload,
  SEMANTIC_KIND,
  normalizeSemanticSubtype
} from '../semantic.js';
import { describeCallLogForViewer, normalizeCallLogPayload, resolveViewerRole } from '../calls/call-log.js';

function toMessageId(raw) {
  if (typeof raw?.id === 'string' && raw.id.length) return raw.id;
  if (typeof raw?.message_id === 'string' && raw.message_id.length) return raw.message_id;
  if (typeof raw?.messageId === 'string' && raw.messageId.length) return raw.messageId;
  return null;
}

function hashMessageId(value) {
  if (!value) return 0;
  const str = String(value);
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function resolveMessageTsMs(ts) {
  if (!Number.isFinite(ts)) return null;
  const n = Number(ts);
  if (n > 10_000_000_000) return Math.floor(n);
  return Math.floor(n) * 1000;
}

function resolveMessageTsSeq(messageId) {
  if (!messageId) return null;
  return hashMessageId(messageId);
}

function normalizeMediaDir(dir) {
  if (!dir) return null;
  if (Array.isArray(dir)) {
    const normalized = dir.map((seg) => String(seg || '').trim()).filter(Boolean);
    return normalized.length ? normalized : null;
  }
  const parts = String(dir || '')
    .split('/')
    .map((seg) => String(seg || '').trim())
    .filter(Boolean);
  return parts.length ? parts : null;
}

function parseMediaMessage({ plaintext, meta }) {
  let parsed = null;
  if (typeof plaintext === 'string') {
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      parsed = null;
    }
  } else if (typeof plaintext === 'object') {
    parsed = plaintext;
  }
  if (!parsed || typeof parsed !== 'object') parsed = null;
  const metaMedia = meta?.media || {};
  const objectKey = parsed?.objectKey || parsed?.object_key || metaMedia?.object_key || null;
  const envelope = parsed?.envelope || metaMedia?.envelope || null;
  const name =
    parsed?.name ||
    metaMedia?.name ||
    (objectKey ? objectKey.split('/').pop() : null) ||
    'Attachment';
  const sizeRaw = parsed?.size ?? metaMedia?.size;
  const size = Number.isFinite(Number(sizeRaw)) ? Number(sizeRaw) : null;
  const contentType = parsed?.contentType || parsed?.mimeType || metaMedia?.content_type || null;
  const dirSource = parsed?.dir ?? metaMedia?.dir ?? null;
  const dir = normalizeMediaDir(dirSource);

  const previewSource = parsed?.preview || metaMedia?.preview || null;
  const previewObjectKey =
    previewSource?.objectKey ||
    previewSource?.object_key ||
    metaMedia?.preview_object_key ||
    null;
  const previewEnvelope =
    previewSource?.envelope ||
    previewSource?.env ||
    metaMedia?.preview_envelope ||
    null;
  const previewSizeRaw = previewSource?.size ?? metaMedia?.preview_size;
  const previewContentType =
    previewSource?.contentType ||
    previewSource?.content_type ||
    metaMedia?.preview_content_type ||
    null;
  const previewWidth = Number(previewSource?.width);
  const previewHeight = Number(previewSource?.height);

  const mediaInfo = {
    objectKey,
    name,
    size,
    contentType,
    envelope: envelope || null,
    preview: previewObjectKey || previewEnvelope ? {
      objectKey: previewObjectKey || null,
      envelope: previewEnvelope || null,
      size: Number.isFinite(Number(previewSizeRaw)) ? Number(previewSizeRaw) : null,
      contentType: previewContentType || null,
      width: Number.isFinite(previewWidth) ? previewWidth : null,
      height: Number.isFinite(previewHeight) ? previewHeight : null
    } : null,
    dir,
    senderDigest: (typeof meta?.senderDigest === 'string' && meta.senderDigest.trim()) ? meta.senderDigest.trim() : null
  };

  if (parsed?.sha256) mediaInfo.sha256 = parsed.sha256;
  if (parsed?.localUrl) mediaInfo.localUrl = parsed.localUrl;
  if (parsed?.previewUrl) mediaInfo.previewUrl = parsed.previewUrl;
  if (previewSource?.localUrl) mediaInfo.previewUrl = mediaInfo.previewUrl || previewSource.localUrl;

  return mediaInfo;
}

function buildMessageObject({ plaintext, payload, header, raw, direction, ts, tsMs, messageId, messageKeyB64, conversationId }) {
  const meta = payload?.meta || null;
  const baseId = messageId || toMessageId(raw) || null;
  if (!baseId) {
    throw new Error('messageId missing for message object');
  }
  const counterRaw =
    header?.n
    ?? header?.counter
    ?? raw?.counter
    ?? raw?.n
    ?? raw?.header?.n
    ?? raw?.header?.counter
    ?? null;
  const counter = Number.isFinite(Number(counterRaw)) ? Number(counterRaw) : null;
  const timestamp = Number.isFinite(ts) ? ts : null;
  const resolvedTsMs = Number.isFinite(Number(tsMs))
    ? Math.floor(Number(tsMs))
    : resolveMessageTsMs(timestamp);
  const tsSeq = resolveMessageTsSeq(baseId);
  const msgType = normalizeSemanticSubtype(meta?.msgType || meta?.msg_type || null);
  const base = {
    conversationId: conversationId || null,
    id: baseId,
    ts: timestamp,
    tsMs: resolvedTsMs,
    tsSeq,
    header,
    meta,
    direction,
    raw,
    counter,
    msgType: 'text',
    text: typeof plaintext === 'string' ? plaintext : '',
    messageKey_b64: messageKeyB64 || null
  };

  if (msgType === 'media') {
    const mediaInfo = parseMediaMessage({ plaintext, meta });
    base.msgType = 'media';
    base.media = mediaInfo || null;
    base.text = mediaInfo
      ? `[file] ${mediaInfo.name || 'Attachment'}`
      : (typeof plaintext === 'string' ? plaintext : '[file]');
    if (base.media && messageKeyB64) {
      base.media.messageKey_b64 = messageKeyB64;
    }
  } else if (msgType === 'call-log') {
    let parsed = null;
    if (typeof plaintext === 'string') {
      try { parsed = JSON.parse(plaintext); } catch { }
    }
    const callLog = normalizeCallLogPayload(parsed || {}, meta || {});
    const viewerRole = resolveViewerRole(callLog.authorRole, direction);
    const { label, subLabel } = describeCallLogForViewer(callLog, viewerRole);
    base.msgType = 'call-log';
    base.callLog = {
      ...callLog,
      viewerRole,
      label,
      subLabel
    };
    base.text = label || 'Call';
    base.subLabel = subLabel || null;
  } else {
    base.msgType = 'text';
    base.text = typeof base.text === 'string' ? base.text : '';
  }

  if (typeof base.text === 'string') {
    base.text = base.text.trim();
  }

  return base;
}

export function buildDecryptError({
  messageId,
  counter,
  direction,
  ts,
  msgType,
  reason,
  reasonCode
} = {}) {
  return {
    messageId: messageId || null,
    counter: Number.isFinite(counter) ? counter : null,
    direction: direction || 'incoming',
    ts: Number.isFinite(ts) ? ts : null,
    msgType: msgType || null,
    kind: SEMANTIC_KIND.USER_MESSAGE,
    control: false,
    reason: reason || 'decrypt_failed',
    reasonCode: reasonCode || reason || null
  };
}

export function normalizeReplayItems({ items, errors } = {}) {
  const decryptedItems = Array.isArray(items) ? items : [];
  const mergedErrors = Array.isArray(errors) ? errors : [];
  const normalized = [];
  for (const entry of decryptedItems) {
    const semantic = classifyDecryptedPayload(entry?.plaintext, {
      meta: entry?.meta,
      header: entry?.header
    });
    if (semantic.kind !== SEMANTIC_KIND.USER_MESSAGE && semantic.kind !== SEMANTIC_KIND.CONTROL_STATE) continue;
    try {
      const messageObj = buildMessageObject({
        plaintext: entry?.plaintext,
        payload: { meta: entry?.meta || null },
        header: entry?.header,
        raw: entry?.raw,
        direction: entry?.direction || 'incoming',
        ts: entry?.ts ?? null,
        tsMs: entry?.tsMs ?? null,
        messageId: entry?.messageId,
        messageKeyB64: entry?.messageKeyB64,
        conversationId: entry?.conversationId
      });
      normalized.push(messageObj);
    } catch (err) {
      mergedErrors.push(buildDecryptError({
        messageId: entry?.messageId || null,
        counter: entry?.counter,
        direction: entry?.direction,
        ts: entry?.ts,
        msgType: entry?.msgType || null,
        reason: err?.message || 'build_message_failed'
      }));
    }
  }
  return { items: normalized, errors: mergedErrors };
}
