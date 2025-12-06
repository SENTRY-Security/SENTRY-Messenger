

// /app/api/media.js
// Front-end API wrappers for media endpoints (sign-put, sign-get, create message index).
// ESM only; depends on core/http. No UI logic here.

import { fetchJSON } from '../core/http.js';
import { getAccountToken, getAccountDigest, buildAccountPayload } from '../core/store.js';

/**
 * Request a presigned PUT for uploading an encrypted object to R2.
 * @param {{ convId: string, contentType: string, dir?: string, conversationFingerprint?: string }} p
 * @returns {Promise<{ r: Response, data: any }>} data typically { upload:{url,key,fields?,headers?,method?}, objectPath, expiresIn }
 */
export async function signPut({ convId, contentType, dir, size, direction, accountToken, accountDigest, conversationFingerprint } = {}) {
  const resolvedConv = typeof convId === 'string' ? convId : '';
  if (!resolvedConv) throw new Error('convId required');
  const body = { convId: resolvedConv, contentType };
  if (dir) body.dir = dir;
  if (typeof size === 'number') body.size = size;
  if (direction) body.direction = direction;
  const token = accountToken || getAccountToken();
  if (token) body.accountToken = token;
  const digest = (accountDigest || getAccountDigest() || '').toUpperCase();
  if (digest) body.accountDigest = digest;
  if (conversationFingerprint) body.conversationFingerprint = conversationFingerprint;
  return await fetchJSON('/api/v1/media/sign-put', body);
}

/**
 * Request a short-lived GET URL for downloading an object from R2.
 * @param {{ key: string }} p
 * @returns {Promise<{ r: Response, data: any }>} data: { download:{url,bucket,key}, expiresIn }
 */
export async function signGet({ key, accountToken, accountDigest, conversationFingerprint } = {}) {
  const resolvedKey = typeof key === 'string' ? key : '';
  if (!resolvedKey) throw new Error('object key required');
  const body = { key: resolvedKey };
  const token = accountToken || getAccountToken();
  if (token) body.accountToken = token;
  const digest = (accountDigest || getAccountDigest() || '').toUpperCase();
  if (digest) body.accountDigest = digest;
  if (conversationFingerprint) body.conversationFingerprint = conversationFingerprint;
  return await fetchJSON('/api/v1/media/sign-get', body);
}

/**
 * Create a message index (e.g., store envelope JSON for media or DR header for text).
 * Caller prepares the body (validated server-side). This is a thin wrapper over POST /api/v1/messages.
 * @param {any} body
 * @returns {Promise<{ r: Response, data: any }>} data: backend response JSON
 */
export async function createMessage(body) {
  return await fetchJSON('/api/v1/messages', body, { 'X-Client-Id': 'webdemo' });
}

export async function deleteMediaKeys({ ids = [], keys = [], conversationId } = {}) {
  if (!conversationId) throw new Error('conversationId required');
  const overrides = { conversationId, ids };
  if (keys && keys.length) overrides.keys = keys;
  const payload = buildAccountPayload({ overrides });
  const { r, data } = await fetchJSON('/api/v1/messages/delete', payload, { 'X-Client-Id': 'webdemo' });
  if (!r.ok) {
    const msg = typeof data === 'string' ? data : data?.message || data?.error || 'delete failed';
    throw new Error(msg);
  }
  return { r, data };
}
