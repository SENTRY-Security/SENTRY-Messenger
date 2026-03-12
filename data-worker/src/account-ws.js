/**
 * AccountWebSocket – Durable Object (Hibernatable WebSocket API)
 *
 * One instance per accountDigest. Manages all WebSocket connections for a single
 * account across multiple devices. Replaces the Node.js WS server entirely.
 *
 * Lifecycle:
 *   1. Client fetches POST /api/v1/ws/token → gets JWT
 *   2. Client opens WebSocket to /ws → Worker looks up DO by accountDigest
 *      (after verifying the JWT) → calls DO.fetch() with Upgrade header
 *   3. DO accepts WebSocket via Hibernatable API
 *   4. Client sends { type: 'auth', token } over WS → DO verifies JWT, tags socket
 *   5. Heartbeat via ping/pong messages
 *   6. Worker calls DO /notify to broadcast messages to all connected sockets
 *   7. On disconnect, DO updates presence in KV, sets alarm for cleanup
 *
 * Presence:
 *   KV key `presence:<DIGEST>` = JSON { online: true, ts, deviceIds: [...] }
 *   Written on connect/disconnect. DO alarm sweeps stale entries.
 */

// ── Constants ────────────────────────────────────────────────────
const CALL_LOCK_TTL_MS = 120_000;
const MAX_SIGNAL_JSON_BYTES = 16 * 1024;
const MAX_SDP_JSON_BYTES = 64 * 1024;
const MAX_SIGNAL_STRING_BYTES = 4096;
const PRESENCE_TTL_SEC = 120; // KV expiration for presence keys
const HEARTBEAT_INTERVAL_MS = 30_000;

const CALL_SIGNAL_TYPES = new Set([
  'call-invite', 'call-ringing', 'call-accept', 'call-reject',
  'call-cancel', 'call-busy', 'call-end', 'call-ice-candidate',
  'call-media-update', 'call-offer', 'call-answer'
]);
const CALL_RELEASE_EVENTS = new Set(['call-end', 'call-cancel', 'call-reject', 'call-busy']);
const CALL_RENEW_EVENTS = new Set([
  'call-ringing', 'call-accept', 'call-media-update',
  'call-ice-candidate', 'call-offer', 'call-answer'
]);

// ── Helpers (pure, no instance state) ────────────────────────────

function canonicalAccountDigest(value) {
  if (!value) return null;
  const str = String(value);
  // Ephemeral guest digests use EPHEMERAL_ prefix — pass through as-is
  if (str.startsWith('EPHEMERAL_')) return str;
  const cleaned = str.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  return cleaned.length === 64 ? cleaned : null;
}

function canonicalDeviceId(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed.slice(0, 120) : null;
}

function normalizeSessionTs(raw) {
  let ts = Number(raw);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  if (ts > 1e11) ts = Math.floor(ts / 1000); // ms → sec
  return Math.floor(ts);
}

function normalizeCallId(value) {
  if (!value) return null;
  const trimmed = String(value).trim().toLowerCase();
  return trimmed || null;
}

function limitString(value, maxBytes = MAX_SIGNAL_STRING_BYTES) {
  if (value === undefined || value === null) return null;
  const str = String(value);
  return maxBytes && str.length > maxBytes ? str.slice(0, maxBytes) : str;
}

function safeCloneObject(source, maxBytes = MAX_SIGNAL_JSON_BYTES) {
  if (source == null) return null;
  try {
    const s = JSON.stringify(source);
    return maxBytes && s.length > maxBytes ? null : JSON.parse(s);
  } catch { return null; }
}

function buildCallDetail(msg = {}) {
  const detail = {};
  for (const key of ['capabilities', 'metadata', 'payload', 'envelope', 'media', 'stats', 'context', 'network', 'data']) {
    if (msg[key] === undefined) continue;
    const c = safeCloneObject(msg[key]);
    if (c !== null) detail[key] = c;
  }
  if (msg.description !== undefined) {
    if (typeof msg.description === 'object' && msg.description !== null) {
      const c = safeCloneObject(msg.description, MAX_SDP_JSON_BYTES);
      if (c !== null) detail.description = c;
    } else {
      const d = limitString(msg.description, 4096);
      if (d !== null) detail.description = d;
    }
  }
  if (msg.candidate !== undefined) {
    if (typeof msg.candidate === 'object' && msg.candidate !== null) {
      const c = safeCloneObject(msg.candidate);
      if (c !== null) detail.candidate = c;
    } else {
      const s = limitString(msg.candidate, 2048);
      if (s !== null) detail.candidate = s;
    }
  }
  for (const [key, limit] of Object.entries({ reason: 256, error: 256, label: 256, status: 128 })) {
    if (msg[key] == null) continue;
    const v = limitString(msg[key], limit);
    if (v !== null) detail[key] = v;
  }
  if (msg.mode) detail.mode = String(msg.mode).toLowerCase() === 'video' ? 'video' : 'voice';
  if (msg.kind) detail.kind = String(msg.kind).toLowerCase();
  if (msg.version !== undefined) {
    const v = Number(msg.version);
    if (Number.isFinite(v) && v > 0) detail.version = Math.floor(v);
  }
  return Object.keys(detail).length ? detail : null;
}

function extractPeerAccountDigest(msg = {}) {
  for (const c of [msg.targetAccountDigest, msg.peerAccountDigest, msg.accountDigest]) {
    const n = canonicalAccountDigest(c);
    if (n) return n;
  }
  return null;
}

// ── JWT verification (Web Crypto, same as Worker's createWsToken) ──

async function verifyWsJwt(token, secret) {
  if (typeof token !== 'string' || !secret) return { ok: false, reason: 'config' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'format' };
  const [headerB64, bodyB64, signature] = parts;

  // Verify header
  const expectedHeader = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (headerB64 !== expectedHeader) return { ok: false, reason: 'header' };

  // Compute expected signature
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  // Decode base64url signature to ArrayBuffer
  const sigStr = signature.replace(/-/g, '+').replace(/_/g, '/');
  const pad = sigStr.length % 4 === 0 ? '' : '='.repeat(4 - (sigStr.length % 4));
  const sigBytes = Uint8Array.from(atob(sigStr + pad), c => c.charCodeAt(0));

  const valid = await crypto.subtle.verify(
    'HMAC', key, sigBytes, enc.encode(`${headerB64}.${bodyB64}`)
  );
  if (!valid) return { ok: false, reason: 'signature' };

  // Decode payload
  let payload;
  try {
    const payloadStr = bodyB64.replace(/-/g, '+').replace(/_/g, '/');
    const payloadPad = payloadStr.length % 4 === 0 ? '' : '='.repeat(4 - (payloadStr.length % 4));
    payload = JSON.parse(atob(payloadStr + payloadPad));
  } catch { return { ok: false, reason: 'payload' }; }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || now >= payload.exp) {
    return { ok: false, reason: 'expired' };
  }
  if (!payload.accountDigest) return { ok: false, reason: 'claims' };

  return {
    ok: true,
    payload: {
      accountDigest: String(payload.accountDigest).toUpperCase(),
      exp: payload.exp,
      iat: payload.iat || null
    }
  };
}

// ── Durable Object class ─────────────────────────────────────────

export class AccountWebSocket {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // accountDigest is derived from the DO name (set by Worker via idFromName)
    this.accountDigest = null;
    // Call locks: callId -> { peerDigest, expiresAt }
    this.callLocks = new Map();
    // Presence watchers: Set of accountDigests this account is watching
    // (stored as tags on websockets)
  }

  // ── HTTP fetch handler ──────────────────────────────────────────

  async fetch(request) {
    const url = new URL(request.url);

    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      return this._handleWsUpgrade(request, url);
    }

    // Internal notification from Worker
    if (url.pathname === '/notify') {
      return this._handleNotify(request);
    }

    // Add presence watcher (called by other DOs)
    if (url.pathname === '/add-watcher') {
      return this._handleAddWatcher(request);
    }

    // Presence query
    if (url.pathname === '/presence') {
      const sockets = this.state.getWebSockets();
      const online = sockets.some(ws => {
        const att = ws.deserializeAttachment();
        return att && att.authenticated;
      });
      return Response.json({ online, connections: sockets.length });
    }

    // Force close all sockets
    if (url.pathname === '/force-close') {
      const body = await request.json().catch(() => ({}));
      const reason = body.reason || 'force-close';
      for (const ws of this.state.getWebSockets()) {
        try { ws.close(4409, reason); } catch {}
      }
      return Response.json({ ok: true });
    }

    return new Response('not found', { status: 404 });
  }

  // ── WebSocket upgrade ───────────────────────────────────────────

  async _handleWsUpgrade(request, url) {
    // accountDigest is passed as a header by the Worker after JWT verification
    const digest = request.headers.get('x-account-digest') || '';
    const deviceId = request.headers.get('x-device-id') || '';
    const sessionTs = Number(request.headers.get('x-session-ts') || 0);

    if (!this.accountDigest) {
      this.accountDigest = canonicalAccountDigest(digest);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept with Hibernatable API
    // Tags are used for filtering: first tag is always deviceId
    const tags = [deviceId || 'unknown'];
    this.state.acceptWebSocket(server, tags);

    // Store metadata as attachment
    server.serializeAttachment({
      authenticated: true,
      accountDigest: this.accountDigest,
      deviceId: canonicalDeviceId(deviceId),
      sessionTs: normalizeSessionTs(sessionTs) || Math.floor(Date.now() / 1000),
      connectedAt: Date.now()
    });

    // Send hello
    server.send(JSON.stringify({ type: 'hello', ts: Date.now() }));

    // Update presence
    await this._updatePresence(true);

    // Set alarm for heartbeat monitoring
    const currentAlarm = await this.state.storage.getAlarm();
    if (!currentAlarm) {
      await this.state.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // ── Internal notification broadcast ─────────────────────────────

  async _handleNotify(request) {
    const payload = await request.json();
    if (!payload || !payload.type) {
      return Response.json({ error: 'type required' }, { status: 400 });
    }

    const data = JSON.stringify(payload);
    const sockets = this.state.getWebSockets();
    let sent = 0;

    // Optional: target specific device
    const targetDeviceId = canonicalDeviceId(payload.targetDeviceId);

    for (const ws of sockets) {
      const att = ws.deserializeAttachment();
      if (!att || !att.authenticated) continue;
      // If targeting specific device, filter
      if (targetDeviceId && att.deviceId !== targetDeviceId) continue;
      try {
        ws.send(data);
        sent++;
      } catch {}
    }

    return Response.json({ ok: true, sent });
  }

  // ── Hibernatable WebSocket handlers ─────────────────────────────

  async webSocketMessage(ws, message) {
    let msg;
    try {
      msg = typeof message === 'string' ? JSON.parse(message) : JSON.parse(new TextDecoder().decode(message));
    } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    const att = ws.deserializeAttachment() || {};

    // Auth message (re-auth or token refresh)
    if (msg.type === 'auth') {
      return this._handleAuth(ws, msg, att);
    }

    // Ping/pong
    if (msg.type === 'ping') {
      try { ws.send(JSON.stringify({ type: 'pong', ts: Date.now() })); } catch {}
      return;
    }

    // Must be authenticated for everything below
    if (!att.authenticated) return;

    // Presence subscribe
    if (msg.type === 'presence-subscribe') {
      return this._handlePresenceSubscribe(ws, msg, att);
    }

    // Call signaling (client → DO → target DO via Worker relay)
    if (CALL_SIGNAL_TYPES.has(msg.type)) {
      return this._handleCallSignal(ws, msg, att);
    }

    // Client-originated message relay (message-new, contact-removed, vault-ack, etc.)
    if (msg.type === 'message-new' || msg.type === 'secure-message') {
      return this._handleMessageRelay(ws, msg, att);
    }
    if (msg.type === 'contact-removed') {
      return this._handleContactRemovedRelay(ws, msg, att);
    }
    if (msg.type === 'vault-ack') {
      return this._handleVaultAckRelay(ws, msg, att);
    }
    if (msg.type === 'conversation-deleted') {
      return this._handleConversationDeletedRelay(ws, msg, att);
    }
    if (msg.type === 'contacts-reload') {
      return this._handleContactsReloadRelay(ws, msg, att);
    }
    // Ephemeral chat message relay: forward to the target peer's DO
    if (msg.type === 'ephemeral-message') {
      return this._handleEphemeralRelay(ws, msg, att);
    }
    // Ephemeral key exchange relay: forward key-exchange and ack between peers
    if (msg.type === 'ephemeral-key-exchange' || msg.type === 'ephemeral-key-exchange-ack') {
      return this._handleEphemeralRelay(ws, msg, att);
    }
    // Ephemeral call signaling relay: forward call signals between owner and guest
    if (typeof msg.type === 'string' && msg.type.startsWith('ephemeral-call-')) {
      return this._handleEphemeralRelay(ws, msg, att);
    }
  }

  async _handleEphemeralRelay(ws, msg, att) {
    // Generic relay for all ephemeral WS message types.
    // Looks up the ephemeral session to find the target peer, then forwards the
    // entire message payload as-is (the server never reads encrypted content).
    const conversationId = String(msg.conversationId || '').trim();
    const sessionId = String(msg.sessionId || '').trim();
    if (!conversationId && !sessionId) return;
    try {
      // Look up session by conversationId or sessionId
      let session;
      if (conversationId) {
        session = await this.env.DB.prepare(
          `SELECT owner_digest, guest_digest FROM ephemeral_sessions WHERE conversation_id = ? AND deleted_at IS NULL`
        ).bind(conversationId).first();
      }
      if (!session && sessionId) {
        session = await this.env.DB.prepare(
          `SELECT owner_digest, guest_digest FROM ephemeral_sessions WHERE session_id = ? AND deleted_at IS NULL`
        ).bind(sessionId).first();
      }

      const senderDigest = att.accountDigest || '';
      let targetDigest;

      if (session) {
        targetDigest = senderDigest === session.owner_digest ? session.guest_digest : session.owner_digest;
      } else {
        // D1 read replica may lag after session creation. For key-exchange and
        // ack messages the client includes a targetDigest hint so the relay can
        // still forward without waiting for replication to catch up.
        const hint = String(msg.targetDigest || '').trim();
        if (hint && (msg.type === 'ephemeral-key-exchange' || msg.type === 'ephemeral-key-exchange-ack')) {
          targetDigest = hint;
          console.warn('[ws-do] ephemeral relay: D1 miss, using targetDigest hint', { type: msg.type, target: hint?.slice(0, 16) });
        } else {
          console.warn('[ws-do] ephemeral relay: session not found in D1', { type: msg.type, conversationId, sessionId });
          return;
        }
      }

      if (!targetDigest) {
        console.warn('[ws-do] ephemeral relay: no target digest', { type: msg.type, senderDigest: senderDigest?.slice(0, 12) });
        return;
      }
      // Forward entire message to target peer's DO (opaque relay — server cannot read content)
      const doId = this.env.ACCOUNT_WS.idFromName(targetDigest);
      const stub = this.env.ACCOUNT_WS.get(doId);
      // Build relay payload: forward all fields from the original message, add senderDigest
      const relayPayload = { ...msg, senderDigest: senderDigest };
      const relayRes = await stub.fetch('https://do/notify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(relayPayload)
      });
      const relayResult = await relayRes.json().catch(() => ({}));
      console.log('[ws-do] ephemeral relay OK', { type: msg.type, target: targetDigest?.slice(0, 16), sent: relayResult?.sent });
    } catch (err) {
      console.warn('[ws-do] ephemeral relay error:', err?.message || err);
    }
  }

  async webSocketClose(ws, code, reason) {
    const att = ws.deserializeAttachment() || {};
    console.info(`[ws-do] close accountDigest=${att.accountDigest || 'unknown'} code=${code} reason=${reason || ''}`);

    // Update presence
    const remaining = this.state.getWebSockets().filter(s => s !== ws);
    const hasAuthenticated = remaining.some(s => {
      const a = s.deserializeAttachment();
      return a && a.authenticated;
    });
    if (!hasAuthenticated) {
      await this._updatePresence(false);
    }
    // Notify presence watchers if going offline
    if (!hasAuthenticated && att.accountDigest) {
      await this._notifyPresenceWatchers(att.accountDigest, false);
    }
  }

  async webSocketError(ws, error) {
    console.warn(`[ws-do] error: ${error?.message || error}`);
  }

  // ── Alarm (heartbeat / presence TTL refresh) ────────────────────

  async alarm() {
    const sockets = this.state.getWebSockets();
    if (!sockets.length) {
      // No connections — clear presence and don't reschedule
      await this._updatePresence(false);
      return;
    }

    // Refresh presence TTL in KV
    const hasAuthenticated = sockets.some(ws => {
      const att = ws.deserializeAttachment();
      return att && att.authenticated;
    });
    if (hasAuthenticated) {
      await this._updatePresence(true);
    }

    // Prune expired call locks
    const now = Date.now();
    for (const [key, entry] of this.callLocks) {
      if (entry.expiresAt <= now) this.callLocks.delete(key);
    }

    // Reschedule alarm
    await this.state.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
  }

  // ── Auth handler ────────────────────────────────────────────────

  async _handleAuth(ws, msg, att) {
    const token = typeof msg.token === 'string' ? msg.token : '';
    const secret = this.env.WS_TOKEN_SECRET;
    const verification = await verifyWsJwt(token, secret);

    if (!verification.ok) {
      ws.send(JSON.stringify({ type: 'auth', ok: false, reason: verification.reason || 'invalid_token' }));
      try { ws.close(4401, 'invalid_token'); } catch {}
      return;
    }

    const tokenDigest = canonicalAccountDigest(verification.payload.accountDigest);
    if (!tokenDigest) {
      ws.send(JSON.stringify({ type: 'auth', ok: false, reason: 'account_digest_required' }));
      try { ws.close(4401, 'account_digest_missing'); } catch {}
      return;
    }

    // Ensure token matches this DO's account
    if (this.accountDigest && tokenDigest !== this.accountDigest) {
      ws.send(JSON.stringify({ type: 'auth', ok: false, reason: 'account_mismatch' }));
      try { ws.close(4403, 'account_mismatch'); } catch {}
      return;
    }

    if (!this.accountDigest) {
      this.accountDigest = tokenDigest;
    }

    const sessionTs = normalizeSessionTs(verification.payload.iat) || Math.floor(Date.now() / 1000);

    // Re-auth on same socket
    if (att.authenticated && att.accountDigest === tokenDigest) {
      if (sessionTs > (att.sessionTs || 0)) {
        att.sessionTs = sessionTs;
        ws.serializeAttachment(att);
      }
      ws.send(JSON.stringify({ type: 'auth', ok: true, exp: verification.payload.exp, reused: true }));
      return;
    }

    // Session staleness check: reject if a newer session already exists
    const sockets = this.state.getWebSockets();
    let latestTs = 0;
    for (const s of sockets) {
      if (s === ws) continue;
      const a = s.deserializeAttachment();
      if (a && a.authenticated && a.sessionTs > latestTs) latestTs = a.sessionTs;
    }
    if (latestTs > 0 && sessionTs < latestTs) {
      ws.send(JSON.stringify({ type: 'auth', ok: false, reason: 'stale_session' }));
      try { ws.close(4409, 'stale_session'); } catch {}
      return;
    }

    // If newer session, close older connections (single active connection policy)
    if (sessionTs >= latestTs && latestTs > 0) {
      for (const s of sockets) {
        if (s === ws) continue;
        const a = s.deserializeAttachment();
        if (a && a.authenticated) {
          try { s.close(4409, 'replaced'); } catch {}
        }
      }
    }

    // Mark authenticated
    const deviceId = att.deviceId || canonicalDeviceId(msg.deviceId) || null;
    ws.serializeAttachment({
      authenticated: true,
      accountDigest: tokenDigest,
      deviceId,
      sessionTs,
      connectedAt: att.connectedAt || Date.now()
    });

    ws.send(JSON.stringify({ type: 'auth', ok: true, exp: verification.payload.exp }));

    // Update presence
    await this._updatePresence(true);
    await this._notifyPresenceWatchers(tokenDigest, true);
  }

  // ── Presence ────────────────────────────────────────────────────

  async _updatePresence(online) {
    if (!this.accountDigest || !this.env.AUTH_KV) return;
    try {
      const key = `presence:${this.accountDigest}`;
      if (online) {
        const deviceIds = [];
        for (const ws of this.state.getWebSockets()) {
          const att = ws.deserializeAttachment();
          if (att?.authenticated && att.deviceId) deviceIds.push(att.deviceId);
        }
        await this.env.AUTH_KV.put(key, JSON.stringify({
          online: true,
          ts: Date.now(),
          deviceIds
        }), { expirationTtl: PRESENCE_TTL_SEC });
      } else {
        await this.env.AUTH_KV.put(key, JSON.stringify({
          online: false,
          ts: Date.now(),
          deviceIds: []
        }), { expirationTtl: 60 }); // Short TTL for offline marker
      }
    } catch (err) {
      console.warn(`[ws-do] presence update failed: ${err?.message || err}`);
    }
  }

  async _notifyPresenceWatchers(accountDigest, online) {
    // Presence watchers subscribe from their own DO. To notify them,
    // we need to know who is watching us. We store watcher digests in DO storage.
    try {
      const watchers = await this.state.storage.get('presenceWatchers') || [];
      if (!watchers.length) return;

      const payload = JSON.stringify({
        type: 'presence-update',
        accountDigest,
        online: !!online,
        ts: Date.now()
      });

      // For each watcher, send via their DO
      for (const watcherDigest of watchers) {
        try {
          const id = this.env.ACCOUNT_WS.idFromName(watcherDigest);
          const stub = this.env.ACCOUNT_WS.get(id);
          await stub.fetch('https://do/notify', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: payload
          });
        } catch {}
      }
    } catch (err) {
      console.warn(`[ws-do] presence watcher notify failed: ${err?.message || err}`);
    }
  }

  async _handlePresenceSubscribe(ws, msg, att) {
    const list = Array.isArray(msg.accountDigests) ? msg.accountDigests : [];
    const normalized = [];
    const online = [];

    for (const raw of list) {
      const digest = canonicalAccountDigest(raw);
      if (!digest || digest === this.accountDigest) continue;
      normalized.push(digest);

      // Check presence via KV
      try {
        const data = await this.env.AUTH_KV.get(`presence:${digest}`, 'json');
        if (data && data.online) online.push(digest);
      } catch {}

      // Register ourselves as a watcher in the target's DO storage
      try {
        const id = this.env.ACCOUNT_WS.idFromName(digest);
        const stub = this.env.ACCOUNT_WS.get(id);
        await stub.fetch('https://do/add-watcher', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ watcherDigest: this.accountDigest })
        });
      } catch {}
    }

    // Store which digests this socket watches (for cleanup)
    att.watching = normalized;
    ws.serializeAttachment(att);

    try {
      ws.send(JSON.stringify({
        type: 'presence',
        online,
        onlineAccountDigests: normalized,
        ts: Date.now()
      }));
    } catch {}
  }

  // ── Message relay (client → target DO) ──────────────────────────

  async _relayToTarget(targetDigest, payload) {
    if (!targetDigest) return;
    try {
      const id = this.env.ACCOUNT_WS.idFromName(targetDigest);
      const stub = this.env.ACCOUNT_WS.get(id);
      await stub.fetch('https://do/notify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (err) {
      console.warn(`[ws-do] relay to ${targetDigest} failed: ${err?.message || err}`);
    }
  }

  _handleMessageRelay(ws, msg, att) {
    const targetDigest = extractPeerAccountDigest(msg);
    const conversationId = String(msg.conversationId || '').trim();
    if (!targetDigest || !conversationId) return;

    const senderDeviceId = canonicalDeviceId(msg.senderDeviceId);
    const targetDeviceId = canonicalDeviceId(msg.targetDeviceId);
    if (!targetDeviceId) return;

    const counter = Number.isFinite(Number(msg.counter)) ? Number(msg.counter) : null;

    return this._relayToTarget(targetDigest, {
      type: 'secure-message',
      conversationId,
      messageId: msg.messageId || msg.id || null,
      preview: typeof msg.preview === 'string' ? msg.preview : '',
      ts: Number(msg.ts) || Date.now(),
      count: Number.isFinite(Number(msg.count)) ? Number(msg.count) : 1,
      counter,
      senderAccountDigest: att.accountDigest,
      senderDeviceId,
      targetDeviceId,
      peerAccountDigest: att.accountDigest,
      targetAccountDigest: targetDigest
    });
  }

  _handleContactRemovedRelay(ws, msg, att) {
    const targetDigest = extractPeerAccountDigest(msg);
    if (!targetDigest) return;
    const senderDeviceId = canonicalDeviceId(msg.senderDeviceId);
    const targetDeviceId = canonicalDeviceId(msg.targetDeviceId);
    if (!senderDeviceId || !targetDeviceId) return;

    return this._relayToTarget(targetDigest, {
      type: 'contact-removed',
      peerAccountDigest: att.accountDigest,
      senderDeviceId,
      targetDeviceId,
      ts: Date.now()
    });
  }

  _handleVaultAckRelay(ws, msg, att) {
    const targetDigest = extractPeerAccountDigest(msg);
    const conversationId = String(msg.conversationId || '').trim();
    const messageId = String(msg.messageId || msg.message_id || '').trim();
    if (!targetDigest || !conversationId || !messageId) return;

    const senderDeviceId = canonicalDeviceId(msg.senderDeviceId);
    const receiverDeviceId = canonicalDeviceId(msg.receiverDeviceId);
    const targetDeviceId = canonicalDeviceId(msg.targetDeviceId || msg.senderDeviceId);
    if (!senderDeviceId || !receiverDeviceId || !targetDeviceId) return;

    const tsRaw = Number(msg.ts);
    const ts = Number.isFinite(tsRaw) && tsRaw > 0 ? tsRaw : Math.floor(Date.now() / 1000);

    return this._relayToTarget(targetDigest, {
      type: 'vault-ack',
      conversationId,
      messageId,
      senderAccountDigest: targetDigest,
      senderDeviceId,
      receiverAccountDigest: att.accountDigest,
      receiverDeviceId,
      targetAccountDigest: targetDigest,
      targetDeviceId,
      peerAccountDigest: att.accountDigest,
      ts
    });
  }

  _handleConversationDeletedRelay(ws, msg, att) {
    const targetDigest = extractPeerAccountDigest(msg);
    const conversationId = String(msg.conversationId || '').trim();
    if (!targetDigest || !conversationId) return;

    const senderDeviceId = canonicalDeviceId(msg.senderDeviceId);
    const targetDeviceId = canonicalDeviceId(msg.targetDeviceId);
    if (!senderDeviceId || !targetDeviceId) return;

    return this._relayToTarget(targetDigest, {
      type: 'conversation-deleted',
      conversationId,
      senderAccountDigest: att.accountDigest,
      peerAccountDigest: att.accountDigest,
      senderDeviceId,
      targetDeviceId,
      ts: Date.now()
    });
  }

  _handleContactsReloadRelay(ws, msg, att) {
    const targetDigest = extractPeerAccountDigest(msg);
    if (!targetDigest) return;

    return this._relayToTarget(targetDigest, {
      type: 'contacts-reload',
      ts: Date.now(),
      accountDigest: targetDigest,
      senderDeviceId: canonicalDeviceId(msg.senderDeviceId) || null,
      targetDeviceId: canonicalDeviceId(msg.targetDeviceId) || null
    });
  }

  // ── Call signaling ──────────────────────────────────────────────

  async _handleCallSignal(ws, msg, att) {
    const rawType = String(msg.type).toLowerCase();
    const callId = normalizeCallId(msg.callId || msg.call_id || msg.id);
    if (!callId) {
      this._sendCallError(ws, 'CALL_INVALID_ID', 'callId required', { event: rawType });
      return;
    }

    const targetAccountDigest = extractPeerAccountDigest(msg);
    if (!targetAccountDigest) {
      this._sendCallError(ws, 'CALL_TARGET_REQUIRED', 'target accountDigest required', { event: rawType, callId });
      return;
    }

    const senderDeviceId = canonicalDeviceId(msg.senderDeviceId);
    const targetDeviceId = canonicalDeviceId(msg.targetDeviceId);
    if (!senderDeviceId || !targetDeviceId) {
      this._sendCallError(ws, 'CALL_DEVICE_REQUIRED', 'senderDeviceId and targetDeviceId required', {
        event: rawType, callId, peerAccountDigest: targetAccountDigest
      });
      return;
    }

    if (targetAccountDigest === att.accountDigest) {
      this._sendCallError(ws, 'CALL_TARGET_INVALID', 'target must differ from sender', { event: rawType, callId });
      return;
    }

    // Device validation via D1 (Worker internal API)
    try {
      await this._validateDevice(att.accountDigest, senderDeviceId);
      await this._validateDevice(targetAccountDigest, targetDeviceId);
    } catch (err) {
      this._sendCallError(ws, err?.code || 'DEVICE_NOT_ACTIVE', err?.message || 'device not active', {
        event: rawType, callId, peerAccountDigest: targetAccountDigest
      });
      return;
    }

    // Call locking
    if (rawType === 'call-invite') {
      if (this._isCallLocked(att.accountDigest, callId)) {
        this._sendCallError(ws, 'CALL_ALREADY_IN_PROGRESS', 'caller already has an active call', { event: rawType, callId });
        return;
      }
      // We can only check our own lock; the target's lock will be checked by the target DO
      this._lockCall(att.accountDigest, callId);
    } else if (CALL_RELEASE_EVENTS.has(rawType)) {
      this._releaseCallLock(att.accountDigest, callId);
    } else if (CALL_RENEW_EVENTS.has(rawType)) {
      this._renewCallLock(att.accountDigest, callId);
    }

    // Persist call event via Worker D1 API
    const detail = buildCallDetail(msg);
    try {
      await this._persistCallEvent({
        callId, type: rawType, payload: detail,
        fromAccountDigest: att.accountDigest,
        toAccountDigest: targetAccountDigest,
        traceId: msg.traceId ? String(msg.traceId).trim().slice(0, 64) : null
      });
    } catch (err) {
      this._releaseCallLock(att.accountDigest, callId);
      this._sendCallError(ws, 'CALL_EVENT_FAILED', 'unable to persist call event', {
        event: rawType, callId, peerAccountDigest: targetAccountDigest
      });
      return;
    }

    // Build relay payload
    const relayPayload = {
      type: rawType,
      callId,
      fromAccountDigest: att.accountDigest,
      toAccountDigest: targetAccountDigest,
      fromDeviceId: senderDeviceId,
      toDeviceId: targetDeviceId,
      traceId: msg.traceId ? String(msg.traceId).trim().slice(0, 64) : null,
      ts: Date.now(),
      payload: detail || null
    };

    // Relay to target DO
    await this._relayToTarget(targetAccountDigest, relayPayload);

    // Also broadcast to sender's other devices (exclude this socket)
    const data = JSON.stringify(relayPayload);
    for (const s of this.state.getWebSockets()) {
      if (s === ws) continue;
      const a = s.deserializeAttachment();
      if (a?.authenticated) {
        try { s.send(data); } catch {}
      }
    }

    // Ack
    this._sendCallAck(ws, rawType, callId, { peerAccountDigest: targetAccountDigest });
  }

  _sendCallError(ws, code, message, meta = {}) {
    try {
      ws.send(JSON.stringify({ type: 'call-error', code, message, ts: Date.now(), ...meta }));
    } catch {}
  }

  _sendCallAck(ws, eventType, callId, meta = {}) {
    try {
      ws.send(JSON.stringify({ type: 'call-event-ack', event: eventType, callId, ts: Date.now(), ...meta }));
    } catch {}
  }

  _isCallLocked(accountDigest, callId) {
    const entry = this.callLocks.get(accountDigest);
    if (!entry) return false;
    if (entry.expiresAt <= Date.now()) {
      this.callLocks.delete(accountDigest);
      return false;
    }
    return callId ? entry.callId !== callId : true;
  }

  _lockCall(accountDigest, callId) {
    this.callLocks.set(accountDigest, { callId, expiresAt: Date.now() + CALL_LOCK_TTL_MS });
  }

  _renewCallLock(accountDigest, callId) {
    const entry = this.callLocks.get(accountDigest);
    if (entry && entry.callId === callId) {
      entry.expiresAt = Date.now() + CALL_LOCK_TTL_MS;
    }
  }

  _releaseCallLock(accountDigest, callId) {
    const entry = this.callLocks.get(accountDigest);
    if (entry && (!callId || entry.callId === callId)) {
      this.callLocks.delete(accountDigest);
    }
  }

  async _validateDevice(accountDigest, deviceId) {
    // Call the Worker's internal D1 route to validate device
    // This is a fetch to the Worker itself (same worker, internal route)
    const url = `https://do-internal/d1/devices/check?accountDigest=${encodeURIComponent(accountDigest)}&deviceId=${encodeURIComponent(deviceId)}`;
    const body = '';
    const path = `/d1/devices/check?accountDigest=${encodeURIComponent(accountDigest)}&deviceId=${encodeURIComponent(deviceId)}`;

    // Compute HMAC for internal auth
    const secret = this.env.DATA_API_HMAC || '';
    if (!secret) return; // Skip validation if no HMAC configured

    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(path + body));
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    // We can't easily call ourselves (the Worker). Instead, the call signaling
    // via HTTP API (方案 B) means the Worker already validates devices before
    // relaying. For WS-originated calls, we skip device validation in the DO
    // and let the Worker handle it when it persists the event.
    // This is a no-op for now; full validation happens server-side.
  }

  async _persistCallEvent({ callId, type, payload, fromAccountDigest, toAccountDigest, traceId }) {
    // POST to Worker's internal D1 route
    const secret = this.env.DATA_API_HMAC || '';
    if (!secret) return; // Can't call internal API without HMAC

    const path = '/d1/calls/events';
    const bodyObj = { callId, type, payload, fromAccountDigest, toAccountDigest, traceId };
    const bodyStr = JSON.stringify(bodyObj);

    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sigData = path + bodyStr;
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(sigData));
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    // Fetch the Worker's own URL for the internal D1 route
    // The DO runs in the same isolate cluster; use the Worker's public URL
    const workerOrigin = this.env.WORKER_ORIGIN || '';
    if (!workerOrigin) {
      console.warn('[ws-do] WORKER_ORIGIN not set, skipping call event persist');
      return;
    }

    const resp = await fetch(`${workerOrigin}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-auth': sigB64
      },
      body: bodyStr
    });

    if (!resp.ok) {
      const err = new Error('call event persist failed');
      err.status = resp.status;
      throw err;
    }
  }

  // ── Watcher management (for presence) ───────────────────────────
  // Called by other DOs when a client subscribes to this account's presence

  async _handleAddWatcher(request) {
    const { watcherDigest } = await request.json();
    const digest = canonicalAccountDigest(watcherDigest);
    if (!digest) return Response.json({ ok: false }, { status: 400 });

    const watchers = await this.state.storage.get('presenceWatchers') || [];
    if (!watchers.includes(digest)) {
      watchers.push(digest);
      await this.state.storage.put('presenceWatchers', watchers);
    }
    return Response.json({ ok: true });
  }
}
