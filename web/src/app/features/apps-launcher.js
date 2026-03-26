// apps-launcher.js
// App-as-a-Service frontend — launches whitelisted Android apps via Genymotion Cloud.
// Shows an app grid; tapping an app starts/reuses the Android instance and opens
// a full-screen modal with the Genymotion Device Web Player (WebRTC stream).

import { startInstance, getInstanceStatus, stopInstance } from '../api/apps.js';
import { t } from '/locales/index.js';

// ── App icons (inline SVG per app) ──────────────────────────────
const APP_ICONS = {
  whatsapp:  '<svg viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="#25D366"/><path d="M24 10a14 14 0 0 0-12.12 21l-1.88 6.88 7.06-1.85A14 14 0 1 0 24 10Zm7.65 19.45c-.32.9-1.86 1.72-2.56 1.83s-1.42.16-2.38-.43a18.2 18.2 0 0 1-7-6.16c-.56-.75-1.88-2.85-.06-4.38.34-.35.72-.36 1-.36h.72c.32 0 .56.06.82.63l1.04 2.46c.14.33.06.63-.07.82l-.67.78c-.27.27-.16.58.15 1 .85 1.22 1.87 2.22 3.12 2.93.42.24.72.18 1-.08l.85-1c.3-.37.58-.28.94-.13l2.38 1.12c.35.17.58.28.67.44.1.17.1.97-.21 1.87Z" fill="#fff"/></svg>',
  telegram:  '<svg viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="#2AABEE"/><path d="M33.2 14.42 10.7 23.08c-1.53.62-1.52 1.47-.28 1.85l5.76 1.8 2.24 6.86c.27.75.14.95.82.95.52 0 .75-.24 1.04-.52l2.5-2.43 5.2 3.84c.96.53 1.65.26 1.89-.89l3.42-16.13c.35-1.4-.53-2.03-1.45-1.62Z" fill="#fff" fill-rule="evenodd"/></svg>',
  signal:    '<svg viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="#3A76F0"/><path d="M24 12a12 12 0 1 0 0 24 12 12 0 0 0 0-24Zm5.3 9.3-6 6a1 1 0 0 1-1.4 0l-3-3a1 1 0 1 1 1.4-1.4l2.3 2.3 5.3-5.3a1 1 0 1 1 1.4 1.4Z" fill="#fff"/></svg>',
  line:      '<svg viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="#06C755"/><path d="M40 21.54c0-6.63-6.64-12.04-14.8-12.04S10.4 14.9 10.4 21.54c0 5.95 5.28 10.94 12.4 11.88.48.1 1.14.32 1.3.73.15.37.1.96.05 1.34l-.2 1.23c-.06.37-.3 1.46 1.28.8s8.5-5 11.6-8.56c2.14-2.35 3.17-4.74 3.17-7.42Z" fill="#fff"/></svg>',
  wechat:    '<svg viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="#07C160"/><path d="M18.8 13c-5.96 0-10.8 4.18-10.8 9.34 0 2.93 1.5 5.56 3.85 7.34l-.96 2.88 3.34-1.67a12.7 12.7 0 0 0 4.57.83c.46 0 .9-.03 1.35-.07a8.44 8.44 0 0 1-.35-2.4c0-5.28 5-9.56 11.15-9.56.39 0 .77.02 1.15.05C30.76 15.63 25.26 13 18.8 13Z" fill="#fff"/><ellipse cx="30.95" cy="29.25" rx="9.05" ry="7.75" fill="#fff" opacity=".85"/></svg>',
  instagram: '<svg viewBox="0 0 48 48"><defs><linearGradient id="ig" x1="0" y1="48" x2="48" y2="0" gradientUnits="userSpaceOnUse"><stop stop-color="#FD5"/><stop offset=".5" stop-color="#FF543E"/><stop offset="1" stop-color="#C837AB"/></linearGradient></defs><rect width="48" height="48" rx="12" fill="url(#ig)"/><rect x="12" y="12" width="24" height="24" rx="6" stroke="#fff" stroke-width="2.5" fill="none"/><circle cx="24" cy="24" r="5.5" stroke="#fff" stroke-width="2.5" fill="none"/><circle cx="31.5" cy="16.5" r="1.8" fill="#fff"/></svg>',
  facebook:  '<svg viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="#1877F2"/><path d="M29 25.5l.75-5H25v-3.25c0-1.37.67-2.7 2.82-2.7H30V10.3S28.12 10 26.32 10C22.56 10 20 12.34 20 16.5v4h-4.5v5H20V38h5V25.5Z" fill="#fff"/></svg>',
  messenger: '<svg viewBox="0 0 48 48"><defs><linearGradient id="ms" x1="12" y1="38" x2="36" y2="10" gradientUnits="userSpaceOnUse"><stop stop-color="#00C6FF"/><stop offset="1" stop-color="#A020F0"/></linearGradient></defs><rect width="48" height="48" rx="12" fill="url(#ms)"/><path d="M24 10C16.28 10 10 15.73 10 22.78c0 3.93 1.96 7.44 5.03 9.74V38l4.93-2.71c1.31.37 2.7.56 4.14.56 7.72 0 14-5.73 14-12.78S31.72 10 24 10Zm1.4 17.22-3.57-3.81-6.96 3.81 7.65-8.13 3.66 3.81 6.88-3.81-7.66 8.13Z" fill="#fff"/></svg>',
};

// ── Local catalog (used as fallback when API is unreachable) ─────
export const APP_CATALOG_LOCAL = {
  whatsapp:  { package: 'com.whatsapp',             label: 'WhatsApp',  icon: 'whatsapp' },
  telegram:  { package: 'org.telegram.messenger',   label: 'Telegram',  icon: 'telegram' },
  signal:    { package: 'org.thoughtcrime.securesms', label: 'Signal',  icon: 'signal' },
  line:      { package: 'jp.naver.line.android',     label: 'LINE',     icon: 'line' },
  wechat:    { package: 'com.tencent.mm',            label: 'WeChat',   icon: 'wechat' },
  instagram: { package: 'com.instagram.android',     label: 'Instagram', icon: 'instagram' },
  facebook:  { package: 'com.facebook.katana',       label: 'Facebook', icon: 'facebook' },
  messenger: { package: 'com.facebook.orca',         label: 'Messenger', icon: 'messenger' },
};

// ── State ────────────────────────────────────────────────────────
let _pollTimer = null;
let _currentState = 'none'; // none | starting | online | error
let _streamInfo = null;
let _modalCleanup = null;

// ── Render the app grid into #tab-apps ──────────────────────────
export function renderAppsGrid(container, { catalog, onAppTap }) {
  if (!container) return;

  const grid = document.createElement('div');
  grid.className = 'apps-grid';

  for (const [slug, app] of Object.entries(catalog)) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'apps-grid-cell';
    cell.dataset.app = slug;
    cell.innerHTML = `
      <div class="apps-icon">${APP_ICONS[slug] || '<div class="apps-icon-placeholder">' + app.label[0] + '</div>'}</div>
      <span class="apps-label">${app.label}</span>`;
    cell.addEventListener('click', () => onAppTap(slug, app));
    grid.appendChild(cell);
  }

  container.innerHTML = '';

  // Header
  const header = document.createElement('div');
  header.className = 'apps-header';
  header.innerHTML = `
    <div class="apps-title">${t('apps.title') || 'Apps'}</div>
    <div class="apps-subtitle">${t('apps.subtitle') || ''}</div>`;
  container.appendChild(header);
  container.appendChild(grid);

  // Instance control bar (hidden until instance is active)
  const controlBar = document.createElement('div');
  controlBar.id = 'apps-control-bar';
  controlBar.className = 'apps-control-bar';
  controlBar.style.display = 'none';
  controlBar.innerHTML = `
    <span id="apps-status-text" class="apps-status-text"></span>
    <button type="button" id="apps-btn-stop" class="apps-btn-stop">
      ${t('apps.stopInstance') || 'Stop'}
    </button>`;
  container.appendChild(controlBar);

  // Stop button
  controlBar.querySelector('#apps-btn-stop')?.addEventListener('click', async () => {
    stopPolling();
    try { await stopInstance(); } catch {}
    _currentState = 'none';
    _streamInfo = null;
    updateControlBar();
  });
}

function updateControlBar() {
  const bar = document.getElementById('apps-control-bar');
  const text = document.getElementById('apps-status-text');
  if (!bar) return;
  if (_currentState === 'none') {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = '';
  if (text) {
    const labels = {
      starting: t('apps.instanceStarting') || 'Starting Android...',
      online: t('apps.instanceOnline') || 'Android ready',
      error: t('apps.instanceError') || 'Error',
    };
    text.textContent = labels[_currentState] || _currentState;
  }
}

// ── Instance lifecycle ──────────────────────────────────────────

export async function ensureInstanceReady() {
  if (_currentState === 'online' && _streamInfo?.wsUrl) return _streamInfo;

  // Try starting
  const startResult = await startInstance();
  _currentState = startResult.status === 'online' ? 'online' : 'starting';

  if (startResult.status === 'online') {
    _streamInfo = startResult;
    updateControlBar();
    return _streamInfo;
  }

  // Poll until online
  updateControlBar();
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const maxAttempts = 40; // 40 * 3s = 120s
    _pollTimer = setInterval(async () => {
      attempts++;
      try {
        const status = await getInstanceStatus();
        _currentState = status.status;
        updateControlBar();

        if (status.status === 'online') {
          stopPolling();
          _streamInfo = status;
          resolve(_streamInfo);
        } else if (status.status === 'error' || status.status === 'deleted') {
          stopPolling();
          _currentState = 'error';
          updateControlBar();
          reject(new Error(status.message || 'Instance failed'));
        } else if (attempts >= maxAttempts) {
          stopPolling();
          _currentState = 'error';
          updateControlBar();
          reject(new Error('Instance startup timed out'));
        }
      } catch (err) {
        stopPolling();
        _currentState = 'error';
        updateControlBar();
        reject(err);
      }
    }, 3000);
  });
}

function stopPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

// ── Full-screen app modal (WebRTC stream) ───────────────────────

export function openAppModal({ app, streamInfo, modalApi }) {
  const modalEl = document.getElementById('modal');
  const body = document.getElementById('modalBody');
  if (!modalEl || !body) return;

  _modalCleanup?.();

  modalEl.classList.add('safe-modal');
  document.getElementById('modalTitle').textContent = '';
  window.__setLandscapeAllowed?.(true);

  body.innerHTML = `
    <div class="apps-viewer">
      <div class="apps-viewer-loading" id="appsViewerLoading">
        <div class="loading-spinner"></div>
        <div class="apps-viewer-loading-text">${t('apps.connecting') || 'Connecting...'}</div>
      </div>
      <div id="appsPlayerContainer" class="apps-player-container"></div>
      <div class="apps-viewer-toolbar">
        <button type="button" class="apps-viewer-back" id="appsViewerBack">
          <svg viewBox="0 0 16 16" fill="none"><path d="M3 8h10M8 3l-5 5 5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <span class="apps-viewer-title">${app.label}</span>
      </div>
    </div>`;

  modalEl.style.display = 'flex';
  modalEl.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');

  // Load Genymotion Device Web Player
  const playerContainer = body.querySelector('#appsPlayerContainer');
  const loadingEl = body.querySelector('#appsViewerLoading');

  initDevicePlayer(playerContainer, streamInfo).then(() => {
    if (loadingEl) loadingEl.style.display = 'none';
  }).catch(err => {
    const text = loadingEl?.querySelector('.apps-viewer-loading-text');
    if (text) text.textContent = t('apps.connectionFailed') || 'Connection failed: ' + (err?.message || err);
  });

  const cleanup = () => {
    window.__setLandscapeAllowed?.(false);
    // Disconnect player
    const player = playerContainer?.__genyPlayer;
    if (player?.disconnect) player.disconnect();
    modalEl.classList.remove('safe-modal');
    modalEl.style.display = 'none';
    modalEl.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
    body.innerHTML = '';
    _modalCleanup = null;
  };

  body.querySelector('#appsViewerBack')?.addEventListener('click', cleanup);
  _modalCleanup = cleanup;
}

async function initDevicePlayer(container, streamInfo) {
  if (!container || !streamInfo) throw new Error('Missing container or stream info');

  // Dynamically import the Genymotion Device Web Player SDK
  // In production, this would be bundled or loaded from CDN
  const wsUrl = streamInfo.wsUrl || `wss://${streamInfo.instanceAddress}`;

  if (typeof window.genyDeviceWebPlayer !== 'undefined') {
    const { DeviceRendererFactory } = window.genyDeviceWebPlayer;
    const factory = new DeviceRendererFactory();
    const api = factory.setupRenderer(container, wsUrl, {
      template: 'renderer_no_toolbar',
      token: streamInfo.token || '',
      rotation: true,
      volume: false,
      navbar: false,
      power: false,
      keyboard: false,
      fullscreen: false,
      camera: false,
      fileUpload: false,
      clipboard: true,
      battery: false,
      gps: false,
      identifiers: false,
      network: false,
      phone: false,
      diskIO: false,
      biometrics: false,
      gamepad: false,
    });
    container.__genyPlayer = api;
    return api;
  }

  // Fallback: load SDK dynamically from CDN
  await loadGenySDK();
  return initDevicePlayer(container, streamInfo);
}

function loadGenySDK() {
  return new Promise((resolve, reject) => {
    if (typeof window.genyDeviceWebPlayer !== 'undefined') return resolve();
    // CSS
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://cdn.jsdelivr.net/npm/@genymotion/device-web-player@4.2.1/dist/css/device-renderer.min.css';
    document.head.appendChild(link);
    // JS
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/@genymotion/device-web-player@4.2.1/dist/js/device-renderer.min.js';
    script.onload = resolve;
    script.onerror = () => reject(new Error('Failed to load Genymotion SDK'));
    document.head.appendChild(script);
  });
}

export function cleanup() {
  stopPolling();
  _modalCleanup?.();
  _currentState = 'none';
  _streamInfo = null;
}
