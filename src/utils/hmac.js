

import crypto from 'node:crypto';

/**
 * Compute an HMAC-SHA256 signature and return base64url encoded string.
 *
 * @param {string} pathWithQS - The request path with optional query string, e.g. "/d1/messages?convId=123"
 * @param {string} body - The request body string (empty string for GET)
 * @param {string} secret - The HMAC secret key
 * @returns {string} - base64url encoded HMAC signature
 */
export function signHmac(pathWithQS, body, secret) {
  // 支援舊版文件 path + "\n" + body，也可用 "|"。這裡保持 "|"，Worker 端會同時接受兩者。
  const msg = `${pathWithQS}|${body || ''}`;
  return crypto.createHmac('sha256', secret).update(msg).digest('base64url');
}
