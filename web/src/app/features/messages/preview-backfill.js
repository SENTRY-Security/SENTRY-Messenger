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
    // Encrypt and upload preview blob
    // Use MK-based encryption (no shared key — the preview is a new asset)
    const upload = await encryptAndPutWithProgress({
      convId: conversationId,
      file,
      onProgress: null,
      skipIndex: true,
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
