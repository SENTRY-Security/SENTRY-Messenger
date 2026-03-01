// /app/features/media.js
// Media feature: Encrypt with MK → presigned PUT to R2 → create index; sign-get; download & decrypt.
// No UI here. Callers (UI) should pass File/Blob and render results.

import { signPut as apiSignPut, signGet as apiSignGet, createMessage, deleteMediaKeys } from '../api/media.js';
import { getMkRaw, buildAccountPayload } from '../core/store.js';
import { encryptWithMK as aeadEncryptWithMK, decryptWithMK as aeadDecryptWithMK, b64, b64u8 } from '../crypto/aead.js';
import { toU8Strict } from '/shared/utils/u8-strict.js';
import { encryptAndPutChunked, CHUNK_SIZE, UnsupportedVideoFormatError } from './chunked-upload.js';

const encoder = new TextEncoder();
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GB
const MEDIA_INFO_TAG = 'media/v1';

const EXT_CONTENT_TYPE = new Map([
  ['mov', 'video/quicktime'],
  ['m4v', 'video/mp4'],
  ['mp4', 'video/mp4'],
  ['webm', 'video/webm'],
  ['avi', 'video/x-msvideo'],
  ['mkv', 'video/x-matroska'],
  ['heic', 'image/heic'],
  ['heif', 'image/heif'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['png', 'image/png'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['bmp', 'image/bmp'],
  ['svg', 'image/svg+xml'],
  ['pdf', 'application/pdf'],
  ['txt', 'text/plain'],
  ['md', 'text/markdown'],
  ['json', 'application/json'],
  ['csv', 'text/csv'],
  ['tsv', 'text/tab-separated-values'],
  ['mp3', 'audio/mpeg'],
  ['m4a', 'audio/mp4'],
  ['aac', 'audio/aac'],
  ['wav', 'audio/wav'],
  ['flac', 'audio/flac'],
  ['ogg', 'audio/ogg'],
  ['oga', 'audio/ogg'],
  ['opus', 'audio/opus'],
  ['zip', 'application/zip'],
  ['rar', 'application/vnd.rar'],
  ['7z', 'application/x-7z-compressed']
]);

function guessContentTypeFromName(name) {
  if (!name) return 'application/octet-stream';
  const idx = String(name).lastIndexOf('.');
  if (idx === -1) return 'application/octet-stream';
  const ext = String(name).slice(idx + 1).toLowerCase();
  return EXT_CONTENT_TYPE.get(ext) || 'application/octet-stream';
}

export function resolveContentType(file) {
  const fileType = typeof file?.type === 'string' ? file.type.trim() : '';
  if (fileType && fileType !== 'application/octet-stream') return fileType;
  const fileName = typeof file?.name === 'string' ? file.name : '';
  return guessContentTypeFromName(fileName);
}

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
    toU8Strict(mk, 'web/src/app/features/media.js:83:deriveStorageDirPath'),
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
    const token = bytesToHex(mac).slice(0, 32); // 16 bytes -> 32 hex chars
    hashes.push(token);
    prev = token;
  }
  return hashes.join('/');
}

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
      return b64u8(input);
    } catch {
      return null;
    }
  }
  return null;
}

function requireMediaInfoTag(infoTag) {
  const tag = typeof infoTag === 'string' ? infoTag.trim() : '';
  if (!tag) throw new Error('media info_tag missing');
  return tag;
}

function buildEnvelope({ ct, keyType, keyU8, infoTag, contentType, name }) {
  const normalizedInfoTag = requireMediaInfoTag(infoTag);
  const envelope = {
    v: keyType === 'shared' ? 2 : 1,
    aead: 'aes-256-gcm',
    iv_b64: b64(ct.iv),
    hkdf_salt_b64: b64(ct.hkdfSalt),
    info_tag: normalizedInfoTag,
    key_type: keyType || 'mk',
    contentType,
    name
  };
  if (keyType === 'shared' && keyU8) {
    envelope.key_b64 = b64(keyU8);
  }
  return envelope;
}

/** Persist envelope metadata for a given object key (local-only cache). */
export function saveEnvelopeMeta(objectKey, meta) {
  try { localStorage.setItem('env_v1:' + objectKey, JSON.stringify(meta)); } catch { }
}
/** Load envelope metadata for a given object key; returns null if missing. */
export function loadEnvelopeMeta(objectKey) {
  try { const s = localStorage.getItem('env_v1:' + objectKey); return s ? JSON.parse(s) : null; } catch { return null; }
}

export async function deleteEncryptedObjects({ keys, ids, convId }) {
  const uniqKeys = Array.from(new Set((keys || []).map(k => String(k || '').trim()).filter(Boolean)));
  const uniqIds = Array.from(new Set((ids || []).map(k => String(k || '').trim()).filter(Boolean)));
  if (!uniqKeys.length && !uniqIds.length) return { deleted: [] };
  if (!convId) throw new Error('convId required for deletion');
  try {
    const { data } = await deleteMediaKeys({ keys: uniqKeys, ids: uniqIds, conversationId: convId });
    try { uniqKeys.forEach((key) => localStorage.removeItem('env_v1:' + key)); } catch { }
    const deleted = data?.deleted || data?.results || [];
    return { deleted, failed: data?.failed || [] };
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.toLowerCase().includes('not found')) {
      try { uniqKeys.forEach((key) => localStorage.removeItem('env_v1:' + key)); } catch { }
      return { deleted: [], failed: [] };
    }
    throw err;
  }
}

/**
 * Encrypt a File/Blob with MK, upload via presigned PUT, then create a message index.
 * @param {{convId:string, file:File|Blob}} p
 * @returns {Promise<{objectKey:string,size:number,envelope:object,message:any}>}
 */
export async function encryptAndPut({ convId, file, dir, skipIndex = false, direction = 'sent', encryptionKey, encryptionInfoTag } = {}) {
  const mk = getMkRaw();
  const sharedKeyU8 = normalizeSharedKey(Array.isArray(encryptionKey) ? encryptionKey : encryptionKey?.key || encryptionKey);
  const useSharedKey = !!sharedKeyU8;
  if (!mk && !useSharedKey) throw new Error('Not unlocked: MK not ready');
  if (!file) throw new Error('file required');
  if (useSharedKey && !skipIndex) {
    throw new Error('shared encryption key is only supported when skipIndex=true');
  }

  const contentType = resolveContentType(file);
  const name = typeof file.name === 'string' ? file.name : 'blob.bin';
  const fileSize = typeof file.size === 'number' ? file.size : null;
  if (fileSize != null && fileSize > MAX_UPLOAD_BYTES) {
    throw new Error('檔案大小超過 1GB 限制');
  }
  const dirSegments = normalizeDirSegments(dir);
  if (dirSegments.length && !mk) {
    throw new Error('MK required for directory hashing');
  }

  // 1) Read & Encrypt
  const plainBuf = new Uint8Array(await file.arrayBuffer());
  if (plainBuf.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error('檔案大小超過 1GB 限制');
  }
  const infoTag = requireMediaInfoTag(useSharedKey ? encryptionInfoTag : MEDIA_INFO_TAG);
  const ctKey = useSharedKey ? sharedKeyU8 : mk;
  const ct = await aeadEncryptWithMK(plainBuf, ctKey, infoTag);

  // 2) Get presigned PUT
  const storageDir = dirSegments.length ? await deriveStorageDirPath(dirSegments, mk) : '';
  const normalizedDirection = direction === 'received' ? 'received' : (direction === 'sent' ? 'sent' : null);
  const signPayload = {
    convId,
    contentType,
    dir: storageDir || undefined,
    size: fileSize ?? plainBuf.byteLength
  };
  if (normalizedDirection) signPayload.direction = normalizedDirection;
  const { r: rSign, data: sign } = await apiSignPut(signPayload);
  if (!rSign.ok) throw new Error('sign-put failed: ' + JSON.stringify(sign));
  const { upload, objectPath } = sign;
  if (!upload?.url) throw new Error('sign-put missing upload.url');

  // 3) PUT ciphertext to R2
  const ctForPut = upload.headers?.['Content-Type'] || contentType;
  const putRes = await fetch(upload.url, {
    method: upload.method || 'PUT',
    headers: { 'Content-Type': ctForPut },
    body: new Blob([ct.cipherBuf], { type: ctForPut })
  });
  if (!putRes.ok) throw new Error('PUT failed (status ' + putRes.status + ')');
  const objectKey = upload.key || objectPath;

  // 4) Save envelope meta locally（供後續下載解密）
  const envelope = buildEnvelope({
    ct,
    keyType: useSharedKey ? 'shared' : 'mk',
    keyU8: useSharedKey ? sharedKeyU8 : null,
    infoTag,
    contentType,
    name
  });
  // 本機快取封套，供同裝置後續下載/預覽
  saveEnvelopeMeta(objectKey, envelope);

  // 5) Create message index（把 envelope JSON 放在 ciphertext_b64，小訊息）
  let dataMsg = null;
  if (!skipIndex) {
    const messageId = crypto.randomUUID();
    const msgPayload = {
      convId,
      type: 'media',
      aead: 'aes-256-gcm',
      id: messageId,
      // 將封套必要欄位一併放入 header.env，支援跨裝置解密
      header: {
        obj: objectKey,
        size: ct.cipherBuf.byteLength,
        name,
        contentType,
        dir: dirSegments,
        iv_b64: envelope.iv_b64,
        env: {
          iv_b64: envelope.iv_b64,
          hkdf_salt_b64: envelope.hkdf_salt_b64,
          info_tag: envelope.info_tag,
          key_type: envelope.key_type
        }
      },
      ciphertext_b64: b64(new TextEncoder().encode(JSON.stringify({
        v: envelope.v,
        aead: envelope.aead,
        iv_b64: envelope.iv_b64,
        hkdf_salt_b64: envelope.hkdf_salt_b64,
        info_tag: envelope.info_tag,
        key_type: envelope.key_type
      })))
    };
    const msgBody = buildAccountPayload({ overrides: msgPayload });
    const { r: rMsg, data } = await createMessage(msgBody);
    if (!rMsg.ok) throw new Error('message index failed: ' + JSON.stringify(data));
    dataMsg = data;
  }

  return { objectKey, size: ct.cipherBuf.byteLength, envelope, message: dataMsg };
}

/**
 * Same as encryptAndPut but allows tracking upload progress via XHR.
 * @param {{convId:string, file:File|Blob, onProgress?:(p:{loaded:number,total:number,percent:number})=>void}} p
 */
export async function encryptAndPutWithProgress({ convId, file, onProgress, dir, skipIndex = false, direction = 'sent', encryptionKey, encryptionInfoTag, abortSignal, extraHeader } = {}) {
  const mk = getMkRaw();
  const sharedKeyU8 = normalizeSharedKey(Array.isArray(encryptionKey) ? encryptionKey : encryptionKey?.key || encryptionKey);
  const useSharedKey = !!sharedKeyU8;
  if (!mk && !useSharedKey) throw new Error('Not unlocked: MK not ready');
  if (!file) throw new Error('file required');
  if (useSharedKey && !skipIndex) {
    throw new Error('shared encryption key is only supported when skipIndex=true');
  }

  const contentType = resolveContentType(file);
  const name = typeof file.name === 'string' ? file.name : 'blob.bin';
  const fileSize = typeof file.size === 'number' ? file.size : null;
  if (fileSize != null && fileSize > MAX_UPLOAD_BYTES) {
    throw new Error('檔案大小超過 1GB 限制');
  }
  const dirSegments = normalizeDirSegments(dir);
  if (dirSegments.length && !mk) {
    throw new Error('MK required for directory hashing');
  }

  const plainBuf = new Uint8Array(await file.arrayBuffer());
  if (plainBuf.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error('檔案大小超過 1GB 限制');
  }
  const infoTag = requireMediaInfoTag(useSharedKey ? encryptionInfoTag : MEDIA_INFO_TAG);
  const ctKey = useSharedKey ? sharedKeyU8 : mk;
  const ct = await aeadEncryptWithMK(plainBuf, ctKey, infoTag);

  const storageDir = dirSegments.length ? await deriveStorageDirPath(dirSegments, mk) : '';
  const normalizedDirection = direction === 'received' ? 'received' : (direction === 'sent' ? 'sent' : null);
  const signPayload = {
    convId,
    contentType,
    dir: storageDir || undefined,
    size: fileSize ?? plainBuf.byteLength
  };
  if (normalizedDirection) signPayload.direction = normalizedDirection;
  const { r: rSign, data: sign } = await apiSignPut(signPayload);
  if (!rSign.ok) throw new Error('sign-put failed: ' + JSON.stringify(sign));
  const { upload, objectPath } = sign;
  if (!upload?.url) throw new Error('sign-put missing upload.url');

  // XHR upload for progress
  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    if (abortSignal) {
      const onAbort = () => {
        try { xhr.abort(); } catch { }
        reject(new DOMException('aborted', 'AbortError'));
      };
      if (abortSignal.aborted) {
        onAbort();
        return;
      }
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    xhr.open(upload.method || 'PUT', upload.url, true);
    const ctForPut = upload.headers?.['Content-Type'] || contentType;
    xhr.setRequestHeader('Content-Type', ctForPut);
    xhr.upload.onprogress = (evt) => {
      if (!onProgress || !evt.lengthComputable) return;
      onProgress({ loaded: evt.loaded, total: evt.total, percent: Math.round((evt.loaded / evt.total) * 100) });
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        // [FIX] Fire explicit 100% — browsers may not fire onprogress
        // with loaded===total before onload, leaving progress at 99%.
        onProgress?.({ loaded: 1, total: 1, percent: 100 });
        resolve(null);
      } else {
        reject(new Error('PUT failed (status ' + xhr.status + ')'));
      }
    };
    xhr.onerror = () => reject(new Error('PUT network error'));
    xhr.send(new Blob([ct.cipherBuf], { type: ctForPut }));
  });

  const objectKey = upload.key || objectPath;
  const envelope = buildEnvelope({
    ct,
    keyType: useSharedKey ? 'shared' : 'mk',
    keyU8: useSharedKey ? sharedKeyU8 : null,
    infoTag,
    contentType,
    name
  });
  saveEnvelopeMeta(objectKey, envelope);

  let dataMsg = null;
  if (!skipIndex) {
    const messageId = crypto.randomUUID();
    const msgPayload = {
      convId,
      type: 'media',
      aead: 'aes-256-gcm',
      id: messageId,
      header: {
        obj: objectKey,
        size: ct.cipherBuf.byteLength,
        name,
        contentType,
        dir: dirSegments,
        iv_b64: envelope.iv_b64,
        env: {
          iv_b64: envelope.iv_b64,
          hkdf_salt_b64: envelope.hkdf_salt_b64,
          info_tag: envelope.info_tag,
          key_type: envelope.key_type
        }
      },
      ciphertext_b64: b64(new TextEncoder().encode(JSON.stringify({
        v: envelope.v,
        aead: envelope.aead,
        iv_b64: envelope.iv_b64,
        hkdf_salt_b64: envelope.hkdf_salt_b64,
        info_tag: envelope.info_tag,
        key_type: envelope.key_type
      })))
    };
    if (extraHeader && typeof extraHeader === 'object') {
      msgPayload.header = { ...msgPayload.header, ...extraHeader };
    }
    const msgBody = buildAccountPayload({ overrides: msgPayload });
    const { r: rMsg, data } = await createMessage(msgBody);
    if (!rMsg.ok) throw new Error('message index failed: ' + JSON.stringify(data));
    dataMsg = data;
  }

  return { objectKey, size: ct.cipherBuf.byteLength, envelope, message: dataMsg };
}

/**
 * Check if a file should use chunked upload.
 * ALL video files use chunked upload (regardless of size) for consistent
 * fMP4 remuxing + MSE streaming playback.
 */
export function shouldUseChunkedUpload(file) {
  if (!file || typeof file.size !== 'number') return false;
  const ct = resolveContentType(file);
  return ct.startsWith('video/');
}

/**
 * Smart upload: delegates to chunked or single-file path.
 * For chunked uploads, returns { chunked: true, baseKey, ... }.
 * For single uploads, returns { chunked: false, objectKey, ... }.
 */
export async function smartEncryptAndPut(params = {}) {
  const { file } = params;
  if (shouldUseChunkedUpload(file)) {
    const result = await encryptAndPutChunked(params);
    return { ...result, chunked: true };
  }
  const result = await encryptAndPutWithProgress(params);
  return { ...result, chunked: false };
}

/** Request a short-lived GET URL for an object key. */
export async function signGet({ key }) {
  const { r, data } = await apiSignGet({ key });
  if (!r.ok) throw new Error('sign-get failed: ' + JSON.stringify(data));
  return data; // { download:{url,bucket,key}, expiresIn }
}

/**
 * Download a ciphertext by key and decrypt with MK.
 * If envelope is not provided, tries local cache (saveEnvelopeMeta/loadEnvelopeMeta).
 * Returns { blob, contentType, name, bytes } for callers to save/display.
 */
export async function downloadAndDecrypt({ key, envelope, onStatus, onProgress, preferXhr, abortSignal, messageKeyB64 }) {
  // onStatus 為既有介面；onProgress 為別名，便於舊呼叫站上事件
  const progress = typeof onStatus === 'function'
    ? onStatus
    : (typeof onProgress === 'function' ? onProgress : null);
  const meta = envelope || loadEnvelopeMeta(key);
  if (!meta) throw new Error('No envelope metadata available for key');
  const keyType = String(meta.key_type || meta.keyType || 'mk').toLowerCase();
  let baseKey = null;
  if (keyType === 'shared') {
    const keyB64 = meta.key_b64 || meta.keyB64;
    if (!keyB64) throw new Error('No shared media key available');
    baseKey = normalizeSharedKey(keyB64);
    if (!baseKey) throw new Error('Shared media key invalid');
  } else if (keyType === 'message') {
    const mkB64 = messageKeyB64 || meta.messageKey_b64 || meta.message_key_b64 || null;
    if (!mkB64) throw new Error('No message key available');
    baseKey = normalizeSharedKey(mkB64);
    if (!baseKey) throw new Error('Message key invalid');
  } else {
    baseKey = getMkRaw();
    if (!baseKey) throw new Error('Not unlocked: MK not ready');
  }
  const infoTag = requireMediaInfoTag(meta.info_tag || meta.infoTag);

  progress?.({ stage: 'sign', message: '取得下載授權…' });
  const { download } = await signGet({ key });
  if (!download?.url) throw new Error('sign-get returned no URL');

  const shouldUseXhr = preferXhr !== false && typeof XMLHttpRequest !== 'undefined' && typeof window !== 'undefined';

  const xhrDownload = async () => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', download.url, true);
    xhr.responseType = 'arraybuffer';
    let headerTotal = null;

    if (abortSignal) {
      const onAbort = () => {
        try { xhr.abort(); } catch { }
        reject(new DOMException('aborted', 'AbortError'));
      };
      if (abortSignal.aborted) return onAbort();
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    xhr.onreadystatechange = () => {
      if (xhr.readyState === XMLHttpRequest.HEADERS_RECEIVED) {
        const len = Number(xhr.getResponseHeader('content-length')) || 0;
        headerTotal = len > 0 ? len : null;
        progress?.({ stage: 'download-start', total: headerTotal });
      }
    };

    xhr.onprogress = (evt) => {
      const loaded = evt.loaded || 0;
      const total = evt.lengthComputable ? evt.total : headerTotal;
      progress?.({ stage: 'download', loaded, total });
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const buf = xhr.response;
        const u8 = buf ? new Uint8Array(buf) : new Uint8Array();
        progress?.({ stage: 'download', loaded: u8.length, total: headerTotal || u8.length });
        resolve(u8);
      } else {
        reject(new Error('download failed (status ' + xhr.status + ')'));
      }
    };
    xhr.onerror = () => reject(new Error('download network error'));
    xhr.ontimeout = () => reject(new Error('download timeout'));
    xhr.send();
  });

  let cipherU8;

  if (shouldUseXhr) {
    try {
      cipherU8 = await xhrDownload();
    } catch (err) {
      // fallback to fetch if XHR failed
      console.warn('download xhr failed, fallback to fetch', err?.message || err);
    }
  }

  if (!cipherU8) {
    const res = await fetch(download.url);
    if (!res.ok) throw new Error('download failed (status ' + res.status + ')');

    const total = Number(res.headers.get('content-length')) || 0;
    progress?.({ stage: 'download-start', total: total || null });

    if (res.body && typeof res.body.getReader === 'function' && total) {
      const reader = res.body.getReader();
      const chunks = [];
      let loaded = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          loaded += value.length;
          progress?.({ stage: 'download', loaded, total });
        }
      }
      cipherU8 = new Uint8Array(loaded);
      let offset = 0;
      for (const chunk of chunks) {
        cipherU8.set(chunk, offset);
        offset += chunk.length;
      }
    } else {
      const buf = await res.arrayBuffer();
      cipherU8 = new Uint8Array(buf);
      progress?.({ stage: 'download', loaded: cipherU8.length, total: total || cipherU8.length });
    }
  }

  progress?.({ stage: 'decrypt', message: '解密檔案中…' });
  const plain = await aeadDecryptWithMK(
    cipherU8,
    baseKey,
    b64u8(meta.hkdf_salt_b64),
    b64u8(meta.iv_b64),
    infoTag
  );
  progress?.({ stage: 'done', bytes: plain.length });
  const blob = new Blob([plain], { type: meta.contentType || 'application/octet-stream' });
  return { blob, contentType: meta.contentType || 'application/octet-stream', name: meta.name || 'decrypted.bin', bytes: plain.length };
}

// Re-export for callers (dr-session.js)
export { UnsupportedVideoFormatError };

// --- small helpers ---
