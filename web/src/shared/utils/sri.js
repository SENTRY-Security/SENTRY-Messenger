// /shared/utils/sri.js
// Subresource Integrity (SRI) verification for dynamic ESM imports.
//
// Native dynamic import() does not support integrity attributes.
// This module fetches the script text, verifies its SHA-384 hash against a
// known-good digest, then executes via a Blob URL so the browser treats it
// as a same-origin ES module.
//
// Usage:
//   import { importWithSRI } from '/shared/utils/sri.js';
//   const mod = await importWithSRI(
//     'https://cdn.jsdelivr.net/npm/foo@1.0.0/+esm',
//     'sha384-<base64hash>'
//   );

/**
 * Fetch a remote ES module, verify its SHA-384 integrity, and return the
 * evaluated module namespace.
 *
 * @param {string} url   – Fully-qualified HTTPS URL of the ES module.
 * @param {string} expected – SRI string, e.g. "sha384-<base64>".
 * @returns {Promise<object>} – The module namespace object.
 */
export async function importWithSRI(url, expected) {
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

  // Execute the verified source as a same-origin ES module via Blob URL.
  const blob = new Blob([new Uint8Array(buf)], { type: 'application/javascript' });
  const blobUrl = URL.createObjectURL(blob);
  try {
    return await import(/* webpackIgnore: true */ blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}
