// preview-backfill.js
// Listens for 'media:preview-backfill' events from the renderer.
// When a PDF/Office thumbnail is rendered client-side for a message that
// lacks a pre-generated preview, this module encrypts the rendered JPEG,
// uploads it to R2, and patches the message header so future loads skip
// heavy client-side rendering.

import { encryptAndPutWithProgress } from '../media.js';
import { fetchJSON } from '../../core/http.js';
import { getAccountToken, ensureDeviceId } from '../../core/store.js';
import { log } from '../../core/log.js';

const inflight = new Set();

function b64ToU8(b64) {
  if (!b64) return null;
  try {
    const s = b64.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(s);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  } catch { return null; }
}

function blobToFile(blob, name) {
  try {
    return new File([blob], name, { type: blob.type || 'image/jpeg' });
  } catch {
    blob.name = name;
    return blob;
  }
}

async function handleBackfill(event) {
  const { messageId, conversationId, messageKeyB64, blob, width, height } = event?.detail || {};
  if (!messageId || !conversationId || !blob) return;
  // Deduplicate: only one backfill per message
  if (inflight.has(messageId)) return;
  inflight.add(messageId);
  try {
    const accountToken = getAccountToken();
    if (!accountToken) return;
    const file = blobToFile(blob, `${messageId}.preview.jpg`);
    // Encrypt with the message's shared media key so both parties can decrypt.
    // If no shared key is available, fall back to MK (self-only).
    const sharedKey = b64ToU8(messageKeyB64);
    const encryptionKey = sharedKey ? { key: sharedKey, type: 'shared' } : undefined;
    const upload = await encryptAndPutWithProgress({
      convId: conversationId,
      file,
      onProgress: null,
      skipIndex: true,
      encryptionKey,
      encryptionInfoTag: 'media/preview-v1'
    });
    if (!upload?.objectKey || !upload?.envelope) return;
    // Patch message header with preview metadata
    await fetchJSON('/api/v1/messages/preview', {
      accountToken,
      messageId,
      conversationId,
      preview: {
        objectKey: upload.objectKey,
        envelope: upload.envelope,
        size: blob.size || null,
        contentType: 'image/jpeg',
        width: width || null,
        height: height || null
      }
    }, { 'X-Device-Id': ensureDeviceId() });
  } catch (err) {
    log({ previewBackfillError: err?.message || err, messageId });
  } finally {
    inflight.delete(messageId);
  }
}

export function initPreviewBackfill() {
  document.addEventListener('media:preview-backfill', handleBackfill);
}
