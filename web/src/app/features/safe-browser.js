// /app/features/safe-browser.js
// SAFE Browser — manages connection to a remote KasmVNC / noVNC browser instance.
//
// Supports two modes:
//   1. Direct iframe embed — for KasmVNC standalone (wss://host:6901)
//   2. Worker-proxied WebSocket — for CF Container deployment (future)
//
// The iframe approach is simplest and gives full KasmVNC client experience
// (keyboard, mouse, clipboard, resize) without custom WebRTC/VNC code.

import { log } from '../core/log.js';

const STORAGE_KEY = 'safe_endpoint';
const STORAGE_PW_KEY = 'safe_password';

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

// ── Endpoint persistence (sessionStorage — cleared on logout) ────

export function getSavedEndpoint() {
  try { return sessionStorage.getItem(STORAGE_KEY) || ''; } catch { return ''; }
}

export function getSavedPassword() {
  try { return sessionStorage.getItem(STORAGE_PW_KEY) || ''; } catch { return ''; }
}

export function saveEndpoint(endpoint, password) {
  try {
    sessionStorage.setItem(STORAGE_KEY, endpoint || '');
    sessionStorage.setItem(STORAGE_PW_KEY, password || '');
  } catch { /* quota / security */ }
}

export function clearEndpoint() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(STORAGE_PW_KEY);
  } catch { /* ignore */ }
}

// ── Connection ──────────────────────────────────────────────────

/**
 * Build the KasmVNC iframe URL from endpoint + password.
 *
 * KasmVNC serves its client at the root path on port 6901.
 * Query params: ?password=<pw> auto-connects without login prompt.
 *
 * For noVNC setups: /vnc.html?autoconnect=true&password=<pw>
 */
export function buildIframeUrl(endpoint, password) {
  if (!endpoint) return null;

  try {
    // Normalize: accept wss://, https://, or bare host:port
    let base = endpoint.trim();

    // If user entered a WebSocket URL, convert to HTTPS for iframe
    base = base.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://');

    // If no protocol, add https
    if (!/^https?:\/\//i.test(base)) {
      base = 'https://' + base;
    }

    const url = new URL(base);

    // KasmVNC auto-login: append password hash
    if (password) {
      url.searchParams.set('password', password);
    }

    // Detect noVNC vs KasmVNC based on path or port
    // KasmVNC: root path on 6901
    // noVNC: /vnc.html
    if (!url.pathname || url.pathname === '/') {
      // Default KasmVNC — root is fine
    }

    return url.toString();
  } catch (err) {
    log({ safeBuildUrlError: err?.message });
    return null;
  }
}

/**
 * Connect to a remote browser instance.
 * Sets up the iframe and monitors connectivity.
 */
export function connect(endpoint, password) {
  if (!endpoint) {
    setState('error', { message: 'No endpoint provided' });
    return false;
  }

  const iframeUrl = buildIframeUrl(endpoint, password);
  if (!iframeUrl) {
    setState('error', { message: 'Invalid endpoint URL' });
    return false;
  }

  saveEndpoint(endpoint, password);
  setState('connecting', { endpoint, iframeUrl });

  // The actual iframe load is handled by the UI layer (app-mobile.js)
  // We emit connecting state → UI sets iframe.src → iframe onload → connected

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
 * Attempt to reconnect using saved credentials.
 */
export function reconnect() {
  const endpoint = getSavedEndpoint();
  const password = getSavedPassword();
  if (endpoint) {
    connect(endpoint, password);
  } else {
    setState('disconnected');
  }
}
