import { log } from '../../core/log.js';
import { cancelCall, acknowledgeCall } from '../../api/calls.js';
import {
  CALL_EVENT,
  CALL_SESSION_STATUS,
  subscribeCallEvent,
  getCallSessionSnapshot,
  sendCallSignal,
  completeCallSession,
  updateCallSessionStatus,
  acceptIncomingCallMedia,
  endCallMediaSession,
  setLocalAudioMuted,
  isLocalAudioMuted,
  setRemoteAudioMuted,
  isRemoteAudioMuted
} from '../../features/calls/index.js';
import { CALL_MEDIA_STATE_STATUS } from '../../../shared/calls/schemas.js';

const STATUS_LABEL = {
  [CALL_SESSION_STATUS.OUTGOING]: '撥號中…',
  [CALL_SESSION_STATUS.INCOMING]: '來電中',
  [CALL_SESSION_STATUS.CONNECTING]: '正在接通…',
  [CALL_SESSION_STATUS.IN_CALL]: '通話中'
};

const MEDIA_STATUS_LABEL = {
  [CALL_MEDIA_STATE_STATUS.KEY_PENDING]: '建立加密金鑰…',
  [CALL_MEDIA_STATE_STATUS.ROTATING]: '加密金鑰輪換中…',
  [CALL_MEDIA_STATE_STATUS.FAILED]: '加密失敗，請稍後再試'
};

const ENCRYPTION_STATUS_LABEL = {
  [CALL_MEDIA_STATE_STATUS.READY]: '端到端加密已啟動',
  [CALL_MEDIA_STATE_STATUS.KEY_PENDING]: '正在建立端到端加密',
  [CALL_MEDIA_STATE_STATUS.ROTATING]: '加密金鑰輪換中…',
  [CALL_MEDIA_STATE_STATUS.FAILED]: '無法保護此通話'
};

function describeStatus(session) {
  if (!session) return '連線中…';
  const mediaStatus = session.mediaState?.status || null;
  if (mediaStatus && MEDIA_STATUS_LABEL[mediaStatus]) {
    return MEDIA_STATUS_LABEL[mediaStatus];
  }
  return STATUS_LABEL[session.status] || '連線中…';
}

function describeSecureStatus(session) {
  if (!session) return '準備端到端加密…';
  const mediaStatus = session.mediaState?.status;
  return ENCRYPTION_STATUS_LABEL[mediaStatus] || '準備端到端加密…';
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function ensureStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('callOverlayStyles')) return;
  const style = document.createElement('style');
  style.id = 'callOverlayStyles';
  style.textContent = `
    .call-overlay {
      position: fixed;
      inset: 0;
      display: flex;
      justify-content: center;
      align-items: flex-end;
      padding: 16px;
      pointer-events: none;
      z-index: 999;
    }
    .call-overlay.hidden { opacity: 0; }
    .call-overlay .call-card {
      width: min(420px, 100%);
      background: rgba(15, 23, 42, 0.92);
      color: #f8fafc;
      border-radius: 20px;
      padding: 20px;
      box-shadow: 0 20px 60px rgba(15, 23, 42, 0.45);
      backdrop-filter: blur(10px);
      pointer-events: auto;
      transform: translateY(12px);
      transition: transform 200ms ease, opacity 200ms ease;
    }
    .call-overlay.hidden .call-card {
      transform: translateY(40px);
      opacity: 0;
    }
    .call-overlay .call-peer {
      display: flex;
      align-items: flex-start;
      gap: 14px;
    }
    .call-overlay .call-avatar {
      width: 60px;
      height: 60px;
      border-radius: 999px;
      background: rgba(255,255,255,0.1);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
      font-weight: 600;
      overflow: hidden;
    }
    .call-overlay .call-avatar img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .call-overlay .call-meta {
      flex: 1;
      min-width: 0;
    }
    .call-overlay .call-meta strong {
      font-size: 18px;
      display: block;
    }
    .call-overlay .call-meta span {
      font-size: 14px;
      color: rgba(248,250,252,0.7);
    }
    .call-overlay .call-timer {
      display: block;
      margin-top: 2px;
      font-size: 13px;
      color: rgba(248,250,252,0.65);
      letter-spacing: 0.04em;
    }
    .call-overlay .call-security {
      margin-top: 12px;
      font-size: 13px;
      color: rgba(248,250,252,0.65);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .call-overlay .call-security .dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: #0ea5e9;
      display: inline-block;
    }
    .call-overlay .call-actions {
      margin-top: 18px;
      display: flex;
      justify-content: center;
      gap: 18px;
    }
    .call-overlay .call-controls {
      margin-top: 22px;
      display: flex;
      gap: 14px;
      justify-content: center;
      flex-wrap: wrap;
    }
    .call-overlay .call-controls.hidden,
    .call-overlay .call-actions.hidden {
      display: none;
    }
    .call-overlay .call-btn {
      min-width: 64px;
      height: 64px;
      border-radius: 999px;
      border: none;
      font-size: 14px;
      color: #fff;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 120ms ease, opacity 120ms ease;
      background: #1e293b;
      padding: 0 18px;
    }
    .call-overlay .call-btn i {
      font-size: 20px;
      margin-right: 6px;
    }
    .call-overlay .call-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .call-overlay .call-btn.accept { background: #0ea5e9; }
    .call-overlay .call-btn.reject { background: #ef4444; }
    .call-overlay .call-btn.cancel { background: #475569; }
    .call-overlay .call-btn.hangup { background: #ef4444; flex: 1; min-width: 140px; }
    .call-overlay .call-btn.toggle.active {
      background: #0ea5e9;
      box-shadow: 0 0 18px rgba(14,165,233,0.45);
    }
  `;
  document.head.appendChild(style);
}

function ensureOverlayElements() {
  if (typeof document === 'undefined') return null;
  let root = document.getElementById('callOverlay');
  if (root) {
    return {
      root,
      card: root.querySelector('.call-card'),
      nameLabel: root.querySelector('.call-peer-name'),
      statusLabel: root.querySelector('.call-status-label'),
      avatar: root.querySelector('.call-avatar'),
      acceptBtn: root.querySelector('[data-call-action="accept"]'),
      rejectBtn: root.querySelector('[data-call-action="reject"]'),
      cancelBtn: root.querySelector('[data-call-action="cancel"]')
    };
  }
  root = document.createElement('div');
  root.id = 'callOverlay';
  root.className = 'call-overlay hidden';
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = `
    <div class="call-card" role="dialog" aria-live="assertive">
      <div class="call-peer">
        <div class="call-avatar" aria-hidden="true"></div>
        <div class="call-meta">
          <strong class="call-peer-name">好友</strong>
          <span class="call-status-label">撥號中…</span>
          <span class="call-timer-label" aria-live="off"></span>
        </div>
      </div>
      <div class="call-security">
        <span class="dot" aria-hidden="true"></span>
        <span class="call-secure-label">建立加密金鑰…</span>
      </div>
      <div class="call-actions">
        <button type="button" class="call-btn reject" data-call-action="reject"><i class='bx bx-x'></i>拒接</button>
        <button type="button" class="call-btn accept" data-call-action="accept"><i class='bx bx-phone'></i>接聽</button>
        <button type="button" class="call-btn cancel" data-call-action="cancel"><i class='bx bx-phone-off'></i>取消</button>
      </div>
      <div class="call-controls hidden" aria-label="通話控制">
        <button type="button" class="call-btn toggle" data-call-action="mute" aria-pressed="false">
          <i class='bx bx-microphone-off'></i><span>靜音</span>
        </button>
        <button type="button" class="call-btn toggle" data-call-action="speaker" aria-pressed="false">
          <i class='bx bx-volume-full'></i><span>喇叭</span>
        </button>
        <button type="button" class="call-btn hangup" data-call-action="hangup">
          <i class='bx bx-phone-off'></i><span>掛斷</span>
        </button>
      </div>
      <audio id="callRemoteAudio" autoplay playsinline style="display:none"></audio>
    </div>
  `;
  document.body.appendChild(root);
  return {
    root,
    card: root.querySelector('.call-card'),
    nameLabel: root.querySelector('.call-peer-name'),
    statusLabel: root.querySelector('.call-status-label'),
    timerLabel: root.querySelector('.call-timer-label'),
    secureLabel: root.querySelector('.call-secure-label'),
    avatar: root.querySelector('.call-avatar'),
    acceptBtn: root.querySelector('[data-call-action="accept"]'),
    rejectBtn: root.querySelector('[data-call-action="reject"]'),
    cancelBtn: root.querySelector('[data-call-action="cancel"]'),
    actionsRow: root.querySelector('.call-actions'),
    controlsRow: root.querySelector('.call-controls'),
    muteBtn: root.querySelector('[data-call-action="mute"]'),
    speakerBtn: root.querySelector('[data-call-action="speaker"]'),
    hangupBtn: root.querySelector('[data-call-action="hangup"]')
  };
}

function formatPeerName(session) {
  if (!session) return '好友';
  if (session.peerDisplayName) return session.peerDisplayName;
  if (session.peerUidHex) {
    return `好友 ${session.peerUidHex.slice(-4)}`;
  }
  return '好友';
}

function updateAvatar(el, session) {
  if (!el) return;
  el.innerHTML = '';
  const url = session?.peerAvatarUrl;
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = session.peerDisplayName || 'avatar';
    el.appendChild(img);
    return;
  }
  const initials = (session?.peerDisplayName || session?.peerUidHex || '?')
    .replace(/\s+/g, '')
    .slice(0, 2)
    .toUpperCase() || '?';
  el.textContent = initials;
}

function shouldDisplay(status) {
  return [
    CALL_SESSION_STATUS.OUTGOING,
    CALL_SESSION_STATUS.INCOMING,
    CALL_SESSION_STATUS.CONNECTING,
    CALL_SESSION_STATUS.IN_CALL
  ].includes(status);
}

export function initCallOverlay({ showToast }) {
  if (typeof document === 'undefined') return () => {};
  ensureStyles();
  const ui = ensureOverlayElements();
  if (!ui) return () => {};
  const state = { actionBusy: false, timerHandle: null, timerStart: null };

  function setVisibility(visible) {
    if (!ui.root) return;
    ui.root.classList.toggle('hidden', !visible);
    ui.root.setAttribute('aria-hidden', visible ? 'false' : 'true');
    if (!visible) {
      stopTimer();
    }
  }

  function stopTimer() {
    if (state.timerHandle) {
      clearInterval(state.timerHandle);
      state.timerHandle = null;
    }
    state.timerStart = null;
    if (ui.timerLabel) ui.timerLabel.textContent = '';
  }

  function renderTimerValue() {
    if (!ui.timerLabel || !state.timerStart) return;
    ui.timerLabel.textContent = formatDuration(Date.now() - state.timerStart);
  }

  function updateTimer(session) {
    if (!session || session.status !== CALL_SESSION_STATUS.IN_CALL || !session.connectedAt) {
      stopTimer();
      return;
    }
    state.timerStart = session.connectedAt;
    renderTimerValue();
    if (!state.timerHandle) {
      state.timerHandle = setInterval(renderTimerValue, 1000);
    }
  }

  function setToggleState(btn, active) {
    if (!btn) return;
    btn.classList.toggle('active', !!active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }

  function syncControlStates(session) {
    const controls = session?.mediaState?.controls || {};
    const localMuted = controls.audioMuted ?? isLocalAudioMuted();
    const remoteMuted = controls.remoteMuted ?? isRemoteAudioMuted();
    setToggleState(ui.muteBtn, !!localMuted);
    setToggleState(ui.speakerBtn, !!remoteMuted);
  }

  function render(session = getCallSessionSnapshot()) {
    if (!session || !shouldDisplay(session.status)) {
      setVisibility(false);
      state.actionBusy = false;
      return;
    }
    setVisibility(true);
    if (ui.nameLabel) ui.nameLabel.textContent = formatPeerName(session);
    if (ui.statusLabel) ui.statusLabel.textContent = describeStatus(session);
    if (ui.secureLabel) ui.secureLabel.textContent = describeSecureStatus(session);
    updateAvatar(ui.avatar, session);
    updateTimer(session);
    syncControlStates(session);
    const incoming = session.status === CALL_SESSION_STATUS.INCOMING;
    const outgoing = session.status === CALL_SESSION_STATUS.OUTGOING;
    const showResponseRow = incoming || outgoing;
    const showControlsRow = [CALL_SESSION_STATUS.CONNECTING, CALL_SESSION_STATUS.IN_CALL].includes(session.status);
    ui.actionsRow?.classList.toggle('hidden', !showResponseRow);
    ui.controlsRow?.classList.toggle('hidden', !showControlsRow);
    if (ui.acceptBtn) ui.acceptBtn.style.display = incoming ? 'flex' : 'none';
    if (ui.rejectBtn) ui.rejectBtn.style.display = incoming ? 'flex' : 'none';
    if (ui.cancelBtn) ui.cancelBtn.style.display = outgoing ? 'flex' : 'none';
    const disable = state.actionBusy;
    [ui.acceptBtn, ui.rejectBtn, ui.cancelBtn, ui.hangupBtn].forEach((btn) => {
      if (btn) btn.disabled = disable;
    });
    const togglesDisabled = disable || !showControlsRow;
    [ui.muteBtn, ui.speakerBtn].forEach((btn) => {
      if (btn) btn.disabled = togglesDisabled;
    });
  }

  async function handleAccept() {
    const session = getCallSessionSnapshot();
    if (!session?.callId || state.actionBusy) return;
    if (!session.peerUidHex) {
      showToast?.('缺少通話對象', true);
      return;
    }
    state.actionBusy = true;
    render(session);
    try {
      await acknowledgeCall({ callId: session.callId, traceId: session.traceId });
      updateCallSessionStatus(CALL_SESSION_STATUS.CONNECTING, { callId: session.callId });
      await acceptIncomingCallMedia({ callId: session.callId, peerUid: session.peerUidHex });
      sendCallSignal('call-accept', {
        callId: session.callId,
        targetUid: session.peerUidHex,
        metadata: { acceptedAt: Date.now() }
      });
    } catch (err) {
      log({ callAcceptError: err?.message || err });
      showToast?.('接聽失敗', true);
    } finally {
      state.actionBusy = false;
      render();
    }
  }

  async function handleReject() {
    const session = getCallSessionSnapshot();
    if (!session?.callId || state.actionBusy) return;
    state.actionBusy = true;
    render(session);
    try {
      if (session.peerUidHex) {
        sendCallSignal('call-reject', {
          callId: session.callId,
          targetUid: session.peerUidHex,
          reason: 'user_reject'
        });
      }
      endCallMediaSession('rejected');
      completeCallSession({ reason: 'rejected' });
    } finally {
      state.actionBusy = false;
      render();
    }
  }

  async function handleCancel() {
    const session = getCallSessionSnapshot();
    if (!session?.callId || state.actionBusy) return;
    state.actionBusy = true;
    render(session);
    try {
      await cancelCall({ callId: session.callId, reason: 'caller_cancelled' });
      endCallMediaSession('cancelled');
      if (session.peerUidHex) {
        sendCallSignal('call-cancel', {
          callId: session.callId,
          targetUid: session.peerUidHex,
          reason: 'caller_cancelled'
        });
      }
      completeCallSession({ reason: 'cancelled' });
    } catch (err) {
      log({ callCancelError: err?.message || err });
      showToast?.('無法結束通話', true);
    } finally {
      state.actionBusy = false;
      render();
    }
  }

  async function handleHangup() {
    const session = getCallSessionSnapshot();
    if (!session?.callId || state.actionBusy) return;
    if (![CALL_SESSION_STATUS.CONNECTING, CALL_SESSION_STATUS.IN_CALL].includes(session.status)) {
      return;
    }
    state.actionBusy = true;
    render(session);
    try {
      if (session.peerUidHex) {
        sendCallSignal('call-end', {
          callId: session.callId,
          targetUid: session.peerUidHex,
          reason: 'hangup'
        });
      }
      endCallMediaSession('hangup');
      completeCallSession({ reason: 'hangup' });
    } catch (err) {
      log({ callHangupError: err?.message || err });
      showToast?.('無法結束通話', true);
    } finally {
      state.actionBusy = false;
      render();
    }
  }

  function handleMuteToggle() {
    const session = getCallSessionSnapshot();
    if (!session) return;
    const controls = session.mediaState?.controls || {};
    const next = !(controls.audioMuted ?? isLocalAudioMuted());
    setLocalAudioMuted(next);
  }

  function handleSpeakerToggle() {
    const session = getCallSessionSnapshot();
    if (!session) return;
    const controls = session.mediaState?.controls || {};
    const next = !(controls.remoteMuted ?? isRemoteAudioMuted());
    setRemoteAudioMuted(next);
  }

  ui.acceptBtn?.addEventListener('click', handleAccept);
  ui.rejectBtn?.addEventListener('click', handleReject);
  ui.cancelBtn?.addEventListener('click', handleCancel);
  ui.hangupBtn?.addEventListener('click', handleHangup);
  ui.muteBtn?.addEventListener('click', handleMuteToggle);
  ui.speakerBtn?.addEventListener('click', handleSpeakerToggle);

  const unsubscribers = [
    subscribeCallEvent(CALL_EVENT.STATE, ({ session }) => {
      render(session);
      if (session?.mediaState?.status === CALL_MEDIA_STATE_STATUS.FAILED) {
        showToast?.('無法建立加密通道', true);
      }
    }),
    subscribeCallEvent(CALL_EVENT.SIGNAL, () => render()),
    subscribeCallEvent(CALL_EVENT.ERROR, () => {
      showToast?.('通話發生錯誤', true);
      render();
    })
  ];

  render();

  return () => {
    unsubscribers.forEach((off) => {
      try { off?.(); } catch {}
    });
    stopTimer();
  };
}
