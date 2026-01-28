import { signHmac } from './hmac.js';

const DATA_API = process.env.DATA_API_URL;
const HMAC_SECRET = process.env.DATA_API_HMAC;

// Allow Signal-style conversationIds plus system-owned identifiers with colon separator (e.g., profile:<digest>)
export const ConversationIdRegex = /^[A-Za-z0-9_:-]{8,128}$/;

export function normalizeConversationId(value) {
  if (!value) return null;
  const token = String(value).trim();
  if (!token) return null;
  if (!ConversationIdRegex.test(token)) return null;
  return token;
}

export function isSystemOwnedConversation({ convId, accountDigest }) {
  if (!convId) return false;
  const acct = (accountDigest || '').toUpperCase();
  if (acct) {
    if (convId === `drive-${acct}`) return true;
    if (convId === `profile-${acct}` || convId === `profile:${acct}`) return true;
    if (convId === `settings-${acct}`) return true;
    if (convId === `avatar-${acct}`) return true;
    if (convId === `contacts-${acct}`) return true;
  }
  return false;
}

export async function authorizeConversationAccess({ convId, accountDigest, deviceId = null }) {
  if (!DATA_API || !HMAC_SECRET) {
    const err = new Error('DATA_API_URL or DATA_API_HMAC not configured');
    err.status = 500;
    throw err;
  }
  const bodyObj = { conversationId: convId, accountDigest };
  if (deviceId) bodyObj.deviceId = deviceId;
  const path = '/d1/conversations/authorize';
  const body = JSON.stringify(bodyObj);
  const sig = signHmac(path, body, HMAC_SECRET);
  const res = await fetch(`${DATA_API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-auth': sig },
    body
  });
  let raw = '';
  try { raw = await res.text(); } catch { raw = ''; }
  let data = raw;
  if (raw) {
    try { data = JSON.parse(raw); } catch {/* ignore */ }
  }
  if (!res.ok) {
    const err = new Error(`conversation authorization failed (${res.status})`);
    err.status = res.status;
    err.details = data;
    throw err;
  }
  return data;
}
