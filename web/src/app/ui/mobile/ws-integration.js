// WebSocket transport + message routing
//
// Manages: connection lifecycle, auth token, reconnect, send queue, monitor,
// and incoming message dispatch (presence, secure-message, invite, etc.)
//
// Usage:
//   const ws = createWsIntegration({ deps: { ... } });
//   ws.startMonitor();
//   ws.ensure();          // connect when ready
//   ws.send(payload);     // queue-safe send
//   ws.close();           // teardown on logout

export function createWsIntegration({ deps }) {
  const {
    log, logForensicsEvent, wsDebugEnabled,
    getAccountDigest, getAccountToken, getLoginSessionTs,
    normalizePeerIdentity, normalizeAccountDigest, normalizePeerDeviceId,
    getDeviceId, ensureDeviceId, getContactSecret,
    sessionStore, requestWsToken, flushOutbox,
    handleCallSignalMessage, handleCallAuxMessage,
    messagesFlowFacade,
    updateConnectionIndicator,
    isSettingsConversationId,
    handleSettingsSecureMessage,
    connectionIndicatorEl,
    // Late-bound via getters (not yet created at instantiation time)
    getPresenceManager,
    getMessagesPane,
    getShareController,
    // Callbacks into app-mobile
    showForcedLogoutModal,
    secureLogout,
    loadInitialContacts,
    hydrateProfileSnapshots,
    isHydrationComplete
  } = deps;

  // --- Tuning constants ---
  const RECONNECT_BASE_DELAY = 2000;
  const RECONNECT_MAX_DELAY  = 30000;
  const HEARTBEAT_INTERVAL   = 30000;   // send ping every 30s
  const HEARTBEAT_TIMEOUT    = 45000;   // no pong within 45s → dead
  const CONNECT_TIMEOUT      = 15000;   // CONNECTING state max age
  const PENDING_QUEUE_LIMIT  = 200;

  // --- Network quality detection ---
  const RTT_WINDOW_SIZE  = 3;      // sliding window of last N pong RTTs
  const RTT_DEGRADED_MS  = 3000;   // avg RTT ≥ 3 s → degraded

  // --- Connection state ---
  let wsConn = null;
  let wsReconnectTimer = null;
  let wsAuthTokenInfo = null;
  const pendingMessages = [];
  let monitorTimer = null;
  let reconnectAttempts = 0;
  let connectStartedAt = 0;
  let lastPongAt = 0;
  let heartbeatTimer = null;
  let connecting = false;

  // --- RTT state ---
  let lastPingSentAt = 0;
  const rttSamples = [];
  let lastQuality = 'good';  // 'good' | 'degraded'

  // --- Auth ---

  async function getAuthToken({ force = false } = {}) {
    const accountDigest = getAccountDigest();
    if (!accountDigest) throw new Error('缺少 accountDigest');
    const nowSec = Math.floor(Date.now() / 1000);
    if (!force && wsAuthTokenInfo && wsAuthTokenInfo.token) {
      const exp = Number(wsAuthTokenInfo.expiresAt || 0);
      if (!exp || exp - nowSec > 30) {
        return wsAuthTokenInfo;
      }
    }
    const accountToken = getAccountToken();
    const sessionTs = getLoginSessionTs();
    const { r, data } = await requestWsToken({ accountToken, accountDigest, sessionTs });
    if (!r.ok || !data?.token) {
      const message = typeof data === 'string' ? data : data?.message || data?.error || 'ws token failed';
      const err = new Error(message);
      err.status = r.status;
      err.code = typeof data === 'object' ? (data?.error || null) : null;
      throw err;
    }
    const expiresAt = Number(data.expires_at || data.expiresAt || data.exp || 0) || null;
    wsAuthTokenInfo = { token: data.token, expiresAt };
    return wsAuthTokenInfo;
  }

  // --- Reconnect ---

  function scheduleReconnect(baseDelay = RECONNECT_BASE_DELAY) {
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    const backoff = Math.min(baseDelay * Math.pow(2, reconnectAttempts), RECONNECT_MAX_DELAY);
    const jitter = Math.floor(Math.random() * backoff * 0.3);
    const delay = backoff + jitter;
    reconnectAttempts++;
    log({ wsScheduleReconnect: true, attempt: reconnectAttempts, delay });
    wsReconnectTimer = setTimeout(() => {
      wsReconnectTimer = null;
      connecting = true;
      connect().catch((err) => {
        log({ wsReconnectError: err?.message || err });
      }).finally(() => { connecting = false; });
    }, delay);
  }

  // --- Connect ---

  async function connect() {
    const accountDigest = getAccountDigest();
    if (!accountDigest) return;
    if (wsDebugEnabled) {
      log({ wsConnectStart: true, accountDigest });
    }
    let tokenInfo;
    try {
      tokenInfo = await getAuthToken();
    } catch (err) {
      log({ wsTokenError: err?.message || err, status: err?.status, code: err?.code });
      if (err?.status === 409 || err?.code === 'StaleSession') {
        showForcedLogoutModal('帳號已在其他裝置登入');
        secureLogout('帳號已在其他裝置登入', { auto: true });
        return;
      }
      scheduleReconnect(4000);
      return;
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let baseHost = connectionIndicatorEl?.dataset?.wsHost || '';
    let path = connectionIndicatorEl?.dataset?.wsPath || '/api/ws';
    const apiOriginRaw = typeof globalThis !== 'undefined' && typeof globalThis.API_ORIGIN === 'string'
      ? globalThis.API_ORIGIN.trim()
      : '';
    if (apiOriginRaw) {
      try {
        const originUrl = new URL(apiOriginRaw);
        baseHost = originUrl.host || baseHost;
        const prefix = originUrl.pathname && originUrl.pathname !== '/' ? originUrl.pathname.replace(/\/$/, '') : '';
        if (prefix) {
          path = path.startsWith('/') ? `${prefix}${path}` : `${prefix}/${path}`;
        }
      } catch (err) {
        log({ apiOriginParseError: err?.message || err });
      }
    }
    if (!baseHost) baseHost = location.host;
    if (!path.startsWith('/')) path = `/${path}`;
    const wsUrl = `${proto}//${baseHost}${path}`;
    if (wsDebugEnabled) {
      log({ wsConnectUrl: wsUrl });
    }
    connectStartedAt = Date.now();
    const ws = new WebSocket(wsUrl);
    wsConn = ws;
    updateConnectionIndicator('connecting');
    ws.onopen = () => {
      if (ws !== wsConn) return;
      if (wsDebugEnabled) {
        log({ wsState: 'open' });
      }
      wsReconnectTimer = null;
      connecting = false;
      reconnectAttempts = 0;
      startHeartbeat();
      try {
        ws.send(JSON.stringify({ type: 'auth', accountDigest, token: tokenInfo.token }));
      } catch (err) {
        log({ wsAuthSendError: err?.message || err });
      }
      if (pendingMessages.length) {
        for (const msg of pendingMessages.splice(0)) {
          try {
            ws.send(JSON.stringify(msg));
          } catch (err) {
            log({ wsSendError: err?.message || err });
          }
        }
      }
    };
    ws.onmessage = (event) => {
      if (ws !== wsConn) return;
      if (wsDebugEnabled) {
        log({ wsMessageRaw: event.data });
      }
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      const msgType = msg?.type || null;
      if (isForensicsWsSecureMessage(msgType)) {
        try {
          logForensicsEvent('WS_RECV', buildForensicsSummary(msg));
        } catch { }
      }
      handleMessage(msg);
    };
    ws.onclose = (evt) => {
      if (ws !== wsConn) return;
      if (wsDebugEnabled) {
        log({ wsClose: { code: evt.code, reason: evt.reason } });
      }
      wsConn = null;
      updateConnectionIndicator('offline');
      getPresenceManager()?.clearPresenceState?.();
      if (evt.code === 4409) {
        showForcedLogoutModal('帳號已在其他裝置登入');
        secureLogout('帳號已在其他裝置登入', { auto: true });
        return;
      }
      if (evt.code === 4401) {
        wsAuthTokenInfo = null;
      }
      scheduleReconnect();
    };
    ws.onerror = () => {
      if (ws !== wsConn) return;
      if (wsDebugEnabled) {
        log({ wsError: true });
      }
      updateConnectionIndicator('offline');
      wsAuthTokenInfo = null;
      try { ws.close(); } catch { }
    };
  }

  // --- Send ---

  function send(payload) {
    if (!wsConn || wsConn.readyState !== WebSocket.OPEN) {
      if (pendingMessages.length >= PENDING_QUEUE_LIMIT) {
        pendingMessages.shift();
        log({ wsPendingQueueOverflow: true, limit: PENDING_QUEUE_LIMIT });
      }
      pendingMessages.push(payload);
      ensure();
      return false;
    }
    try {
      wsConn.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      log({ wsSendError: err?.message || err });
      pendingMessages.push(payload);
      ensure();
      return false;
    }
  }

  send.isReady = () => !!(wsConn && wsConn.readyState === WebSocket.OPEN);

  // --- Ensure / Monitor ---

  function ensure() {
    if (wsConn || wsReconnectTimer || connecting) return;
    const digest = getAccountDigest();
    if (!digest) {
      log({ wsSkip: 'missing_account_digest' });
      return;
    }
    if (!isHydrationComplete()) {
      if (wsDebugEnabled) console.log('[ws-ensure] Skipped: Hydration pending');
      return;
    }
    log({ wsEnsure: true, state: wsConn?.readyState ?? 'none' });
    connecting = true;
    connect().catch((err) => {
      log({ wsConnectError: err?.message || err });
    }).finally(() => { connecting = false; });
  }

  function startMonitor(intervalMs = 5000) {
    if (monitorTimer) return;
    monitorTimer = setInterval(() => {
      // Detect hung CONNECTING state
      if (wsConn && wsConn.readyState === WebSocket.CONNECTING) {
        if (connectStartedAt && Date.now() - connectStartedAt > CONNECT_TIMEOUT) {
          log({ wsConnectTimeout: true, elapsed: Date.now() - connectStartedAt });
          try { wsConn.close(); } catch { }
          wsConn = null;
          connecting = false;
          scheduleReconnect();
        }
        return;
      }
      if (!wsConn || wsConn.readyState !== WebSocket.OPEN) {
        log({ wsMonitorReconnect: true, readyState: wsConn?.readyState ?? null });
        ensure();
      }
    }, intervalMs);
  }

  // --- Heartbeat (application-level ping/pong) ---

  function startHeartbeat() {
    stopHeartbeat();
    lastPongAt = Date.now();
    heartbeatTimer = setInterval(() => {
      if (!wsConn || wsConn.readyState !== WebSocket.OPEN) return;
      if (lastPongAt && Date.now() - lastPongAt > HEARTBEAT_TIMEOUT) {
        log({ wsHeartbeatTimeout: true, elapsed: Date.now() - lastPongAt });
        try { wsConn.close(); } catch { }
        return;  // onclose will trigger reconnect
      }
      lastPingSentAt = Date.now();
      try { wsConn.send(JSON.stringify({ type: 'ping' })); } catch { }
    }, HEARTBEAT_INTERVAL);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  // --- Close / Cleanup (for secureLogout) ---

  function close() {
    try { wsConn?.close(); } catch { }
    wsConn = null;
    wsAuthTokenInfo = null;
    connecting = false;
    reconnectAttempts = 0;
    connectStartedAt = 0;
    if (wsReconnectTimer) {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null;
    }
    if (monitorTimer) {
      clearInterval(monitorTimer);
      monitorTimer = null;
    }
    stopHeartbeat();
    pendingMessages.length = 0;
    // Reset RTT state
    lastPingSentAt = 0;
    rttSamples.length = 0;
    lastQuality = 'good';
  }

  function clearAuth() {
    wsAuthTokenInfo = null;
  }

  // --- Message routing helpers ---

  function resolveWsPeer(msg = {}) {
    return normalizePeerIdentity({
      peerAccountDigest: msg.peerAccountDigest || msg.fromAccountDigest || null
    });
  }

  function isTargetingThisDevice(msg = {}) {
    const targetDeviceId = msg.targetDeviceId || null;
    if (!targetDeviceId) return true;
    const selfDeviceId = typeof getDeviceId === 'function' ? (getDeviceId() || ensureDeviceId()) : null;
    if (!selfDeviceId) return false;
    return String(targetDeviceId).trim() === String(selfDeviceId).trim();
  }

  function isForensicsWsSecureMessage(type) {
    return type === 'secure-message' || type === 'message-new';
  }

  function buildForensicsSummary(msg = {}) {
    const conversationId = String(msg?.conversationId || msg?.conversation_id || '').trim() || null;
    const messageId = msg?.messageId || msg?.message_id || msg?.id || null;
    const serverMessageId = msg?.serverMessageId || msg?.server_message_id || null;
    const senderDeviceId = msg?.senderDeviceId || msg?.sender_device_id || null;
    const targetDeviceId = msg?.targetDeviceId || msg?.target_device_id || null;
    const msgType = msg?.msgType || msg?.msg_type || msg?.type || null;
    const ts = msg?.ts ?? msg?.timestamp ?? msg?.createdAt ?? msg?.created_at ?? null;
    return { conversationId, messageId, serverMessageId, senderDeviceId, targetDeviceId, msgType, ts };
  }

  function normalizeWsToken(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
  }

  function resolveIncomingPeerIdentity(msg = {}) {
    return normalizePeerIdentity({
      peerAccountDigest: msg?.senderAccountDigest
        || msg?.fromAccountDigest
        || msg?.sender_account_digest
        || msg?.senderDigest
        || msg?.sender_digest
        || null,
      peerDeviceId: msg?.senderDeviceId
        || msg?.sender_device_id
        || null
    });
  }

  function resolveConversationToken({ conversationId, peerAccountDigest, peerDeviceId } = {}) {
    const convId = typeof conversationId === 'string' ? conversationId.trim() : '';
    let tokenB64 = null;
    let resolvedPeerDigest = normalizeAccountDigest(peerAccountDigest || null);
    let resolvedPeerDeviceId = normalizePeerDeviceId(peerDeviceId || null);
    if (!convId) {
      return { tokenB64: null, peerAccountDigest: resolvedPeerDigest || null, peerDeviceId: resolvedPeerDeviceId || null };
    }
    const convIndex = sessionStore.conversationIndex instanceof Map ? sessionStore.conversationIndex : null;
    if (convIndex) {
      const entry = convIndex.get(convId) || null;
      const tokenCandidate = normalizeWsToken(entry?.token_b64 || entry?.tokenB64 || entry?.conversationToken || null);
      if (!tokenB64 && tokenCandidate) tokenB64 = tokenCandidate;
      if (!resolvedPeerDigest) {
        resolvedPeerDigest = normalizeAccountDigest(entry?.peerAccountDigest || null);
      }
      if (!resolvedPeerDeviceId) {
        resolvedPeerDeviceId = normalizePeerDeviceId(entry?.peerDeviceId || null);
      }
    }
    const threads = sessionStore.conversationThreads instanceof Map ? sessionStore.conversationThreads : null;
    if (!tokenB64 && threads) {
      const entry = threads.get(convId) || null;
      const tokenCandidate = normalizeWsToken(entry?.conversationToken || entry?.token_b64 || entry?.tokenB64 || null);
      if (!tokenB64 && tokenCandidate) tokenB64 = tokenCandidate;
      if (!resolvedPeerDigest) {
        resolvedPeerDigest = normalizeAccountDigest(entry?.peerAccountDigest || null);
      }
      if (!resolvedPeerDeviceId) {
        resolvedPeerDeviceId = normalizePeerDeviceId(entry?.peerDeviceId || null);
      }
    }
    if (!tokenB64 && resolvedPeerDigest) {
      const secret = getContactSecret(resolvedPeerDigest, { peerDeviceId: resolvedPeerDeviceId });
      const tokenCandidate = normalizeWsToken(secret?.conversationToken || secret?.conversation?.token || null);
      if (!tokenB64 && tokenCandidate) tokenB64 = tokenCandidate;
      if (!resolvedPeerDeviceId) {
        resolvedPeerDeviceId = normalizePeerDeviceId(secret?.peerDeviceId || null);
      }
    }
    return {
      tokenB64: tokenB64 || null,
      peerAccountDigest: resolvedPeerDigest || null,
      peerDeviceId: resolvedPeerDeviceId || null
    };
  }

  function buildLiveJobContext(msg = {}, convId = null) {
    const conversationId = typeof convId === 'string' ? convId.trim() : '';
    const peerIdentity = resolveIncomingPeerIdentity(msg);
    const tokenInfo = resolveConversationToken({
      conversationId,
      peerAccountDigest: peerIdentity.accountDigest,
      peerDeviceId: peerIdentity.deviceId
    });
    return {
      conversationId: conversationId || null,
      tokenB64: tokenInfo.tokenB64 || null,
      peerAccountDigest: tokenInfo.peerAccountDigest || peerIdentity.accountDigest || null,
      peerDeviceId: tokenInfo.peerDeviceId || peerIdentity.deviceId || null,
      messageId: msg?.messageId || msg?.message_id || msg?.id || null,
      serverMessageId: msg?.serverMessageId || msg?.server_message_id || msg?.serverMsgId || null,
      sourceTag: 'ws_incoming'
    };
  }

  // --- Incoming message dispatch ---

  function handleMessage(msg) {
    const type = msg?.type;
    if (type === 'hello') return;
    if (type === 'pong') {
      const now = Date.now();
      lastPongAt = now;
      // RTT measurement — detect degraded network quality
      if (lastPingSentAt > 0) {
        const rtt = now - lastPingSentAt;
        rttSamples.push(rtt);
        if (rttSamples.length > RTT_WINDOW_SIZE) rttSamples.shift();
        const avg = rttSamples.reduce((a, b) => a + b, 0) / rttSamples.length;
        const quality = avg >= RTT_DEGRADED_MS ? 'degraded' : 'good';
        if (quality !== lastQuality) {
          lastQuality = quality;
          updateConnectionIndicator(quality === 'degraded' ? 'degraded' : 'online');
        }
      }
      return;
    }
    if (type === 'auth') {
      if (msg?.ok) updateConnectionIndicator('online');
      else updateConnectionIndicator('offline');
      if (msg?.ok) {
        const pm = getPresenceManager();
        const mp = getMessagesPane();
        pm?.sendPresenceSubscribe?.();
        mp?.refreshAfterReconnect?.();
        messagesFlowFacade.onLoginResume({
          source: 'ws_reconnect',
          runRestore: false,
          onOfflineDecryptError: (err) => log({ offlineDecryptSyncError: err?.message || err, source: 'ws_reconnect' }),
          reconcileOutgoingStatus: (params) => messagesFlowFacade.reconcileOutgoingStatusNow({
            ...params,
            reconcileOutgoingStatusNow: mp?.reconcileOutgoingStatusNow
          })
        });
        flushOutbox({ sourceTag: 'ws_auth_ok' }).catch(() => { });
      }
      return;
    }
    if (type === 'force-logout') {
      const reason = msg?.reason || '帳號已被清除';
      showForcedLogoutModal(reason);
      secureLogout(reason, { auto: true });
      return;
    }
    if (handleCallSignalMessage(msg) || handleCallAuxMessage(msg)) {
      return;
    }
    if (type === 'contact-removed') {
      if (!isTargetingThisDevice(msg)) return;
      const identity = resolveWsPeer(msg);
      const peerAccountDigest = identity.key;
      if (peerAccountDigest) {
        try {
          document.dispatchEvent(new CustomEvent('contacts:removed', { detail: { peerAccountDigest, notifyPeer: false } }));
        } catch (err) {
          log({ contactRemovedEventError: err?.message || err, peerAccountDigest });
        }
      }
      return;
    }
    if (type === 'invite-delivered') {
      if (!isTargetingThisDevice(msg)) return;
      const inviteId = msg?.inviteId || null;
      if (!inviteId) {
        log({ inviteDeliveredMissingId: true });
        return;
      }
      getShareController()?.consumeInviteDropbox?.(inviteId, { source: 'ws' })
        .catch((err) => log({ inviteConsumeError: err?.message || err, inviteId }));
      return;
    }
    if (type === 'contacts-reload') {
      if (!isTargetingThisDevice(msg)) return;
      loadInitialContacts()
        .then(() => hydrateProfileSnapshots())
        .catch((err) => log({ contactsInitError: err?.message || err }));
      return;
    }
    if (type === 'presence') {
      const online = Array.isArray(msg?.onlineAccountDigests) ? msg.onlineAccountDigests
        : Array.isArray(msg?.onlineDigests) ? msg.onlineDigests
          : Array.isArray(msg?.online_accounts) ? msg.online_accounts
            : Array.isArray(msg?.online) ? msg.online
              : [];
      getPresenceManager()?.applyPresenceSnapshot?.(online);
      return;
    }
    if (type === 'presence-update') {
      const identity = resolveWsPeer(msg);
      if (!identity.key) return;
      getPresenceManager()?.setContactPresence?.(identity, !!msg?.online);
      return;
    }
    if (type === 'vault-ack') {
      if (!isTargetingThisDevice(msg)) return;
      getMessagesPane()?.handleVaultAckEvent?.(msg);
      return;
    }
    if (type === 'secure-message' || type === 'message-new') {
      if (!isTargetingThisDevice(msg)) return;
      if (!msg?.senderDeviceId || !msg?.targetDeviceId) {
        log({ secureMessageMissingDeviceId: true, type, hasSender: !!msg?.senderDeviceId, hasTarget: !!msg?.targetDeviceId });
        return;
      }
      const convId = String(msg?.conversationId || msg?.conversation_id || '').trim();
      if (isSettingsConversationId(convId)) {
        handleSettingsSecureMessage();
        return;
      }
      if (wsDebugEnabled) {
        try {
          console.log('[ws-dispatch]', {
            type,
            conversationId: convId || null,
            senderAccountDigest: msg?.senderAccountDigest || null,
            senderDeviceId: msg?.senderDeviceId || null,
            targetDeviceId: msg?.targetDeviceId || null,
            targetAccountDigest: msg?.targetAccountDigest || null,
            peerAccountDigest: msg?.peerAccountDigest || null
          });
        } catch { }
      }
      try {
        const summary = buildForensicsSummary(msg);
        logForensicsEvent('WS_DISPATCH', {
          ...summary,
          conversationId: convId || summary.conversationId || null,
          handler: 'messagesPane.handleIncomingSecureMessage'
        });
      } catch { }
      const liveJobCtx = buildLiveJobContext(msg, convId);
      messagesFlowFacade.onWsIncomingMessageNew({
        event: msg,
        handleIncomingSecureMessage: getMessagesPane()?.handleIncomingSecureMessage
      }, liveJobCtx);
      return;
    }
  }

  return {
    ensure,
    send,
    close,
    clearAuth,
    startMonitor
  };
}
