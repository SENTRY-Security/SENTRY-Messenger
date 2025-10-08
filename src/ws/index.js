import { WebSocketServer } from 'ws';
import { logger } from '../utils/logger.js';

const clients = new Map(); // uid -> Set<WebSocket>
const presenceWatchers = new Map(); // uid -> Set<WebSocket>
let manager = null;

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

function broadcast(uid, payload) {
  const set = clients.get(String(uid || '').toUpperCase());
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const ws of set) {
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
    if (!uid) {
      ws.send(JSON.stringify({ type: 'auth', ok: false, reason: 'uid_required' }));
      return;
    }
    addClient(uid, ws);
    ws.send(JSON.stringify({ type: 'auth', ok: true }));
    return;
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
    ws.__watching = new Set();
    ws.on('message', (data) => handleClientMessage(ws, data));
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
