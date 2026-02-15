import { log } from '../../core/log.js';
import { cancelCall, acknowledgeCall } from '../../api/calls.js';
import {
  CALL_EVENT,
  CALL_SESSION_STATUS,
  CALL_REQUEST_KIND,
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
  isRemoteAudioMuted,
  isLocalVideoMuted,
  setLocalVideoMuted,
  setRemoteVideoElement,
  setLocalVideoElement,
  getLocalStream,
  toggleLocalVideo,
  switchCamera,
  resolveCallPeerProfile
} from '../../features/calls/index.js';
import { CALL_MEDIA_STATE_STATUS } from '../../../shared/calls/schemas.js';
import { createCallAudioManager } from './call-audio.js';

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

const BUBBLE_SIZE = 76;
const BUBBLE_MARGIN = 16;
const MIN_DRAG_DISTANCE = 6;

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
      position: relative;
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
    .call-overlay .call-minify-btn {
      position: absolute;
      top: 12px;
      right: 12px;
      width: 32px;
      height: 32px;
      border-radius: 999px;
      border: none;
      background: rgba(15,23,42,0.4);
      color: #f8fafc;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: opacity 160ms ease, transform 160ms ease;
    }
    .call-overlay .call-minify-btn i {
      font-size: 18px;
      margin: 0;
    }
    .call-overlay .call-minify-btn:active {
      transform: scale(0.9);
    }
    .call-overlay .call-mini-bubble {
      position: fixed;
      width: 76px;
      height: 76px;
      border-radius: 999px;
      background: rgba(15,23,42,0.95);
      box-shadow: 0 12px 30px rgba(15, 23, 42, 0.55);
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      transform: scale(0.8);
      transition: opacity 200ms ease, transform 200ms ease;
      pointer-events: none;
      touch-action: none;
      z-index: 1000;
    }
    .call-overlay .call-mini-bubble.dragging {
      opacity: 0.85;
    }
    .call-overlay .call-mini-avatar {
      width: 48px;
      height: 48px;
      border-radius: 999px;
      background: rgba(248,250,252,0.1);
      color: #f8fafc;
      font-size: 16px;
      font-weight: 600;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }
    .call-overlay .call-mini-avatar img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .call-overlay.minimized {
      pointer-events: none;
    }
    .call-overlay.minimized .call-card {
      opacity: 0;
      transform: translateY(40px) scale(0.95);
      pointer-events: none;
    }
    .call-overlay.minimized .call-minify-btn {
      opacity: 0;
      pointer-events: none;
    }
    .call-overlay.minimized .call-mini-bubble {
      opacity: 1;
      transform: scale(1);
      pointer-events: auto;
    }

    /* ── Video mode ── */
    .call-overlay .call-card.video-mode {
      position: fixed;
      inset: 0;
      width: 100%;
      max-width: 100%;
      border-radius: 0;
      padding: 0;
      background: #000;
      display: flex;
      flex-direction: column;
    }
    .call-overlay .call-remote-video {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      background: #111;
    }
    .call-overlay .call-local-pip {
      position: absolute;
      bottom: 110px;
      right: 16px;
      width: 110px;
      height: 150px;
      border-radius: 12px;
      border: 2px solid rgba(255,255,255,0.25);
      overflow: hidden;
      background: #1e293b;
      z-index: 2;
    }
    .call-overlay .call-local-pip video {
      width: 100%;
      height: 100%;
      object-fit: cover;
      transform: scaleX(-1);
    }
    .call-overlay .call-video-top-bar {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      padding: 16px;
      background: linear-gradient(to bottom, rgba(0,0,0,0.6), transparent);
      display: flex;
      align-items: center;
      gap: 10px;
      z-index: 2;
    }
    .call-overlay .call-video-top-bar .call-avatar {
      width: 36px;
      height: 36px;
      font-size: 14px;
    }
    .call-overlay .call-video-top-bar .vt-name {
      font-size: 16px;
      font-weight: 600;
      color: #f8fafc;
    }
    .call-overlay .call-video-top-bar .vt-status {
      font-size: 13px;
      color: rgba(248,250,252,0.7);
    }
    .call-overlay .call-card.video-mode .call-minify-btn {
      position: absolute;
      top: 12px;
      right: 12px;
      z-index: 3;
    }
    .call-overlay .call-card.video-mode .call-controls {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      padding: 24px 16px;
      padding-bottom: max(24px, env(safe-area-inset-bottom));
      background: linear-gradient(to top, rgba(0,0,0,0.7), transparent);
      margin-top: 0;
      z-index: 2;
    }
    .call-overlay .call-card.video-mode .call-actions {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      padding: 24px 16px;
      padding-bottom: max(24px, env(safe-area-inset-bottom));
      background: linear-gradient(to top, rgba(0,0,0,0.7), transparent);
      margin-top: 0;
      z-index: 2;
    }
    .call-overlay .call-card.video-mode .call-peer,
    .call-overlay .call-card.video-mode .call-security {
      display: none;
    }
    .call-overlay .call-video-waiting {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      z-index: 1;
    }
    .call-overlay .call-video-waiting .call-avatar {
      width: 80px;
      height: 80px;
      font-size: 28px;
    }
    .call-overlay .call-video-waiting .vw-name {
      font-size: 20px;
      font-weight: 600;
      color: #f8fafc;
    }
    .call-overlay .call-video-waiting .vw-status {
      font-size: 14px;
      color: rgba(248,250,252,0.7);
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
      hangupBtn: root.querySelector('[data-call-action="hangup"]'),
      cameraBtn: root.querySelector('[data-call-action="camera"]'),
      flipCameraBtn: root.querySelector('[data-call-action="flip-camera"]'),
      minifyBtn: root.querySelector('[data-call-action="minify"]'),
      bubble: root.querySelector('.call-mini-bubble'),
      bubbleAvatar: root.querySelector('.call-mini-avatar'),
      remoteVideo: root.querySelector('.call-remote-video'),
      localPip: root.querySelector('.call-local-pip'),
      localPipVideo: root.querySelector('.call-local-pip video'),
      videoWaiting: root.querySelector('.call-video-waiting'),
      videoWaitingAvatar: root.querySelector('.call-video-waiting .call-avatar'),
      videoWaitingName: root.querySelector('.call-video-waiting .vw-name'),
      videoWaitingStatus: root.querySelector('.call-video-waiting .vw-status'),
      videoTopBar: root.querySelector('.call-video-top-bar'),
      videoTopBarAvatar: root.querySelector('.call-video-top-bar .call-avatar'),
      videoTopBarName: root.querySelector('.call-video-top-bar .vt-name'),
      videoTopBarStatus: root.querySelector('.call-video-top-bar .vt-status')
    };
  }
  root = document.createElement('div');
  root.id = 'callOverlay';
  root.className = 'call-overlay hidden';
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = `
    <div class="call-card" role="dialog" aria-live="assertive">
      <button type="button" class="call-minify-btn" data-call-action="minify" aria-label="縮小通話視窗">
        <i class='bx bx-chevron-down'></i>
      </button>
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
        <button type="button" class="call-btn toggle" data-call-action="camera" aria-pressed="false" style="display:none">
          <i class='bx bx-video'></i><span>鏡頭</span>
        </button>
        <button type="button" class="call-btn toggle" data-call-action="flip-camera" style="display:none">
          <i class='bx bx-refresh'></i><span>翻轉</span>
        </button>
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
      <video class="call-remote-video" autoplay playsinline style="display:none"></video>
      <div class="call-video-waiting" style="display:none">
        <div class="call-avatar" aria-hidden="true"></div>
        <div class="vw-name">好友</div>
        <div class="vw-status">撥號中…</div>
      </div>
      <div class="call-video-top-bar" style="display:none">
        <div class="call-avatar" aria-hidden="true"></div>
        <div>
          <div class="vt-name">好友</div>
          <div class="vt-status">通話中</div>
        </div>
      </div>
      <div class="call-local-pip" style="display:none">
        <video autoplay playsinline muted></video>
      </div>
    </div>
    <div class="call-mini-bubble" role="button" aria-label="回到通話視窗" tabindex="0">
      <div class="call-mini-avatar" aria-hidden="true"></div>
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
      hangupBtn: root.querySelector('[data-call-action="hangup"]'),
      cameraBtn: root.querySelector('[data-call-action="camera"]'),
      flipCameraBtn: root.querySelector('[data-call-action="flip-camera"]'),
      minifyBtn: root.querySelector('[data-call-action="minify"]'),
      bubble: root.querySelector('.call-mini-bubble'),
      bubbleAvatar: root.querySelector('.call-mini-avatar'),
      remoteVideo: root.querySelector('.call-remote-video'),
      localPip: root.querySelector('.call-local-pip'),
      localPipVideo: root.querySelector('.call-local-pip video'),
      videoWaiting: root.querySelector('.call-video-waiting'),
      videoWaitingAvatar: root.querySelector('.call-video-waiting .call-avatar'),
      videoWaitingName: root.querySelector('.call-video-waiting .vw-name'),
      videoWaitingStatus: root.querySelector('.call-video-waiting .vw-status'),
      videoTopBar: root.querySelector('.call-video-top-bar'),
      videoTopBarAvatar: root.querySelector('.call-video-top-bar .call-avatar'),
      videoTopBarName: root.querySelector('.call-video-top-bar .vt-name'),
      videoTopBarStatus: root.querySelector('.call-video-top-bar .vt-status')
    };
  }

function resolveUiPeerProfile(session) {
  if (!session) {
    return {
      name: '好友',
      avatarUrl: null,
      source: 'fallback',
      peerKey: null,
      hasNickname: false,
      hasAvatar: false
    };
  }
  const profile = resolveCallPeerProfile({
    peerAccountDigest: session.peerAccountDigest,
    peerDeviceId: session.peerDeviceId,
    peerKey: session.peerKey || null,
    displayNameFallback: session.remoteDisplayName || session.peerDisplayName || null
  });
  const name = profile.nickname || profile.placeholderName || profile.fallbackName || '好友';
  const avatarUrl = profile.avatarUrl || null;
  return {
    ...profile,
    name,
    avatarUrl,
    hasNickname: !!profile.nickname,
    hasAvatar: !!avatarUrl
  };
}

function maybeLogPeerProfile(session, profile, state) {
  if (!session || !profile || !state) return;
  const logKey = `${session.callId || 'unknown'}:${profile.peerKey || profile.peerAccountDigest || 'unknown'}:${profile.source}:${profile.hasNickname ? '1' : '0'}:${profile.hasAvatar ? '1' : '0'}`;
  if (state.lastProfileLogKey === logKey) return;
  state.lastProfileLogKey = logKey;
  try {
    console.info('[call] ui:peer-profile ' + JSON.stringify({
      callId: session.callId || null,
      peerKey: profile.peerKey || profile.peerAccountDigest || null,
      hasNickname: !!profile.hasNickname,
      hasAvatar: !!profile.hasAvatar,
      source: profile.source || 'fallback'
    }));
  } catch {}
}

function renderAvatarContent(el, profile) {
  if (!el || !profile) return;
  el.innerHTML = '';
  if (profile.avatarUrl) {
    const img = document.createElement('img');
    img.src = profile.avatarUrl;
    img.alt = profile.name || 'avatar';
    el.appendChild(img);
    return;
  }
  const peerKey = profile.peerAccountDigest || '?';
  const initials = (profile.name || peerKey || '?')
    .replace(/\s+/g, '')
    .slice(0, 2)
    .toUpperCase() || '?';
  el.textContent = initials;
}

function updateAvatar(el, profile) {
  renderAvatarContent(el, profile);
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
  const state = {
    actionBusy: false,
    timerHandle: null,
    timerStart: null,
    lastStatus: CALL_SESSION_STATUS.IDLE,
    toneCallId: null,
    playedToneKeys: new Set(),
    minimized: false,
    bubble: { x: null, y: null },
    bubbleDrag: {
      pointerId: null,
      startX: 0,
      startY: 0,
      baseX: 0,
      baseY: 0,
      moved: false
    },
    lastProfileLogKey: null
  };
  const audio = createCallAudioManager();

  function clampBubblePosition(x, y) {
    if (typeof window === 'undefined') return { x, y };
    const maxX = Math.max(BUBBLE_MARGIN, window.innerWidth - BUBBLE_SIZE - BUBBLE_MARGIN);
    const maxY = Math.max(BUBBLE_MARGIN, window.innerHeight - BUBBLE_SIZE - BUBBLE_MARGIN);
    const clampedX = Math.min(Math.max(x, BUBBLE_MARGIN), maxX);
    const clampedY = Math.min(Math.max(y, BUBBLE_MARGIN), maxY);
    return { x: clampedX, y: clampedY };
  }

  function applyBubblePosition() {
    if (!ui.bubble || state.bubble.x == null || state.bubble.y == null) return;
    const { x, y } = clampBubblePosition(state.bubble.x, state.bubble.y);
    state.bubble.x = x;
    state.bubble.y = y;
    ui.bubble.style.left = `${x}px`;
    ui.bubble.style.top = `${y}px`;
  }

  function ensureBubblePosition() {
    if (state.bubble.x != null && state.bubble.y != null) {
      applyBubblePosition();
      return;
    }
    if (typeof window === 'undefined') return;
    state.bubble.x = window.innerWidth - (BUBBLE_SIZE + BUBBLE_MARGIN);
    state.bubble.y = window.innerHeight - (BUBBLE_SIZE + BUBBLE_MARGIN * 4);
    applyBubblePosition();
  }

  function updateMinimizedState() {
    if (!ui.root) return;
    ui.root.classList.toggle('minimized', !!state.minimized);
    if (state.minimized) {
      ensureBubblePosition();
    }
  }

  function minimizeOverlay() {
    if (state.minimized) return;
    state.minimized = true;
    ensureBubblePosition();
    updateMinimizedState();
  }

  function restoreOverlay() {
    if (!state.minimized) return;
    state.minimized = false;
    updateMinimizedState();
  }

  function setVisibility(visible) {
    if (!ui.root) return;
    ui.root.classList.toggle('hidden', !visible);
    ui.root.setAttribute('aria-hidden', visible ? 'false' : 'true');
    if (!visible) {
      stopTimer();
      state.minimized = false;
      updateMinimizedState();
    } else {
      updateMinimizedState();
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

  function ensureToneContext(session) {
    const callId = session?.callId || null;
    if (callId !== state.toneCallId) {
      state.toneCallId = callId;
      state.playedToneKeys.clear();
    }
  }

  function makeToneKey(kind, callId) {
    const id = callId || 'global';
    return `${id}:${kind}`;
  }

  function playToneOnce(kind, { callId } = {}) {
    const key = makeToneKey(kind, callId || state.toneCallId);
    if (state.playedToneKeys.has(key)) return;
    state.playedToneKeys.add(key);
    if (kind === 'accepted') {
      audio.playAcceptedTone();
    } else if (kind === 'ended') {
      audio.playEndTone();
    }
  }

  function setToggleState(btn, active) {
    if (!btn) return;
    btn.classList.toggle('active', !!active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }

  function handleWindowResize() {
    if (!state.minimized) return;
    applyBubblePosition();
  }

  function handleBubblePointerDown(event) {
    if (!state.minimized || !ui.bubble) return;
    event.preventDefault();
    const pointerId = event.pointerId ?? 'mouse';
    state.bubbleDrag.pointerId = pointerId;
    state.bubbleDrag.startX = event.clientX;
    state.bubbleDrag.startY = event.clientY;
    state.bubbleDrag.baseX = state.bubble.x ?? 0;
    state.bubbleDrag.baseY = state.bubble.y ?? 0;
    state.bubbleDrag.moved = false;
    ui.bubble.setPointerCapture?.(pointerId);
  }

  function handleBubblePointerMove(event) {
    if (!state.minimized || state.bubbleDrag.pointerId == null) return;
    if (event.pointerId !== state.bubbleDrag.pointerId) return;
    const dx = event.clientX - state.bubbleDrag.startX;
    const dy = event.clientY - state.bubbleDrag.startY;
    if (!state.bubbleDrag.moved && Math.hypot(dx, dy) > MIN_DRAG_DISTANCE) {
      state.bubbleDrag.moved = true;
      ui.bubble?.classList.add('dragging');
    }
    if (!state.bubbleDrag.moved) return;
    state.bubble.x = state.bubbleDrag.baseX + dx;
    state.bubble.y = state.bubbleDrag.baseY + dy;
    applyBubblePosition();
  }

  function finishBubblePointer(event, cancelled = false) {
    if (state.bubbleDrag.pointerId == null || event.pointerId !== state.bubbleDrag.pointerId) return;
    ui.bubble?.releasePointerCapture?.(state.bubbleDrag.pointerId);
    const moved = state.bubbleDrag.moved;
    state.bubbleDrag.pointerId = null;
    state.bubbleDrag.moved = false;
    ui.bubble?.classList.remove('dragging');
    if (!cancelled && !moved) {
      restoreOverlay();
    }
  }

  function handleBubblePointerUp(event) {
    finishBubblePointer(event, false);
  }

  function handleBubblePointerCancel(event) {
    finishBubblePointer(event, true);
  }

  function handleBubbleKeyDown(event) {
    if (!state.minimized) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      restoreOverlay();
    }
  }

  function syncControlStates(session) {
    const controls = session?.mediaState?.controls || {};
    const localMuted = controls.audioMuted ?? isLocalAudioMuted();
    const remoteMuted = controls.remoteMuted ?? isRemoteAudioMuted();
    setToggleState(ui.muteBtn, !!localMuted);
    setToggleState(ui.speakerBtn, !!remoteMuted);
    const videoEnabled = controls.videoEnabled ?? !isLocalVideoMuted();
    setToggleState(ui.cameraBtn, !!videoEnabled);
  }

  function updateBubbleDetails(profile) {
    if (!ui.bubble) return;
    const safeProfile = profile || { name: '好友', peerAccountDigest: null, avatarUrl: null };
    const labelName = safeProfile.name || '好友';
    ui.bubble.setAttribute('aria-label', `回到與 ${labelName} 的通話`);
    renderAvatarContent(ui.bubbleAvatar, safeProfile);
  }

  function syncAudio(session) {
    const status = session?.status || CALL_SESSION_STATUS.IDLE;
    const displayable = session && shouldDisplay(status);
    if (!displayable) {
      audio.stopLoops();
    } else if (status === CALL_SESSION_STATUS.OUTGOING) {
      audio.playOutgoingLoop();
    } else if (status === CALL_SESSION_STATUS.INCOMING) {
      audio.playIncomingLoop();
    } else {
      audio.stopLoops();
    }
    if (status === CALL_SESSION_STATUS.CONNECTING && state.lastStatus !== CALL_SESSION_STATUS.CONNECTING) {
      playToneOnce('accepted', { callId: session?.callId });
    }
    const wasEnded = [CALL_SESSION_STATUS.ENDED, CALL_SESSION_STATUS.FAILED].includes(state.lastStatus);
    if ([CALL_SESSION_STATUS.ENDED, CALL_SESSION_STATUS.FAILED].includes(status) && !wasEnded) {
      playToneOnce('ended', { callId: session?.callId });
    }
    state.lastStatus = status;
  }

  function render(session = getCallSessionSnapshot()) {
    ensureToneContext(session);
    syncAudio(session);
    if (!session || !shouldDisplay(session.status)) {
      updateBubbleDetails(null);
      setVisibility(false);
      state.actionBusy = false;
      return;
    }
    setVisibility(true);
    const profile = resolveUiPeerProfile(session);
    maybeLogPeerProfile(session, profile, state);
    if (ui.nameLabel) ui.nameLabel.textContent = profile.name || '好友';
    if (ui.statusLabel) ui.statusLabel.textContent = describeStatus(session);
    if (ui.secureLabel) ui.secureLabel.textContent = describeSecureStatus(session);
    updateAvatar(ui.avatar, profile);
    updateBubbleDetails(profile);
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

    // ── Video mode rendering ──
    const isVideo = session.kind === CALL_REQUEST_KIND.VIDEO;
    ui.card?.classList.toggle('video-mode', isVideo);
    const inCall = session.status === CALL_SESSION_STATUS.IN_CALL;
    const connecting = session.status === CALL_SESSION_STATUS.CONNECTING;

    // Camera / flip buttons visibility
    if (ui.cameraBtn) ui.cameraBtn.style.display = isVideo && showControlsRow ? 'flex' : 'none';
    if (ui.flipCameraBtn) ui.flipCameraBtn.style.display = isVideo && showControlsRow ? 'flex' : 'none';
    if (ui.cameraBtn) ui.cameraBtn.disabled = togglesDisabled;
    if (ui.flipCameraBtn) ui.flipCameraBtn.disabled = togglesDisabled;

    // Video elements
    if (isVideo) {
      const hasRemoteVideo = inCall || connecting;
      if (ui.remoteVideo) ui.remoteVideo.style.display = hasRemoteVideo ? 'block' : 'none';
      if (ui.localPip) ui.localPip.style.display = (inCall || connecting) ? 'block' : 'none';

      // Waiting screen (before connected)
      const showWaiting = incoming || outgoing;
      if (ui.videoWaiting) {
        ui.videoWaiting.style.display = showWaiting ? 'flex' : 'none';
        if (showWaiting) {
          renderAvatarContent(ui.videoWaitingAvatar, profile);
          if (ui.videoWaitingName) ui.videoWaitingName.textContent = profile.name || '好友';
          if (ui.videoWaitingStatus) {
            const videoStatusText = incoming ? '視訊來電' : '視訊撥號中…';
            ui.videoWaitingStatus.textContent = videoStatusText;
          }
        }
      }

      // Top bar (during call)
      if (ui.videoTopBar) {
        ui.videoTopBar.style.display = (inCall || connecting) ? 'flex' : 'none';
        if (inCall || connecting) {
          renderAvatarContent(ui.videoTopBarAvatar, profile);
          if (ui.videoTopBarName) ui.videoTopBarName.textContent = profile.name || '好友';
          if (ui.videoTopBarStatus) ui.videoTopBarStatus.textContent = describeSecureStatus(session);
        }
      }

      // Re-attach localPip srcObject if we have a local stream with video tracks
      if (ui.localPipVideo && (inCall || connecting)) {
        const ls = getLocalStream();
        if (ls && ls.getVideoTracks().length && ui.localPipVideo.srcObject !== ls) {
          ui.localPipVideo.srcObject = ls;
          ui.localPipVideo.muted = true;
          try { ui.localPipVideo.play(); } catch {}
        }
      }

      // Incoming video call: change accept button text
      if (ui.acceptBtn && incoming) {
        ui.acceptBtn.innerHTML = "<i class='bx bx-video'></i>接聽視訊";
      }
    } else {
      // Reset video elements when not video
      if (ui.remoteVideo) ui.remoteVideo.style.display = 'none';
      if (ui.localPip) ui.localPip.style.display = 'none';
      if (ui.videoWaiting) ui.videoWaiting.style.display = 'none';
      if (ui.videoTopBar) ui.videoTopBar.style.display = 'none';
      if (ui.cameraBtn) ui.cameraBtn.style.display = 'none';
      if (ui.flipCameraBtn) ui.flipCameraBtn.style.display = 'none';
      // Reset accept button for voice
      if (ui.acceptBtn && incoming) {
        ui.acceptBtn.innerHTML = "<i class='bx bx-phone'></i>接聽";
      }
    }
  }

  async function handleAccept() {
    const session = getCallSessionSnapshot();
    if (!session?.callId || state.actionBusy) return;
    if (!session.peerAccountDigest) {
      showToast?.('缺少通話對象', { variant: 'error' });
      return;
    }
    state.actionBusy = true;
    render(session);
    try {
      // acknowledgeCall is for server tracking only — do not block the call if it fails
      try {
        await acknowledgeCall({ callId: session.callId, traceId: session.traceId });
      } catch (ackErr) {
        log({ callAcknowledgeError: ackErr?.message || ackErr, callId: session.callId });
      }
      updateCallSessionStatus(CALL_SESSION_STATUS.CONNECTING, { callId: session.callId });
      // Send call-accept BEFORE media setup so the caller receives the state
      // transition signal before the SDP answer, preventing state regression.
      sendCallSignal('call-accept', {
        callId: session.callId,
        targetAccountDigest: session.peerAccountDigest || null,
        metadata: { acceptedAt: Date.now() }
      });
      await acceptIncomingCallMedia({ callId: session.callId, peerAccountDigest: session.peerAccountDigest });
    } catch (err) {
      log({ callAcceptError: err?.message || err });
      showToast?.('接聽失敗', { variant: 'error' });
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
      if (session.peerAccountDigest) {
        sendCallSignal('call-reject', {
          callId: session.callId,
          targetAccountDigest: session.peerAccountDigest || null,
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
      // cancelCall is for server tracking only — do not block the cancel if it fails
      try {
        await cancelCall({ callId: session.callId, reason: 'caller_cancelled' });
      } catch (cancelErr) {
        log({ callCancelApiError: cancelErr?.message || cancelErr, callId: session.callId });
      }
      endCallMediaSession('cancelled');
      if (session.peerAccountDigest) {
        sendCallSignal('call-cancel', {
          callId: session.callId,
          targetAccountDigest: session.peerAccountDigest || null,
          reason: 'caller_cancelled'
        });
      }
      completeCallSession({ reason: 'cancelled' });
    } catch (err) {
      log({ callCancelError: err?.message || err });
      showToast?.('無法結束通話', { variant: 'error' });
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
      if (session.peerAccountDigest) {
        sendCallSignal('call-end', {
          callId: session.callId,
          targetAccountDigest: session.peerAccountDigest || null,
          reason: 'hangup'
        });
      }
      endCallMediaSession('hangup');
      completeCallSession({ reason: 'hangup' });
    } catch (err) {
      log({ callHangupError: err?.message || err });
      showToast?.('無法結束通話', { variant: 'error' });
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

  async function handleCameraToggle() {
    const session = getCallSessionSnapshot();
    if (!session) return;
    const controls = session.mediaState?.controls || {};
    const currentlyEnabled = controls.videoEnabled ?? !isLocalVideoMuted();
    await toggleLocalVideo(!currentlyEnabled);
  }

  async function handleFlipCamera() {
    await switchCamera();
  }

  ui.acceptBtn?.addEventListener('click', handleAccept);
  ui.rejectBtn?.addEventListener('click', handleReject);
  ui.cancelBtn?.addEventListener('click', handleCancel);
  ui.hangupBtn?.addEventListener('click', handleHangup);
  ui.muteBtn?.addEventListener('click', handleMuteToggle);
  ui.speakerBtn?.addEventListener('click', handleSpeakerToggle);
  ui.cameraBtn?.addEventListener('click', handleCameraToggle);
  ui.flipCameraBtn?.addEventListener('click', handleFlipCamera);
  ui.minifyBtn?.addEventListener('click', minimizeOverlay);
  // Wire video elements to media-session
  if (ui.remoteVideo) setRemoteVideoElement(ui.remoteVideo);
  if (ui.localPipVideo) setLocalVideoElement(ui.localPipVideo);

  ui.bubble?.addEventListener('pointerdown', handleBubblePointerDown);
  ui.bubble?.addEventListener('pointermove', handleBubblePointerMove);
  ui.bubble?.addEventListener('pointerup', handleBubblePointerUp);
  ui.bubble?.addEventListener('pointercancel', handleBubblePointerCancel);
  ui.bubble?.addEventListener('keydown', handleBubbleKeyDown);
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', handleWindowResize);
  }

  function handleSignalTone(signal) {
    if (!signal?.type) return;
    const type = String(signal.type);
    const session = getCallSessionSnapshot();
    ensureToneContext(session);
    const callId = signal.callId || session?.callId || null;
    if (type === 'call-accept') {
      playToneOnce('accepted', { callId });
      return;
    }
    if (['call-end', 'call-cancel', 'call-reject', 'call-busy'].includes(type)) {
      playToneOnce('ended', { callId });
      audio.stopLoops();
    }
  }

  const unsubscribers = [
    subscribeCallEvent(CALL_EVENT.STATE, ({ session }) => {
      render(session);
      if (session?.mediaState?.status === CALL_MEDIA_STATE_STATUS.FAILED) {
        showToast?.('無法建立加密通道', { variant: 'error' });
      }
    }),
    subscribeCallEvent(CALL_EVENT.SIGNAL, ({ signal }) => {
      handleSignalTone(signal);
      render();
    }),
    subscribeCallEvent(CALL_EVENT.ERROR, () => {
      showToast?.('通話發生錯誤', { variant: 'error' });
      render();
    })
  ];

  render();

  return () => {
    unsubscribers.forEach((off) => {
      try { off?.(); } catch {}
    });
    stopTimer();
    audio.dispose();
    ui.acceptBtn?.removeEventListener('click', handleAccept);
    ui.rejectBtn?.removeEventListener('click', handleReject);
    ui.cancelBtn?.removeEventListener('click', handleCancel);
    ui.hangupBtn?.removeEventListener('click', handleHangup);
    ui.muteBtn?.removeEventListener('click', handleMuteToggle);
    ui.speakerBtn?.removeEventListener('click', handleSpeakerToggle);
    ui.cameraBtn?.removeEventListener('click', handleCameraToggle);
    ui.flipCameraBtn?.removeEventListener('click', handleFlipCamera);
    ui.minifyBtn?.removeEventListener('click', minimizeOverlay);
    setRemoteVideoElement(null);
    setLocalVideoElement(null);
    ui.bubble?.removeEventListener('pointerdown', handleBubblePointerDown);
    ui.bubble?.removeEventListener('pointermove', handleBubblePointerMove);
    ui.bubble?.removeEventListener('pointerup', handleBubblePointerUp);
    ui.bubble?.removeEventListener('pointercancel', handleBubblePointerCancel);
    ui.bubble?.removeEventListener('keydown', handleBubbleKeyDown);
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', handleWindowResize);
    }
  };
}
