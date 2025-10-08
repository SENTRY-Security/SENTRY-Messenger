// /app/features/media.js
// Media feature: Encrypt with MK → presigned PUT to R2 → create index; sign-get; download & decrypt.
// No UI here. Callers (UI) should pass File/Blob and render results.

import { signPut as apiSignPut, signGet as apiSignGet, createMessage, deleteMediaKeys } from '../api/media.js';
import { getMkRaw } from '../core/store.js';
import { encryptWithMK as aeadEncryptWithMK, decryptWithMK as aeadDecryptWithMK, b64, b64u8 } from '../crypto/aead.js';

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
  const key = await crypto.subtle.importKey('raw', mk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
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

/** Persist envelope metadata for a given object key (local-only cache). */
export function saveEnvelopeMeta(objectKey, meta) {
  try { localStorage.setItem('env_v1:' + objectKey, JSON.stringify(meta)); } catch {}
}
/** Load envelope metadata for a given object key; returns null if missing. */
export function loadEnvelopeMeta(objectKey) {
  try { const s = localStorage.getItem('env_v1:' + objectKey); return s ? JSON.parse(s) : null; } catch { return null; }
}

export async function deleteEncryptedObjects({ keys, ids }) {
  const uniqKeys = Array.from(new Set((keys || []).map(k => String(k || '').trim()).filter(Boolean)));
  const uniqIds = Array.from(new Set((ids || []).map(k => String(k || '').trim()).filter(Boolean)));
  if (!uniqKeys.length && !uniqIds.length) return { deleted: [] };
  try {
    const { data } = await deleteMediaKeys({ keys: uniqKeys, ids: uniqIds });
    try { uniqKeys.forEach((key) => localStorage.removeItem('env_v1:' + key)); } catch {}
    const deleted = data?.deleted || data?.results || [];
    return { deleted, failed: data?.failed || [] };
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.toLowerCase().includes('not found')) {
      try { uniqKeys.forEach((key) => localStorage.removeItem('env_v1:' + key)); } catch {}
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
export async function encryptAndPut({ convId, file, dir }) {
  const mk = getMkRaw();
  if (!mk) throw new Error('Not unlocked: MK not ready');
  if (!file) throw new Error('file required');

  const contentType = file.type || 'application/octet-stream';
  const name = typeof file.name === 'string' ? file.name : 'blob.bin';
  const dirSegments = normalizeDirSegments(dir);

  // 1) Read & Encrypt
  const plainBuf = new Uint8Array(await file.arrayBuffer());
  const ct = await aeadEncryptWithMK(plainBuf, mk, 'media/v1');

  // 2) Get presigned PUT
  const storageDir = dirSegments.length ? await deriveStorageDirPath(dirSegments, mk) : '';
  const { r: rSign, data: sign } = await apiSignPut({ convId, contentType, dir: storageDir || undefined });
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
  const envelope = { v: 1, aead: 'aes-256-gcm', iv_b64: b64(ct.iv), hkdf_salt_b64: b64(ct.hkdfSalt) };
  // 本機快取封套，供同裝置後續下載/預覽
  saveEnvelopeMeta(objectKey, { iv_b64: envelope.iv_b64, hkdf_salt_b64: envelope.hkdf_salt_b64, contentType, name });

  // 5) Create message index（把 envelope JSON 放在 ciphertext_b64，小訊息）
  const msgBody = {
    convId,
    type: 'media',
    aead: 'aes-256-gcm',
    // 將封套必要欄位一併放入 header.env，支援跨裝置解密
    header: { obj: objectKey, size: ct.cipherBuf.byteLength, name, contentType, dir: dirSegments, env: { iv_b64: envelope.iv_b64, hkdf_salt_b64: envelope.hkdf_salt_b64 } },
    ciphertext_b64: b64(new TextEncoder().encode(JSON.stringify(envelope)))
  };
  const { r: rMsg, data: dataMsg } = await createMessage(msgBody);
  if (!rMsg.ok) throw new Error('message index failed: ' + JSON.stringify(dataMsg));

  return { objectKey, size: ct.cipherBuf.byteLength, envelope, message: dataMsg };
}

/**
 * Same as encryptAndPut but allows tracking upload progress via XHR.
 * @param {{convId:string, file:File|Blob, onProgress?:(p:{loaded:number,total:number,percent:number})=>void}} p
 */
export async function encryptAndPutWithProgress({ convId, file, onProgress, dir }) {
  const mk = getMkRaw();
  if (!mk) throw new Error('Not unlocked: MK not ready');
  if (!file) throw new Error('file required');

  const contentType = file.type || 'application/octet-stream';
  const name = typeof file.name === 'string' ? file.name : 'blob.bin';
  const dirSegments = normalizeDirSegments(dir);

  const plainBuf = new Uint8Array(await file.arrayBuffer());
  const ct = await aeadEncryptWithMK(plainBuf, mk, 'media/v1');

  const storageDir = dirSegments.length ? await deriveStorageDirPath(dirSegments, mk) : '';
  const { r: rSign, data: sign } = await apiSignPut({ convId, contentType, dir: storageDir || undefined });
  if (!rSign.ok) throw new Error('sign-put failed: ' + JSON.stringify(sign));
  const { upload, objectPath } = sign;
  if (!upload?.url) throw new Error('sign-put missing upload.url');

  // XHR upload for progress
  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(upload.method || 'PUT', upload.url, true);
    const ctForPut = upload.headers?.['Content-Type'] || contentType;
    xhr.setRequestHeader('Content-Type', ctForPut);
    xhr.upload.onprogress = (evt) => {
      if (!onProgress || !evt.lengthComputable) return;
      onProgress({ loaded: evt.loaded, total: evt.total, percent: Math.round((evt.loaded/evt.total)*100) });
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(null);
      else reject(new Error('PUT failed (status ' + xhr.status + ')'));
    };
    xhr.onerror = () => reject(new Error('PUT network error'));
    xhr.send(new Blob([ct.cipherBuf], { type: ctForPut }));
  });

  const objectKey = upload.key || objectPath;
  const envelope = { v: 1, aead: 'aes-256-gcm', iv_b64: b64(ct.iv), hkdf_salt_b64: b64(ct.hkdfSalt) };
  saveEnvelopeMeta(objectKey, { iv_b64: envelope.iv_b64, hkdf_salt_b64: envelope.hkdf_salt_b64, contentType, name });

  const msgBody = {
    convId,
    type: 'media',
    aead: 'aes-256-gcm',
    header: { obj: objectKey, size: ct.cipherBuf.byteLength, name, contentType, dir: dirSegments, env: { iv_b64: envelope.iv_b64, hkdf_salt_b64: envelope.hkdf_salt_b64 } },
    ciphertext_b64: b64(new TextEncoder().encode(JSON.stringify(envelope)))
  };
  const { r: rMsg, data: dataMsg } = await createMessage(msgBody);
  if (!rMsg.ok) throw new Error('message index failed: ' + JSON.stringify(dataMsg));

  return { objectKey, size: ct.cipherBuf.byteLength, envelope, message: dataMsg };
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
export async function downloadAndDecrypt({ key, envelope, onStatus }) {
  const mk = getMkRaw();
  if (!mk) throw new Error('Not unlocked: MK not ready');

  const meta = envelope || loadEnvelopeMeta(key);
  if (!meta) throw new Error('No envelope metadata available for key');

  onStatus?.({ stage: 'sign', message: '取得下載授權…' });
  const { download } = await signGet({ key });
  if (!download?.url) throw new Error('sign-get returned no URL');

  const res = await fetch(download.url);
  if (!res.ok) throw new Error('download failed (status ' + res.status + ')');

  const total = Number(res.headers.get('content-length')) || 0;
  onStatus?.({ stage: 'download-start', total });

  let cipherU8;
  if (res.body && total) {
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        loaded += value.length;
        onStatus?.({ stage: 'download', loaded, total });
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
    onStatus?.({ stage: 'download', loaded: cipherU8.length, total: cipherU8.length });
  }

  onStatus?.({ stage: 'decrypt', message: '解密檔案中…' });
  const plain = await aeadDecryptWithMK(
    cipherU8,
    mk,
    b64u8(meta.hkdf_salt_b64),
    b64u8(meta.iv_b64),
    'media/v1'
  );
  onStatus?.({ stage: 'done', bytes: plain.length });
  const blob = new Blob([plain], { type: meta.contentType || 'application/octet-stream' });
  return { blob, contentType: meta.contentType || 'application/octet-stream', name: meta.name || 'decrypted.bin', bytes: plain.length };
}

// --- small helpers ---
