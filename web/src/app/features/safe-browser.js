// /app/features/safe-browser.js
// SAFE Browser — fully automatic browser session management.
//
// Flow:
//   1. User opens SAFE tab → autoStart() called
//   2. POST /api/safe/start → Worker starts CF Container, returns { password }
//   3. iframe.src = {workerUrl}/api/safe/browser/?password={auto-generated}
//   4. User sees Chromium immediately — zero config needed
//
// The Worker URL is resolved from SAFE_WORKER_URL env or derived from app origin.

import { log } from '../core/log.js';
import { getAccountToken } from '../core/store.js';

// ── State machine ────────────────────────────────────────────────

let _state = 'idle'; // idle | starting | connected | stopped | error
let _listeners = [];
let _iframeUrl = null;
let _lastError = null;
let _pollTimer = null;
let _containerStatus = null; // raw container state from backend (e.g. 'starting', 'running')
let _elapsed = null;         // seconds since container start was requested

export function getState() { return _state; }
export function getIframeUrl() { return _iframeUrl; }
export function getLastError() { return _lastError; }
export function getContainerStatus() { return _containerStatus; }
export function getElapsed() { return _elapsed; }

export function onStateChange(fn) {
  _listeners.push(fn);
  return () => { _listeners = _listeners.filter(f => f !== fn); };
}

function setState(next, detail) {
  const prev = _state;
  _state = next;
  if (detail?.iframeUrl) _iframeUrl = detail.iframeUrl;
  if (detail?.error) _lastError = detail.error;
  for (const fn of _listeners) {
    try { fn(next, detail, prev); } catch (e) { log({ safeBrowserStateError: e?.message }); }
  }
}

// ── Worker URL resolution ────────────────────────────────────────

function getWorkerUrl() {
  // 1. Explicit global config (set by build or runtime)
  if (typeof globalThis !== 'undefined' && typeof globalThis.SAFE_WORKER_URL === 'string') {
    const url = globalThis.SAFE_WORKER_URL.trim();
    if (url) return url.replace(/\/+$/, '');
  }
  // 2. Same-origin: safe-worker deployed as route on same domain
  //    (via Cloudflare Pages Function or Service Binding)
  return window.location.origin;
}

// ── API calls ────────────────────────────────────────────────────

function authHeaders() {
  const token = getAccountToken?.() || '';
  return {
    'Authorization': 'Bearer ' + token,
    'Content-Type': 'application/json',
  };
}

/**
 * Start the container. Worker auto-generates VNC password.
 * Returns { status, password, browserPath }.
 */
async function apiStart() {
  const base = getWorkerUrl();
  const res = await fetch(base + '/api/safe/start', {
    method: 'POST',
    headers: {
      'Authorization': authHeaders()['Authorization'],
    },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.message || `Start failed (${res.status})`);
  }
  return res.json();
}

/**
 * Stop the container.
 */
async function apiStop() {
  const base = getWorkerUrl();
  await fetch(base + '/api/safe/stop', {
    method: 'POST',
    headers: {
      'Authorization': authHeaders()['Authorization'],
    },
  }).catch(() => {});
}

/**
 * Destroy the container and clear all session data.
 */
async function apiDestroy() {
  const base = getWorkerUrl();
  await fetch(base + '/api/safe/destroy', {
    method: 'DELETE',
    headers: {
      'Authorization': authHeaders()['Authorization'],
    },
  }).catch(() => {});
}

/**
 * Get container status.
 */
async function apiStatus() {
  const base = getWorkerUrl();
  const res = await fetch(base + '/api/safe/status', {
    headers: {
      'Authorization': authHeaders()['Authorization'],
    },
  });
  if (!res.ok) return { status: 'unknown' };
  return res.json();
}

// ── iframe URL builder ───────────────────────────────────────────

function buildIframeUrl(password) {
  const base = getWorkerUrl();
  const url = new URL(base + '/api/safe/browser/vnc.html');
  url.searchParams.set('autoconnect', 'true');
  url.searchParams.set('resize', 'scale');
  // Tell noVNC the correct WebSocket path (proxied through /api/safe/browser/)
  url.searchParams.set('path', 'api/safe/browser/websockify');
  if (password) url.searchParams.set('password', password);
  return url.toString();
}

// ── Polling ──────────────────────────────────────────────────────

function stopPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

function startPolling(password) {
  stopPolling();
  _pollTimer = setInterval(async () => {
    try {
      const data = await apiStatus();
      _containerStatus = data.status;
      _elapsed = data.elapsed;

      // Build iframeUrl as soon as container is running (ports may not be ready yet)
      if ((data.status === 'running' || data.status === 'healthy') && !_iframeUrl) {
        _iframeUrl = buildIframeUrl(password);
      }

      // Notify listeners so UI can update the status text
      for (const fn of _listeners) {
        try { fn(_state, { containerStatus: data.status, elapsed: data.elapsed, iframeUrl: _iframeUrl }); }
        catch (e) { /* ignore */ }
      }

      // Container is fully healthy — stop polling
      if (data.status === 'healthy') {
        stopPolling();
        setState('starting', { iframeUrl: buildIframeUrl(password) });
      }
    } catch (err) {
      log({ safePollError: err?.message });
    }
  }, 3000);
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Auto-start a browser session. Called when SAFE tab is opened.
 * No user input required.
 */
export async function autoStart() {
  // Already running — don't restart
  if (_state === 'starting' || _state === 'connected') return;

  setState('starting');
  _containerStatus = null;
  _elapsed = null;

  try {
    const result = await apiStart();

    if (result.status === 'healthy') {
      // Container already healthy — load iframe immediately
      setState('starting', { iframeUrl: buildIframeUrl(result.password) });
    } else {
      // Container is starting/running/building — poll every 3s until healthy
      _containerStatus = result.status;
      setState('starting', { containerStatus: result.status, elapsed: 0 });
      startPolling(result.password);
    }
  } catch (err) {
    log({ safeAutoStartError: err?.message });
    setState('error', { error: err?.message || 'Failed to start browser' });
  }
}

/**
 * Mark as connected (called by UI when iframe loads).
 */
export function markConnected() {
  setState('connected');
}

/**
 * Mark error (called by UI on iframe error).
 */
export function markError(message) {
  setState('error', { error: message || 'Connection failed' });
}

/**
 * Stop the browser session.
 */
export async function stop() {
  stopPolling();
  setState('stopped');
  _iframeUrl = null;
  await apiStop();
}

/**
 * Destroy the container — stops it and deletes all associated data.
 */
export async function destroy() {
  stopPolling();
  setState('stopped');
  _iframeUrl = null;
  await apiDestroy();
}

/**
 * Resume after stop — just auto-start again.
 */
export function resume() {
  autoStart();
}

/**
 * Retry after error — just auto-start again.
 */
export function retry() {
  autoStart();
}
