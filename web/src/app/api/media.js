

// /app/api/media.js
// Front-end API wrappers for media endpoints (sign-put, sign-get, create message index).
// ESM only; depends on core/http. No UI logic here.

import { fetchJSON, jsonReq } from '../core/http.js';

/**
 * Request a presigned PUT for uploading an encrypted object to R2.
 * @param {{ convId: string, contentType: string, dir?: string }} p
 * @returns {Promise<{ r: Response, data: any }>} data typically { upload:{url,key,fields?,headers?,method?}, objectPath, expiresIn }
 */
export async function signPut({ convId, contentType, dir }) {
  const body = { convId, contentType };
  if (dir) body.dir = dir;
  return await fetchJSON('/api/v1/media/sign-put', body);
}

/**
 * Request a short-lived GET URL for downloading an object from R2.
 * @param {{ key: string }} p
 * @returns {Promise<{ r: Response, data: any }>} data: { download:{url,bucket,key}, expiresIn }
 */
export async function signGet({ key }) {
  return await fetchJSON('/api/v1/media/sign-get', { key });
}

/**
 * Create a message index (e.g., store envelope JSON for media or DR header for text).
 * Caller prepares the body (validated server-side). This is a thin wrapper over POST /api/v1/messages.
 * @param {any} body
 * @returns {Promise<{ r: Response, data: any }>} data: backend response JSON
 */
export async function createMessage(body) {
  const r = await fetch('/api/v1/messages', jsonReq(body, { 'X-Client-Id': 'webdemo' }));
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { r, data };
}

export async function deleteMediaKeys(payload) {
  const r = await fetch('/api/v1/messages/delete', jsonReq(payload, { 'X-Client-Id': 'webdemo' }));
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) {
    const msg = typeof data === 'string' ? data : data?.message || data?.error || 'delete failed';
    throw new Error(msg);
  }
  return { r, data };
}
