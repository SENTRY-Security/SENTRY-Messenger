// /app/ui/ephemeral-ui.js
// Guest-side ephemeral chat controller.
// Consumes a one-time link token, establishes WS connection, handles timer + messaging.

import { ephemeralConsume, ephemeralExtend, ephemeralWsToken } from '../api/ephemeral.js';
import { initI18n, t } from '/locales/index.js';

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

// ── Send ──
function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    type: 'ephemeral-message',
    conversationId: sessionState.conversation_id,
    text,
    ts: Date.now()
  }));
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
function connectWs() {
  if (!sessionState?.ws_token) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${proto}//${location.host}/api/ws?token=${encodeURIComponent(sessionState.ws_token)}&deviceId=${encodeURIComponent(sessionState.guest_device_id)}`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'auth',
      accountDigest: sessionState.guest_digest,
      token: sessionState.ws_token
    }));
  };

  ws.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      handleWsMessage(msg);
    } catch { /* ignore non-JSON */ }
  };

  ws.onclose = () => {
    if (!destroyed) {
      // Reconnect after delay
      setTimeout(() => {
        refreshWsToken().then(connectWs).catch(() => {});
      }, 3000);
    }
  };

  ws.onerror = () => { /* onclose will handle reconnect */ };
}

async function refreshWsToken() {
  try {
    const data = await ephemeralWsToken({
      sessionId: sessionState.session_id,
      guestDigest: sessionState.guest_digest
    });
    sessionState.ws_token = data.token;
  } catch { /* session may be expired */ }
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'ephemeral-message':
      if (msg.conversationId === sessionState.conversation_id) {
        addMessage(msg.text, 'incoming', msg.ts);
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
    case 'hello':
    case 'pong':
      break;
    case 'ping':
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'pong' }));
      break;
  }
}

// ── Destroy ──
function destroyChat() {
  if (destroyed) return;
  destroyed = true;
  if (timerInterval) clearInterval(timerInterval);
  if (ws) { try { ws.close(); } catch {} }
  chatUI.style.display = 'none';
  destroyedEl.classList.add('active');
  // Clear session data
  sessionState = null;
  sessionStorage.clear();
}

// ── Boot ──
async function boot() {
  const hash = location.hash ? location.hash.slice(1) : '';
  const token = hash || new URLSearchParams(location.search).get('t');
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
    await sleep(300);

    setProgress(60, _t('ephemeral.exchangingProtocol'));
    const data = await ephemeralConsume({ token });
    sessionState = data;

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
