import { WebSocketServer } from 'ws';
import { logger } from '../utils/logger.js';
import { verifyWsToken } from '../utils/ws-token.js';
import { normalizeCallId } from '../utils/call-validators.js';
import { appendCallEvent } from '../services/call-worker.js';

const clients = new Map(); // uid -> Set<WebSocket>
const presenceWatchers = new Map(); // uid -> Set<WebSocket>
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
const callLocks = new Map(); // uid -> { callId, expiresAt }
let lastCallLockSweep = 0;

function canonicalUid(uid) {
  if (!uid) return null;
  return String(uid).trim().toUpperCase() || null;
}

function pruneCallLocks() {
  const now = Date.now();
  if (now - lastCallLockSweep < 5000) return;
  lastCallLockSweep = now;
  for (const [uid, entry] of callLocks) {
    if (!entry || entry.expiresAt <= now) {
      callLocks.delete(uid);
    }
  }
}

function isUidLocked(uid, callId = null) {
  const key = canonicalUid(uid);
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

function lockUidForCall(uid, callId) {
  const key = canonicalUid(uid);
  if (!key || !callId) return;
  callLocks.set(key, {
    callId,
    expiresAt: Date.now() + CALL_LOCK_TTL_MS
  });
}

function renewCallLock(uid, callId) {
  const key = canonicalUid(uid);
  if (!key || !callId) return;
  pruneCallLocks();
  const entry = callLocks.get(key);
  if (entry && entry.callId === callId) {
    entry.expiresAt = Date.now() + CALL_LOCK_TTL_MS;
  }
}

function releaseCallLock(uid, callId) {
  const key = canonicalUid(uid);
  if (!key) return;
  const entry = callLocks.get(key);
  if (entry && (!callId || entry.callId === callId)) {
    callLocks.delete(key);
  }
}

function releaseCallLocksForPair(callId, fromUid, toUid) {
  releaseCallLock(fromUid, callId);
  releaseCallLock(toUid, callId);
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
  const stringFields = {
    candidate: 2048,
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

function normalizeSignalUid(value) {
  if (!value) return null;
  const cleaned = String(value).trim().toUpperCase();
  if (!cleaned) return null;
  return cleaned.length > 128 ? cleaned.slice(0, 128) : cleaned;
}

function extractPeerUid(msg = {}) {
  const candidates = [
    msg.targetUid,
    msg.target_uid,
    msg.peerUid,
    msg.peer_uid,
    msg.toUid,
    msg.to_uid,
    msg.to,
    msg.peer
  ];
  for (const candidate of candidates) {
    const normalized = normalizeSignalUid(candidate);
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
  if (!ws || !ws.__uid) return;
  const rawType = String(msg?.type || '').toLowerCase();
  if (!CALL_SIGNAL_TYPES.has(rawType)) return;
  const callId = normalizeCallId(msg.callId || msg.call_id || msg.id);
  if (!callId) {
    sendCallError(ws, 'CALL_INVALID_ID', 'callId required', { event: rawType });
    return;
  }
  const targetUid = extractPeerUid(msg);
  if (!targetUid) {
    sendCallError(ws, 'CALL_TARGET_REQUIRED', 'target uid required', { event: rawType, callId });
    return;
  }
  if (targetUid === ws.__uid) {
    sendCallError(ws, 'CALL_TARGET_INVALID', 'target uid must differ from sender', { event: rawType, callId });
    return;
  }

  if (rawType === 'call-invite') {
    if (isUidLocked(ws.__uid, callId)) {
      sendCallError(ws, 'CALL_ALREADY_IN_PROGRESS', 'caller already has an active call', { event: rawType, callId });
      return;
    }
    if (isUidLocked(targetUid, callId)) {
      sendCallError(ws, 'CALL_TARGET_BUSY', 'target already has an active call', { event: rawType, callId, peerUid: targetUid });
      return;
    }
    lockUidForCall(ws.__uid, callId);
    lockUidForCall(targetUid, callId);
  } else if (CALL_RELEASE_EVENTS.has(rawType)) {
    releaseCallLocksForPair(callId, ws.__uid, targetUid);
  } else if (CALL_RENEW_EVENTS.has(rawType)) {
    renewCallLock(ws.__uid, callId);
    renewCallLock(targetUid, callId);
  }

  const detail = buildCallDetail(msg);
  const traceId = normalizeTraceId(msg.traceId);
  const payload = {
    type: rawType,
    callId,
    fromUid: ws.__uid,
    toUid: targetUid,
    traceId: traceId || null,
    ts: Date.now(),
    payload: detail || null
  };

  await appendCallEvent({
    callId,
    type: rawType,
    payload: detail || null,
    fromUid: ws.__uid,
    toUid: targetUid,
    traceId
  });

  broadcast(targetUid, payload);
  broadcast(ws.__uid, payload, { exclude: ws });
  sendCallAck(ws, rawType, callId, { peerUid: targetUid });
}

function addClient(uid, ws) {
  const key = uid.toUpperCase();
  if (!clients.has(key)) clients.set(key, new Set());
  clients.get(key).add(ws);
  ws.__uid = key;
  logger.info({ uid: key }, 'ws_client_registered');
  notifyPresence(key, true);
}

function removeClient(ws) {
  const uid = ws.__uid;
  if (!uid) return;
  const set = clients.get(uid);
  if (!set) return;
  set.delete(ws);
  if (!set.size) clients.delete(uid);
  logger.info({ uid }, 'ws_client_removed');
  if (!set || set.size === 0) {
    notifyPresence(uid, false);
  }
}

function broadcast(uid, payload, { exclude } = {}) {
  const set = clients.get(String(uid || '').toUpperCase());
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
  logger.debug({ raw: msg, uid: ws.__uid || null }, 'ws_message_received');
  if (msg.type === 'auth') {
    const uid = String(msg.uid || '').trim();
    const token = typeof msg.token === 'string' ? msg.token : '';
    if (!uid) {
      ws.send(JSON.stringify({ type: 'auth', ok: false, reason: 'uid_required' }));
      return;
    }
    const verification = verifyWsToken(token);
    if (!verification.ok) {
      ws.send(JSON.stringify({ type: 'auth', ok: false, reason: 'invalid_token' }));
      try { ws.close(4401, 'invalid_token'); } catch {}
      return;
    }
    const claimedUid = uid.toUpperCase();
    if (verification.payload.uid !== claimedUid) {
      ws.send(JSON.stringify({ type: 'auth', ok: false, reason: 'uid_mismatch' }));
      try { ws.close(4401, 'uid_mismatch'); } catch {}
      return;
    }
    ws.__accountDigest = verification.payload.accountDigest;
    addClient(claimedUid, ws);
    ws.send(JSON.stringify({ type: 'auth', ok: true, exp: verification.payload.exp }));
    return;
  }
  if (isCallSignalType(msg.type)) {
    return handleCallSignal(ws, msg);
  }
  if (!ws.__uid) return;
  if (msg.type === 'presence-subscribe') {
    const list = Array.isArray(msg.uids) ? msg.uids : [];
    const normalized = registerPresenceWatchers(ws, list);
    const online = normalized.filter(isUidOnline);
    try {
      ws.send(JSON.stringify({ type: 'presence', online, ts: Date.now() }));
    } catch (err) {
      logger.warn({ err: err?.message || err }, 'ws_presence_send_failed');
    }
    return;
  }
  if (msg.type === 'contact-share') {
    const targetUid = String(msg.targetUid || '').trim();
    if (!targetUid) return;
    broadcast(targetUid, {
      type: 'contact-share',
      fromUid: ws.__uid,
      inviteId: msg.inviteId || null,
      envelope: msg.envelope || null,
      ts: Date.now()
    });
    return;
  }
  if (msg.type === 'contact-removed') {
    const targetUid = String(msg.targetUid || msg.peerUid || '').trim().toUpperCase();
    if (!targetUid) return;
    broadcast(targetUid, {
      type: 'contact-removed',
      peerUid: ws.__uid,
      ts: Date.now()
    });
    return;
  }
  if (msg.type === 'message-new') {
    if (!ws.__uid) return;
    const targetUid = String(msg.targetUid || msg.peerUid || msg.peer_uid || '').trim().toUpperCase();
    const conversationId = String(msg.conversationId || msg.conversation_id || '').trim();
    if (!targetUid || !conversationId) return;
    const preview = typeof msg.preview === 'string' ? msg.preview : '';
    const ts = Number(msg.ts) || Date.now();
    const count = Number.isFinite(Number(msg.count)) ? Number(msg.count) : 1;
    broadcast(targetUid, {
      type: 'secure-message',
      conversationId,
      preview,
      ts,
      count,
      senderUid: ws.__uid,
      peerUid: ws.__uid
    });
    return;
  }
  if (msg.type === 'contacts-reload') {
    const targetUid = String(msg.targetUid || msg.peerUid || '').trim().toUpperCase();
    if (!targetUid) return;
    broadcast(targetUid, { type: 'contacts-reload', ts: Date.now() });
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
    } catch {}
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
    ws.__uid = null;
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
      logger.info({ uid: ws.__uid || null, code, reason: reason ? reason.toString() : undefined }, 'ws_client_closed');
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
    notifyInviteAccepted(ownerUid, inviteId, fromUid) {
      broadcast(ownerUid, { type: 'invite-accepted', inviteId, fromUid, ts: Date.now() });
    },
    notifyContactsReload(uid) {
      broadcast(uid, { type: 'contacts-reload', ts: Date.now() });
    },
    sendContactShare(targetUid, { fromUid, inviteId, envelope }) {
      if (!targetUid || !inviteId || !envelope) return;
      broadcast(targetUid, {
        type: 'contact-share',
        fromUid: String(fromUid || '').toUpperCase() || null,
        inviteId,
        envelope,
        ts: Date.now()
      });
    }
  };
  logger.info('WebSocket server initialized');
  return manager;
}

export function getWebSocketManager() {
  if (!manager) throw new Error('WebSocket manager not initialized');
  return manager;
}

function registerPresenceWatchers(ws, uids) {
  clearPresenceWatchers(ws);
  if (!Array.isArray(uids) || !uids.length) return [];
  const normalized = [];
  const seen = new Set();
  for (const raw of uids) {
    const key = String(raw || '').trim().toUpperCase();
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
  for (const uid of ws.__watching) {
    const set = presenceWatchers.get(uid);
    if (!set) continue;
    set.delete(ws);
    if (!set.size) presenceWatchers.delete(uid);
  }
  ws.__watching.clear();
}

function isUidOnline(uid) {
  const key = String(uid || '').toUpperCase();
  const set = clients.get(key);
  return !!(set && set.size > 0);
}

function notifyPresence(uid, online) {
  const key = String(uid || '').toUpperCase();
  const watchers = presenceWatchers.get(key);
  if (!watchers || !watchers.size) return;
  const payload = JSON.stringify({ type: 'presence-update', uid: key, online: !!online, ts: Date.now() });
  for (const ws of [...watchers]) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(payload); } catch (err) { logger.warn({ err: err?.message || err }, 'ws_presence_broadcast_failed'); }
    } else {
      watchers.delete(ws);
    }
  }
  if (!watchers.size) presenceWatchers.delete(key);
}
