// /app/features/chunked-upload.js
// Chunked encrypted upload for video files.
//
// VIDEO (fMP4):
//   - Preprocessing: tries WebCodecs transcode first (guarantees MSE-compatible H.264 fMP4).
//     If the input is already H.264+AAC, falls through to fast remux (no re-encoding).
//     If WebCodecs is unavailable, falls back to remux-only.
//   - Each fMP4 segment (init + media segments) becomes a separate encrypted chunk,
//     ensuring each chunk is a valid MSE segment for SourceBuffer.appendBuffer().
//
// NON-VIDEO:
//   - Fixed 5MB byte-range chunks (unchanged from original).
//
// Each chunk is independently encrypted with AES-256-GCM via HKDF-derived key.

import { signPutChunked as apiSignPutChunked, cleanupChunked as apiCleanupChunked } from '../api/media.js';
import { getMkRaw } from '../core/store.js';
import { encryptWithMK as aeadEncryptWithMK, createBulkEncryptor } from '../crypto/aead.js';
import { b64 } from '../crypto/aead.js';
import { toU8Strict } from '/shared/utils/u8-strict.js';
import {
  remuxToFragmentedMp4, canRemuxVideo, UnsupportedVideoFormatError,
  isAlreadyFragmented, countMoofBoxesFromFile, iterateFragmentedSegmentsFromFile,
  extractDurationFromFile
} from './mp4-remuxer.js';
import { transcodeToFmp4, isWebCodecsSupported, probeTranscode } from './webcodecs-transcoder.js';
import { AdaptiveConcurrency } from './adaptive-concurrency.js';

// Default encoder constraints: cap all uploads to 720p @ 1.5Mbps for smooth MSE streaming
// on iOS Safari. Short high-bitrate videos (e.g. 4K iPhone) cause excessive buffering times.
const DEFAULT_ENCODER = { maxWidth: 1280, maxHeight: 720, maxBitrate: 1_500_000 };

// Extreme fallback for OOM retry (480p @ 800Kbps)
const EXTREME_FALLBACK_ENCODER = { maxWidth: 854, maxHeight: 480, maxBitrate: 800_000 };

const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB for non-segment chunking
const CHUNK_INFO_TAG = 'media/chunk-v1';
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1GB — must match server UPLOAD_MAX_BYTES

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

/**
 * Check if the current browser supports HEVC playback through MSE/MMS.
 * Used to decide whether HEVC fMP4 (after failed H.264 transcode) is
 * viable for streaming, or if the upload should be rejected.
 */
function _checkHevcMseSupport() {
  const MSCtor = (typeof self !== 'undefined' && typeof self.ManagedMediaSource === 'function')
    ? self.ManagedMediaSource
    : (typeof MediaSource !== 'undefined' ? MediaSource : null);
  if (!MSCtor?.isTypeSupported) return false;
  return MSCtor.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.b0"') ||
         MSCtor.isTypeSupported('video/mp4; codecs="hvc1"') ||
         MSCtor.isTypeSupported('video/mp4; codecs="hev1.1.6.L93.b0"');
}

function resolveContentType(file) {
  const fileType = typeof file?.type === 'string' ? file.type.trim() : '';
  if (fileType && fileType !== 'application/octet-stream') return fileType;
  return 'application/octet-stream';
}

/**
 * Upload a single encrypted chunk via XHR with progress.
 * Includes a timeout to prevent permanent hangs on stalled connections.
 * Retries up to CHUNK_RETRY_COUNT times on transient errors (timeout, network).
 * @returns {Promise<void>}
 */
const CHUNK_UPLOAD_TIMEOUT_MS = 120_000; // 2 minutes per chunk
const CHUNK_RETRY_COUNT = 2; // max retries per chunk (total attempts = 3)

function uploadChunkXhr({ url, method, headers, cipherBuf, abortSignal, onUploadProgress }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

    const xhr = new XMLHttpRequest();
    xhr.timeout = CHUNK_UPLOAD_TIMEOUT_MS;
    if (abortSignal) {
      const onAbort = () => {
        try { xhr.abort(); } catch { }
        settle(reject, new DOMException('aborted', 'AbortError'));
      };
      if (abortSignal.aborted) { onAbort(); return; }
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    if (onUploadProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onUploadProgress(e.loaded, e.total);
      };
    }
    xhr.open(method || 'PUT', url, true);
    const ct = headers?.['Content-Type'] || 'application/octet-stream';
    xhr.setRequestHeader('Content-Type', ct);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) settle(resolve);
      else settle(reject, new Error('chunk PUT failed (status ' + xhr.status + ')'));
    };
    xhr.onerror = () => settle(reject, new Error('chunk PUT network error'));
    xhr.ontimeout = () => settle(reject, new Error('chunk PUT timeout (connection stalled)'));
    // Send the ArrayBuffer directly — avoids an extra Blob copy (~5MB per chunk).
    // Content-Type is already set via setRequestHeader above.
    xhr.send(cipherBuf.buffer.byteLength === cipherBuf.byteLength
      ? cipherBuf.buffer
      : cipherBuf.buffer.slice(cipherBuf.byteOffset, cipherBuf.byteOffset + cipherBuf.byteLength));
  });
}

/**
 * Upload with retry — retries on timeout or network errors only.
 * Abort errors and HTTP 4xx/5xx are NOT retried.
 */
async function uploadChunkWithRetry(opts) {
  let lastErr;
  for (let attempt = 0; attempt <= CHUNK_RETRY_COUNT; attempt++) {
    try {
      return await uploadChunkXhr(opts);
    } catch (err) {
      lastErr = err;
      // Don't retry user-initiated abort
      if (err?.name === 'AbortError') throw err;
      // Only retry on timeout or network error
      const msg = err?.message || '';
      const isRetryable = msg.includes('timeout') || msg.includes('network error');
      if (!isRetryable || attempt >= CHUNK_RETRY_COUNT) throw err;
      // Exponential backoff: 2s, 4s
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/**
 * Streaming upload for already-fragmented fMP4 files.
 * Reads boxes directly from the File via file.slice() — never loads the entire
 * file into memory. Each segment is read, encrypted, and uploaded before the
 * next is read. Peak memory: a few segments (bounded by adaptive concurrency).
 */
async function _streamingUploadFragmented({
  file, convId, cryptoKey, useSharedKey, sharedKeyU8,
  name, direction, dir, mk,
  PHASE, onProgress, abortSignal
}) {
  // Count moof boxes and extract duration in parallel.
  // countMoofBoxes scans only 16-byte box headers; extractDuration uses a
  // temporary <video> element that only reads the moov header — both are fast.
  const [moofCount, fileDuration] = await Promise.all([
    countMoofBoxesFromFile(file),
    extractDurationFromFile(file)
  ]);
  if (moofCount === 0) {
    throw new UnsupportedVideoFormatError('已分片的影片格式無法正確解析');
  }

  const chunkCount = 1 + moofCount;
  const contentType = 'video/mp4';
  const totalFileSize = file.size;

  const dirSegments = normalizeDirSegments(dir);
  let storageDir = '';
  if (dirSegments.length) {
    if (!mk) throw new Error('MK required for directory hashing');
    storageDir = await deriveStorageDirPath(dirSegments, mk);
  }

  // Sign URLs (use file.size as totalSize for the API)
  const { r: rSign, data: signData } = await apiSignPutChunked({
    convId, totalSize: totalFileSize, chunkCount, contentType, direction,
    dir: storageDir || undefined
  });
  if (!rSign.ok) {
    const errCode = signData?.error || 'Unknown';
    if (errCode === 'FileTooLarge') {
      const limitMB = signData?.maxBytes ? Math.round(signData.maxBytes / 1024 / 1024) : '?';
      throw new Error(`檔案大小超過伺服器限制 (${limitMB}MB)，請確認伺服器已更新至最新版本`);
    }
    throw new Error('sign-put-chunked failed: ' + JSON.stringify(signData));
  }
  const { baseKey, manifest: manifestPut, chunks: chunkPuts } = signData;
  if (!baseKey || !manifestPut?.url || !chunkPuts?.length) {
    throw new Error('sign-put-chunked returned incomplete data');
  }
  onProgress?.({ percent: PHASE.signEnd });

  // Stream segments from file via async generator — reads each box individually
  // with file.slice(), never loading the entire file into memory.
  // Each segment is processed (encrypt + upload) before the next is read.
  let completedBytesStream = 0;
  const streamInFlight = {}; // idx → partial bytes uploaded
  let actualTotalSize = 0;
  const chunkMetas = new Array(chunkCount);
  let uploadError = null;
  let chunkIndex = 0;

  let _lastStreamProgressTime = 0;
  const _reportStreamProgress = (force) => {
    if (!force) {
      const now = Date.now();
      if (now - _lastStreamProgressTime < 200) return;
      _lastStreamProgressTime = now;
    }
    let inflight = 0;
    for (const k in streamInFlight) inflight += streamInFlight[k];
    const totalUploaded = completedBytesStream + inflight;
    const chunkRange = PHASE.chunkEnd - PHASE.chunkStart;
    const ratio = Math.min(totalUploaded / totalFileSize, 1);
    onProgress?.({
      loaded: totalUploaded, total: totalFileSize,
      percent: Math.round(PHASE.chunkStart + ratio * chunkRange)
    });
  };

  const bulkEncrypt = createBulkEncryptor(cryptoKey, CHUNK_INFO_TAG);
  const ac = new AdaptiveConcurrency({ floor: 2, ceiling: 15 });

  try {
    const pool = new Set();
    for await (const { trackIndex, data } of iterateFragmentedSegmentsFromFile(file)) {
      if (abortSignal?.aborted) throw new DOMException('aborted', 'AbortError');
      if (uploadError) throw uploadError;

      const idx = chunkIndex++;
      const segSize = data.byteLength;
      actualTotalSize += segSize;
      const chunkPut = chunkPuts[idx];
      if (!chunkPut?.url) throw new Error(`missing presigned URL for chunk ${idx}`);

      const p = (async () => {
        const t0 = performance.now();
        const ct = await bulkEncrypt(data);
        streamInFlight[idx] = 0;
        try {
          await uploadChunkWithRetry({
            url: chunkPut.url, method: chunkPut.method || 'PUT',
            headers: chunkPut.headers, cipherBuf: ct.cipherBuf, abortSignal,
            onUploadProgress: (loaded, total) => {
              streamInFlight[idx] = total > 0 ? segSize * (loaded / total) : 0;
              _reportStreamProgress();
            }
          });
          ac.recordSuccess(performance.now() - t0);
        } catch (err) {
          ac.recordFailure();
          throw err;
        }
        delete streamInFlight[idx];
        completedBytesStream += segSize;
        _reportStreamProgress(true);
        chunkMetas[idx] = {
          index: idx, size: segSize, cipher_size: ct.cipherBuf.byteLength,
          iv_b64: b64(ct.iv), salt_b64: b64(ct.hkdfSalt), trackIndex
        };
      })().catch(err => { if (!uploadError) uploadError = err; throw err; })
        .finally(() => pool.delete(p));

      pool.add(p);
      if (pool.size >= ac.concurrency) {
        await Promise.race(pool);
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

  // Build and upload manifest (use actual sizes from uploaded segments)
  onProgress?.({ percent: PHASE.chunkEnd });
  const manifest = {
    v: 3, segment_aligned: true, chunkSize: 0,
    totalSize: actualTotalSize, totalChunks: chunkIndex,
    contentType, name,
    chunks: chunkMetas.slice(0, chunkIndex),
    tracks: [{ type: 'muxed', codec: null }],
    duration: fileDuration
  };
  const manifestJson = new TextEncoder().encode(JSON.stringify(manifest));
  const manifestCt = await aeadEncryptWithMK(manifestJson, cryptoKey, MANIFEST_INFO_TAG);

  try {
    await uploadChunkWithRetry({
      url: manifestPut.url, method: manifestPut.method || 'PUT',
      headers: manifestPut.headers, cipherBuf: manifestCt.cipherBuf, abortSignal
    });
  } catch (err) {
    try { await apiCleanupChunked({ baseKey }); } catch { }
    throw err;
  }
  onProgress?.({ percent: PHASE.manifestEnd });

  const manifestEnvelope = {
    v: useSharedKey ? 2 : 1, aead: 'aes-256-gcm',
    iv_b64: b64(manifestCt.iv), hkdf_salt_b64: b64(manifestCt.hkdfSalt),
    info_tag: MANIFEST_INFO_TAG, key_type: useSharedKey ? 'shared' : 'mk'
  };
  if (useSharedKey && sharedKeyU8) manifestEnvelope.key_b64 = b64(sharedKeyU8);

  return { baseKey, totalSize: actualTotalSize, chunkCount: chunkIndex, manifestEnvelope, chunked: true };
}

/**
 * Streaming transcode + upload pipeline.
 * Segments are encrypted and uploaded as they're produced by the encoder,
 * so the upload starts within seconds instead of waiting for full transcode.
 * Memory: bounded by ~2MB file chunk + decoder/encoder pipeline + ~3 in-flight segments.
 */
async function _streamingTranscodeUpload({
  file, probe, convId, cryptoKey, useSharedKey, sharedKeyU8,
  name, direction, dir, mk,
  encoderConstraints, onProgress, abortSignal,
  onSegmentProduced,
}) {
  const PHASE = { chunkStart: 5, chunkEnd: 95, manifestEnd: 100 };
  const contentType = 'video/mp4';

  const dirSegments = normalizeDirSegments(dir);
  let storageDir = '';
  if (dirSegments.length) {
    if (!mk) throw new Error('MK required for directory hashing');
    storageDir = await deriveStorageDirPath(dirSegments, mk);
  }

  // 1. Sign presigned URLs (use file.size as upper bound for server size check)
  const { r: rSign, data: signData } = await apiSignPutChunked({
    convId, totalSize: file.size, chunkCount: probe.estimatedChunks,
    contentType, direction, dir: storageDir || undefined
  });
  if (!rSign.ok) {
    const errCode = signData?.error || 'Unknown';
    if (errCode === 'FileTooLarge') {
      const limitMB = signData?.maxBytes ? Math.round(signData.maxBytes / 1024 / 1024) : '?';
      throw new Error(`檔案大小超過伺服器限制 (${limitMB}MB)，請確認伺服器已更新至最新版本`);
    }
    throw new Error('sign-put-chunked failed: ' + JSON.stringify(signData));
  }
  const { baseKey, manifest: manifestPut, chunks: chunkPuts } = signData;
  if (!baseKey || !manifestPut?.url || !chunkPuts?.length) {
    throw new Error('sign-put-chunked returned incomplete data');
  }
  onProgress?.({ percent: PHASE.chunkStart });

  // 2. Set up encrypt + upload machinery
  const bulkEncrypt = createBulkEncryptor(cryptoKey, CHUNK_INFO_TAG);
  const ac = new AdaptiveConcurrency({ floor: 2, ceiling: 8 });
  let chunkIndex = 0;
  let completedBytes = 0;
  let actualTotalSize = 0;
  let segmentsComplete = 0;
  const totalExpectedSegments = Math.max(probe.estimatedChunks, 1);
  const chunkMetas = [];
  let uploadError = null;
  const uploadPool = new Set();
  const inFlightFrac = {};   // idx → fraction of segment uploaded (0-1)
  let _lastPT = 0;

  // Progress is based on segment count, not bytes, because the transcoded
  // output at 720p is much smaller than the original file (e.g. 36MB vs 581MB).
  const _reportPipelineProgress = (force) => {
    if (!force) {
      const now = Date.now();
      if (now - _lastPT < 200) return;
      _lastPT = now;
    }
    let frac = segmentsComplete;
    for (const k in inFlightFrac) frac += inFlightFrac[k];
    const ratio = Math.min(frac / totalExpectedSegments, 1);
    const chunkRange = PHASE.chunkEnd - PHASE.chunkStart;
    onProgress?.({
      loaded: completedBytes, total: actualTotalSize || completedBytes || 1,
      percent: Math.round(PHASE.chunkStart + ratio * chunkRange),
      statusText: segmentsComplete > 0 ? `上傳中 ${segmentsComplete}/${totalExpectedSegments}` : undefined,
    });
  };

  // 3. Segment callback: each transcoded fMP4 segment → encrypt → upload
  const onSegmentReady = async (seg) => {
    if (abortSignal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (uploadError) throw uploadError;

    const idx = chunkIndex++;
    onSegmentProduced?.(chunkIndex, totalExpectedSegments);
    const segData = seg?.data;
    if (!segData || !segData.byteLength) {
      console.warn('[streaming-upload] skipping empty segment at index', idx);
      return;
    }
    const segSize = segData.byteLength;
    actualTotalSize += segSize;

    if (idx >= chunkPuts.length) {
      throw new Error(`segment count exceeded estimate (${idx + 1} > ${chunkPuts.length})`);
    }

    const t0 = performance.now();
    const ct = await bulkEncrypt(segData);

    const p = (async () => {
      inFlightFrac[idx] = 0;
      try {
        await uploadChunkWithRetry({
          url: chunkPuts[idx].url, method: chunkPuts[idx].method || 'PUT',
          headers: chunkPuts[idx].headers, cipherBuf: ct.cipherBuf, abortSignal,
          onUploadProgress: (loaded, total) => {
            inFlightFrac[idx] = total > 0 ? loaded / total : 0;
            _reportPipelineProgress();
          }
        });
        ac.recordSuccess(performance.now() - t0);
      } catch (err) {
        ac.recordFailure();
        if (!uploadError) uploadError = err;
        throw err;
      }
      delete inFlightFrac[idx];
      completedBytes += segSize;
      segmentsComplete++;
      _reportPipelineProgress(true);

      chunkMetas[idx] = {
        index: idx, size: segSize, cipher_size: ct.cipherBuf.byteLength,
        iv_b64: b64(ct.iv), salt_b64: b64(ct.hkdfSalt), trackIndex: seg.trackIndex
      };
    })().catch(err => { if (!uploadError) uploadError = err; throw err; })
      .finally(() => uploadPool.delete(p));

    uploadPool.add(p);
    if (uploadPool.size >= ac.concurrency) {
      await Promise.race(uploadPool);
    }
    if (uploadError) throw uploadError;
  };

  // 4. Run transcode — segments are encrypted + uploaded via onSegmentReady
  let transcodeResult;
  try {
    transcodeResult = await transcodeToFmp4(file, {
      encoderConstraints,
      onSegment: onSegmentReady,
      onProgress: ({ phase, percent }) => {
        if (phase === 'load') {
          onProgress?.({ percent: Math.round(percent * PHASE.chunkStart / 100) });
        } else if (phase === 'encode') {
          // Blend encode progress with upload progress:
          // The encode phase covers the full chunkStart→chunkEnd range.
          // As segments upload, _reportPipelineProgress also updates this range.
          // Use whichever is higher so the bar never goes backwards.
          const encodePercent = Math.round(PHASE.chunkStart + (percent / 100) * (PHASE.chunkEnd - PHASE.chunkStart));
          // Only report if encode progress leads upload progress
          const currentUploadFrac = segmentsComplete / totalExpectedSegments;
          const currentUploadPercent = Math.round(PHASE.chunkStart + currentUploadFrac * (PHASE.chunkEnd - PHASE.chunkStart));
          if (encodePercent > currentUploadPercent) {
            onProgress?.({ percent: encodePercent, statusText: `正在轉碼… ${percent}%` });
          }
        }
      },
    });
    // Wait for remaining uploads to finish
    await Promise.all(uploadPool);
  } catch (err) {
    try { await apiCleanupChunked({ baseKey }); } catch {}
    throw uploadError || err;
  }
  if (uploadError) {
    try { await apiCleanupChunked({ baseKey }); } catch {}
    throw uploadError;
  }

  // 5. Upload manifest
  onProgress?.({ percent: PHASE.chunkEnd });
  const manifest = {
    v: 3, segment_aligned: true, chunkSize: 0,
    totalSize: actualTotalSize, totalChunks: chunkIndex,
    contentType, name,
    chunks: chunkMetas.slice(0, chunkIndex),
    tracks: transcodeResult?.tracks || [{ type: 'muxed', codec: null }],
    duration: probe.duration
  };
  const manifestJson = new TextEncoder().encode(JSON.stringify(manifest));
  const manifestCt = await aeadEncryptWithMK(manifestJson, cryptoKey, MANIFEST_INFO_TAG);

  try {
    await uploadChunkWithRetry({
      url: manifestPut.url, method: manifestPut.method || 'PUT',
      headers: manifestPut.headers, cipherBuf: manifestCt.cipherBuf, abortSignal
    });
  } catch (err) {
    try { await apiCleanupChunked({ baseKey }); } catch {}
    throw err;
  }
  onProgress?.({ percent: PHASE.manifestEnd, statusText: null });

  const manifestEnvelope = {
    v: useSharedKey ? 2 : 1, aead: 'aes-256-gcm',
    iv_b64: b64(manifestCt.iv), hkdf_salt_b64: b64(manifestCt.hkdfSalt),
    info_tag: MANIFEST_INFO_TAG, key_type: useSharedKey ? 'shared' : 'mk'
  };
  if (useSharedKey && sharedKeyU8) manifestEnvelope.key_b64 = b64(sharedKeyU8);

  return { baseKey, totalSize: actualTotalSize, chunkCount: chunkIndex, manifestEnvelope, chunked: true };
}

/**
 * Encrypt and upload a file in chunks.
 *
 * For video files (MP4/MOV/WebM):
 *   - Already-fragmented fMP4 → streaming upload (low memory)
 *   - Non-fragmented MP4/MOV → remuxed to fMP4 → each fMP4 segment is one chunk
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

  // Early size guard: reject before loading the file into memory.
  // Without this, a 600MB video would be fully read + remuxed (~1.2GB peak)
  // only to be rejected by the server's 413 response at sign-put-chunked.
  const fileSize = typeof file.size === 'number' ? file.size : null;
  if (fileSize != null && fileSize > MAX_UPLOAD_BYTES) {
    throw new Error(`檔案大小超過 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB 限制`);
  }

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
  let mediaDuration;  // video duration in seconds (from remuxer), used in manifest

  // Progress allocation across all phases (percent ranges):
  //   Video:     remux 0-10 | sign 10-12 | chunks 12-95 | manifest 95-100
  //   Non-video: sign 0-2   | chunks 2-95  | manifest 95-100
  const PHASE = isVideo
    ? { remuxEnd: 10, signEnd: 12, chunkStart: 12, chunkEnd: 95, manifestEnd: 100 }
    : { remuxEnd: 0,  signEnd: 2,  chunkStart: 2,  chunkEnd: 95, manifestEnd: 100 };

  // ── Step tracking for the upload detail panel (video only) ──
  // Steps are emitted via onProgress({ steps }) and rendered by the UI.
  let _steps = isVideo ? [] : null;
  const _emitSteps = () => {
    if (_steps) onProgress?.({ steps: _steps.map(s => ({ ...s })) });
  };
  const _addStep = (label, status = 'pending', detail) => {
    if (!_steps) return -1;
    _steps.push({ label, status, detail: detail || '' });
    _emitSteps();
    return _steps.length - 1;
  };
  const _setStep = (idx, status, detail) => {
    if (!_steps || idx < 0 || !_steps[idx]) return;
    _steps[idx].status = status;
    if (detail !== undefined) _steps[idx].detail = detail;
    _emitSteps();
  };
  // Throttled step progress updater — updates produced/total on a step
  // and emits steps at most every 500ms to keep the pie responsive without
  // flooding the UI with full DOM rebuilds.
  let _stepPctTimer = null;
  const _setStepSegments = (idx, produced, total) => {
    if (!_steps || idx < 0 || !_steps[idx]) return;
    _steps[idx].produced = produced;
    _steps[idx].total = total;
    if (!_stepPctTimer) {
      _stepPctTimer = setTimeout(() => { _stepPctTimer = null; _emitSteps(); }, 500);
    }
  };
  /** Extract a short, UI-friendly error reason from a transcode Error. */
  const _shortError = (err) => {
    const msg = err?.message || String(err || '');
    // Strip common Chinese prefixes to get the actual reason
    const stripped = msg
      .replace(/^視訊[編解]碼失敗[：:]\s*/i, '')
      .replace(/^音訊[編解]碼失敗[：:]\s*/i, '')
      .replace(/^影片解析失敗[（(]?記憶體不足[？?][）)]?[：:]\s*/i, '記憶體不足：')
      .replace(/^影片解析失敗[：:]\s*/i, '')
      .replace(/^此裝置不支援\s*/, '不支援 ')
      .trim();
    // Truncate to keep UI readable
    const short = stripped.length > 80 ? stripped.slice(0, 78) + '…' : stripped;
    return short || '未知錯誤';
  };

  if (isVideo) {
    // Step 0: Format detection
    const fmtIdx = _addStep('格式偵測', 'active');

    if (!canRemuxVideo(file)) {
      _setStep(fmtIdx, 'error', rawType);
      throw new UnsupportedVideoFormatError(`不支援此影片格式：${rawType}`);
    }
    _setStep(fmtIdx, 'done', rawType);

    // Preprocessing: WebCodecs streaming pipeline → remux fallback
    let preprocessResult = null;

    if (isWebCodecsSupported()) {
      // Probe to check if transcode is needed (lightweight, reads headers only)
      let transcodeProbe = null;
      try { transcodeProbe = await probeTranscode(file, DEFAULT_ENCODER); } catch {}

      if (transcodeProbe?.needed) {
        // ── Streaming pipeline: transcode → encrypt → upload per-segment ──
        // Segments are encrypted and uploaded as they're produced by the encoder,
        // so the upload starts within seconds instead of waiting for full transcode.
        const tcIdx = _addStep('轉碼上傳 (720p)', 'active');
        onProgress?.({ percent: 1, statusText: '正在轉碼並上傳…' });
        try {
          const result = await _streamingTranscodeUpload({
            file, probe: transcodeProbe, convId, cryptoKey, useSharedKey, sharedKeyU8,
            name, direction, dir, mk,
            encoderConstraints: DEFAULT_ENCODER, onProgress, abortSignal,
            onSegmentProduced: (produced, total) => _setStepSegments(tcIdx, produced, total),
          });
          _setStep(tcIdx, 'done', '720p');
          return result;
        } catch (err) {
          console.warn('[chunked-upload] Streaming transcode 720p failed:', err?.message);
          _setStep(tcIdx, 'warn', _shortError(err));

          // Retry with extreme fallback (480p, 800Kbps)
          const retryIdx = _addStep('降級重試 (480p)', 'active');
          onProgress?.({ percent: 1, statusText: '影片轉換失敗，正在以較低品質重試…' });
          try {
            const retryResult = await _streamingTranscodeUpload({
              file, probe: transcodeProbe, convId, cryptoKey, useSharedKey, sharedKeyU8,
              name, direction, dir, mk,
              encoderConstraints: EXTREME_FALLBACK_ENCODER, onProgress, abortSignal,
              onSegmentProduced: (produced, total) => _setStepSegments(retryIdx, produced, total),
            });
            _setStep(retryIdx, 'done', '480p');
            return retryResult;
          } catch (retryErr) {
            console.warn('[chunked-upload] Streaming transcode 480p also failed:', retryErr?.message);
            _setStep(retryIdx, 'warn', _shortError(retryErr));
            preprocessResult = null;
            onProgress?.({ statusText: null });
            // Fall through to remux path below
          }
        }
      }
    }

    // If transcode returned null (already MSE-safe or unavailable):
    // check for streaming fast path before falling back to full remux.
    if (!preprocessResult) {
      const peekBuf = await file.slice(0, 64 * 1024).arrayBuffer();
      if (isAlreadyFragmented(new Uint8Array(peekBuf))) {
        // Already-fragmented fMP4: streaming upload (low memory).
        const uploadIdx = _addStep('加密上傳', 'active');
        onProgress?.({ percent: PHASE.remuxEnd, statusText: null });
        const result = await _streamingUploadFragmented({
          file, convId, cryptoKey, useSharedKey, sharedKeyU8,
          name, direction, dir, mk,
          PHASE, onProgress, abortSignal
        });
        _setStep(uploadIdx, 'done');
        return result;
      }

      // Not fragmented — remux to fMP4 via mp4box.js (keeps original codec)
      const remuxIdx = _addStep('影片封裝', 'active');
      preprocessResult = await remuxToFragmentedMp4(file, {
        onProgress: ({ percent }) => {
          onProgress?.({ percent: Math.round(percent * PHASE.remuxEnd / 100) });
        }
      });
      _setStep(remuxIdx, 'done');

      // Guard: if the remuxed output uses a codec that isn't universally
      // MSE-compatible (e.g. HEVC after failed transcode), verify the current
      // browser can stream it. Reject early rather than uploading data that
      // forces blob-URL fallback (OOM risk on large files in iOS Safari).
      const outCodec = preprocessResult?.tracks?.[0]?.codec || '';
      if (outCodec && !/^avc/i.test(outCodec)) {
        if (_checkHevcMseSupport()) {
          console.info(`[chunked-upload] proceeding with HEVC fMP4 (MSE HEVC supported on this browser)`);
        } else {
          throw new UnsupportedVideoFormatError(
            '此影片使用 HEVC 編碼，無法在此裝置上串流播放。請在相機設定中切換為「最相容」(H.264) 後重新錄製。'
          );
        }
      }
    }

    // Add upload step (will be set to 'done' after chunks + manifest)
    _addStep('加密上傳', 'active');

    onProgress?.({ percent: PHASE.remuxEnd, statusText: null });
    contentType = preprocessResult.contentType;
    mediaDuration = preprocessResult.duration || undefined;

    if (preprocessResult.segments) {
      const rawSegments = preprocessResult.segments;
      fmp4Tracks = preprocessResult.tracks
        ? preprocessResult.tracks.map(t => ({ type: t.type, codec: t.codec }))
        : [{ type: 'muxed', codec: null }];

      // Segments from remuxer already have media data wrapped in Blobs
      // (converted in onSegment callback to avoid ~582MB heap accumulation).
      // Init segment (first entry) may still be a Uint8Array — it's tiny (<1KB).
      // Just transfer the blob references; no additional copying needed.
      totalSize = 0;
      fmp4Segments = [];
      for (const seg of rawSegments) {
        let blob, size;
        if (seg.blob) {
          // Media segment — already a Blob from remuxer
          blob = seg.blob;
          size = seg.size;
          seg.blob = null; // Release remuxer's reference
        } else if (seg.data) {
          // Init segment or legacy path — wrap small Uint8Array in Blob
          size = seg.data.byteLength;
          blob = new Blob([seg.data]);
          seg.data = null;
        } else {
          continue; // skip empty segments
        }
        fmp4Segments.push({
          trackIndex: seg.trackIndex,
          _blob: blob,
          _size: size,
          data: null
        });
        totalSize += size;
      }
    } else {
      // WebM or passthrough — use byte-range chunking on original file
      totalSize = typeof file.size === 'number' ? file.size : 0;
    }

    // Release the preprocessResult reference — segments are now wrapped in
    // individual Blobs. This drops the remuxer's internal references
    // (muxedTrack, orderedMediaSegs, etc.) so GC can reclaim the file buffer.
    preprocessResult = null;
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
  onProgress?.({ percent: PHASE.remuxEnd });
  const { r: rSign, data: signData } = await apiSignPutChunked({
    convId,
    totalSize,
    chunkCount,
    contentType,
    direction,
    dir: storageDir || undefined
  });
  if (!rSign.ok) {
    const errCode = signData?.error || 'Unknown';
    if (errCode === 'FileTooLarge') {
      const limitMB = signData?.maxBytes ? Math.round(signData.maxBytes / 1024 / 1024) : '?';
      throw new Error(`檔案大小超過伺服器限制 (${limitMB}MB)，請確認伺服器已更新至最新版本`);
    }
    throw new Error('sign-put-chunked failed: ' + JSON.stringify(signData));
  }
  const { baseKey, manifest: manifestPut, chunks: chunkPuts } = signData;
  if (!baseKey || !manifestPut?.url || !chunkPuts?.length) {
    throw new Error('sign-put-chunked returned incomplete data');
  }
  onProgress?.({ percent: PHASE.signEnd });

  // Track uploaded bytes for progress — per-chunk partial bytes for smooth updates
  let completedBytes = 0;
  const chunkInFlight = new Float64Array(chunkCount); // tracks partial upload per chunk
  const chunkMetas = new Array(chunkCount);

  let _lastProgressTime = 0;
  const _reportProgress = (force) => {
    // Throttle XHR byte-level updates to max 5/sec to avoid flooding the UI.
    // Chunk completions pass force=true for immediate feedback.
    if (!force) {
      const now = Date.now();
      if (now - _lastProgressTime < 200) return;
      _lastProgressTime = now;
    }
    let inflight = 0;
    for (let k = 0; k < chunkCount; k++) inflight += chunkInFlight[k];
    const totalUploaded = completedBytes + inflight;
    const chunkRange = PHASE.chunkEnd - PHASE.chunkStart;
    const ratio = Math.min(totalUploaded / totalSize, 1);
    onProgress?.({
      loaded: totalUploaded, total: totalSize,
      percent: Math.round(PHASE.chunkStart + ratio * chunkRange)
    });
  };

  // 2. Encrypt and upload chunks with adaptive concurrency (AIMD)
  const bulkEncryptMain = createBulkEncryptor(cryptoKey, CHUNK_INFO_TAG);
  const uploadAc = new AdaptiveConcurrency({ floor: 2, ceiling: 15 });
  let uploadError = null;

  const processChunk = async (index) => {
    if (abortSignal?.aborted) throw new DOMException('aborted', 'AbortError');

    const t0 = performance.now();

    let plainBuf;
    if (fmp4Segments) {
      // fMP4 segment-based: read from per-segment Blob on demand (low memory)
      const seg = fmp4Segments[index];
      if (seg._blob) {
        plainBuf = new Uint8Array(await seg._blob.arrayBuffer());
      } else {
        plainBuf = seg.data;
      }
    } else {
      // Byte-range chunking: slice from file
      const offset = index * CHUNK_SIZE;
      const end = Math.min(offset + CHUNK_SIZE, totalSize);
      const chunkSlice = file.slice(offset, end);
      plainBuf = new Uint8Array(await chunkSlice.arrayBuffer());
    }

    const tRead = performance.now();

    // Encrypt this chunk (uses cached HKDF key import)
    const chunkPlainSize = plainBuf.byteLength;
    const ct = await bulkEncryptMain(plainBuf);
    plainBuf = null; // Free plaintext immediately — cipher is all we need now

    const tEncrypt = performance.now();

    // Upload
    const chunkPut = chunkPuts[index];
    if (!chunkPut?.url) throw new Error(`missing presigned URL for chunk ${index}`);

    try {
      await uploadChunkWithRetry({
        url: chunkPut.url,
        method: chunkPut.method || 'PUT',
        headers: chunkPut.headers,
        cipherBuf: ct.cipherBuf,
        abortSignal,
        onUploadProgress: (loaded, total) => {
          // Map cipher bytes to plain bytes ratio for accurate progress
          chunkInFlight[index] = total > 0 ? chunkPlainSize * (loaded / total) : 0;
          _reportProgress();
        }
      });
      uploadAc.recordSuccess(performance.now() - t0);
    } catch (err) {
      uploadAc.recordFailure();
      throw err;
    }

    const tUpload = performance.now();

    // Chunk fully uploaded — move from in-flight to completed
    chunkInFlight[index] = 0;
    completedBytes += chunkPlainSize;
    _reportProgress(true);

    // Log per-chunk timing for diagnostics (helps identify bottleneck)
    if (index < 5 || index % 20 === 0) {
      const readMs = (tRead - t0).toFixed(0);
      const encMs = (tEncrypt - tRead).toFixed(0);
      const upMs = (tUpload - tEncrypt).toFixed(0);
      const sizeMB = (chunkPlainSize / (1024 * 1024)).toFixed(1);
      const upSpeed = chunkPlainSize / ((tUpload - tEncrypt) / 1000) / (1024 * 1024);
      console.info(`[upload] chunk ${index}: ${sizeMB}MB read=${readMs}ms enc=${encMs}ms up=${upMs}ms (${upSpeed.toFixed(1)} MB/s)`);
    }

    // Record metadata
    const meta = {
      index,
      size: chunkPlainSize,
      cipher_size: ct.cipherBuf.byteLength,
      iv_b64: b64(ct.iv),
      salt_b64: b64(ct.hkdfSalt)
    };
    if (fmp4Segments) {
      meta.trackIndex = fmp4Segments[index].trackIndex;
    }
    chunkMetas[index] = meta;

    // Allow GC of the segment Blob after upload
    if (fmp4Segments && fmp4Segments[index]) {
      fmp4Segments[index]._blob = null;
      fmp4Segments[index] = null;
    }
  };

  // Concurrency pool — AIMD adaptive: starts conservative, ramps up on
  // stable RTT, backs off on errors. ac.concurrency is checked each iteration.
  try {
    const pool = new Set();
    for (let i = 0; i < chunkCount; i++) {
      if (uploadError) throw uploadError;

      const p = processChunk(i).catch((err) => {
        if (!uploadError) uploadError = err;
        throw err;
      }).finally(() => pool.delete(p));
      pool.add(p);

      if (pool.size >= uploadAc.concurrency) {
        await Promise.race(pool);
      }
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
  onProgress?.({ percent: PHASE.chunkEnd });
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
    tracks: fmp4Tracks || null,
    // Total media duration in seconds (if available from remuxer).
    // Used by MSE player to set MediaSource.duration upfront, preventing
    // incremental duration growth that causes auto-pause on some browsers.
    duration: mediaDuration
  };

  const manifestJson = new TextEncoder().encode(JSON.stringify(manifest));
  const manifestCt = await aeadEncryptWithMK(manifestJson, cryptoKey, MANIFEST_INFO_TAG);

  // 4. Upload encrypted manifest
  try {
    await uploadChunkWithRetry({
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
  onProgress?.({ percent: PHASE.manifestEnd });

  // Mark upload step as done (last step in _steps array for video uploads)
  if (_steps && _steps.length > 0) {
    const lastIdx = _steps.length - 1;
    if (_steps[lastIdx].status === 'active') {
      _setStep(lastIdx, 'done');
    }
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
