const MSG_PREFIX = '[msg]';
const DR_CORE_PREFIX = '[dr-core]';
const UI_NOISE_PREFIX = '[ui-noise]';

const uiNoiseThrottle = new Map();
const MSG_REQUIRED_FIELDS = [
  'conversationId',
  'messageId',
  'serverMessageId',
  'direction',
  'senderDigest',
  'senderDeviceId',
  'peerDigest',
  'peerDeviceId',
  'msgType',
  'gate',
  'stage'
];

function readStorageFlag(key) {
  try {
    if (typeof sessionStorage !== 'undefined') {
      const val = sessionStorage.getItem(key);
      if (val != null) return val;
    }
  } catch {}
  try {
    if (typeof localStorage !== 'undefined') {
      const val = localStorage.getItem(key);
      if (val != null) return val;
    }
  } catch {}
  return null;
}

function isTruthyFlag(val) {
  if (val === null || typeof val === 'undefined') return false;
  const lowered = String(val).toLowerCase();
  return lowered === '1' || lowered === 'true' || lowered === 'yes';
}

function isHarnessEnv() {
  try {
    if (typeof navigator !== 'undefined' && navigator.webdriver) return true;
    if (typeof window !== 'undefined' && (window.__HARNESS__ || window.__HARNESS_MODE__)) return true;
  } catch {}
  return false;
}

export function shouldLogDrCore() {
  if (isHarnessEnv()) return true;
  try {
    if (typeof window !== 'undefined' && window.__DEBUG_DR_STATE__) return true;
  } catch {}
  const sessionFlag = readStorageFlag('debug-dr-log') || readStorageFlag('debug-dr');
  return isTruthyFlag(sessionFlag);
}

export function shouldLogUiNoise() {
  try {
    if (typeof window !== 'undefined' && window.__DEBUG_UI__) return true;
  } catch {}
  return isTruthyFlag(readStorageFlag('debug-ui'));
}

function logJsonLine(prefix, payload) {
  try {
    const line = JSON.stringify(payload);
    console.log(`${prefix} ${line}`);
  } catch {
    try {
      console.log(`${prefix} ${String(payload?.event || 'log')}`);
    } catch {
      /* ignore logging errors */
    }
  }
}

function stageFromEvent(event = '') {
  const ev = String(event || '').toLowerCase();
  if (ev.startsWith('send')) return 'send';
  if (ev.startsWith('fetch')) return 'fetch';
  if (ev.startsWith('enqueue')) return 'enqueue';
  if (ev.startsWith('handle')) return 'handle';
  if (ev.startsWith('decrypt')) return 'decrypt';
  if (ev.startsWith('ui')) return 'ui';
  return null;
}

function normalizeMsgPayload(event, payload = {}) {
  const normalized = {
    event,
    action: payload?.action || payload?.event || event,
    ...payload
  };
  normalized.conversationId = payload?.conversationId ?? payload?.convId ?? payload?.conversation_id ?? normalized.conversationId ?? null;
  normalized.messageId = payload?.messageId ?? payload?.msgId ?? payload?.id ?? normalized.messageId ?? null;
  normalized.serverMessageId =
    payload?.serverMessageId ?? payload?.serverMsgId ?? payload?.server_message_id ?? normalized.serverMessageId ?? null;
  normalized.direction = payload?.direction ?? normalized.direction ?? null;
  normalized.senderDigest = payload?.senderDigest ?? payload?.sender_digest ?? normalized.senderDigest ?? null;
  normalized.senderDeviceId = payload?.senderDeviceId ?? payload?.sender_device_id ?? normalized.senderDeviceId ?? null;
  normalized.peerDigest =
    payload?.peerDigest ?? payload?.peerAccountDigest ?? payload?.peer_account_digest ?? normalized.peerDigest ?? null;
  normalized.peerDeviceId =
    payload?.peerDeviceId ?? payload?.peer_device_id ?? payload?.targetDeviceId ?? payload?.target_device_id ?? normalized.peerDeviceId ?? null;
  normalized.msgType = payload?.msgType ?? payload?.msg_type ?? payload?.type ?? normalized.msgType ?? null;
  normalized.gate = payload?.gate ?? payload?.reason ?? normalized.gate ?? null;
  normalized.stage = payload?.stage ?? stageFromEvent(event) ?? normalized.stage ?? null;
  for (const key of MSG_REQUIRED_FIELDS) {
    if (typeof normalized[key] === 'undefined') normalized[key] = null;
  }
  return normalized;
}

export function logMsgEvent(event, payload = {}, opts = {}) {
  const normalized = normalizeMsgPayload(event, payload);
  const level = opts.level || (normalized.gate ? 'warn' : 'log');
  const loggerPayload = { ...normalized };
  if (level === 'error') {
    logJsonLine(MSG_PREFIX, { ...loggerPayload, level: 'error' });
  } else {
    logJsonLine(MSG_PREFIX, loggerPayload);
  }
}

export function logDrCore(event, payload = {}, opts = {}) {
  if (!shouldLogDrCore() && !opts.force) return;
  logJsonLine(DR_CORE_PREFIX, { event, ...payload });
}

export function logUiNoise(event, payload = {}, opts = {}) {
  const throttleMs = Number(opts?.throttleMs) || 0;
  const throttleKey = opts?.throttleKey || event;
  const debugEnabled = shouldLogUiNoise();
  if (!debugEnabled && !throttleMs && !opts?.force) return;

  const shouldThrottle = throttleMs > 0 && (!debugEnabled || opts?.throttleWhenDebug) && !opts?.force;
  if (shouldThrottle) {
    const now = Date.now();
    const last = uiNoiseThrottle.get(throttleKey) || 0;
    if (!opts?.force && now - last < throttleMs) return;
    uiNoiseThrottle.set(throttleKey, now);
  }

  logJsonLine(UI_NOISE_PREFIX, { event, ...payload });
}
