// /app/features/safe-browser.js
// SAFE Browser — manages connection to a KasmVNC browser instance.
//
// Two modes:
//   1. CF Container mode — Worker at SAFE_WORKER_URL proxies to container
//      iframe src = {SAFE_WORKER_URL}/api/safe/browser/?password=...
//   2. Direct mode — connect to a self-hosted KasmVNC/noVNC instance
//      iframe src = https://your-server:6901/?password=...

import { log } from '../core/log.js';

const STORAGE_KEY = 'safe_endpoint';
const STORAGE_PW_KEY = 'safe_password';
const STORAGE_MODE_KEY = 'safe_mode';

let _state = 'disconnected'; // disconnected | connecting | connected | error
let _listeners = [];

export function getState() { return _state; }

export function onStateChange(fn) {
  _listeners.push(fn);
  return () => { _listeners = _listeners.filter(f => f !== fn); };
}

function setState(next, detail) {
  _state = next;
  for (const fn of _listeners) {
    try { fn(next, detail); } catch (e) { log({ safeBrowserStateError: e?.message }); }
  }
}

// ── Persistence (sessionStorage — cleared on logout) ─────────────

export function getSavedEndpoint() {
  try { return sessionStorage.getItem(STORAGE_KEY) || ''; } catch { return ''; }
}

export function getSavedPassword() {
  try { return sessionStorage.getItem(STORAGE_PW_KEY) || ''; } catch { return ''; }
}

export function getSavedMode() {
  try { return sessionStorage.getItem(STORAGE_MODE_KEY) || 'direct'; } catch { return 'direct'; }
}

export function saveConfig(endpoint, password, mode) {
  try {
    sessionStorage.setItem(STORAGE_KEY, endpoint || '');
    sessionStorage.setItem(STORAGE_PW_KEY, password || '');
    sessionStorage.setItem(STORAGE_MODE_KEY, mode || 'direct');
  } catch { /* quota / security */ }
}

export function clearConfig() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(STORAGE_PW_KEY);
    sessionStorage.removeItem(STORAGE_MODE_KEY);
  } catch { /* ignore */ }
}

// ── URL builders ─────────────────────────────────────────────────

/**
 * Build iframe URL for CF Container mode.
 * The Worker proxies /api/safe/browser/* → KasmVNC port 6901.
 */
function buildContainerIframeUrl(workerUrl, password) {
  try {
    const base = workerUrl.replace(/\/+$/, '');
    const url = new URL(base + '/api/safe/browser/');
    if (password) url.searchParams.set('password', password);
    return url.toString();
  } catch (err) {
    log({ safeBuildContainerUrlError: err?.message });
    return null;
  }
}

/**
 * Build iframe URL for direct KasmVNC/noVNC connection.
 */
function buildDirectIframeUrl(endpoint, password) {
  if (!endpoint) return null;
  try {
    let base = endpoint.trim();
    base = base.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://');
    if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
    const url = new URL(base);
    if (password) url.searchParams.set('password', password);
    return url.toString();
  } catch (err) {
    log({ safeBuildDirectUrlError: err?.message });
    return null;
  }
}

// ── CF Container API calls ───────────────────────────────────────

/**
 * Start the CF Container via Worker API.
 * Returns { status, browserPath } on success.
 */
async function startContainer(workerUrl, authToken, password) {
  const base = workerUrl.replace(/\/+$/, '');
  const res = await fetch(base + '/api/safe/start', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + authToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ password: password || 'sentry' }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.message || `Start failed: ${res.status}`);
  }
  return res.json();
}

/**
 * Check container status via Worker API.
 */
async function getContainerStatus(workerUrl, authToken) {
  const base = workerUrl.replace(/\/+$/, '');
  const res = await fetch(base + '/api/safe/status', {
    headers: { 'Authorization': 'Bearer ' + authToken },
  });
  if (!res.ok) return { status: 'unknown' };
  return res.json();
}

/**
 * Stop the CF Container via Worker API.
 */
async function stopContainer(workerUrl, authToken) {
  const base = workerUrl.replace(/\/+$/, '');
  await fetch(base + '/api/safe/stop', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + authToken },
  }).catch(() => {});
}

// ── Connection ───────────────────────────────────────────────────

/**
 * Connect in CF Container mode.
 * Starts the container, then loads KasmVNC via Worker proxy.
 */
export async function connectContainer(workerUrl, password, authToken) {
  if (!workerUrl) {
    setState('error', { message: 'No Worker URL provided' });
    return false;
  }
  if (!authToken) {
    setState('error', { message: 'No auth token' });
    return false;
  }

  saveConfig(workerUrl, password, 'container');
  setState('connecting', { mode: 'container' });

  try {
    // Start the container (may take 2-10s for cold start)
    await startContainer(workerUrl, authToken, password);

    // Build iframe URL through the Worker proxy
    const iframeUrl = buildContainerIframeUrl(workerUrl, password);
    if (!iframeUrl) throw new Error('Failed to build browser URL');

    setState('connecting', { mode: 'container', iframeUrl });
    return true;
  } catch (err) {
    setState('error', { message: err?.message || 'Container start failed' });
    return false;
  }
}

/**
 * Connect in direct mode (self-hosted KasmVNC/noVNC).
 */
export function connectDirect(endpoint, password) {
  if (!endpoint) {
    setState('error', { message: 'No endpoint provided' });
    return false;
  }

  const iframeUrl = buildDirectIframeUrl(endpoint, password);
  if (!iframeUrl) {
    setState('error', { message: 'Invalid endpoint URL' });
    return false;
  }

  saveConfig(endpoint, password, 'direct');
  setState('connecting', { mode: 'direct', iframeUrl });
  return true;
}

/**
 * Signal that the iframe has loaded successfully.
 */
export function markConnected() {
  setState('connected');
}

/**
 * Signal a connection error.
 */
export function markError(message) {
  setState('error', { message: message || 'Connection failed' });
}

/**
 * Disconnect from the remote browser.
 */
export function disconnect() {
  setState('disconnected');
}

/**
 * Attempt to reconnect using saved config.
 */
export function reconnect() {
  const endpoint = getSavedEndpoint();
  const password = getSavedPassword();
  const mode = getSavedMode();
  if (!endpoint) {
    setState('disconnected');
    return;
  }
  if (mode === 'container') {
    // Can't reconnect container mode without auth token — show setup
    setState('disconnected');
  } else {
    connectDirect(endpoint, password);
  }
}
