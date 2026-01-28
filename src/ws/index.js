import { WebSocketServer } from 'ws';
import { logger } from '../utils/logger.js';
import { verifyWsToken } from '../utils/ws-token.js';
import { normalizeCallId } from '../utils/call-validators.js';
import { appendCallEvent, touchDeviceRegistry, assertDeviceIdActive } from '../services/call-worker.js';
import { normalizeSessionTs } from '../utils/session-utils.js';

const clients = new Map(); // accountDigest -> Set<WebSocket>
const latestSessionTs = new Map(); // accountDigest -> iat (seconds)
const presenceWatchers = new Map(); // account_digest -> Set<WebSocket>
let manager = null;
const CALL_SIGNAL_TYPES = new Set([
  'call-invite',
  'call-ringing',
  'call-accept',
  'call-reject',
  'call-cancel',
  'call-busy',
  'call-end',
  'call-ice-candidate',
  'call-media-update',
  'call-offer',
  'call-answer'
]);
const CALL_RELEASE_EVENTS = new Set(['call-end', 'call-cancel', 'call-reject', 'call-busy']);
const CALL_RENEW_EVENTS = new Set(['call-ringing', 'call-accept', 'call-media-update', 'call-ice-candidate', 'call-offer', 'call-answer']);
const CALL_LOCK_TTL_MS = Math.max(30_000, Number(process.env.CALL_LOCK_TTL_MS || 120000));
const MAX_SIGNAL_JSON_BYTES = 16 * 1024;
const MAX_SIGNAL_STRING_BYTES = 4096;
const callLocks = new Map(); // accountDigest -> { callId, expiresAt }
let lastCallLockSweep = 0;

function canonicalAccountDigest(value) {
  if (!value) return null;
  const cleaned = String(value).replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  return cleaned && cleaned.length === 64 ? cleaned : null;
}

function canonicalDeviceId(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 120);
}

function pruneCallLocks() {
  const now = Date.now();
  if (now - lastCallLockSweep < 5000) return;
  lastCallLockSweep = now;
  for (const [accountDigest, entry] of callLocks) {
    if (!entry || entry.expiresAt <= now) {
      callLocks.delete(accountDigest);
    }
  }
}

function isAccountDigestLocked(accountDigest, callId = null) {
  const key = canonicalAccountDigest(accountDigest);
  if (!key) return false;
  pruneCallLocks();
  const entry = callLocks.get(key);
  if (!entry) return false;
  if (entry.expiresAt <= Date.now()) {
    callLocks.delete(key);
    return false;
  }
  if (callId && entry.callId === callId) {
    return false;
  }
  return true;
}

function lockAccountDigestForCall(accountDigest, callId) {
  const key = canonicalAccountDigest(accountDigest);
  if (!key || !callId) return;
  callLocks.set(key, {
    callId,
    expiresAt: Date.now() + CALL_LOCK_TTL_MS
  });
}

function renewCallLock(accountDigest, callId) {
  const key = canonicalAccountDigest(accountDigest);
  if (!key || !callId) return;
  pruneCallLocks();
  const entry = callLocks.get(key);
  if (entry && entry.callId === callId) {
    entry.expiresAt = Date.now() + CALL_LOCK_TTL_MS;
  }
}

function releaseCallLock(accountDigest, callId) {
  const key = canonicalAccountDigest(accountDigest);
  if (!key) return;
  const entry = callLocks.get(key);
  if (entry && (!callId || entry.callId === callId)) {
    callLocks.delete(key);
  }
}

function releaseCallLocksForPair(callId, fromAccountDigest, toAccountDigest) {
  releaseCallLock(fromAccountDigest, callId);
  releaseCallLock(toAccountDigest, callId);
}

function normalizeTraceId(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  return trimmed.length > 64 ? trimmed.slice(0, 64) : trimmed;
}

function limitString(value, maxBytes = MAX_SIGNAL_STRING_BYTES) {
  if (value === undefined || value === null) return null;
  const str = String(value);
  if (!maxBytes || str.length <= maxBytes) return str;
  return str.slice(0, maxBytes);
}

function safeCloneObject(source, maxBytes = MAX_SIGNAL_JSON_BYTES) {
  if (source === undefined || source === null) return null;
  try {
    const serialized = JSON.stringify(source);
    if (maxBytes && serialized.length > maxBytes) return null;
    return JSON.parse(serialized);
  } catch {
    return null;
  }
}

function buildCallDetail(msg = {}) {
  const detail = {};
  const objectFields = ['capabilities', 'metadata', 'payload', 'envelope', 'media', 'stats', 'context', 'network', 'data'];
  for (const key of objectFields) {
    if (msg[key] === undefined) continue;
    const cloned = safeCloneObject(msg[key]);
    if (cloned !== null) detail[key] = cloned;
  }
  if (msg.description !== undefined) {
    if (typeof msg.description === 'object' && msg.description !== null) {
      const cloned = safeCloneObject(msg.description);
      if (cloned !== null) detail.description = cloned;
    } else {
      const desc = limitString(msg.description, 4096);
      if (desc !== null) detail.description = desc;
    }
  }
  if (msg.candidate !== undefined) {
    if (typeof msg.candidate === 'object' && msg.candidate !== null) {
      const cloned = safeCloneObject(msg.candidate);
      if (cloned !== null) detail.candidate = cloned;
    } else {
      const candidateStr = limitString(msg.candidate, 2048);
      if (candidateStr !== null) detail.candidate = candidateStr;
    }
  }
  const stringFields = {
    reason: 256,
    error: 256,
    label: 256,
    status: 128
  };
  for (const [key, limit] of Object.entries(stringFields)) {
    if (msg[key] === undefined || msg[key] === null) continue;
    const value = limitString(msg[key], limit);
    if (value !== null) detail[key] = value;
  }
  if (msg.mode) detail.mode = String(msg.mode).toLowerCase() === 'video' ? 'video' : 'voice';
  if (msg.kind) detail.kind = String(msg.kind).toLowerCase();
  if (msg.version !== undefined) {
    const version = Number(msg.version);
    if (Number.isFinite(version) && version > 0) detail.version = Math.floor(version);
  }
  return Object.keys(detail).length ? detail : null;
}

function extractPeerAccountDigest(msg = {}) {
  const candidates = [
    msg.targetAccountDigest,
    msg.peerAccountDigest,
    msg.accountDigest
  ];
  for (const candidate of candidates) {
    const normalized = canonicalAccountDigest(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function isCallSignalType(type) {
  if (!type) return false;
  return CALL_SIGNAL_TYPES.has(String(type));
}

function sendCallError(ws, code, message, meta = {}) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  const payload = {
    type: 'call-error',
    code,
    message,
    ts: Date.now(),
    ...meta
  };
  try {
    ws.send(JSON.stringify(payload));
  } catch (err) {
    logger.warn({ err: err?.message || err }, 'ws_call_error_send_failed');
  }
}

function sendCallAck(ws, eventType, callId, meta = {}) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  const payload = {
    type: 'call-event-ack',
    event: eventType,
    callId,
    ts: Date.now(),
    ...meta
  };
  try {
    ws.send(JSON.stringify(payload));
  } catch (err) {
    logger.warn({ err: err?.message || err }, 'ws_call_ack_send_failed');
  }
}

async function handleCallSignal(ws, msg) {
  if (!ws || !ws.__accountDigest) return;
  const rawType = String(msg?.type || '').toLowerCase();
  if (!CALL_SIGNAL_TYPES.has(rawType)) return;
  const callId = normalizeCallId(msg.callId || msg.call_id || msg.id);
  if (!callId) {
    sendCallError(ws, 'CALL_INVALID_ID', 'callId required', { event: rawType });
    return;
  }
  const targetAccountDigest = extractPeerAccountDigest(msg);
  if (!targetAccountDigest) {
    sendCallError(ws, 'CALL_TARGET_REQUIRED', 'target accountDigest required', { event: rawType, callId });
    return;
  }
  const senderDeviceId = canonicalDeviceId(msg.senderDeviceId);
  const targetDeviceId = canonicalDeviceId(msg.targetDeviceId);
  if (!senderDeviceId || !targetDeviceId) {
    sendCallError(ws, 'CALL_DEVICE_REQUIRED', 'senderDeviceId and targetDeviceId required', {
      event: rawType,
      callId,
      peerAccountDigest: targetAccountDigest
    });
    return;
  }
  if (targetAccountDigest === ws.__accountDigest) {
    sendCallError(ws, 'CALL_TARGET_INVALID', 'target must differ from sender', { event: rawType, callId });
    return;
  }

  try {
    await touchDeviceRegistry({ accountDigest: ws.__accountDigest, deviceId: senderDeviceId });
    await assertDeviceIdActive({ accountDigest: ws.__accountDigest, deviceId: senderDeviceId });
    await assertDeviceIdActive({ accountDigest: targetAccountDigest, deviceId: targetDeviceId });
  } catch (err) {
    sendCallError(ws, err?.code || 'DEVICE_NOT_ACTIVE', err?.message || 'device not active', { event: rawType, callId, peerAccountDigest: targetAccountDigest });
    return;
  }

  if (rawType === 'call-invite') {
    if (isAccountDigestLocked(ws.__accountDigest, callId)) {
      sendCallError(ws, 'CALL_ALREADY_IN_PROGRESS', 'caller already has an active call', { event: rawType, callId });
      return;
    }
    if (isAccountDigestLocked(targetAccountDigest, callId)) {
      sendCallError(ws, 'CALL_TARGET_BUSY', 'target already has an active call', { event: rawType, callId, peerAccountDigest: targetAccountDigest });
      return;
    }
    lockAccountDigestForCall(ws.__accountDigest, callId);
    lockAccountDigestForCall(targetAccountDigest, callId);
  } else if (CALL_RELEASE_EVENTS.has(rawType)) {
    releaseCallLocksForPair(callId, ws.__accountDigest, targetAccountDigest);
  } else if (CALL_RENEW_EVENTS.has(rawType)) {
    renewCallLock(ws.__accountDigest, callId);
    renewCallLock(targetAccountDigest, callId);
  }

  const detail = buildCallDetail(msg);
  const traceId = normalizeTraceId(msg.traceId);
  const payload = {
    type: rawType,
    callId,
    fromAccountDigest: ws.__accountDigest || null,
    toAccountDigest: targetAccountDigest || null,
    fromDeviceId: senderDeviceId,
    toDeviceId: targetDeviceId,
    traceId: traceId || null,
    ts: Date.now(),
    payload: detail || null
  };

  await appendCallEvent({
    callId,
    type: rawType,
    payload: detail || null,
    fromAccountDigest: ws.__accountDigest || null,
    toAccountDigest: targetAccountDigest || null,
    traceId
  }).catch((err) => {
    releaseCallLocksForPair(callId, ws.__accountDigest, targetAccountDigest);
    logger.warn({ err: err?.message || err, callId, rawType }, 'ws_call_event_append_failed');
    sendCallError(ws, 'CALL_EVENT_FAILED', 'unable to persist call event', {
      event: rawType,
      callId,
      peerAccountDigest: targetAccountDigest
    });
    throw err;
  });

  broadcastByDigest(targetAccountDigest, payload);
  broadcastByDigest(ws.__accountDigest, payload, { exclude: ws });
  sendCallAck(ws, rawType, callId, { peerAccountDigest: targetAccountDigest });
}

function addClient(accountDigest, ws, sessionTs) {
  const key = canonicalAccountDigest(accountDigest);
  const nowSec = Math.floor(Date.now() / 1000);
  const sessionInfo = normalizeSessionTs(sessionTs, { now: nowSec });
  const ts = sessionInfo.ts ?? nowSec;
  const latestInfo = normalizeSessionTs(latestSessionTs.get(key), { now: nowSec });
  const latestTs = latestInfo.ts || 0;
  const latestReliable = !!latestTs && latestInfo.clamped !== true;
  if (latestReliable && ts < latestTs) {
    try {
      ws.send(JSON.stringify({ type: 'auth', ok: false, reason: 'stale_session' }));
    } catch { }
    try { ws.close(4409, 'stale_session'); } catch { }
    return false;
  }
  // 單一活躍連線策略：同一 accountDigest 只保留最新連線，先關閉舊連線。
  const existing = clients.get(key);
  if (existing && existing.size) {
    for (const other of existing) {
      try { other.close(4409, 'replaced'); } catch { }
    }
    existing.clear();
  }
  if (!clients.has(key)) clients.set(key, new Set());
  clients.get(key).add(ws);
  ws.__accountDigest = key;
  ws.__sessionTs = ts;
  latestSessionTs.set(key, ts);
  logger.info({ accountDigest: key }, 'ws_client_registered');
  notifyPresence(key, true);
  return true;
}

function removeClient(ws) {
  const acct = ws.__accountDigest;
  if (!acct) return;
  const set = clients.get(acct);
  if (!set) return;
  set.delete(ws);
  if (!set.size) {
    clients.delete(acct);
    latestSessionTs.delete(acct);
  }
  logger.info({ accountDigest: acct }, 'ws_client_removed');
  if (!set || set.size === 0) {
    notifyPresence(acct, false);
  }
}

function broadcastByDigest(accountDigest, payload, { exclude } = {}) {
  const set = clients.get(String(accountDigest || '').toUpperCase());
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const ws of set) {
    if (exclude && ws === exclude) continue;
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
    }
  }
}

function handleClientMessage(ws, data) {
  let msg;
  try { msg = JSON.parse(data); } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  logger.debug({ raw: msg, accountDigest: ws.__accountDigest || null }, 'ws_message_received');
  if (msg.type === 'auth') {
    const token = typeof msg.token === 'string' ? msg.token : '';
    const verification = verifyWsToken(token);
    if (!verification.ok) {
      ws.send(JSON.stringify({ type: 'auth', ok: false, reason: 'invalid_token' }));
      try { ws.close(4401, 'invalid_token'); } catch { }
      return;
    }
    const tokenDigest = canonicalAccountDigest(verification.payload.accountDigest);
    if (!tokenDigest) {
      ws.send(JSON.stringify({ type: 'auth', ok: false, reason: 'account_digest_required' }));
      try { ws.close(4401, 'account_digest_missing'); } catch { }
      return;
    }
    if (ws.__accountDigest) {
      if (ws.__accountDigest === tokenDigest) {
        const nowSec = Math.floor(Date.now() / 1000);
        const normalized = normalizeSessionTs(verification.payload.iat || nowSec, { now: nowSec });
        if (normalized.ts && (!ws.__sessionTs || normalized.ts > ws.__sessionTs)) {
          ws.__sessionTs = normalized.ts;
          latestSessionTs.set(tokenDigest, normalized.ts);
        }
        ws.send(JSON.stringify({ type: 'auth', ok: true, exp: verification.payload.exp, reused: true }));
        return;
      }
      clearPresenceWatchers(ws);
      removeClient(ws);
      ws.__accountDigest = null;
      ws.__sessionTs = null;
    }
    ws.__accountDigest = tokenDigest;
    const sessionTs = verification.payload.iat || Math.floor(Date.now() / 1000);
    const ok = addClient(tokenDigest, ws, sessionTs);
    if (!ok) return;
    ws.send(JSON.stringify({ type: 'auth', ok: true, exp: verification.payload.exp }));
    return;
  }
  if (isCallSignalType(msg.type)) {
    return handleCallSignal(ws, msg);
  }
  if (!ws.__accountDigest) return;
  if (msg.type === 'presence-subscribe') {
    const list = Array.isArray(msg.accountDigests) ? msg.accountDigests : [];
    const normalized = registerPresenceWatchers(ws, list);
    const online = normalized.filter(isDigestOnline);
    try {
      ws.send(JSON.stringify({ type: 'presence', online, onlineAccountDigests: normalized, ts: Date.now() }));
    } catch (err) {
      logger.warn({ err: err?.message || err }, 'ws_presence_send_failed');
    }
    return;
  }
  if (msg.type === 'contact-removed') {
    const targetDigest = extractPeerAccountDigest(msg);
    if (!targetDigest) return;
    const peerAcct = ws.__accountDigest || null;
    const senderDeviceId = canonicalDeviceId(msg.senderDeviceId);
    const targetDeviceId = canonicalDeviceId(msg.targetDeviceId);
    if (!senderDeviceId || !targetDeviceId) {
      logger.warn({
        event: 'ws.contact-removed.missing-device',
        fromDigest: peerAcct,
        targetDigest,
        senderDeviceId: senderDeviceId || null,
        targetDeviceId: targetDeviceId || null
      }, 'drop contact-removed due to missing deviceId');
      return;
    }
    broadcastByDigest(targetDigest, {
      type: 'contact-removed',
      peerAccountDigest: peerAcct,
      senderDeviceId,
      targetDeviceId,
      ts: Date.now()
    });
    return;
  }
  if (msg.type === 'message-new') {
    if (!ws.__accountDigest) return;
    const targetDigest = extractPeerAccountDigest(msg);
    const conversationId = String(msg.conversationId || '').trim();
    if (!targetDigest || !conversationId) return;
    const preview = typeof msg.preview === 'string' ? msg.preview : '';
    const ts = Number(msg.ts) || Date.now();
    const count = Number.isFinite(Number(msg.count)) ? Number(msg.count) : 1;
    const senderAcct = ws.__accountDigest || null;
    const senderDeviceId = canonicalDeviceId(msg.senderDeviceId);
    const targetDeviceId = canonicalDeviceId(msg.targetDeviceId);
    if (!targetDeviceId) {
      logger.warn({
        event: 'ws.message-new.missing-device',
        fromDigest: senderAcct,
        targetDigest,
        conversationId,
        senderDeviceId: senderDeviceId || null,
        targetDeviceId: targetDeviceId || null
      }, 'drop message-new due to missing targetDeviceId');
      return;
    }
    broadcastByDigest(targetDigest, {
      type: 'secure-message',
      conversationId,
      preview,
      ts,
      count,
      senderAccountDigest: senderAcct,
      senderDeviceId,
      targetDeviceId,
      peerAccountDigest: senderAcct,
      targetAccountDigest: targetDigest
    });
    return;
  }
  if (msg.type === 'vault-ack') {
    if (!ws.__accountDigest) return;
    const targetDigest = extractPeerAccountDigest(msg);
    const conversationId = String(msg.conversationId || '').trim();
    const messageId = String(msg.messageId || msg.message_id || '').trim();
    if (!targetDigest || !conversationId || !messageId) return;
    const senderDeviceId = canonicalDeviceId(msg.senderDeviceId);
    const receiverDeviceId = canonicalDeviceId(msg.receiverDeviceId);
    const targetDeviceId = canonicalDeviceId(msg.targetDeviceId || msg.senderDeviceId);
    if (!senderDeviceId || !receiverDeviceId || !targetDeviceId) {
      logger.warn({
        event: 'ws.vault-ack.missing-device',
        fromDigest: ws.__accountDigest || null,
        targetDigest,
        conversationId,
        senderDeviceId: senderDeviceId || null,
        receiverDeviceId: receiverDeviceId || null,
        targetDeviceId: targetDeviceId || null
      }, 'drop vault-ack due to missing deviceId');
      return;
    }
    const tsRaw = Number(msg.ts);
    const ts = Number.isFinite(tsRaw) && tsRaw > 0
      ? tsRaw
      : Math.floor(Date.now() / 1000);
    broadcastByDigest(targetDigest, {
      type: 'vault-ack',
      conversationId,
      messageId,
      senderAccountDigest: targetDigest,
      senderDeviceId,
      receiverAccountDigest: ws.__accountDigest,
      receiverDeviceId,
      targetAccountDigest: targetDigest,
      targetDeviceId,
      peerAccountDigest: ws.__accountDigest,
      ts
    });
    return;
  }
  if (msg.type === 'conversation-deleted') {
    if (!ws.__accountDigest) return;
    const targetDigest = extractPeerAccountDigest(msg);
    const conversationId = String(msg.conversationId || '').trim();
    if (!targetDigest || !conversationId) return;
    const senderAcct = ws.__accountDigest || null;
    const senderDeviceId = canonicalDeviceId(msg.senderDeviceId);
    const targetDeviceId = canonicalDeviceId(msg.targetDeviceId);
    if (!senderDeviceId || !targetDeviceId) {
      logger.warn({
        event: 'ws.conversation-deleted.missing-device',
        fromDigest: senderAcct,
        targetDigest,
        conversationId,
        senderDeviceId: senderDeviceId || null,
        targetDeviceId: targetDeviceId || null
      }, 'drop conversation-deleted due to missing deviceId');
      return;
    }
    broadcastByDigest(targetDigest, {
      type: 'conversation-deleted',
      conversationId,
      senderAccountDigest: senderAcct,
      peerAccountDigest: senderAcct,
      senderDeviceId,
      targetDeviceId,
      ts: Date.now()
    });
    return;
  }
  if (msg.type === 'contacts-reload') {
    const targetDigest = extractPeerAccountDigest(msg);
    if (!targetDigest) return;
    const senderDeviceId = canonicalDeviceId(msg.senderDeviceId);
    const targetDeviceId = canonicalDeviceId(msg.targetDeviceId);
    if (!senderDeviceId || !targetDeviceId) {
      logger.warn({
        event: 'ws.contacts-reload.missing-device',
        targetDigest,
        senderDeviceId: senderDeviceId || null,
        targetDeviceId: targetDeviceId || null
      }, 'drop contacts-reload due to missing deviceId');
      return;
    }
    broadcastByDigest(targetDigest, {
      type: 'contacts-reload',
      ts: Date.now(),
      accountDigest: targetDigest,
      senderDeviceId,
      targetDeviceId
    });
    return;
  }
}

export function setupWebSocket(server) {
  if (manager) return manager;
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch { }
    logger.info({ pathname, headers: req.headers }, 'ws_upgrade_attempt');
    if (pathname !== '/ws' && pathname !== '/api/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    ws.__accountDigest = null;
    ws.__watching = new Set();
    ws.on('message', (data) => {
      try {
        const maybePromise = handleClientMessage(ws, data);
        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.catch((err) => logger.warn({ err: err?.message || err }, 'ws_message_handler_failed'));
        }
      } catch (err) {
        logger.warn({ err: err?.message || err }, 'ws_message_dispatch_failed');
      }
    });
    ws.on('close', (code, reason) => {
      logger.info({ accountDigest: ws.__accountDigest || null, code, reason: reason ? reason.toString() : undefined }, 'ws_client_closed');
      clearPresenceWatchers(ws);
      removeClient(ws);
    });
    ws.on('error', (err) => {
      logger.warn({ err: err?.message || err }, 'ws_client_error');
      clearPresenceWatchers(ws);
    });
    logger.info('ws_client_connected');
    ws.send(JSON.stringify({ type: 'hello', ts: Date.now() }));
  });

  manager = {
    notifyContactsReload(_unused, accountDigest = null) {
      const digest = canonicalAccountDigest(accountDigest || null);
      if (!digest) return;
      broadcastByDigest(digest, { type: 'contacts-reload', ts: Date.now(), accountDigest: digest });
    },
    notifySecureMessage({ targetAccountDigest, conversationId, messageId, preview, ts = Date.now(), senderAccountDigest, senderDeviceId, targetDeviceId }) {
      const target = canonicalAccountDigest(targetAccountDigest);
      const senderDev = canonicalDeviceId(senderDeviceId);
      const targetDev = canonicalDeviceId(targetDeviceId);
      if (!target || !conversationId) return;
      if (!senderDev || !targetDev) {
        logger.warn({
          event: 'ws.notifySecureMessage.missing-device',
          targetAccountDigest: target,
          conversationId,
          messageId: messageId || null,
          senderAccountDigest: canonicalAccountDigest(senderAccountDigest),
          senderDeviceId: senderDev || null,
          targetDeviceId: targetDev || null
        }, 'drop notifySecureMessage due to missing deviceId');
        return;
      }
      broadcastByDigest(target, {
        type: 'secure-message',
        conversationId,
        messageId: messageId || null,
        preview: preview || '',
        ts,
        count: 1,
        senderAccountDigest: canonicalAccountDigest(senderAccountDigest),
        senderDeviceId: senderDev,
        targetDeviceId: targetDev,
        peerAccountDigest: canonicalAccountDigest(senderAccountDigest),
        targetAccountDigest: target
      });
    },
    notifyConversationDeleted({ targetAccountDigest, conversationId, senderAccountDigest, senderDeviceId, targetDeviceId }) {
      const target = canonicalAccountDigest(targetAccountDigest);
      const senderDev = canonicalDeviceId(senderDeviceId);
      const targetDev = canonicalDeviceId(targetDeviceId);
      if (!target || !conversationId) return;
      if (!senderDev || !targetDev) {
        logger.warn({
          event: 'ws.notifyConversationDeleted.missing-device',
          targetAccountDigest: target,
          conversationId,
          senderAccountDigest: canonicalAccountDigest(senderAccountDigest),
          senderDeviceId: senderDev || null,
          targetDeviceId: targetDev || null
        }, 'drop notifyConversationDeleted due to missing deviceId');
        return;
      }
      broadcastByDigest(target, {
        type: 'conversation-deleted',
        conversationId,
        senderAccountDigest: canonicalAccountDigest(senderAccountDigest),
        peerAccountDigest: canonicalAccountDigest(senderAccountDigest),
        senderDeviceId: senderDev,
        targetDeviceId: targetDev,
        ts: Date.now()
      });
    },
    sendInviteDelivered(_unused, { targetAccountDigest, targetDeviceId = null, inviteId }) {
      const digest = canonicalAccountDigest(targetAccountDigest);
      if (!digest || !inviteId) return;
      const targetDev = canonicalDeviceId(targetDeviceId);
      broadcastByDigest(digest, {
        type: 'invite-delivered',
        inviteId,
        targetDeviceId: targetDev || null,
        ts: Date.now()
      });
    },
    sendContactRemoved(_unused, { fromAccountDigest, targetAccountDigest, senderDeviceId, targetDeviceId, conversationId = null }) {
      const digest = canonicalAccountDigest(targetAccountDigest);
      const senderDev = canonicalDeviceId(senderDeviceId);
      const targetDev = canonicalDeviceId(targetDeviceId);
      if (!digest) return;
      if (!senderDev || !targetDev) {
        logger.warn({
          event: 'ws.sendContactRemoved.missing-device',
          targetAccountDigest: digest,
          senderAccountDigest: canonicalAccountDigest(fromAccountDigest),
          senderDeviceId: senderDev || null,
          targetDeviceId: targetDev || null,
          conversationId: conversationId || null
        }, 'drop contact-removed due to missing deviceId');
        return;
      }
      const senderDigest = canonicalAccountDigest(fromAccountDigest);
      broadcastByDigest(digest, {
        type: 'contact-removed',
        peerAccountDigest: senderDigest,
        senderDeviceId: senderDev,
        targetDeviceId: targetDev,
        conversationId: conversationId || null,
        ts: Date.now()
      });
    },
    forceLogout(accountDigest = null, { reason = 'account removed' } = {}) {
      const digest = canonicalAccountDigest(accountDigest);
      if (!digest) return;
      const payload = { type: 'force-logout', reason, ts: Date.now() };
      broadcastByDigest(digest, payload);
      const set = clients.get(digest);
      if (set) {
        for (const ws of set) {
          try { ws.close(4409, 'account_purged'); } catch { }
        }
      }
    }
  };
  logger.info('WebSocket server initialized');
  return manager;
}

export function getWebSocketManager() {
  if (!manager) throw new Error('WebSocket manager not initialized');
  return manager;
}

function registerPresenceWatchers(ws, digests) {
  clearPresenceWatchers(ws);
  if (!Array.isArray(digests) || !digests.length) return [];
  const normalized = [];
  const seen = new Set();
  for (const raw of digests) {
    const key = canonicalAccountDigest(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (!presenceWatchers.has(key)) presenceWatchers.set(key, new Set());
    presenceWatchers.get(key).add(ws);
    normalized.push(key);
  }
  if (!ws.__watching) ws.__watching = new Set();
  for (const key of normalized) ws.__watching.add(key);
  return normalized;
}

function clearPresenceWatchers(ws) {
  if (!ws.__watching || ws.__watching.size === 0) return;
  for (const digest of ws.__watching) {
    const set = presenceWatchers.get(digest);
    if (!set) continue;
    set.delete(ws);
    if (!set.size) presenceWatchers.delete(digest);
  }
  ws.__watching.clear();
}

function isDigestOnline(digest) {
  const key = canonicalAccountDigest(digest);
  if (!key) return false;
  const set = clients.get(key);
  return !!(set && set.size > 0);
}

function notifyPresence(accountDigest, online) {
  const digest = canonicalAccountDigest(accountDigest);
  if (!digest) return;
  const watchers = presenceWatchers.get(digest);
  if (!watchers || !watchers.size) return;
  const payload = JSON.stringify({
    type: 'presence-update',
    accountDigest: digest,
    online: !!online,
    ts: Date.now()
  });
  for (const ws of [...watchers]) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(payload); } catch (err) { logger.warn({ err: err?.message || err }, 'ws_presence_broadcast_failed'); }
    } else {
      watchers.delete(ws);
    }
  }
  if (!watchers.size) presenceWatchers.delete(digest);
}
