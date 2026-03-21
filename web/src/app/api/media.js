

// /app/api/media.js
// Front-end API wrappers for media endpoints (sign-put, sign-get, create message index).
// ESM only; depends on core/http. No UI logic here.

import { fetchJSON } from '../core/http.js';
import { getAccountToken, getAccountDigest, buildAccountPayload, ensureDeviceId, allocateDeviceCounter, setDeviceCounter } from '../core/store.js';
import { fetchSecureMaxCounter } from './messages.js';

/**
 * Request a presigned PUT for uploading an encrypted object to R2.
 * @param {{ convId: string, contentType: string, dir?: string }} p
 * @returns {Promise<{ r: Response, data: any }>} data typically { upload:{url,key,fields?,headers?,method?}, objectPath, expiresIn }
 */
export async function signPut({ convId, contentType, dir, size, direction, accountToken, accountDigest } = {}) {
  const resolvedConv = typeof convId === 'string' ? convId : '';
  if (!resolvedConv) throw new Error('convId required');
  const body = { conv_id: resolvedConv, content_type: contentType };
  const headers = {};
  const deviceId = ensureDeviceId();
  if (deviceId) headers['X-Device-Id'] = deviceId;
  if (dir) body.dir = dir;
  if (typeof size === 'number') body.size = size;
  if (direction) body.direction = direction;
  const token = accountToken || getAccountToken();
  if (token) body.account_token = token;
  const digest = (accountDigest || getAccountDigest() || '').toUpperCase();
  if (digest) body.account_digest = digest;
  return await fetchJSON('/api/v1/media/sign-put', body, headers);
}

/**
 * Request a short-lived GET URL for downloading an object from R2.
 * @param {{ key: string }} p
 * @returns {Promise<{ r: Response, data: any }>} data: { download:{url,bucket,key}, expiresIn }
 */
export async function signGet({ key, accountToken, accountDigest } = {}) {
  const resolvedKey = typeof key === 'string' ? key : '';
  if (!resolvedKey) throw new Error('object key required');
  const body = { key: resolvedKey };
  const headers = {};
  const deviceId = ensureDeviceId();
  if (deviceId) headers['X-Device-Id'] = deviceId;
  const token = accountToken || getAccountToken();
  if (token) body.account_token = token;
  const digest = (accountDigest || getAccountDigest() || '').toUpperCase();
  if (digest) body.account_digest = digest;
  return await fetchJSON('/api/v1/media/sign-get', body, headers);
}

/**
 * Create a message index (e.g., store envelope JSON for media or DR header for text).
 * Caller prepares the body (validated server-side). This is a thin wrapper over POST /api/v1/messages.
 * @param {any} body
 * @returns {Promise<{ r: Response, data: any }>} data: backend response JSON
 */
export async function createMessage(body) {
  const headers = { 'X-Client-Id': 'webdemo' };
  let attempt = 0;
  let lastRes = null;
  while (attempt < 2) {
    const { deviceId, counter, commit } = allocateDeviceCounter();
    headers['X-Device-Id'] = deviceId;

    const payload = { ...body };
    const messageId = typeof payload.id === 'string' && payload.id.trim().length ? payload.id.trim() : null;
    if (!messageId) throw new Error('id (messageId) required');
    payload.id = messageId;
    // Normalize convId → conv_id
    const convId = payload.conv_id || payload.convId || null;
    if (!convId) throw new Error('conv_id required');
    payload.conv_id = convId;
    delete payload.convId;
    const accountDigest = (payload.account_digest || payload.accountDigest || getAccountDigest() || '').toUpperCase();
    if (!accountDigest) throw new Error('accountDigest required');
    payload.account_digest = accountDigest;
    delete payload.accountDigest;
    payload.counter = counter;
    const receiverDigest = (payload.receiver_account_digest || payload.receiverAccountDigest || accountDigest || '').toUpperCase();
    if (!receiverDigest) throw new Error('receiverAccountDigest required');
    payload.receiver_account_digest = receiverDigest;
    delete payload.receiverAccountDigest;
    const receiverDeviceId = payload.receiver_device_id || payload.receiverDeviceId || deviceId;
    if (!receiverDeviceId) throw new Error('receiverDeviceId required');
    payload.receiver_device_id = receiverDeviceId;
    delete payload.receiverDeviceId;

    if (payload.header && typeof payload.header === 'object') {
      const headerObj = { ...payload.header };
      headerObj.n = counter;
      if (!headerObj.v) headerObj.v = 1;
      if (deviceId) headerObj.device_id = headerObj.device_id || deviceId;
      payload.header = headerObj;
      payload.header_json = JSON.stringify(headerObj);
    }
    try {
      console.log('[media.api] createMessage', { deviceId, convId: payload.conv_id || payload.convId || null, counter, attempt });
    } catch {}
    const res = await fetchJSON('/api/v1/messages', payload, headers);
    lastRes = res;
    if (res?.r?.ok) {
      try { commit(); } catch {}
      return res;
    }
    try {
      console.warn('[media.api] createMessage failed', {
        status: res?.r?.status,
        convId: payload.conv_id || payload.convId || null,
        error: res?.data || res
      });
    } catch {}
    const detail = res?.data || res;
    const errCode = detail?.error || detail?.code || null;
    if (res?.r?.status === 409 && errCode === 'CounterTooLow') {
      // Try to recover: get maxCounter from response or fetch from server
      let maxCounter = detail?.details?.max_counter ?? detail?.details?.maxCounter ?? detail?.maxCounter ?? detail?.max_counter;
      if (!Number.isFinite(maxCounter)) {
        try {
          const probe = await fetchSecureMaxCounter({ conversationId: payload.conv_id, senderDeviceId: deviceId });
          if (probe?.r?.ok && Number.isFinite(probe?.data?.maxCounter)) {
            maxCounter = probe.data.maxCounter;
          }
        } catch {}
      }
      if (Number.isFinite(maxCounter)) {
        try { setDeviceCounter(Number(maxCounter)); } catch {}
      }
      attempt += 1;
      continue;
    }
    return res;
  }
  return lastRes;
}

/**
 * Request presigned PUT URLs for a chunked upload (manifest + N chunk objects).
 * @param {{ convId: string, totalSize: number, chunkCount: number, contentType?: string, direction?: string, dir?: string }} p
 * @returns {Promise<{ r: Response, data: { baseKey: string, manifest: object, chunks: object[], expiresIn: number } }>}
 */
export async function signPutChunked({ convId, totalSize, chunkCount, contentType, direction, dir, accountToken, accountDigest } = {}) {
  const resolvedConv = typeof convId === 'string' ? convId : '';
  if (!resolvedConv) throw new Error('convId required');
  const body = { conv_id: resolvedConv, total_size: totalSize, chunk_count: chunkCount };
  const headers = {};
  const deviceId = ensureDeviceId();
  if (deviceId) headers['X-Device-Id'] = deviceId;
  if (contentType) body.content_type = contentType;
  if (direction) body.direction = direction;
  if (dir) body.dir = dir;
  const token = accountToken || getAccountToken();
  if (token) body.account_token = token;
  const digest = (accountDigest || getAccountDigest() || '').toUpperCase();
  if (digest) body.account_digest = digest;
  return await fetchJSON('/api/v1/media/sign-put-chunked', body, headers);
}

/**
 * Request presigned GET URLs for chunked download (manifest + optional chunk indices).
 * @param {{ baseKey: string, chunkIndices?: number[] }} p
 * @returns {Promise<{ r: Response, data: { manifest: object, chunks: object[], expiresIn: number } }>}
 */
export async function signGetChunked({ baseKey, chunkIndices, accountToken, accountDigest } = {}) {
  if (!baseKey) throw new Error('baseKey required');
  const body = { base_key: baseKey };
  const headers = {};
  const deviceId = ensureDeviceId();
  if (deviceId) headers['X-Device-Id'] = deviceId;
  if (chunkIndices && chunkIndices.length > 0) body.chunk_indices = chunkIndices;
  const token = accountToken || getAccountToken();
  if (token) body.account_token = token;
  const digest = (accountDigest || getAccountDigest() || '').toUpperCase();
  if (digest) body.account_digest = digest;
  return await fetchJSON('/api/v1/media/sign-get-chunked', body, headers);
}

/**
 * Cleanup a failed chunked upload (delete all objects under the base key).
 * @param {{ baseKey: string }} p
 */
export async function cleanupChunked({ baseKey, accountToken, accountDigest } = {}) {
  if (!baseKey) throw new Error('baseKey required');
  const body = { base_key: baseKey };
  const headers = {};
  const deviceId = ensureDeviceId();
  if (deviceId) headers['X-Device-Id'] = deviceId;
  const token = accountToken || getAccountToken();
  if (token) body.account_token = token;
  const digest = (accountDigest || getAccountDigest() || '').toUpperCase();
  if (digest) body.account_digest = digest;
  return await fetchJSON('/api/v1/media/cleanup-chunked', body, headers);
}

/**
 * Server-side R2 copy of a single object to the user's drive.
 * @param {{ sourceKey: string, destConvId: string, destDir?: string }} p
 * @returns {Promise<{ r: Response, data: { ok: boolean, dest_key: string } }>}
 */
export async function copyMedia({ sourceKey, destConvId, destDir, accountToken, accountDigest } = {}) {
  if (!sourceKey) throw new Error('sourceKey required');
  if (!destConvId) throw new Error('destConvId required');
  const body = { source_key: sourceKey, dest_conv_id: destConvId };
  const headers = {};
  const deviceId = ensureDeviceId();
  if (deviceId) headers['X-Device-Id'] = deviceId;
  if (destDir) body.dest_dir = destDir;
  const token = accountToken || getAccountToken();
  if (token) body.account_token = token;
  const digest = (accountDigest || getAccountDigest() || '').toUpperCase();
  if (digest) body.account_digest = digest;
  return await fetchJSON('/api/v1/media/copy', body, headers);
}

/**
 * Server-side R2 copy of a chunked (multi-object) file to the user's drive.
 * @param {{ sourceBaseKey: string, chunkCount: number, destConvId: string, destDir?: string }} p
 * @returns {Promise<{ r: Response, data: { ok: boolean, dest_base_key: string } }>}
 */
export async function copyChunkedMedia({ sourceBaseKey, chunkCount, destConvId, destDir, accountToken, accountDigest } = {}) {
  if (!sourceBaseKey) throw new Error('sourceBaseKey required');
  if (!destConvId) throw new Error('destConvId required');
  const body = { source_base_key: sourceBaseKey, chunk_count: chunkCount, dest_conv_id: destConvId };
  const headers = {};
  const deviceId = ensureDeviceId();
  if (deviceId) headers['X-Device-Id'] = deviceId;
  if (destDir) body.dest_dir = destDir;
  const token = accountToken || getAccountToken();
  if (token) body.account_token = token;
  const digest = (accountDigest || getAccountDigest() || '').toUpperCase();
  if (digest) body.account_digest = digest;
  return await fetchJSON('/api/v1/media/copy-chunked', body, headers);
}

export async function deleteMediaKeys({ ids = [], keys = [], conversationId } = {}) {
  if (!conversationId) throw new Error('conversationId required');
  const overrides = { conversation_id: conversationId, ids };
  if (keys && keys.length) overrides.keys = keys;
  const payload = buildAccountPayload({ overrides });
  const headers = { 'X-Client-Id': 'webdemo' };
  try {
    const deviceId = ensureDeviceId();
    if (deviceId) headers['X-Device-Id'] = deviceId;
  } catch {
    // keep headers without deviceId; backend will reject if missing
  }
  const { r, data } = await fetchJSON('/api/v1/messages/delete', payload, headers);
  if (!r.ok) {
    const msg = typeof data === 'string' ? data : data?.message || data?.error || 'delete failed';
    throw new Error(msg);
  }
  return { r, data };
}
