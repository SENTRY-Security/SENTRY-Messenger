// /app/features/chunked-download.js
// Chunked encrypted download: fetch manifest, then download + decrypt chunks
// sequentially or with small lookahead for streaming playback.

import { signGetChunked as apiSignGetChunked } from '../api/media.js';
import { getMkRaw } from '../core/store.js';
import { decryptWithMK as aeadDecryptWithMK, b64u8 } from '../crypto/aead.js';

const CHUNK_INFO_TAG = 'media/chunk-v1';
const MANIFEST_INFO_TAG = 'media/manifest-v1';

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
 * Download a single URL as Uint8Array using fetch.
 */
async function fetchAsUint8Array(url, abortSignal) {
  const res = await fetch(url, { signal: abortSignal });
  if (!res.ok) throw new Error(`download failed (status ${res.status})`);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
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
 * Get signed download URLs for specific chunk indices.
 *
 * @param {{ baseKey: string, chunkIndices: number[] }} params
 * @returns {Promise<Map<number, string>>} Map of index → signed URL
 */
export async function getChunkUrls({ baseKey, chunkIndices, abortSignal }) {
  const { r, data } = await apiSignGetChunked({ baseKey, chunkIndices });
  if (!r.ok) throw new Error('sign-get-chunked failed: ' + JSON.stringify(data));
  const map = new Map();
  for (const c of (data.chunks || [])) {
    map.set(c.index, c.url);
  }
  return map;
}

/**
 * Async generator that streams decrypted chunks sequentially.
 * Yields { index, data: Uint8Array, progress: number } for each chunk.
 *
 * @param {{ baseKey: string, manifest: object, manifestEnvelope: object, abortSignal?: AbortSignal, onProgress?: Function }} params
 */
export async function* streamChunks({ baseKey, manifest, manifestEnvelope, abortSignal, onProgress }) {
  const cryptoKey = resolveKey(manifestEnvelope);
  const totalChunks = manifest.totalChunks;

  // Request signed URLs in batches to avoid URL expiry issues
  const BATCH_SIZE = 10;

  for (let batchStart = 0; batchStart < totalChunks; batchStart += BATCH_SIZE) {
    if (abortSignal?.aborted) throw new DOMException('aborted', 'AbortError');

    const batchEnd = Math.min(batchStart + BATCH_SIZE, totalChunks);
    const indices = [];
    for (let i = batchStart; i < batchEnd; i++) indices.push(i);

    const urlMap = await getChunkUrls({ baseKey, chunkIndices: indices, abortSignal });

    for (const idx of indices) {
      if (abortSignal?.aborted) throw new DOMException('aborted', 'AbortError');

      const url = urlMap.get(idx);
      if (!url) throw new Error(`No signed URL for chunk ${idx}`);

      const chunkMeta = manifest.chunks[idx];
      if (!chunkMeta) throw new Error(`No metadata for chunk ${idx}`);

      const decrypted = await downloadAndDecryptChunk({
        chunkUrl: url,
        encryptionKey: cryptoKey,
        chunkMeta,
        abortSignal
      });

      const progress = (idx + 1) / totalChunks;
      onProgress?.({ chunkIndex: idx, totalChunks, progress, percent: Math.round(progress * 100) });

      yield { index: idx, data: decrypted, progress };
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
