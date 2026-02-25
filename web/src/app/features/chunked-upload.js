// /app/features/chunked-upload.js
// Chunked encrypted upload for video files.
//
// VIDEO (fMP4/WebM):
//   - Remuxes to fMP4 first (if needed), then each fMP4 segment (init + media segments)
//     becomes a separate encrypted chunk. This ensures each chunk is a valid MSE segment
//     that can be directly appended to SourceBuffer for streaming playback.
//   - WebM files use fixed 5MB byte-range chunks (WebM is natively MSE-compatible).
//
// NON-VIDEO:
//   - Fixed 5MB byte-range chunks (unchanged from original).
//
// Each chunk is independently encrypted with AES-256-GCM via HKDF-derived key.

import { signPutChunked as apiSignPutChunked, cleanupChunked as apiCleanupChunked } from '../api/media.js';
import { getMkRaw } from '../core/store.js';
import { encryptWithMK as aeadEncryptWithMK } from '../crypto/aead.js';
import { b64 } from '../crypto/aead.js';
import { toU8Strict } from '/shared/utils/u8-strict.js';
import { remuxToFragmentedMp4, canRemuxVideo, UnsupportedVideoFormatError } from './mp4-remuxer.js';

const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB for non-segment chunking
const UPLOAD_CONCURRENCY = 3;
const CHUNK_INFO_TAG = 'media/chunk-v1';

const encoder = new TextEncoder();

function normalizeDirSegments(dir) {
  if (!dir) return [];
  if (Array.isArray(dir)) {
    return dir
      .map((seg) => String(seg || '').trim())
      .map((seg) => seg.normalize('NFKC'))
      .filter(Boolean);
  }
  return String(dir || '')
    .split('/')
    .map((seg) => String(seg || '').trim())
    .map((seg) => seg.normalize('NFKC'))
    .filter(Boolean);
}

function bytesToHex(u8) {
  return Array.from(u8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function deriveStorageDirPath(dirSegments, mk) {
  if (!dirSegments || !dirSegments.length) return '';
  const key = await crypto.subtle.importKey(
    'raw',
    toU8Strict(mk, 'chunked-upload.js:deriveStorageDirPath'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  let prev = 'root';
  const hashes = [];
  for (const raw of dirSegments) {
    const seg = String(raw || '').normalize('NFKC');
    const data = encoder.encode(`drive-dir:${prev}:${seg}`);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
    const token = bytesToHex(mac).slice(0, 32);
    hashes.push(token);
    prev = token;
  }
  return hashes.join('/');
}

const MANIFEST_INFO_TAG = 'media/manifest-v1';

function normalizeSharedKey(input) {
  if (!input) return null;
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (Array.isArray(input) && input.every((n) => Number.isFinite(n))) {
    return new Uint8Array(input.map((n) => Number(n) & 0xff));
  }
  if (typeof input === 'string') {
    try {
      const bin = atob(input);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return u8;
    } catch {
      return null;
    }
  }
  return null;
}

function resolveContentType(file) {
  const fileType = typeof file?.type === 'string' ? file.type.trim() : '';
  if (fileType && fileType !== 'application/octet-stream') return fileType;
  return 'application/octet-stream';
}

/**
 * Upload a single encrypted chunk via XHR with progress.
 * @returns {Promise<void>}
 */
function uploadChunkXhr({ url, method, headers, cipherBuf, abortSignal }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    if (abortSignal) {
      const onAbort = () => {
        try { xhr.abort(); } catch { }
        reject(new DOMException('aborted', 'AbortError'));
      };
      if (abortSignal.aborted) { onAbort(); return; }
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    xhr.open(method || 'PUT', url, true);
    const ct = headers?.['Content-Type'] || 'application/octet-stream';
    xhr.setRequestHeader('Content-Type', ct);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error('chunk PUT failed (status ' + xhr.status + ')'));
    };
    xhr.onerror = () => reject(new Error('chunk PUT network error'));
    xhr.send(new Blob([cipherBuf], { type: ct }));
  });
}

/**
 * Encrypt and upload a file in chunks.
 *
 * For video files (MP4/MOV/WebM):
 *   - MP4/MOV → remuxed to fMP4 → each fMP4 segment is one chunk
 *   - WebM → fixed 5MB byte-range chunks
 *
 * For non-video files:
 *   - Fixed 5MB byte-range chunks
 *
 * @param {{
 *   convId: string,
 *   file: File|Blob,
 *   encryptionKey?: Uint8Array|object,
 *   direction?: 'sent'|'received',
 *   onProgress?: (p: {loaded: number, total: number, percent: number}) => void,
 *   abortSignal?: AbortSignal,
 *   dir?: string
 * }} params
 * @returns {Promise<{
 *   baseKey: string,
 *   totalSize: number,
 *   chunkCount: number,
 *   manifestEnvelope: object,
 *   chunked: true
 * }>}
 */
export async function encryptAndPutChunked({
  convId, file, encryptionKey, direction = 'sent',
  onProgress, abortSignal, dir
} = {}) {
  const mk = getMkRaw();
  const sharedKeyU8 = normalizeSharedKey(
    Array.isArray(encryptionKey) ? encryptionKey : encryptionKey?.key || encryptionKey
  );
  const useSharedKey = !!sharedKeyU8;
  if (!mk && !useSharedKey) throw new Error('Not unlocked: MK not ready');
  if (!file) throw new Error('file required');

  const rawType = (typeof file.type === 'string' ? file.type : '').toLowerCase().trim();
  const isVideo = rawType.startsWith('video/');
  const name = typeof file.name === 'string' ? file.name : 'blob.bin';
  const cryptoKey = useSharedKey ? sharedKeyU8 : mk;

  // For video files, try to get fMP4 segments
  let fmp4Segments = null; // null = use byte-range chunking
  // fmp4Segments: array of { trackIndex, data } when segment-based
  let fmp4Tracks = null; // track info: [{ type, codec }]
  let contentType = resolveContentType(file);
  let totalSize;

  if (isVideo) {
    if (!canRemuxVideo(file)) {
      throw new UnsupportedVideoFormatError(`不支援此影片格式：${rawType}`);
    }
    const remuxResult = await remuxToFragmentedMp4(file);
    contentType = remuxResult.contentType;

    if (remuxResult.segments) {
      // fMP4 segments available — use segment-based chunking
      // Each segment is { trackIndex, data }
      fmp4Segments = remuxResult.segments;
      fmp4Tracks = remuxResult.tracks
        ? remuxResult.tracks.map(t => ({ type: t.type, codec: t.codec }))
        : [{ type: 'muxed', codec: null }];
      // Calculate total size from segments
      totalSize = 0;
      for (const seg of fmp4Segments) totalSize += seg.data.byteLength;
    } else {
      // WebM or passthrough — use byte-range chunking on original file
      totalSize = typeof file.size === 'number' ? file.size : 0;
    }
  } else {
    totalSize = typeof file.size === 'number' ? file.size : 0;
  }

  if (!totalSize) throw new Error('file size unknown');

  // Determine chunk count
  const chunkCount = fmp4Segments
    ? fmp4Segments.length      // Each fMP4 segment = one chunk
    : Math.ceil(totalSize / CHUNK_SIZE);  // Byte-range chunking

  // Normalize dir
  const dirSegments = normalizeDirSegments(dir);
  let storageDir = '';
  if (dirSegments.length) {
    if (!mk) throw new Error('MK required for directory hashing');
    storageDir = await deriveStorageDirPath(dirSegments, mk);
  }

  // 1. Request batch presigned URLs
  const { r: rSign, data: signData } = await apiSignPutChunked({
    convId,
    totalSize,
    chunkCount,
    contentType,
    direction,
    dir: storageDir || undefined
  });
  if (!rSign.ok) throw new Error('sign-put-chunked failed: ' + JSON.stringify(signData));
  const { baseKey, manifest: manifestPut, chunks: chunkPuts } = signData;
  if (!baseKey || !manifestPut?.url || !chunkPuts?.length) {
    throw new Error('sign-put-chunked returned incomplete data');
  }

  // Track uploaded bytes for progress
  let uploadedBytes = 0;
  const chunkMetas = new Array(chunkCount);

  // 2. Encrypt and upload chunks with concurrency limit
  let uploadError = null;

  const processChunk = async (index) => {
    if (abortSignal?.aborted) throw new DOMException('aborted', 'AbortError');

    let plainBuf;
    if (fmp4Segments) {
      // fMP4 segment-based: each segment is { trackIndex, data }
      plainBuf = fmp4Segments[index].data;
    } else {
      // Byte-range chunking: slice from file
      const offset = index * CHUNK_SIZE;
      const end = Math.min(offset + CHUNK_SIZE, totalSize);
      const chunkSlice = file.slice(offset, end);
      plainBuf = new Uint8Array(await chunkSlice.arrayBuffer());
    }

    // Encrypt this chunk independently
    const ct = await aeadEncryptWithMK(plainBuf, cryptoKey, CHUNK_INFO_TAG);

    // Upload
    const chunkPut = chunkPuts[index];
    if (!chunkPut?.url) throw new Error(`missing presigned URL for chunk ${index}`);

    await uploadChunkXhr({
      url: chunkPut.url,
      method: chunkPut.method || 'PUT',
      headers: chunkPut.headers,
      cipherBuf: ct.cipherBuf,
      abortSignal
    });

    // Record metadata
    const meta = {
      index,
      size: plainBuf.byteLength,
      cipher_size: ct.cipherBuf.byteLength,
      iv_b64: b64(ct.iv),
      salt_b64: b64(ct.hkdfSalt)
    };
    // Tag with track index for fMP4 segment-based chunks
    if (fmp4Segments) {
      meta.trackIndex = fmp4Segments[index].trackIndex;
    }
    chunkMetas[index] = meta;

    // Update progress
    uploadedBytes += plainBuf.byteLength;
    onProgress?.({
      loaded: uploadedBytes,
      total: totalSize,
      percent: Math.round((uploadedBytes / totalSize) * 100)
    });

    // Allow GC of the segment data after upload
    if (fmp4Segments && fmp4Segments[index]) {
      fmp4Segments[index].data = null;
      fmp4Segments[index] = null;
    }
  };

  // Concurrency pool
  try {
    const pool = [];
    for (let i = 0; i < chunkCount; i++) {
      const p = processChunk(i).catch((err) => {
        if (!uploadError) uploadError = err;
        throw err;
      });
      pool.push(p);

      if (pool.length >= UPLOAD_CONCURRENCY) {
        await Promise.race(pool);
        // Remove settled promises
        for (let j = pool.length - 1; j >= 0; j--) {
          const status = await Promise.race([pool[j].then(() => 'done'), Promise.resolve('pending')]);
          if (status === 'done') pool.splice(j, 1);
        }
      }
      if (uploadError) throw uploadError;
    }
    await Promise.all(pool);
  } catch (err) {
    try { await apiCleanupChunked({ baseKey }); } catch { }
    throw err;
  }

  if (uploadError) {
    try { await apiCleanupChunked({ baseKey }); } catch { }
    throw uploadError;
  }

  // 3. Build and encrypt manifest
  const manifest = {
    v: 3,
    // segment_aligned: true means each chunk is a complete fMP4 segment (init or moof+mdat)
    // segment_aligned: false means chunks are arbitrary byte ranges
    segment_aligned: !!fmp4Segments,
    chunkSize: fmp4Segments ? 0 : CHUNK_SIZE,  // 0 for segment-aligned (variable size)
    totalSize,
    totalChunks: chunkCount,
    contentType,
    name,
    chunks: chunkMetas,
    // Per-track info for multi-SourceBuffer MSE playback
    // tracks[i] = { type: 'video'|'audio'|'muxed', codec: 'avc1.xxx'|'mp4a.40.2'|null }
    // Each chunk's trackIndex references this array
    tracks: fmp4Tracks || null
  };

  const manifestJson = new TextEncoder().encode(JSON.stringify(manifest));
  const manifestCt = await aeadEncryptWithMK(manifestJson, cryptoKey, MANIFEST_INFO_TAG);

  // 4. Upload encrypted manifest
  try {
    await uploadChunkXhr({
      url: manifestPut.url,
      method: manifestPut.method || 'PUT',
      headers: manifestPut.headers,
      cipherBuf: manifestCt.cipherBuf,
      abortSignal
    });
  } catch (err) {
    try { await apiCleanupChunked({ baseKey }); } catch { }
    throw err;
  }

  const manifestEnvelope = {
    v: useSharedKey ? 2 : 1,
    aead: 'aes-256-gcm',
    iv_b64: b64(manifestCt.iv),
    hkdf_salt_b64: b64(manifestCt.hkdfSalt),
    info_tag: MANIFEST_INFO_TAG,
    key_type: useSharedKey ? 'shared' : 'mk'
  };
  if (useSharedKey && sharedKeyU8) {
    manifestEnvelope.key_b64 = b64(sharedKeyU8);
  }

  return {
    baseKey,
    totalSize,
    chunkCount,
    manifestEnvelope,
    chunked: true
  };
}

export { CHUNK_SIZE, UnsupportedVideoFormatError };
