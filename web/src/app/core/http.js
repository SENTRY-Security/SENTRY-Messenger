// core/http.js
// Small HTTP helpers for Cloudflare Pages front-end (ESM).
// - fetchWithTimeout(resource, options, timeoutMs)
// - fetchJSON(url, bodyObj, extraHeaders, timeoutMs)
// - jsonReq(obj, extraHeaders)
//
// NOTE: This module is UI-agnostic. Do not import UI/logging here.

import { log } from './log.js';
import { DEBUG } from '../ui/mobile/debug-flags.js';

const API_ORIGIN = (() => {
  if (typeof globalThis !== 'undefined' && typeof globalThis.API_ORIGIN === 'string') {
    const trimmed = globalThis.API_ORIGIN.trim();
    if (trimmed) return trimmed.replace(/\/$/, '');
  }
  return '';
})();

const FETCH_LOG_ENABLED = DEBUG.fetchNoise === true;

function resolveUrl(resource) {
  if (typeof resource === 'string' && resource.startsWith('/') && API_ORIGIN) {
    return API_ORIGIN + resource;
  }
  return resource;
}

function fmtResource(resource) {
  if (typeof resource === 'string') return resource;
  if (resource && typeof resource === 'object') {
    return resource.url || String(resource);
  }
  return String(resource);
}

function dispatchFetchEvent(name, detail) {
  try {
    const target = typeof window !== 'undefined' && window && typeof window.dispatchEvent === 'function'
      ? window
      : (typeof globalThis !== 'undefined' && typeof globalThis.dispatchEvent === 'function' ? globalThis : null);
    if (!target) return;
    const evt = typeof Event === 'function' ? new Event(name) : null;
    if (evt) {
      evt.detail = detail;
      target.dispatchEvent(evt);
    }
  } catch {}
}

/**
 * Perform a fetch with an AbortController-based timeout.
 * @param {RequestInfo} resource
 * @param {RequestInit} [options]
 * @param {number} [timeout=15000] milliseconds
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(resource, options = {}, timeout = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  const target = resolveUrl(resource);
  const detail = {
    resource: fmtResource(target),
    method: options?.method || 'GET',
    startedAt: Date.now()
  };
  dispatchFetchEvent('app:fetch-start', detail);
  try {
    if (FETCH_LOG_ENABLED) {
      log({ fetchStart: fmtResource(target), method: options?.method || 'GET', body: options?.body || null });
    }
    const fetchOptions = {
      ...options,
      cache: options?.cache ?? 'no-store',
      signal: controller.signal
    };
    const res = await fetch(target, fetchOptions);
    if (FETCH_LOG_ENABLED) {
      log({ fetchDone: fmtResource(resource), status: res?.status });
    }
    return res;
  } catch (err) {
    log({
      fetchFail: fmtResource(target),
      status: err?.status ?? null,
      error: err?.message || err
    });
    throw err;
  } finally {
    clearTimeout(id);
    detail.completedAt = Date.now();
    dispatchFetchEvent('app:fetch-end', detail);
  }
}

/**
 * Make a JSON POST request with timeout and parse the response.
 * Always returns { r: Response, data: any } where data is either parsed JSON or raw text.
 * @param {string} url
 * @param {any} bodyObj
 * @param {Record<string,string>} [extraHeaders]
 * @param {number} [timeout=15000]
 */
export async function fetchJSON(url, bodyObj, extraHeaders = {}, timeout = 15000) {
  const r = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      body: JSON.stringify(bodyObj)
    },
    timeout
  );
  const data = await safeParseJSON(r);
  if (FETCH_LOG_ENABLED) {
    log({ fetchJSONDone: fmtResource(url), status: r.status, dataPreview: previewData(data) });
  }
  return { r, data };
}

function previewData(data) {
  if (data === null || data === undefined) return data;
  if (typeof data === 'string') return data.slice(0, 120);
  if (typeof data === 'object') {
    try {
      return JSON.stringify(data).slice(0, 120);
    } catch {
      return '[object]';
    }
  }
  return data;
}

/**
 * Build a standard JSON RequestInit for fetch().
 * @param {any} obj
 * @param {Record<string,string>} [extraHeaders]
 * @returns {RequestInit}
 */
export function jsonReq(obj, extraHeaders = {}) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(obj)
  };
}

/**
 * Parse response body as JSON; if it fails, return text string.
 * @param {Response} r
 * @returns {Promise<any>}
 */
async function safeParseJSON(r) {
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
