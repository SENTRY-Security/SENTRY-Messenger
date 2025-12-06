import { signHmac } from '../utils/hmac.js';
import { logger } from '../utils/logger.js';

const DATA_API_URL = process.env.DATA_API_URL || '';
const DATA_API_HMAC = process.env.DATA_API_HMAC || '';
const DEFAULT_TIMEOUT_MS = Number(process.env.DATA_API_TIMEOUT_MS || 8000);

export function hasCallWorkerConfig() {
  return Boolean(DATA_API_URL && DATA_API_HMAC);
}

export function ensureCallWorkerConfig(res = null) {
  if (hasCallWorkerConfig()) return true;
  if (res) {
    res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not configured' });
    return false;
  }
  const err = new Error('DATA_API_URL or DATA_API_HMAC not configured');
  err.code = 'CALL_WORKER_CONFIG_MISSING';
  throw err;
}

function withTimeout(task, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (typeof task !== 'function') {
    throw new TypeError('task must be a function');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return task();
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return task(controller.signal).finally(() => clearTimeout(timer));
}

export async function callWorkerRequest(path, { method = 'POST', body = null, timeout = DEFAULT_TIMEOUT_MS } = {}) {
  ensureCallWorkerConfig();
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const serialized = body !== undefined && body !== null ? JSON.stringify(body) : '';
  const sig = signHmac(normalizedPath, serialized, DATA_API_HMAC);
  const headers = { 'x-auth': sig };
  if (serialized) headers['content-type'] = 'application/json';
  const fetcher = async (signal) => {
    const resp = await fetch(`${DATA_API_URL}${normalizedPath}`, {
      method,
      headers,
      body: serialized || undefined,
      signal
    });
    const text = await resp.text().catch(() => '');
    let data;
    if (!text) {
      data = null;
    } else {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!resp.ok) {
      const err = new Error('worker request failed');
      err.status = resp.status;
      err.payload = data;
      throw err;
    }
    return data;
  };
  return withTimeout(fetcher, timeout);
}

export async function appendCallEvent({ callId, type, payload, fromUid, toUid, fromAccountDigest, toAccountDigest, traceId }) {
  if (!hasCallWorkerConfig()) {
    logger.warn({ callId, type }, 'call_event_append_skipped_missing_config');
    return null;
  }
  try {
    const res = await callWorkerRequest('/d1/calls/events', {
      method: 'POST',
      body: {
        callId,
        type,
        payload,
        fromUid,
        toUid,
        fromAccountDigest,
        toAccountDigest,
        traceId
      }
    });
    return res?.event || null;
  } catch (err) {
    logger.warn({
      msg: 'call_event_append_failed',
      callId,
      type,
      error: err?.message || err,
      status: err?.status
    });
    return null;
  }
}
