// /app/ui/ephemeral-ui.js
// Guest-side ephemeral chat controller.
// Consumes a one-time link token, establishes E2EE via X3DH + Double Ratchet,
// then handles timer + encrypted messaging.

import { ephemeralConsume, ephemeralExtend, ephemeralWsToken, ephemeralKeyExchangeSubmit } from '../api/ephemeral.js';
import { initI18n, t } from '/locales/index.js';
import { generateInitialBundle } from '../../shared/crypto/prekeys.js';
import { x3dhInitiate, drEncryptText, drDecryptText } from '../../shared/crypto/dr.js';
import { loadNacl, b64 } from '../../shared/crypto/nacl.js';
import { setDeviceId, setAccountDigest } from '../core/store.js';
import {
  activateEphemeralCallMode,
  deactivateEphemeralCallMode,
  handleEphemeralCallMessage,
  initiateEphemeralCall,
  isEphemeralCallMode,
  deriveCallTokenFromDR,
  setCallTokenGate
} from '../features/calls/ephemeral-call-adapter.js';
import { setContactSecret } from '../core/contact-secrets.js';
import { bytesToB64Url } from '../../shared/utils/base64.js';
import { initCallOverlay } from './mobile/call-overlay.js';
import {
  initCallMediaSession,
  sendCallSignal,
  initCallKeyManager,
  showCallInfoOverlay
} from '../features/calls/index.js';

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
let guestNickname = '';        // temporary display name chosen by guest
let peerPresent = true;        // whether the remote peer is in foreground

// ── E2EE State (memory-only) ──
let ephDrState = null;         // Double Ratchet session state
let keyExchangeComplete = false; // true after owner sends ack
let _callTokenPromise = null;  // resolves when call token is stored

// ── Pre-cached media stream from gesture unlock ──
let _cachedMediaStream = null;

// ── WebRTC support detection ──
let _webrtcSupported = true; // assume true until checked

// ── DOM refs ──
const splash = document.getElementById('ephSplash');
const progressBar = document.getElementById('ephProgressBar');
const splashStatus = document.getElementById('ephSplashStatus');
const splashError = document.getElementById('ephSplashError');
const chatUI = document.getElementById('ephChat');
const timerClock = document.getElementById('ephTimerClock');
const timerFill = document.getElementById('ephTimerFill');
const timerFire = document.getElementById('ephTimerFire');
const timerLabel = document.getElementById('ephTimerLabel');
const extendBtn = document.getElementById('ephExtendBtn');
let timerTotalDuration = 0; // captured at timer start
const messagesEl = document.getElementById('ephMessages');
const inputEl = document.getElementById('ephInput');
const sendBtn = document.getElementById('ephSendBtn');
const destroyedEl = document.getElementById('ephDestroyed');
const particlesEl = document.getElementById('ephParticles');
const attachBtn = document.getElementById('ephAttachBtn');
const fileInput = document.getElementById('ephFileInput');
const voiceCallBtn = document.getElementById('ephVoiceCallBtn');
const videoCallBtn = document.getElementById('ephVideoCallBtn');
// Old call overlay DOM refs removed — call-overlay.js creates its own DOM elements
const wsStatusEl = document.getElementById('ephWsStatus');
const nicknameScreen = document.getElementById('ephNickname');
const nicknameInput = document.getElementById('ephNicknameInput');
const nicknameBtn = document.getElementById('ephNicknameBtn');
const endBtn = document.getElementById('ephEndBtn');
const guestEndModal = document.getElementById('ephGuestEndModal');
const guestEndBackdrop = document.getElementById('ephGuestEndBackdrop');
const guestEndCancel = document.getElementById('ephGuestEndCancel');
const guestEndConfirm = document.getElementById('ephGuestEndConfirm');
const webrtcWarningEl = document.getElementById('ephWebrtcWarning');
const splashWebrtcWarnEl = document.getElementById('ephSplashWebrtcWarn');

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
  const now = Math.floor(Date.now() / 1000);
  timerTotalDuration = sessionState.expires_at - now;
  if (timerTotalDuration <= 0) timerTotalDuration = 600;
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

  // Progress bar: elapsed percentage (0% = just started, 100% = time's up)
  const elapsed = Math.max(0, Math.min(100, (1 - remaining / timerTotalDuration) * 100));
  if (timerFill) {
    timerFill.style.width = elapsed + '%';
  }
  if (timerFire) {
    timerFire.style.left = elapsed + '%';
  }
  // Clock turns red when <20% remaining (fire past 80% mark)
  timerClock.className = 'eph-timer-clock' + (elapsed >= 80 ? ' red' : '');

  // Extend button: always visible, enabled when ≤5min remaining
  if (remaining <= 300) {
    extendBtn.classList.add('active');
    extendBtn.disabled = false;
  } else {
    extendBtn.classList.remove('active');
    extendBtn.disabled = true;
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
    // Recalculate total duration so progress bar resets properly
    const nowExt = Math.floor(Date.now() / 1000);
    timerTotalDuration = sessionState.expires_at - nowExt;
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

function addImageMessage(dataUrl, direction, ts, name) {
  const div = document.createElement('div');
  div.className = 'eph-msg ' + direction;
  const timeStr = ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const img = document.createElement('img');
  img.src = dataUrl;
  img.alt = name || 'Image';
  img.className = 'eph-inline-img';
  img.addEventListener('click', () => openImageFullscreen(dataUrl));
  div.appendChild(img);
  if (timeStr) {
    const t = document.createElement('div');
    t.className = 'msg-time';
    t.textContent = timeStr;
    div.appendChild(t);
  }
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function openImageFullscreen(url) {
  const overlay = document.createElement('div');
  overlay.className = 'eph-image-fullscreen';
  const img = document.createElement('img');
  img.src = url;
  overlay.appendChild(img);
  overlay.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
}

async function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const MAX = 1024;
      let w = img.width, h = img.height;
      if (w > MAX || h > MAX) {
        const s = MAX / Math.max(w, h);
        w = Math.round(w * s); h = Math.round(h * s);
      }
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => { URL.revokeObjectURL(img.src); reject(new Error('image load failed')); };
    img.src = URL.createObjectURL(file);
  });
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
  console.log('[EphE2EE] sendMessage state:', { hasDrState: !!ephDrState, keyExchangeComplete, wsOpen: ws?.readyState === WebSocket.OPEN });
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
    // Re-trigger key exchange in case it was lost
    if (ephDrState && !keyExchangeComplete) sendKeyExchange();
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
    console.log('[EphE2EE] WS open, state:', { hasDrState: !!ephDrState, keyExchangeComplete });
    if (ephDrState && !keyExchangeComplete) {
      sendKeyExchange();
    }
  };

  ws.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      console.log('[EphWS] recv', msg?.type, msg?.sessionId ? msg.sessionId.slice(0, 8) + '...' : '');
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
      // Token refresh failed (session expired/deleted) — show cleanup screen
      destroyChat({ reason: 'owner-terminated' });
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
let keyExchangeRetryTimer = null;
const KEY_EXCHANGE_RETRY_INTERVALS = [2000, 4000, 8000, 15000, 30000]; // progressive retry
let keyExchangeRetryCount = 0;
let httpFallbackSent = false;

function _buildGuestBundle() {
  if (!sessionState?._guestBundlePub || !ephDrState) return null;
  return {
    ik_pub: sessionState._guestBundlePub.ik_pub,
    spk_pub: sessionState._guestBundlePub.spk_pub,
    spk_sig: sessionState._guestBundlePub.spk_sig,
    ek_pub: b64(ephDrState.myRatchetPub),
    opk_id: sessionState._usedOpkId
  };
}

function sendKeyExchange() {
  const bundle = _buildGuestBundle();
  if (!bundle) return;
  console.log('[EphE2EE] sending key-exchange, attempt', keyExchangeRetryCount);
  // Always try WS path
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'ephemeral-key-exchange',
      sessionId: sessionState.session_id,
      conversationId: sessionState.conversation_id,
      targetDigest: sessionState.owner_digest,
      guestBundle: bundle
    }));
  }
  // After 2 failed WS attempts, also try HTTP fallback (persists in D1)
  if (keyExchangeRetryCount >= 2 && !httpFallbackSent) {
    httpFallbackSent = true;
    console.log('[EphE2EE] WS key-exchange not acked, trying HTTP fallback');
    ephemeralKeyExchangeSubmit({
      sessionId: sessionState.session_id,
      guestDigest: sessionState.guest_digest,
      guestBundle: bundle
    }).then(() => {
      console.log('[EphE2EE] HTTP key-exchange submitted successfully');
    }).catch(err => {
      console.warn('[EphE2EE] HTTP key-exchange submit failed:', err?.message);
      httpFallbackSent = false; // allow retry
    });
  }
  scheduleKeyExchangeRetry();
}

function scheduleKeyExchangeRetry() {
  if (keyExchangeRetryTimer) clearTimeout(keyExchangeRetryTimer);
  if (keyExchangeComplete || destroyed) return;
  const delay = KEY_EXCHANGE_RETRY_INTERVALS[Math.min(keyExchangeRetryCount, KEY_EXCHANGE_RETRY_INTERVALS.length - 1)];
  keyExchangeRetryCount++;
  keyExchangeRetryTimer = setTimeout(() => {
    if (keyExchangeComplete || destroyed) return;
    console.log('[EphE2EE] key-exchange ack not received, retrying...');
    sendKeyExchange();
  }, delay);
}

function cancelKeyExchangeRetry() {
  if (keyExchangeRetryTimer) { clearTimeout(keyExchangeRetryTimer); keyExchangeRetryTimer = null; }
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
            // Handle control messages and special types
            try {
              if (plaintext[0] === '{') {
                const parsed = JSON.parse(plaintext);
                if (parsed._ctrl === 'peer-away') { _handlePeerPresence(false); return; }
                if (parsed._ctrl === 'peer-back') { _handlePeerPresence(true); return; }
                if (parsed._ctrl) return; // other control messages (e.g. nickname)
                if (parsed._type === 'image' && parsed.data) {
                  addImageMessage(parsed.data, 'incoming', msg.ts, parsed.name);
                  return;
                }
              }
            } catch {}
            addMessage(plaintext, 'incoming', msg.ts);
          }).catch(err => {
            console.error('[EphE2EE] decrypt failed', err);
            addSystemMessage('Decryption failed');
          });
        }
      }
      break;
    case 'ephemeral-key-exchange-ack':
      console.log('[EphE2EE] received ack', { msgSession: msg.sessionId?.slice(0, 8), mySession: sessionState.session_id?.slice(0, 8), match: msg.sessionId === sessionState.session_id, alreadyComplete: keyExchangeComplete });
      if (msg.sessionId === sessionState.session_id && !keyExchangeComplete) {
        keyExchangeComplete = true;
        cancelKeyExchangeRetry();
        addSystemMessage(_t('ephemeral.e2eEstablished'));
        console.log('[EphE2EE] key exchange complete, encryption ready');
        // Derive call token from DR root key and store for call E2EE.
        // Must complete BEFORE any call can be accepted/initiated —
        // without the token, key derivation fails → encrypted audio
        // cannot be decrypted → both sides hear noise.
        if (ephDrState?.rk && sessionState?.owner_digest) {
          _callTokenPromise = deriveCallTokenFromDR(ephDrState.rk).then(tokenBytes => {
            const token = bytesToB64Url(tokenBytes);
            setContactSecret(sessionState.owner_digest, {
              conversation: { token },
              peerDeviceId: 'owner-device',
              __debugSource: 'ephemeral-call-token-guest'
            });
            console.log('[EphE2EE] call token stored for owner');
          }).catch(err => console.warn('[EphE2EE] call token derive failed:', err?.message));
          // Gate incoming call signals until token is stored
          setCallTokenGate(_callTokenPromise);
        }
        // Send nickname via encrypted control message
        if (guestNickname) _sendNicknameControl();
        // Notify owner if WebRTC is not supported
        if (!_webrtcSupported) _sendNoWebrtcControl();
      }
      break;
    case 'ephemeral-extended':
      if (msg.sessionId === sessionState.session_id || msg.conversationId === sessionState.conversation_id) {
        sessionState.expires_at = msg.expiresAt;
        const nowUpd = Math.floor(Date.now() / 1000);
        timerTotalDuration = sessionState.expires_at - nowUpd;
        updateTimer();
        addSystemMessage(_t('ephemeral.extendedTenMin'));
      }
      break;
    case 'ephemeral-deleted':
      if (msg.sessionId === sessionState.session_id || msg.conversationId === sessionState.conversation_id) {
        destroyChat({ reason: 'owner-terminated' });
      }
      break;
    case 'hello':
      updateWsStatus('online');
      break;
    case 'auth':
      if (msg.ok) {
        updateWsStatus('online');
        // Trigger key exchange on auth success (belt-and-suspenders with onopen)
        if (ephDrState && !keyExchangeComplete) {
          console.log('[EphE2EE] auth confirmed, triggering key exchange');
          sendKeyExchange();
        }
      } else {
        console.warn('[Ephemeral WS] auth rejected:', msg.reason);
        updateWsStatus('offline');
      }
      break;
    case 'pong':
      break;
    case 'buffered-messages-start':
      console.log('[EphWS] receiving buffered messages...');
      break;
    case 'buffered-messages-end':
      console.log('[EphWS] buffered messages done, count:', msg.count);
      break;
    case 'ephemeral-peer-reconnected':
      if (msg.conversationId === sessionState?.conversation_id) {
        _handlePeerPresence(true);
      }
      break;
    case 'ephemeral-peer-disconnected':
      if (msg.conversationId === sessionState?.conversation_id) {
        _handlePeerPresence(false);
      }
      break;
    case 'ping':
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'pong' }));
      break;
    default:
      // Route any ephemeral-call-* message through the adapter (prefix filter
      // instead of explicit list so new signal types — e.g. ephemeral-call-rekey,
      // ephemeral-call-media-update — don't need to be enumerated here).
      if (typeof msg?.type === 'string' && msg.type.startsWith('ephemeral-call-')) {
        handleEphemeralCallMessage(msg);
      }
      break;
  }
}

// ── Call System (now powered by standard call pipeline via ephemeral-call-adapter) ──

function enableCallButtons() {
  if (voiceCallBtn) voiceCallBtn.disabled = false;
  if (videoCallBtn) videoCallBtn.disabled = false;
}

function _disableCallButtonsPermanently() {
  if (voiceCallBtn) {
    voiceCallBtn.disabled = true;
    voiceCallBtn.title = _t('ephemeral.webrtcCallsDisabled');
  }
  if (videoCallBtn) {
    videoCallBtn.disabled = true;
    videoCallBtn.title = _t('ephemeral.webrtcCallsDisabled');
  }
}

/** Send a control message to owner informing WebRTC is unavailable. */
function _sendNoWebrtcControl() {
  if (!ephDrState || _webrtcSupported) return;
  const controlMsg = JSON.stringify({ _ctrl: 'no-webrtc' });
  drEncryptText(ephDrState, controlMsg, { deviceId: sessionState?.guest_device_id || '', version: 1 })
    .then(packet => {
      wsSendJSON({
        type: 'ephemeral-message',
        conversationId: sessionState.conversation_id,
        header: packet.header,
        iv_b64: packet.iv_b64,
        ciphertext_b64: packet.ciphertext_b64,
        ts: Date.now()
      });
      console.log('[Eph] no-webrtc control message sent');
    })
    .catch(err => console.warn('[Eph] failed to send no-webrtc control', err?.message));
}

function wsSendJSON(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// Old inline call functions removed — now powered by standard call pipeline via ephemeral-call-adapter

// Button click handlers — use adapter for calls
if (voiceCallBtn) voiceCallBtn.addEventListener('click', () => {
  if (isEphemeralCallMode()) initiateEphemeralCall({ mode: 'voice' });
});
if (videoCallBtn) videoCallBtn.addEventListener('click', () => {
  if (isEphemeralCallMode()) initiateEphemeralCall({ mode: 'video' });
});
const callInfoBtn = document.getElementById('ephCallInfoBtn');
if (callInfoBtn) callInfoBtn.addEventListener('click', () => showCallInfoOverlay());

// Image attach
if (attachBtn) attachBtn.addEventListener('click', () => fileInput?.click());
if (fileInput) fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    addSystemMessage(_t('ephemeral.onlyImagesAllowed') || 'Only images are supported');
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    addSystemMessage(_t('ephemeral.imageTooLarge') || 'Image must be under 5 MB');
    return;
  }
  if (!ephDrState || !keyExchangeComplete) {
    addSystemMessage(_t('ephemeral.encryptionNotReady') || 'Encryption not ready');
    return;
  }
  try {
    const dataUrl = await compressImage(file);
    const payload = JSON.stringify({ _type: 'image', data: dataUrl, name: file.name || 'image.jpg' });
    const packet = await drEncryptText(ephDrState, payload, {
      deviceId: sessionState.guest_device_id,
      version: 1
    });
    wsSendJSON({
      type: 'ephemeral-message',
      conversationId: sessionState.conversation_id,
      header: packet.header,
      iv_b64: packet.iv_b64,
      ciphertext_b64: packet.ciphertext_b64,
      ts: Date.now()
    });
    addImageMessage(dataUrl, 'outgoing', Date.now(), file.name);
  } catch (err) {
    console.error('[EphImage] send failed', err);
    addSystemMessage(_t('messages.sendFailed') || 'Failed to send image');
  }
});

// ── End conversation (guest-initiated) ──
endBtn?.addEventListener('click', () => {
  if (guestEndModal) guestEndModal.classList.add('active');
});
guestEndBackdrop?.addEventListener('click', () => {
  if (guestEndModal) guestEndModal.classList.remove('active');
});
guestEndCancel?.addEventListener('click', () => {
  if (guestEndModal) guestEndModal.classList.remove('active');
});
guestEndConfirm?.addEventListener('click', () => {
  if (guestEndModal) guestEndModal.classList.remove('active');
  destroyChat({ reason: 'guest-terminated' });
});

// ── Destroy ──
function destroyChat({ reason } = {}) {
  if (destroyed) return;
  destroyed = true;
  cancelKeyExchangeRetry();
  // End any active call
  deactivateEphemeralCallMode();
  if (timerInterval) clearInterval(timerInterval);
  // Notify owner when guest ends the conversation
  if (reason === 'guest-terminated' && ws?.readyState === WebSocket.OPEN && sessionState) {
    try { ws.send(JSON.stringify({ type: 'ephemeral-guest-leave', sessionId: sessionState.session_id, conversationId: sessionState.conversation_id })); } catch {}
  }
  if (ws) { try { ws.close(); } catch {} }
  chatUI.style.display = 'none';
  // Show termination reason if owner terminated the session
  if (reason === 'owner-terminated') {
    const titleEl = destroyedEl.querySelector('.destroy-title');
    const subEl = destroyedEl.querySelector('.destroy-sub');
    if (titleEl) titleEl.textContent = _t('ephemeral.terminatedTitle');
    if (subEl) subEl.textContent = _t('ephemeral.terminatedSub');
  }
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

  // Wait for user interaction before consuming the token.
  // Link preview crawlers (Instagram, Facebook, etc.) may execute JS and
  // auto-consume the one-time token before the real user clicks.
  const startBtn = document.getElementById('ephStartBtn');
  const progressTrack = document.getElementById('ephProgressTrack');
  const statusEl = document.getElementById('ephSplashStatus');
  if (startBtn) {
    await new Promise(resolve => {
      startBtn.addEventListener('click', () => {
        startBtn.style.display = 'none';
        if (progressTrack) progressTrack.style.display = '';
        if (statusEl) statusEl.style.display = '';
        resolve();
      }, { once: true });
    });
  }

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
    console.log('[EphE2EE] ownerBundle received:', {
      hasBundle: !!ownerBundle,
      ik_pub: !!ownerBundle?.ik_pub,
      spk_pub: !!ownerBundle?.spk_pub,
      spk_sig: !!ownerBundle?.spk_sig,
      opks: ownerBundle?.opks?.length ?? 0,
      bundleType: typeof ownerBundle,
      bundleKeys: ownerBundle ? Object.keys(ownerBundle) : []
    });
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
      console.log('[EphE2EE] x3dhInitiate SUCCESS, ephDrState:', !!ephDrState);

      // Store guest bundle info for sending key-exchange after WS connects
      sessionState._guestBundlePub = guestBundlePub;
      sessionState._usedOpkId = ownerBundleWithOpk.opk.id;
    } else {
      console.error('[EphE2EE] Owner bundle missing or incomplete, E2EE unavailable.',
        'Raw prekey_bundle:', JSON.stringify(ownerBundle).slice(0, 200));
      addSystemMessage(_t('ephemeral.e2eUnavailable') || 'End-to-end encryption unavailable — owner key bundle missing');
    }

    setProgress(80, _t('ephemeral.establishingChannel'));
    await sleep(300);

    setProgress(100, _t('ephemeral.connectionComplete'));
    await sleep(400);

    // Show WebRTC warning on nickname screen (detection already ran before boot)
    if (!_webrtcSupported && webrtcWarningEl) {
      webrtcWarningEl.style.display = 'flex';
    }

    // Show nickname input instead of going directly to chat
    hideSplash();
    if (nicknameScreen) {
      // Pre-fill a random nickname from locale list
      const nicks = _t('ephemeral.randomNicknames');
      if (Array.isArray(nicks) && nicks.length && nicknameInput) {
        nicknameInput.value = nicks[Math.floor(Math.random() * nicks.length)];
      }
      nicknameScreen.style.display = 'flex';
      nicknameInput?.focus();
    } else {
      // Fallback: skip nickname step
      _enterChat();
    }

  } catch (err) {
    const msg = err.status === 404
      ? _t('ephemeral.linkExpiredOrUsed')
      : err.status === 410
        ? _t('ephemeral.linkExpired')
        : _t('ephemeral.connectionFailed', { error: err.message || '' });
    showError(msg);
  }
}

function _enterChat() {
  if (nicknameScreen) nicknameScreen.style.display = 'none';
  chatUI.classList.add('active');
  initParticles();
  startTimer();
  connectWs();

  if (_webrtcSupported) {
    enableCallButtons();
  } else {
    // Keep call buttons disabled and show notice in chat
    _disableCallButtonsPermanently();
    addSystemMessage(_t('ephemeral.webrtcCallsDisabled'));
  }

  _bindVisibilityPresence();

  if (_webrtcSupported) {
    // Gesture-unlock: play a silent-ish click to unlock Web Audio API,
    // then pre-request microphone + camera permissions so call setup is instant.
    _gestureUnlockMedia();
  }

  // Initialize the standard call system for guest use
  _initCallSystem();

  // Show "establishing secure connection" system message (before ack arrives)
  if (ephDrState && !keyExchangeComplete) {
    addSystemMessage(_t('ephemeral.establishingE2e'));
  }
}

/** Initialize the standard call system (overlay, media-session, adapter) for guest side. */
function _initCallSystem() {
  if (!sessionState) return;

  // Set guest identity in store so call modules can use ensureDeviceId()/getAccountDigest()
  setDeviceId(sessionState.guest_device_id);
  setAccountDigest(sessionState.guest_digest);

  // Initialize call overlay UI (injects CSS + creates DOM, subscribes to call events)
  const showToast = (msg) => addSystemMessage(msg);
  initCallOverlay({ showToast });

  // Initialize call media session (subscribes to call signals/state)
  initCallMediaSession({
    sendSignalFn: (type, payload) => sendCallSignal(type, payload),
    showToastFn: showToast
  });

  // Initialize call key manager on guest side too.  Historically skipped to
  // avoid the STATE=ENDED → resetKeyContext path (keyContext used to leak
  // across calls), but that cleanup is now handled explicitly by
  // media-session's releaseCallKeyContextOnCleanup.  Enabling it here wires:
  //   • CALL_EVENT.SIGNAL → maybeDeriveKeys — so incoming call-rekey envelopes
  //     trigger fresh key derivation (required for owner-initiated calls to
  //     survive the 10-minute rotation).
  //   • CALL_EVENT.STATE → startRotationTimer — so guest-initiated calls also
  //     drive rotation, giving forward secrecy in both directions.
  initCallKeyManager();

  // Activate ephemeral call adapter — translates call-* ↔ ephemeral-call-*
  activateEphemeralCallMode({
    conversationId: sessionState.conversation_id,
    sessionId: sessionState.session_id,
    peerDigest: sessionState.owner_digest,
    peerDeviceId: 'owner-device', // Owner's device ID is unknown; will be set from incoming signals
    selfDeviceId: sessionState.guest_device_id,
    wsSend: (msg) => wsSendJSON(msg),
    side: 'guest',
    peerDisplayName: _t('ephemeral.ownerLabel') || 'Owner'
  });
}

/** Play short audio to unlock Web Audio via user gesture, then pre-cache media permissions. */
function _gestureUnlockMedia() {
  // 1) Unlock Web Audio API with a short sound
  try {
    const audio = new Audio('/assets/audio/click.mp3');
    audio.volume = 0.01; // nearly silent
    audio.play().catch(() => {});
  } catch {}
  // 2) Pre-request mic + camera so permissions are cached for call setup
  navigator.mediaDevices?.getUserMedia?.({ audio: true, video: true })
    .then(stream => {
      // Cache the stream reference for first call, stop tracks after a brief moment
      _cachedMediaStream = stream;
      setTimeout(() => {
        if (_cachedMediaStream === stream) {
          for (const t of stream.getTracks()) t.stop();
          _cachedMediaStream = null;
        }
      }, 60_000); // keep alive for 60s to reuse in first call
    })
    .catch(() => {
      // If video denied, try audio-only
      navigator.mediaDevices?.getUserMedia?.({ audio: true, video: false })
        .then(stream => {
          _cachedMediaStream = stream;
          setTimeout(() => {
            if (_cachedMediaStream === stream) {
              for (const t of stream.getTracks()) t.stop();
              _cachedMediaStream = null;
            }
          }, 60_000);
        })
        .catch(() => {}); // both denied — calls will fail gracefully later
    });
}

// ── WebRTC support detection ──
function _detectWebRTCSupport() {
  _webrtcSupported = !!(
    typeof RTCPeerConnection !== 'undefined' &&
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  );
  return _webrtcSupported;
}

// ── Visibility-based presence notifications ──
function _bindVisibilityPresence() {
  document.addEventListener('visibilitychange', () => {
    if (destroyed || !ephDrState || !keyExchangeComplete || !sessionState) return;
    const ctrl = document.hidden ? { _ctrl: 'peer-away' } : { _ctrl: 'peer-back' };
    const payload = JSON.stringify(ctrl);
    drEncryptText(ephDrState, payload, {
      deviceId: sessionState.guest_device_id, version: 1
    }).then(packet => {
      wsSendJSON({
        type: 'ephemeral-message',
        conversationId: sessionState.conversation_id,
        header: packet.header,
        iv_b64: packet.iv_b64,
        ciphertext_b64: packet.ciphertext_b64,
        ts: Date.now()
      });
    }).catch(() => {});
  });
}

function _handlePeerPresence(present) {
  peerPresent = present;
  const text = present
    ? (_t('ephemeral.peerBack') || 'Peer is back')
    : (_t('ephemeral.peerAway') || 'Peer left the screen');
  addSystemMessage(text);
  // Update input placeholder as warning
  if (inputEl) {
    if (!present) {
      inputEl.dataset.origPlaceholder = inputEl.placeholder;
      inputEl.placeholder = _t('ephemeral.peerAwayHint') || 'Peer is away — messages may not be delivered';
    } else {
      inputEl.placeholder = inputEl.dataset.origPlaceholder || _t('ephemeral.inputPlaceholder') || 'Type a message…';
    }
  }
}

function _sendNicknameControl() {
  // Send nickname as an encrypted control message through DR
  if (!ephDrState || !guestNickname) return;
  const controlMsg = JSON.stringify({ _ctrl: 'set-nickname', nickname: guestNickname });
  drEncryptText(ephDrState, controlMsg, { deviceId: sessionState?.guest_device_id || '', version: 1 })
    .then(packet => {
      wsSendJSON({
        type: 'ephemeral-message',
        conversationId: sessionState.conversation_id,
        header: packet.header,
        iv_b64: packet.iv_b64,
        ciphertext_b64: packet.ciphertext_b64,
        ts: Date.now()
      });
      console.log('[EphE2EE] nickname control message sent');
    })
    .catch(err => console.warn('[EphE2EE] failed to send nickname control', err?.message));
}

// Nickname button handler
nicknameBtn?.addEventListener('click', () => {
  guestNickname = (nicknameInput?.value || '').trim();
  if (!guestNickname) {
    nicknameInput?.focus();
    return;
  }
  _enterChat();
});

// Enter key on nickname input
nicknameInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    nicknameBtn?.click();
  }
});

// Auto-select all text when nickname input is focused
nicknameInput?.addEventListener('focus', () => {
  nicknameInput.select();
});

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Detect WebRTC support immediately — before splash loading begins
_detectWebRTCSupport();
if (!_webrtcSupported && splashWebrtcWarnEl) {
  splashWebrtcWarnEl.style.display = 'flex';
}

boot();
