// call-info-overlay.js
// Self-contained overlay showing live call E2EE key info:
//   - Key rotation status (active / idle)
//   - Rotations elapsed (epoch − 1)
//   - Next rotation countdown (mm:ss)
//   - Key algorithm
//
// Transparent backdrop. Dismissed via backdrop click, ✕ button, or Esc.
// Designed to work standalone in both the main app (app.html) and the
// ephemeral page (ephemeral.html) without touching page-level CSS.

import { getCallKeyContext } from './key-manager.js';
import { getCallMediaState } from './state.js';
import { t } from '/locales/index.js';

const OVERLAY_ID = 'callInfoOverlay';
const STYLE_ID = 'callInfoOverlayStyles';
const POLL_INTERVAL_MS = 500;

let pollTimer = null;
let escHandler = null;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      inset: 0;
      z-index: 10000;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      animation: callInfoFadeIn 180ms ease-out;
    }
    @keyframes callInfoFadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    #${OVERLAY_ID} .call-info-card {
      background: rgba(20, 24, 34, 0.92);
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 14px;
      min-width: 300px;
      max-width: calc(100vw - 40px);
      padding: 20px 22px;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
      animation: callInfoSlideUp 220ms ease-out;
    }
    @keyframes callInfoSlideUp {
      from { opacity: 0; transform: translateY(12px); }
      to { opacity: 1; transform: translateY(0); }
    }
    #${OVERLAY_ID} .call-info-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 16px;
    }
    #${OVERLAY_ID} .call-info-header svg {
      width: 20px;
      height: 20px;
      flex-shrink: 0;
      color: #6bdbb5;
    }
    #${OVERLAY_ID} .call-info-title {
      flex: 1;
      font-size: 15px;
      font-weight: 600;
      letter-spacing: 0.2px;
    }
    #${OVERLAY_ID} .call-info-close {
      background: transparent;
      border: none;
      color: rgba(255, 255, 255, 0.7);
      cursor: pointer;
      padding: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      transition: background 150ms, color 150ms;
    }
    #${OVERLAY_ID} .call-info-close:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
    }
    #${OVERLAY_ID} .call-info-close svg {
      width: 18px;
      height: 18px;
    }
    #${OVERLAY_ID} .call-info-grid {
      display: grid;
      grid-template-columns: auto 1fr;
      column-gap: 16px;
      row-gap: 10px;
      font-size: 13px;
    }
    #${OVERLAY_ID} .call-info-label {
      color: rgba(255, 255, 255, 0.58);
      white-space: nowrap;
    }
    #${OVERLAY_ID} .call-info-value {
      color: #fff;
      font-variant-numeric: tabular-nums;
      font-weight: 500;
      word-break: break-word;
    }
    #${OVERLAY_ID} .call-info-value--mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      line-height: 1.5;
    }
    #${OVERLAY_ID} .call-info-status-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 6px;
      vertical-align: middle;
    }
    #${OVERLAY_ID} .call-info-status-dot--active {
      background: #6bdbb5;
      box-shadow: 0 0 8px rgba(107, 219, 181, 0.6);
    }
    #${OVERLAY_ID} .call-info-status-dot--idle {
      background: rgba(255, 255, 255, 0.3);
    }
    #${OVERLAY_ID} .call-info-empty {
      color: rgba(255, 255, 255, 0.6);
      font-size: 13px;
      text-align: center;
      padding: 12px 0;
    }
  `;
  document.head.appendChild(style);
}

function buildOverlayDom() {
  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `
    <div class="call-info-card" role="document">
      <div class="call-info-header">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
        <span class="call-info-title" data-ci="title"></span>
        <button type="button" class="call-info-close" data-ci="close" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div data-ci="body"></div>
    </div>
  `;

  // Click backdrop to close (but not clicks inside the card)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) hideCallInfoOverlay();
  });
  overlay.querySelector('[data-ci="close"]')?.addEventListener('click', () => hideCallInfoOverlay());

  return overlay;
}

function formatCountdown(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '00:00';
  const total = Math.floor(ms / 1000);
  const mm = Math.floor(total / 60).toString().padStart(2, '0');
  const ss = (total % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

function renderBody() {
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) return;
  const body = overlay.querySelector('[data-ci="body"]');
  if (!body) return;

  const keyCtx = getCallKeyContext();
  const mediaState = getCallMediaState();
  const hasActiveCall = !!(keyCtx || mediaState?.callId);

  if (!hasActiveCall) {
    body.innerHTML = `<div class="call-info-empty">${escapeHtml(t('calls.infoNoActiveCall'))}</div>`;
    return;
  }

  const epoch = keyCtx?.epoch ?? mediaState?.epoch ?? 0;
  const rotations = Math.max(0, (Number(epoch) || 0) - 1);
  const rotateInterval = Number(mediaState?.rotateIntervalMs) || 0;
  const nextRotateAt = Number(mediaState?.nextRotateAt) || 0;
  const hasRotation = rotateInterval > 0 && nextRotateAt > 0;
  const countdownMs = hasRotation ? Math.max(0, nextRotateAt - Date.now()) : 0;
  const active = hasRotation;

  const statusLabel = active
    ? t('calls.infoRotationActive')
    : t('calls.infoRotationIdle');
  const statusDotClass = active ? 'call-info-status-dot--active' : 'call-info-status-dot--idle';

  body.innerHTML = `
    <div class="call-info-grid">
      <div class="call-info-label">${escapeHtml(t('calls.infoRotationStatus'))}</div>
      <div class="call-info-value">
        <span class="call-info-status-dot ${statusDotClass}"></span>${escapeHtml(statusLabel)}
      </div>

      <div class="call-info-label">${escapeHtml(t('calls.infoRotationCount'))}</div>
      <div class="call-info-value">${rotations}</div>

      <div class="call-info-label">${escapeHtml(t('calls.infoNextRotation'))}</div>
      <div class="call-info-value" data-ci="countdown">${hasRotation ? formatCountdown(countdownMs) : '—'}</div>

      <div class="call-info-label">${escapeHtml(t('calls.infoKeyAlgorithm'))}</div>
      <div class="call-info-value call-info-value--mono">
        AES-256-GCM<br/>HKDF-SHA256
      </div>
    </div>
  `;
}

function tickCountdown() {
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) return;
  const mediaState = getCallMediaState();
  const keyCtx = getCallKeyContext();

  // If epoch changed (rotation just happened) or the entire keyContext appeared/disappeared,
  // re-render the whole body so rotation count + status update too.
  const currentEpoch = keyCtx?.epoch ?? mediaState?.epoch ?? 0;
  const prevEpoch = Number(overlay.dataset.epoch || 0);
  const hasCall = !!(keyCtx || mediaState?.callId);
  const prevHasCall = overlay.dataset.hasCall === '1';
  if (currentEpoch !== prevEpoch || hasCall !== prevHasCall) {
    overlay.dataset.epoch = String(currentEpoch);
    overlay.dataset.hasCall = hasCall ? '1' : '0';
    renderBody();
    return;
  }

  // Lightweight path: just update countdown text
  const nextRotateAt = Number(mediaState?.nextRotateAt) || 0;
  const countdownEl = overlay.querySelector('[data-ci="countdown"]');
  if (countdownEl && nextRotateAt > 0) {
    const ms = Math.max(0, nextRotateAt - Date.now());
    countdownEl.textContent = formatCountdown(ms);
  }
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export function showCallInfoOverlay() {
  ensureStyles();
  let overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) {
    overlay = buildOverlayDom();
    document.body.appendChild(overlay);
  }
  const titleEl = overlay.querySelector('[data-ci="title"]');
  if (titleEl) titleEl.textContent = t('calls.infoTitle');

  renderBody();

  if (!escHandler) {
    escHandler = (e) => {
      if (e.key === 'Escape') hideCallInfoOverlay();
    };
    document.addEventListener('keydown', escHandler);
  }
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(tickCountdown, POLL_INTERVAL_MS);
}

export function hideCallInfoOverlay() {
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay) overlay.remove();
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (escHandler) {
    document.removeEventListener('keydown', escHandler);
    escHandler = null;
  }
}
