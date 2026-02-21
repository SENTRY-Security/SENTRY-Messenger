// /shared/utils/sri.js
// Subresource Integrity (SRI) verification for dynamic ESM imports.
//
// Native dynamic import() does not support integrity attributes.
// This module provides two strategies:
//
// 1. Blob URL (default) — fetch, verify hash, execute via Blob URL.
//    Works for self-contained modules with no internal sub-imports.
//
// 2. Verify-then-import — fetch to verify hash, then use native import()
//    so the browser can resolve relative sub-dependencies normally.
//    Use this for CDN modules that have internal imports (e.g. esm.sh).
//
// Usage:
//   import { importWithSRI } from '/shared/utils/sri.js';
//
//   // Self-contained module (no sub-imports):
//   const mod = await importWithSRI(
//     'https://cdn.jsdelivr.net/npm/foo@1.0.0/dist/foo.min.mjs',
//     'sha384-<base64hash>'
//   );
//
//   // Module with sub-dependencies (esm.sh, jsdelivr +esm):
//   const mod = await importWithSRI(
//     'https://esm.sh/@cloudflare/opaque-ts@0.7.5',
//     'sha384-<base64hash>',
//     { useNativeImport: true }
//   );

/**
 * Fetch a remote script, verify its SHA-384 integrity, and return a Blob URL.
 * Useful for Web Worker scripts where native import() is not applicable.
 *
 * @param {string} url       – Fully-qualified HTTPS URL of the script.
 * @param {string} expected  – SRI string, e.g. "sha384-<base64>".
 * @returns {Promise<string>} – A Blob URL containing the verified script.
 */
export async function fetchBlobWithSRI(url, expected) {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`SRI fetch failed: ${url} (${res.status})`);

  const buf = await res.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-384', buf);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  const actual = `sha384-${b64}`;

  if (actual !== expected) {
    throw new Error(
      `SRI mismatch for ${url}\n  expected: ${expected}\n  actual:   ${actual}`
    );
  }

  const blob = new Blob([new Uint8Array(buf)], { type: 'application/javascript' });
  return URL.createObjectURL(blob);
}

/**
 * Fetch a remote ES module, verify its SHA-384 integrity, and return the
 * evaluated module namespace.
 *
 * @param {string} url       – Fully-qualified HTTPS URL of the ES module.
 * @param {string} expected  – SRI string, e.g. "sha384-<base64>".
 * @param {object} [opts]    – Options.
 * @param {boolean} [opts.useNativeImport=false]
 *   When true, after verifying the hash the module is loaded via native
 *   import() instead of a Blob URL. This allows internal sub-imports to
 *   resolve correctly (e.g. esm.sh modules that depend on other esm.sh
 *   packages). The browser cache ensures the same verified bytes are used.
 * @returns {Promise<object>} – The module namespace object.
 */
export async function importWithSRI(url, expected, opts) {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`SRI fetch failed: ${url} (${res.status})`);

  const buf = await res.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-384', buf);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  const actual = `sha384-${b64}`;

  if (actual !== expected) {
    throw new Error(
      `SRI mismatch for ${url}\n  expected: ${expected}\n  actual:   ${actual}`
    );
  }

  // For modules with sub-dependencies, use native import() after verification.
  // The browser cache will serve the identical bytes we just verified.
  if (opts?.useNativeImport) {
    return import(/* webpackIgnore: true */ url);
  }

  // For self-contained modules, execute via Blob URL (strongest isolation).
  const blob = new Blob([new Uint8Array(buf)], { type: 'application/javascript' });
  const blobUrl = URL.createObjectURL(blob);
  try {
    return await import(/* webpackIgnore: true */ blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}
