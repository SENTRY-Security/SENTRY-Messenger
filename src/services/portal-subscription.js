import crypto from 'node:crypto';
import { logger } from '../utils/logger.js';

const PORTAL_ORIGIN = process.env.PORTAL_API_ORIGIN;
const PORTAL_HMAC_SECRET = process.env.PORTAL_HMAC_SECRET;

function ensurePortalConfig() {
  if (!PORTAL_ORIGIN || !PORTAL_HMAC_SECRET) {
    const err = new Error('Portal config missing');
    err.status = 500;
    throw err;
  }
}

function signHmac(path, body) {
  const secretBuf = (() => {
    try { return Buffer.from(PORTAL_HMAC_SECRET, 'hex'); } catch { return null; }
  })();
  const key = secretBuf && secretBuf.length ? secretBuf : Buffer.from(PORTAL_HMAC_SECRET);
  const msg = `${path}\n${body}`;
  return crypto.createHmac('sha256', key).update(msg).digest('hex');
}

async function parseJsonSafe(res) {
  const txt = await res.text();
  try { return JSON.parse(txt); } catch { return txt; }
}

export async function callPortal({ path, method = 'POST', bodyObj = null }) {
  ensurePortalConfig();
  const url = new URL(path, PORTAL_ORIGIN);
  const body = bodyObj ? JSON.stringify(bodyObj) : '';
  const headers = new Headers();
  headers.set('Content-Type', 'application/json');
  headers.set('X-Portal-HMAC', signHmac(url.pathname + url.search, body));

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: method === 'GET' ? undefined : body
  });

  const data = await parseJsonSafe(res).catch(() => null);
  if (!res.ok) {
    const err = new Error('PortalError');
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

export async function redeemSubscription(body) {
  return callPortal({ path: '/api/v1/subscription/redeem', method: 'POST', bodyObj: body });
}

export async function validateSubscription(body) {
  const payload = { ...(body || {}), dryRun: true };
  return callPortal({ path: '/api/v1/subscription/redeem', method: 'POST', bodyObj: payload });
}

export async function getSubscriptionStatus({ digest, limit }) {
  const params = new URLSearchParams();
  if (digest) params.set('digest', digest);
  if (limit) params.set('limit', String(limit));
  const path = `/api/v1/subscription/status?${params.toString()}`;
  return callPortal({ path, method: 'GET', bodyObj: null });
}
