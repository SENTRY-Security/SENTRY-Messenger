

// core/log.js
// Minimal logging utility for front-end modules (ESM).
// - setLogSink(fn | Element | selectorString)
// - log(any)
// - installGlobalErrorLogging()
//
// The sink can be:
//  1) a function (line: string) => void
//  2) a DOM Element (we append textContent with \n)
//  3) a CSS selector string (resolved once at setLogSink)
//
// If no sink is set, logs fall back to console.log.
import { DEBUG } from '../ui/mobile/debug-flags.js';

// Only keep high-signal replay/forensic events by default.
const REPLAY_DEBUG_KEYS = new Set([
  'conversationResetTrace',
  'replayGateTrace',
  'historyReplayFlagTrace',
  'replayInvariantViolation',
  'replayDrPathBlocked',
  'replayCallsite',
  'replayFetchResult',
  'replaySummary',
  'replaySkipSample',
  'vaultPutAttempt',
  'vaultPutResult',
  'vaultGetAttempt',
  'vaultGetResult',
  'vaultUnwrapErrorTrace',
  'avatarWriteTrace',
  'avatar:env-written',
  'mkHardblockTrace',
  'mkUnwrapHardblockTrace',
  'deviceIdRestoreTrace',
  'contactSecretsRoleNormalizeTrace',
  'secureModalGateTrace',
  'sendPreflightSecretTrace',
  'contactSecretsRestoreTrace',
  'contactSecretsSanitizeDropTrace',
  'vaultGateDecisionTrace',
  'contactSecretWriteTrace'
]);
const REPLAY_ACTION_VALUES = new Set();
const FETCH_NOISE_KEYS = new Set(['fetchStart', 'fetchDone', 'fetchJSONDone', 'fetchFail']);
const WS_NOISE_KEYS = new Set(['wsEnsure', 'wsConnectStart', 'wsConnectResult', 'wsDisconnect']);
const QUEUE_NOISE_KEYS = new Set(['queue', 'enqueue', 'dequeue', 'queueState']);
const UI_NOISE_KEYS = new Set(['messagesRendered', 'messagesRenderLogError', 'uiNoise', 'probeReplay', 'action']);
const TICK_NOISE_KEYS = new Set(['tick', 'tickState']);
const PRESENCE_NOISE_KEYS = new Set(['presence', 'presenceUpdate', 'presenceSnapshot', 'presenceState']);

let _sink = null;   // function | Element | null
let _sinkIsFn = false;

function shouldAllowReplayPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const action = typeof payload.action === 'string' ? payload.action : null;
  if (action && REPLAY_ACTION_VALUES.has(action)) return true;
  for (const key of REPLAY_DEBUG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) return true;
  }
  return false;
}

function shouldSuppress(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const keys = Object.keys(payload);
  const hasFetchNoise = keys.some((key) => FETCH_NOISE_KEYS.has(key));
  if (hasFetchNoise && DEBUG.fetchNoise !== true) return true;
  const hasWsNoise = keys.some((key) => WS_NOISE_KEYS.has(key));
  if (hasWsNoise && DEBUG.ws !== true) return true;
  const hasQueueNoise = keys.some((key) => QUEUE_NOISE_KEYS.has(key));
  if (hasQueueNoise && DEBUG.queueNoise !== true) return true;
  const hasUiNoise = keys.some((key) => UI_NOISE_KEYS.has(key));
  if (hasUiNoise && DEBUG.uiNoise !== true) return true;
  const hasTickNoise = keys.some((key) => key.startsWith('tick') || TICK_NOISE_KEYS.has(key));
  if (hasTickNoise && DEBUG.uiNoise !== true) return true;
  const hasPresenceNoise = keys.some((key) => key.startsWith('presence') || PRESENCE_NOISE_KEYS.has(key));
  if (hasPresenceNoise && DEBUG.uiNoise !== true) return true;
  const replayKey = keys.find((key) => key.startsWith('replay'));
  if (replayKey && !REPLAY_DEBUG_KEYS.has(replayKey)) return true;
  const drNoise = keys.some((key) => key.startsWith('dr') || key.includes('ratchet'));
  if (drNoise && DEBUG.drVerbose !== true && DEBUG.drCounter !== true) return true;
  return false;
}

function shouldEmit(payload) {
  if (!payload || typeof payload !== 'object') return true;
  if (shouldAllowReplayPayload(payload)) return true;
  // Preserve explicit error logs even when filters are active.
  const hasError = Object.prototype.hasOwnProperty.call(payload, 'error')
    || Object.prototype.hasOwnProperty.call(payload, 'errorMessage')
    || Object.keys(payload || {}).some((key) => key.toLowerCase().includes('error'));
  if (hasError) return true;
  if (shouldSuppress(payload)) return false;
  const debugBypass = DEBUG.uiNoise === true
    || DEBUG.queueNoise === true
    || DEBUG.fetchNoise === true
    || DEBUG.ws === true
    || DEBUG.drVerbose === true
    || DEBUG.drCounter === true;
  if (debugBypass) return true;
  return false;
}

/**
 * Configure the log sink.
 * @param {Function | Element | string | null} target
 */
export function setLogSink(target) {
  if (!target) {
    _sink = null; _sinkIsFn = false; return;
  }
  if (typeof target === 'function') {
    _sink = target; _sinkIsFn = true; return;
  }
  if (typeof target === 'string') {
    const el = typeof document !== 'undefined' ? document.querySelector(target) : null;
    _sink = el || null; _sinkIsFn = false; return;
  }
  // assume Element
  _sink = target; _sinkIsFn = false;
}

function stringify(x) {
  try {
    if (typeof x === 'string') return x;
    return JSON.stringify(x, null, 2);
  } catch {
    return String(x);
  }
}

/**
 * Log a line to sink or console.
 * @param {any} x
 */
export function log(x) {
  if (!shouldEmit(x)) return;
  const line = stringify(x);
  // Write to configured sink (UI panel or custom handler)
  if (_sinkIsFn && typeof _sink === 'function') {
    try { _sink(line); } catch { /* ignore sink errors */ }
  } else if (_sink && typeof _sink.textContent === 'string') {
    try {
      const needsNL = _sink.textContent && !_sink.textContent.endsWith('\n');
      _sink.textContent += (needsNL ? '\n' : '') + line;
    } catch { /* ignore sink errors */ }
  }
  // Always mirror to native console for debugging.
  try { console.log(line); } catch { /* ignore console errors */ }
}

/**
 * Install global error logging to the current sink (or console).
 * Safe to call multiple times.
 */
export function installGlobalErrorLogging() {
  if (typeof window === 'undefined') return;
  if (window.__globalLogInstalled) return;
  window.__globalLogInstalled = true;
  window.addEventListener('error', (e) => {
    log({ jsError: String(e?.error?.message || e?.message || e) });
  });
  window.addEventListener('unhandledrejection', (e) => {
    log({ unhandledRejection: String(e?.reason?.message || e?.reason || e) });
  });
}

// optional default install
try { installGlobalErrorLogging(); } catch {}
