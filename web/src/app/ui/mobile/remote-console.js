import { buildAccountPayload, getUidHex, getAccountToken, getAccountDigest } from '../../core/store.js';

const STORAGE_KEY_ENABLED = 'remoteConsole:enabled';
const STORAGE_KEY_ENDPOINT = 'remoteConsole:endpoint';
const DEFAULT_FLUSH_INTERVAL = 2000;
const MAX_BUFFER_SIZE = 40;

const state = {
  enabled: false,
  endpoint: null,
  buffer: [],
  timer: null,
  flushing: false,
  userPreferenceSet: false,
  serverEnabled: false
};

function getApiOrigin() {
  try {
    if (typeof window !== 'undefined' && typeof window.API_ORIGIN === 'string') {
      const trimmed = window.API_ORIGIN.trim();
      if (trimmed) return trimmed.replace(/\/$/, '');
    }
  } catch {}
  return '';
}

function getDefaultEndpoint() {
  const base = getApiOrigin();
  return `${base || ''}/api/v1/debug/console`;
}

function getConfigEndpoint() {
  const base = getApiOrigin();
  return `${base || ''}/api/v1/debug/config`;
}

function applyQueryOverrides() {
  try {
    if (typeof window === 'undefined' || !window.location || !window.location.search) return;
    const params = new URLSearchParams(window.location.search);
    if (params.has('remoteConsole')) {
      const flag = params.get('remoteConsole');
      state.enabled = flag !== '0' && flag !== 'false';
      state.userPreferenceSet = true;
    }
    if (params.has('remoteConsoleEndpoint')) {
      const ep = params.get('remoteConsoleEndpoint') || '';
      if (ep) state.endpoint = ep;
      state.userPreferenceSet = true;
    }
  } catch {}
}

function loadConfig() {
  try {
    const rawEnabled = localStorage.getItem(STORAGE_KEY_ENABLED);
    if (rawEnabled !== null) {
      state.enabled = rawEnabled === 'true';
      state.userPreferenceSet = true;
    } else {
      state.enabled = false;
      state.userPreferenceSet = false;
    }
    const storedEndpoint = localStorage.getItem(STORAGE_KEY_ENDPOINT);
    state.endpoint = storedEndpoint || getDefaultEndpoint();
  } catch {
    state.enabled = false;
    state.endpoint = getDefaultEndpoint();
    state.userPreferenceSet = false;
  }
  applyQueryOverrides();
}

function persistConfig() {
  try {
    localStorage.setItem(STORAGE_KEY_ENABLED, state.enabled ? 'true' : 'false');
    if (state.endpoint) {
      localStorage.setItem(STORAGE_KEY_ENDPOINT, state.endpoint);
    }
  } catch {}
}

function serializeArg(arg) {
  if (arg == null) return arg;
  if (typeof arg === 'string' || typeof arg === 'number' || typeof arg === 'boolean') return arg;
  if (arg instanceof Error) {
    return { error: arg.message, stack: arg.stack };
  }
  try {
    return JSON.parse(JSON.stringify(arg));
  } catch (err) {
    try {
      return { value: String(arg), note: 'non-serializable' };
    } catch {
      return '[unserializable]';
    }
  }
}

function coerceMessage(args = []) {
  if (!args.length) return '';
  if (typeof args[0] === 'string') return args[0];
  const first = serializeArg(args[0]);
  return typeof first === 'string' ? first : JSON.stringify(first);
}

function scheduleFlush() {
  if (state.flushing || state.timer || state.buffer.length === 0) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    flushBuffer().catch(() => {});
  }, DEFAULT_FLUSH_INTERVAL);
}

function disableFlushTimer() {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

async function flushBuffer() {
  if (!state.enabled || state.buffer.length === 0 || state.flushing) return;
  if (!getUidHex() || (!getAccountToken() && !getAccountDigest())) {
    scheduleFlush();
    return;
  }
  state.flushing = true;
  disableFlushTimer();
  const entries = state.buffer.splice(0, MAX_BUFFER_SIZE);
  const payload = buildAccountPayload({
    includeUid: true,
    overrides: {
      entries,
      clientTs: Date.now(),
      meta: { relay: 'remote-console' }
    }
  });
  try {
    await fetch(state.endpoint || getDefaultEndpoint(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    state.buffer.unshift(...entries);
  } finally {
    state.flushing = false;
    if (state.buffer.length > 0) scheduleFlush();
  }
}

function bufferEntry(level, args) {
  if (!state.enabled) return;
  state.buffer.push({
    level,
    message: coerceMessage(args),
    args: args?.map(serializeArg) || [],
    ts: Date.now(),
    source: 'app'
  });
  if (state.buffer.length >= MAX_BUFFER_SIZE) {
    flushBuffer().catch(() => {});
  } else {
    scheduleFlush();
  }
}

function patchConsole() {
  if (typeof console === 'undefined') return;
  if (console.__REMOTE_CONSOLE_PATCHED__) return;
  const methods = ['log', 'info', 'warn', 'error'];
  const original = {};
  for (const method of methods) {
    if (typeof console[method] !== 'function') continue;
    original[method] = console[method].bind(console);
    console[method] = (...args) => {
      try {
        original[method]?.(...args);
      } catch {}
      try {
        bufferEntry(method, args);
      } catch {}
    };
  }
  Object.defineProperty(console, '__REMOTE_CONSOLE_PATCHED__', {
    value: true,
    enumerable: false,
    configurable: false
  });
}

function enableRelay({ endpoint, persist = true } = {}) {
  if (endpoint) state.endpoint = endpoint;
  state.enabled = true;
  if (persist) {
    state.userPreferenceSet = true;
    persistConfig();
  }
  scheduleFlush();
}

function disableRelay({ persist = true } = {}) {
  state.enabled = false;
  if (persist) {
    state.userPreferenceSet = true;
    persistConfig();
  }
  disableFlushTimer();
}

async function fetchServerConfig() {
  try {
    const res = await fetch(getConfigEndpoint(), { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    state.serverEnabled = !!data?.enabled;
    if (state.serverEnabled && !state.userPreferenceSet) {
      const endpoint = data.endpoint || state.endpoint || getDefaultEndpoint();
      enableRelay({ endpoint, persist: false });
    }
    if (!state.serverEnabled && !state.userPreferenceSet) {
      disableRelay({ persist: false });
    }
  } catch {}
}

export function initRemoteConsoleRelay() {
  loadConfig();
  patchConsole();
  if (state.enabled) {
    scheduleFlush();
  }
  fetchServerConfig().catch(() => {});
  if (typeof window !== 'undefined') {
    window.RemoteConsoleRelay = {
      enable: (endpoint) => enableRelay({ endpoint, persist: true }),
      disable: () => disableRelay({ persist: true }),
      setEndpoint: (endpoint) => {
        state.endpoint = endpoint || getDefaultEndpoint();
        persistConfig();
      },
      status: () => ({ enabled: state.enabled, endpoint: state.endpoint, serverEnabled: state.serverEnabled })
    };
  }
}
