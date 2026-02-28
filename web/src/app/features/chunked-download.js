// /app/features/chunked-download.js
// Chunked encrypted download: fetch manifest, then download + decrypt chunks
// with concurrent downloads and URL prefetching for streaming playback.

import { signGetChunked as apiSignGetChunked } from '../api/media.js';
import { getMkRaw } from '../core/store.js';
import { decryptWithMK as aeadDecryptWithMK, b64u8 } from '../crypto/aead.js';

const CHUNK_INFO_TAG = 'media/chunk-v1';
const MANIFEST_INFO_TAG = 'media/manifest-v1';

// Timeout for a single chunk download (fetch + read body)
const CHUNK_DOWNLOAD_TIMEOUT_MS = 30_000;
// Max retries for a single chunk download or API call
const MAX_RETRIES = 3;

function normalizeSharedKey(input) {
  if (!input) return null;
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (typeof input === 'string') {
    try { return b64u8(input); } catch { return null; }
  }
  return null;
}

/**
 * Resolve the decryption key from the manifest envelope.
 */
function resolveKey(manifestEnvelope) {
  const keyType = String(manifestEnvelope?.key_type || 'mk').toLowerCase();
  if (keyType === 'shared') {
    const keyB64 = manifestEnvelope.key_b64 || manifestEnvelope.keyB64;
    if (!keyB64) throw new Error('No shared media key in manifest envelope');
    const key = normalizeSharedKey(keyB64);
    if (!key) throw new Error('Shared media key invalid');
    return key;
  }
  const mk = getMkRaw();
  if (!mk) throw new Error('Not unlocked: MK not ready');
  return mk;
}

/**
 * Create an AbortSignal that fires on timeout OR when the parent signal aborts.
 */
function withTimeout(parentSignal, ms) {
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(new DOMException('Download timed out', 'TimeoutError')), ms);
  const cleanup = () => clearTimeout(tid);
  ac.signal.addEventListener('abort', cleanup, { once: true });
  if (parentSignal) {
    if (parentSignal.aborted) { cleanup(); ac.abort(parentSignal.reason); }
    else parentSignal.addEventListener('abort', () => { cleanup(); ac.abort(parentSignal.reason); }, { once: true });
  }
  return ac.signal;
}

/**
 * Download a single URL as Uint8Array using fetch, with per-request timeout.
 */
async function fetchAsUint8Array(url, abortSignal) {
  const signal = withTimeout(abortSignal, CHUNK_DOWNLOAD_TIMEOUT_MS);
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`download failed (status ${res.status})`);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Retry an async operation with exponential backoff.
 * Rethrows AbortError immediately without retrying.
 */
async function withRetry(fn, { maxRetries = MAX_RETRIES, label = '', abortSignal } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (abortSignal?.aborted) throw new DOMException('aborted', 'AbortError');
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Don't retry user-initiated aborts
      if (err.name === 'AbortError' && abortSignal?.aborted) throw err;
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
        console.warn(`[chunked-dl] ${label} attempt ${attempt + 1}/${maxRetries + 1} failed: ${err?.message}, retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

/**
 * Download and decrypt the manifest for a chunked media file.
 *
 * @param {{ baseKey: string, manifestEnvelope: object }} params
 * @returns {Promise<object>} The decrypted manifest JSON
 */
export async function downloadChunkedManifest({ baseKey, manifestEnvelope, abortSignal }) {
  if (!baseKey) throw new Error('baseKey required');
  if (!manifestEnvelope) throw new Error('manifestEnvelope required');

  const cryptoKey = resolveKey(manifestEnvelope);

  // Get signed URL for manifest
  const { r, data } = await apiSignGetChunked({ baseKey });
  if (!r.ok) throw new Error('sign-get-chunked failed: ' + JSON.stringify(data));
  const { manifest: manifestGet } = data;
  if (!manifestGet?.url) throw new Error('sign-get-chunked returned no manifest URL');

  // Download encrypted manifest
  const cipherU8 = await fetchAsUint8Array(manifestGet.url, abortSignal);

  // Decrypt manifest
  const plain = await aeadDecryptWithMK(
    cipherU8,
    cryptoKey,
    b64u8(manifestEnvelope.hkdf_salt_b64),
    b64u8(manifestEnvelope.iv_b64),
    manifestEnvelope.info_tag || MANIFEST_INFO_TAG
  );

  return JSON.parse(new TextDecoder().decode(plain));
}

/**
 * Download and decrypt a single chunk.
 *
 * @param {{ chunkUrl: string, encryptionKey: Uint8Array, chunkMeta: object, abortSignal?: AbortSignal }} params
 * @returns {Promise<Uint8Array>} Decrypted chunk data
 */
export async function downloadAndDecryptChunk({ chunkUrl, encryptionKey, chunkMeta, abortSignal }) {
  const cipherU8 = await fetchAsUint8Array(chunkUrl, abortSignal);
  return aeadDecryptWithMK(
    cipherU8,
    encryptionKey,
    b64u8(chunkMeta.salt_b64),
    b64u8(chunkMeta.iv_b64),
    CHUNK_INFO_TAG
  );
}

/**
 * Get signed download URLs for specific chunk indices (with retry).
 *
 * @param {{ baseKey: string, chunkIndices: number[], abortSignal?: AbortSignal }} params
 * @returns {Promise<Map<number, string>>} Map of index → signed URL
 */
export async function getChunkUrls({ baseKey, chunkIndices, abortSignal }) {
  return withRetry(async () => {
    const { r, data } = await apiSignGetChunked({ baseKey, chunkIndices });
    if (!r.ok) throw new Error('sign-get-chunked failed: ' + JSON.stringify(data));
    const map = new Map();
    for (const c of (data.chunks || [])) {
      map.set(c.index, c.url);
    }
    return map;
  }, { label: `getChunkUrls [${chunkIndices[0]}..${chunkIndices[chunkIndices.length - 1]}]`, abortSignal });
}

/**
 * Async generator that streams decrypted chunks with concurrent downloads.
 * Yields { index, data: Uint8Array, progress: number } for each chunk **in order**.
 *
 * Optimizations over sequential download:
 * 1. Concurrent downloads (default 3) — multiple chunks in-flight simultaneously
 * 2. Larger URL signing batches (20) — fewer API round-trips
 * 3. URL prefetching — next batch's signed URLs are requested while current batch downloads
 *
 * @param {{ baseKey: string, manifest: object, manifestEnvelope: object, abortSignal?: AbortSignal, onProgress?: Function, concurrency?: number }} params
 */
export async function* streamChunks({ baseKey, manifest, manifestEnvelope, abortSignal, onProgress, concurrency = 3 }) {
  const cryptoKey = resolveKey(manifestEnvelope);
  const totalChunks = manifest.totalChunks;

  // Larger batches to reduce API round-trips (signed URLs are valid for minutes)
  const URL_BATCH_SIZE = 20;
  const CONCURRENCY = Math.max(1, Math.min(concurrency, 6));

  let prefetchPromise = null;

  for (let batchStart = 0; batchStart < totalChunks; batchStart += URL_BATCH_SIZE) {
    if (abortSignal?.aborted) throw new DOMException('aborted', 'AbortError');

    const batchEnd = Math.min(batchStart + URL_BATCH_SIZE, totalChunks);
    const indices = [];
    for (let i = batchStart; i < batchEnd; i++) indices.push(i);

    // Use prefetched URLs from previous iteration, or fetch now
    const urlMap = prefetchPromise
      ? await prefetchPromise
      : await getChunkUrls({ baseKey, chunkIndices: indices, abortSignal });
    prefetchPromise = null;

    // Prefetch next batch's signed URLs while we download the current batch
    const nextBatchStart = batchEnd;
    if (nextBatchStart < totalChunks) {
      const nextEnd = Math.min(nextBatchStart + URL_BATCH_SIZE, totalChunks);
      const nextIndices = [];
      for (let i = nextBatchStart; i < nextEnd; i++) nextIndices.push(i);
      prefetchPromise = getChunkUrls({ baseKey, chunkIndices: nextIndices, abortSignal });
    }

    // --- Concurrent downloads with ordered yield ---
    // Sliding window: up to CONCURRENCY downloads in-flight, yield in index order.
    const downloads = new Map(); // index → Promise<Uint8Array>
    let head = 0; // next position in `indices` to yield
    let tail = 0; // next position in `indices` to start downloading

    const launchNext = () => {
      while (tail < indices.length && tail - head < CONCURRENCY) {
        const idx = indices[tail++];
        const url = urlMap.get(idx);
        const chunkMeta = manifest.chunks[idx];
        if (!url) { downloads.set(idx, Promise.reject(new Error(`No signed URL for chunk ${idx}`))); continue; }
        if (!chunkMeta) { downloads.set(idx, Promise.reject(new Error(`No metadata for chunk ${idx}`))); continue; }
        downloads.set(idx, withRetry(
          () => downloadAndDecryptChunk({ chunkUrl: url, encryptionKey: cryptoKey, chunkMeta, abortSignal }),
          { label: `chunk ${idx}/${totalChunks}`, abortSignal }
        ));
      }
    };

    launchNext();

    while (head < indices.length) {
      if (abortSignal?.aborted) throw new DOMException('aborted', 'AbortError');

      const idx = indices[head];
      const data = await downloads.get(idx);
      downloads.delete(idx);
      head++;
      launchNext(); // refill window

      const progress = (idx + 1) / totalChunks;
      onProgress?.({ chunkIndex: idx, totalChunks, progress, percent: Math.round(progress * 100) });

      yield { index: idx, data, progress };
    }
  }
}

/**
 * Download all chunks and assemble into a single Blob (fallback for non-MSE playback).
 *
 * @param {{ baseKey: string, manifest: object, manifestEnvelope: object, abortSignal?: AbortSignal, onProgress?: Function }} params
 * @returns {Promise<{ blob: Blob, contentType: string, name: string }>}
 */
export async function downloadAllChunks({ baseKey, manifest, manifestEnvelope, abortSignal, onProgress }) {
  const parts = [];
  for await (const { data } of streamChunks({ baseKey, manifest, manifestEnvelope, abortSignal, onProgress })) {
    parts.push(data);
  }
  const contentType = manifest.contentType || 'application/octet-stream';
  const blob = new Blob(parts, { type: contentType });
  return { blob, contentType, name: manifest.name || 'video.bin' };
}
