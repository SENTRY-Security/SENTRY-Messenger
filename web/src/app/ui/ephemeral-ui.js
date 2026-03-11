// /app/ui/ephemeral-ui.js
// Guest-side ephemeral chat controller.
// Consumes a one-time link token, establishes E2EE via X3DH + Double Ratchet,
// then handles timer + encrypted messaging.

import { ephemeralConsume, ephemeralExtend, ephemeralWsToken } from '../api/ephemeral.js';
import { initI18n, t } from '/locales/index.js';
import { generateInitialBundle } from '../../shared/crypto/prekeys.js';
import { x3dhInitiate, drEncryptText, drDecryptText } from '../../shared/crypto/dr.js';
import { loadNacl, b64 } from '../../shared/crypto/nacl.js';

// Use bootstrap translator until async i18n is ready, then use async t()
function _t(key, params) {
  try { return t(key, params); } catch { /* fallback */ }
  return typeof window.__t === 'function' ? window.__t(key, params) : key;
}

// ── State ──
let sessionState = null;   // { session_id, conversation_id, guest_digest, guest_device_id, owner_digest, expires_at, ws_token }
let ws = null;
let timerInterval = null;
let destroyed = false;

// ── E2EE State (memory-only) ──
let ephDrState = null;         // Double Ratchet session state
let keyExchangeComplete = false; // true after owner sends ack

// ── DOM refs ──
const splash = document.getElementById('ephSplash');
const progressBar = document.getElementById('ephProgressBar');
const splashStatus = document.getElementById('ephSplashStatus');
const splashError = document.getElementById('ephSplashError');
const chatUI = document.getElementById('ephChat');
const timerClock = document.getElementById('ephTimerClock');
const timerGradient = document.getElementById('ephTimerGradient');
const timerLabel = document.getElementById('ephTimerLabel');
const extendBtn = document.getElementById('ephExtendBtn');
const messagesEl = document.getElementById('ephMessages');
const inputEl = document.getElementById('ephInput');
const sendBtn = document.getElementById('ephSendBtn');
const destroyedEl = document.getElementById('ephDestroyed');
const particlesEl = document.getElementById('ephParticles');
const voiceCallBtn = document.getElementById('ephVoiceCallBtn');
const videoCallBtn = document.getElementById('ephVideoCallBtn');
const callOverlay = document.getElementById('ephCallOverlay');
const callModeIcon = document.getElementById('ephCallModeIcon');
const callStatusEl = document.getElementById('ephCallStatus');
const callTimerEl = document.getElementById('ephCallTimer');
const remoteVideo = document.getElementById('ephRemoteVideo');
const localVideo = document.getElementById('ephLocalVideo');
const muteBtn = document.getElementById('ephMuteBtn');
const camToggleBtn = document.getElementById('ephCamToggleBtn');
const hangupBtn = document.getElementById('ephHangupBtn');
const wsStatusEl = document.getElementById('ephWsStatus');

// ── Particles ──
function initParticles() {
  for (let i = 0; i < 12; i++) {
    const p = document.createElement('div');
    p.className = 'eph-particle';
    p.style.left = Math.random() * 100 + '%';
    p.style.animationDuration = (8 + Math.random() * 12) + 's';
    p.style.animationDelay = (-Math.random() * 20) + 's';
    p.style.width = (2 + Math.random() * 2) + 'px';
    p.style.height = p.style.width;
    particlesEl.appendChild(p);
  }
}

// ── Splash progress ──
function setProgress(pct, status) {
  if (progressBar) progressBar.style.width = pct + '%';
  if (splashStatus) splashStatus.textContent = status;
}

function showError(msg) {
  if (progressBar) progressBar.style.display = 'none';
  const scanEl = progressBar?.parentElement?.querySelector('.splash-bar-scan');
  if (scanEl) scanEl.style.display = 'none';
  if (splashError) {
    splashError.textContent = msg;
    splashError.style.display = 'block';
  }
  if (splashStatus) splashStatus.style.display = 'none';
}

function hideSplash() {
  if (splash) {
    splash.classList.add('fade-out');
    setTimeout(() => { if (splash.parentNode) splash.parentNode.removeChild(splash); }, 600);
  }
  window.__ephCanvasStop?.();
}

// ── Timer ──
function startTimer() {
  updateTimer();
  timerInterval = setInterval(updateTimer, 1000);
}

function updateTimer() {
  if (destroyed || !sessionState) return;
  const now = Math.floor(Date.now() / 1000);
  let remaining = sessionState.expires_at - now;
  if (remaining <= 0) {
    remaining = 0;
    destroyChat();
    return;
  }
  const min = Math.floor(remaining / 60);
  const sec = remaining % 60;
  timerClock.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;

  // Color states
  const cls = remaining > 300 ? '' : remaining > 120 ? 'yellow' : 'red';
  timerClock.className = 'eph-timer-clock' + (cls ? ' ' + cls : '');
  timerGradient.className = 'eph-timer-gradient' + (cls ? ' ' + cls : '');

  // Extend button visibility
  if (remaining <= 300) {
    extendBtn.classList.add('visible');
  } else {
    extendBtn.classList.remove('visible');
  }
}

// ── Extend ──
extendBtn?.addEventListener('click', async () => {
  try {
    extendBtn.disabled = true;
    extendBtn.textContent = _t('ephemeral.extending');
    const data = await ephemeralExtend({
      sessionId: sessionState.session_id,
      guestDigest: sessionState.guest_digest
    });
    sessionState.expires_at = data.expires_at;
    extendBtn.textContent = _t('ephemeral.extendTime');
    extendBtn.disabled = false;
    updateTimer();
    addSystemMessage(_t('ephemeral.extendedTenMin'));
  } catch (err) {
    extendBtn.textContent = _t('ephemeral.extendTime');
    extendBtn.disabled = false;
    addSystemMessage(_t('ephemeral.extendFailed', { error: err.message || '' }));
  }
});

// ── Messages ──
function addMessage(text, direction, ts) {
  const div = document.createElement('div');
  div.className = 'eph-msg ' + direction;
  const timeStr = ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  div.innerHTML = `${escapeHtml(text)}${timeStr ? `<div class="msg-time">${timeStr}</div>` : ''}`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'eph-system-msg';
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ── WS Status Indicator ──
function updateWsStatus(state) {
  if (!wsStatusEl) return;
  wsStatusEl.classList.remove('online', 'connecting', 'degraded');
  const labelEl = wsStatusEl.querySelector('span:last-child');
  if (state === 'online') {
    wsStatusEl.classList.add('online');
    if (labelEl) labelEl.textContent = _t('status.online');
  } else if (state === 'connecting') {
    wsStatusEl.classList.add('connecting');
    if (labelEl) labelEl.textContent = _t('status.connecting');
  } else if (state === 'degraded') {
    wsStatusEl.classList.add('degraded');
    if (labelEl) labelEl.textContent = _t('status.unstableNetwork');
  } else {
    if (labelEl) labelEl.textContent = _t('status.offline');
  }
}

// ── Send ──
async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

  // E2EE: encrypt with Double Ratchet if key exchange is complete
  if (ephDrState && keyExchangeComplete) {
    try {
      const packet = await drEncryptText(ephDrState, text, {
        deviceId: sessionState.guest_device_id,
        version: 1
      });
      ws.send(JSON.stringify({
        type: 'ephemeral-message',
        conversationId: sessionState.conversation_id,
        header: packet.header,
        iv_b64: packet.iv_b64,
        ciphertext_b64: packet.ciphertext_b64,
        ts: Date.now()
      }));
    } catch (err) {
      console.error('[EphE2EE] encrypt failed', err);
      addSystemMessage('Encryption failed: ' + (err.message || ''));
      return;
    }
  } else {
    // Key exchange not yet complete — queue or reject
    addSystemMessage(_t('ephemeral.waitingEncryption') || 'Waiting for encryption setup...');
    return;
  }

  addMessage(text, 'outgoing', Date.now());
  inputEl.value = '';
  sendBtn.disabled = true;
}

sendBtn?.addEventListener('click', sendMessage);
inputEl?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
inputEl?.addEventListener('input', () => {
  sendBtn.disabled = !inputEl.value.trim();
});

// ── WebSocket ──
let wsReconnectAttempts = 0;
const WS_RECONNECT_BASE = 2000;
const WS_RECONNECT_MAX = 30000;

function connectWs() {
  if (!sessionState?.ws_token) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${proto}//${location.host}/api/ws?token=${encodeURIComponent(sessionState.ws_token)}&deviceId=${encodeURIComponent(sessionState.guest_device_id)}`;
  ws = new WebSocket(wsUrl);
  updateWsStatus('connecting');

  ws.onopen = () => {
    wsReconnectAttempts = 0; // Reset backoff on successful open
    ws.send(JSON.stringify({
      type: 'auth',
      accountDigest: sessionState.guest_digest,
      token: sessionState.ws_token
    }));

    // Send key exchange once WS is connected
    if (ephDrState && !keyExchangeComplete) {
      sendKeyExchange();
    }
  };

  ws.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      handleWsMessage(msg);
    } catch { /* ignore non-JSON */ }
  };

  ws.onclose = () => {
    updateWsStatus('offline');
    if (!destroyed) {
      scheduleReconnect();
    }
  };

  ws.onerror = () => {
    updateWsStatus('offline');
  };
}

function scheduleReconnect() {
  const backoff = Math.min(WS_RECONNECT_BASE * Math.pow(2, wsReconnectAttempts), WS_RECONNECT_MAX);
  const jitter = Math.floor(Math.random() * backoff * 0.3);
  wsReconnectAttempts++;
  setTimeout(async () => {
    if (destroyed) return;
    const ok = await refreshWsToken();
    if (!ok) {
      // Token refresh failed (session expired) — stop reconnecting
      updateWsStatus('offline');
      addSystemMessage(_t('ephemeral.sessionExpiredWs'));
      return;
    }
    connectWs();
  }, backoff + jitter);
}

async function refreshWsToken() {
  try {
    const data = await ephemeralWsToken({
      sessionId: sessionState.session_id,
      guestDigest: sessionState.guest_digest
    });
    sessionState.ws_token = data.token;
    return true;
  } catch {
    return false; // session expired or network failure
  }
}

// ── E2EE: Send key exchange to owner ──
function sendKeyExchange() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !sessionState?._guestBundlePub || !ephDrState) return;
  ws.send(JSON.stringify({
    type: 'ephemeral-key-exchange',
    sessionId: sessionState.session_id,
    conversationId: sessionState.conversation_id,
    guestBundle: {
      ik_pub: sessionState._guestBundlePub.ik_pub,
      spk_pub: sessionState._guestBundlePub.spk_pub,
      spk_sig: sessionState._guestBundlePub.spk_sig,
      ek_pub: b64(ephDrState.myRatchetPub),
      opk_id: sessionState._usedOpkId
    }
  }));
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'ephemeral-message':
      if (msg.conversationId === sessionState.conversation_id) {
        // E2EE: decrypt with Double Ratchet
        if (ephDrState && msg.header && msg.ciphertext_b64) {
          drDecryptText(ephDrState, {
            header: msg.header,
            iv_b64: msg.iv_b64,
            ciphertext_b64: msg.ciphertext_b64
          }).then(plaintext => {
            addMessage(plaintext, 'incoming', msg.ts);
          }).catch(err => {
            console.error('[EphE2EE] decrypt failed', err);
            addSystemMessage('Decryption failed');
          });
        }
      }
      break;
    case 'ephemeral-key-exchange-ack':
      if (msg.sessionId === sessionState.session_id) {
        keyExchangeComplete = true;
        addSystemMessage(_t('ephemeral.e2eEstablished'));
        console.log('[EphE2EE] key exchange complete, encryption ready');
      }
      break;
    case 'ephemeral-extended':
      if (msg.sessionId === sessionState.session_id || msg.conversationId === sessionState.conversation_id) {
        sessionState.expires_at = msg.expiresAt;
        updateTimer();
        addSystemMessage(_t('ephemeral.extendedTenMin'));
      }
      break;
    case 'ephemeral-deleted':
      if (msg.sessionId === sessionState.session_id || msg.conversationId === sessionState.conversation_id) {
        destroyChat();
      }
      break;
    case 'call-answer':
    case 'call-accept':
    case 'call-reject':
    case 'call-busy':
    case 'call-ice-candidate':
    case 'call-end':
      handleCallSignal(msg);
      break;
    case 'hello':
      updateWsStatus('online');
      break;
    case 'auth':
      if (msg.ok) updateWsStatus('online');
      else {
        console.warn('[Ephemeral WS] auth rejected:', msg.reason);
        updateWsStatus('offline');
      }
      break;
    case 'pong':
      break;
    case 'ping':
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'pong' }));
      break;
  }
}

// ── Call System ──
let callState = null; // { callId, mode, pc, localStream, muted, camOff, timerStart, timerInterval }
const STUN_SERVERS = [{ urls: 'stun:stun.cloudflare.com:3478' }];

function enableCallButtons() {
  if (voiceCallBtn) voiceCallBtn.disabled = false;
  if (videoCallBtn) videoCallBtn.disabled = false;
}

function generateCallId() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

function wsSendJSON(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

async function handleCall(mode) {
  if (!sessionState || destroyed || callState) return;
  const callId = generateCallId();

  // Show call overlay immediately
  showCallOverlay(mode, _t('ephemeral.callDialing') || 'Dialing…');

  try {
    // Request media
    const constraints = { audio: true, video: mode === 'video' };
    const stream = await navigator.mediaDevices.getUserMedia(constraints).catch(err => {
      if (mode === 'video') return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      throw err;
    });

    // Show local preview for video
    if (stream.getVideoTracks().length > 0 && localVideo) {
      localVideo.srcObject = stream;
      localVideo.classList.add('visible');
      if (camToggleBtn) camToggleBtn.style.display = '';
    }

    // Create peer connection
    const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS, bundlePolicy: 'max-bundle' });

    callState = { callId, mode, pc, localStream: stream, muted: false, camOff: false, timerStart: null, timerInterval: null };

    // Add local tracks
    for (const track of stream.getTracks()) {
      pc.addTrack(track, stream);
    }

    // Handle remote tracks
    pc.ontrack = (evt) => {
      if (remoteVideo && evt.streams[0]) {
        remoteVideo.srcObject = evt.streams[0];
        if (evt.track.kind === 'video') remoteVideo.classList.add('visible');
      }
    };

    // ICE candidates — send to peer
    pc.onicecandidate = (evt) => {
      if (evt.candidate) {
        wsSendJSON({
          type: 'call-ice-candidate',
          callId,
          targetAccountDigest: sessionState.owner_digest,
          candidate: evt.candidate.toJSON()
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        updateCallStatus(_t('ephemeral.callConnected') || 'Connected');
        startCallTimer();
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        endCall();
      }
    };

    // Create and send offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Send call invite + offer to owner
    wsSendJSON({
      type: 'call-invite',
      callId,
      targetAccountDigest: sessionState.owner_digest,
      senderDeviceId: sessionState.guest_device_id,
      mode,
      conversationId: sessionState.conversation_id,
      metadata: { displayName: _t('ephemeral.guestLabel', { id: sessionState.guest_device_id.slice(-4) }) || 'Guest' }
    });
    wsSendJSON({
      type: 'call-offer',
      callId,
      targetAccountDigest: sessionState.owner_digest,
      senderDeviceId: sessionState.guest_device_id,
      description: pc.localDescription.toJSON()
    });
  } catch (err) {
    console.error('[EphCall] failed to start call', err);
    hideCallOverlay();
    callState = null;
    addSystemMessage(_t('ephemeral.callFailed') || 'Call failed: ' + (err.message || ''));
  }
}

function handleCallSignal(msg) {
  if (!callState || msg.callId !== callState.callId) return;
  const { pc } = callState;

  switch (msg.type) {
    case 'call-answer':
      if (msg.description) {
        pc.setRemoteDescription(new RTCSessionDescription(msg.description)).catch(console.error);
      }
      break;
    case 'call-ice-candidate':
      if (msg.candidate) {
        pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(console.error);
      }
      break;
    case 'call-accept':
      updateCallStatus(_t('ephemeral.callConnecting') || 'Connecting…');
      break;
    case 'call-reject':
    case 'call-busy':
      updateCallStatus(msg.type === 'call-busy'
        ? (_t('ephemeral.callBusy') || 'User is busy')
        : (_t('ephemeral.callRejected') || 'Call declined'));
      setTimeout(endCall, 1500);
      break;
    case 'call-end':
      endCall(true);
      break;
  }
}

function endCall(fromRemote) {
  if (!callState) return;
  const { pc, localStream, callId, timerInterval: ti } = callState;
  // Notify peer (only if we initiated the hangup)
  if (!fromRemote) {
    wsSendJSON({ type: 'call-end', callId, targetAccountDigest: sessionState?.owner_digest });
  }
  // Cleanup
  if (ti) clearInterval(ti);
  for (const track of localStream?.getTracks() || []) track.stop();
  pc?.close();
  if (remoteVideo) { remoteVideo.srcObject = null; remoteVideo.classList.remove('visible'); }
  if (localVideo) { localVideo.srcObject = null; localVideo.classList.remove('visible'); }
  callState = null;
  hideCallOverlay();
  addSystemMessage(_t('ephemeral.callEnded') || 'Call ended');
}

function showCallOverlay(mode, status) {
  if (callModeIcon) callModeIcon.textContent = mode === 'video' ? '📹' : '📞';
  updateCallStatus(status);
  if (callTimerEl) callTimerEl.textContent = '';
  if (callOverlay) callOverlay.classList.add('active');
  if (muteBtn) muteBtn.classList.remove('active');
  if (camToggleBtn) { camToggleBtn.classList.remove('active'); camToggleBtn.style.display = mode === 'video' ? '' : 'none'; }
}

function hideCallOverlay() {
  if (callOverlay) callOverlay.classList.remove('active');
}

function updateCallStatus(text) {
  if (callStatusEl) callStatusEl.textContent = text;
}

function startCallTimer() {
  if (!callState) return;
  callState.timerStart = Date.now();
  callState.timerInterval = setInterval(() => {
    if (!callState) return;
    const elapsed = Math.floor((Date.now() - callState.timerStart) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    if (callTimerEl) callTimerEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }, 1000);
}

// Mute toggle
muteBtn?.addEventListener('click', () => {
  if (!callState?.localStream) return;
  callState.muted = !callState.muted;
  for (const t of callState.localStream.getAudioTracks()) t.enabled = !callState.muted;
  muteBtn.classList.toggle('active', callState.muted);
});

// Camera toggle
camToggleBtn?.addEventListener('click', () => {
  if (!callState?.localStream) return;
  callState.camOff = !callState.camOff;
  for (const t of callState.localStream.getVideoTracks()) t.enabled = !callState.camOff;
  camToggleBtn.classList.toggle('active', callState.camOff);
});

// Hangup
hangupBtn?.addEventListener('click', endCall);

// Button click handlers
if (voiceCallBtn) voiceCallBtn.addEventListener('click', () => handleCall('voice'));
if (videoCallBtn) videoCallBtn.addEventListener('click', () => handleCall('video'));

// ── Destroy ──
function destroyChat() {
  if (destroyed) return;
  destroyed = true;
  if (timerInterval) clearInterval(timerInterval);
  if (ws) { try { ws.close(); } catch {} }
  chatUI.style.display = 'none';
  destroyedEl.classList.add('active');
  // Clear all state including crypto
  sessionState = null;
  ephDrState = null;
  keyExchangeComplete = false;
  sessionStorage.clear();
}

// ── Boot ──
async function boot() {
  // Token can come from: /e/{token} path, #hash, or ?t= query param
  const pathMatch = location.pathname.match(/\/e\/([A-Za-z0-9_-]+)/);
  const hash = location.hash ? location.hash.slice(1) : '';
  const token = (pathMatch && pathMatch[1]) || hash || new URLSearchParams(location.search).get('t');
  if (!token) {
    showError(_t('ephemeral.invalidLinkMissingToken'));
    return;
  }

  // Load async i18n (non-blocking; bootstrap __t already covers first paint)
  initI18n().catch(() => {});

  try {
    setProgress(20, _t('ephemeral.verifyingLink'));
    await sleep(400);

    setProgress(40, _t('ephemeral.generatingTempKey'));

    // Initialize crypto library
    await loadNacl();

    const data = await ephemeralConsume({ token });
    sessionState = data;

    setProgress(60, _t('ephemeral.exchangingProtocol'));

    // ── E2EE: X3DH key exchange ──
    const ownerBundle = data.prekey_bundle;
    if (ownerBundle && ownerBundle.ik_pub && ownerBundle.spk_pub && ownerBundle.spk_sig && ownerBundle.opks?.length) {
      // Owner provided a valid prekey bundle — perform X3DH
      const { devicePriv: guestPriv, bundlePub: guestBundlePub } = await generateInitialBundle(1, 1);

      const ownerBundleWithOpk = {
        ik_pub: ownerBundle.ik_pub,
        spk_pub: ownerBundle.spk_pub,
        spk_sig: ownerBundle.spk_sig,
        opk: ownerBundle.opks[0]
      };

      ephDrState = await x3dhInitiate(guestPriv, ownerBundleWithOpk);

      // Store guest bundle info for sending key-exchange after WS connects
      sessionState._guestBundlePub = guestBundlePub;
      sessionState._usedOpkId = ownerBundleWithOpk.opk.id;
    } else {
      console.warn('[EphE2EE] Owner bundle missing or incomplete, E2EE unavailable');
    }

    setProgress(80, _t('ephemeral.establishingChannel'));
    await sleep(300);

    setProgress(100, _t('ephemeral.connectionComplete'));
    await sleep(400);

    // Transition to chat
    hideSplash();
    chatUI.classList.add('active');
    initParticles();
    startTimer();
    connectWs();
    enableCallButtons();

  } catch (err) {
    const msg = err.status === 404
      ? _t('ephemeral.linkExpiredOrUsed')
      : err.status === 410
        ? _t('ephemeral.linkExpired')
        : _t('ephemeral.connectionFailed', { error: err.message || '' });
    showError(msg);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

boot();
