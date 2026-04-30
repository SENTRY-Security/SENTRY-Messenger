// In-memory store for contact emoji labels.
// Persisted via encrypted backup (contact-secrets.js), never in plaintext.

import { isValidEmoji } from './emoji-pool.js';
import { registerContactLabelHooks } from '../../core/contact-secrets.js';

const labels = new Map();

function normalizeDigest(value) {
  if (!value || typeof value !== 'string') return null;
  const cleaned = value.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  return cleaned.length === 64 ? cleaned : null;
}

function emitChange(peerDigest, emoji) {
  try {
    document.dispatchEvent(new CustomEvent('contact-label:changed', {
      detail: { peerDigest, emoji: emoji || null }
    }));
  } catch { /* SSR guard */ }
}

export function getLabel(peerDigest) {
  const key = normalizeDigest(peerDigest);
  if (!key) return null;
  return labels.get(key) || null;
}

export function getLabelEmoji(peerDigest) {
  return getLabel(peerDigest)?.emoji || null;
}

export function setLabel(peerDigest, emoji) {
  const key = normalizeDigest(peerDigest);
  if (!key) return false;
  if (!isValidEmoji(emoji)) return false;
  labels.set(key, {
    emoji,
    assigned_at: Math.floor(Date.now() / 1000)
  });
  emitChange(key, emoji);
  return true;
}

export function clearLabel(peerDigest) {
  const key = normalizeDigest(peerDigest);
  if (!key) return false;
  const had = labels.delete(key);
  if (had) emitChange(key, null);
  return had;
}

export function getAllLabels() {
  const result = {};
  for (const [digest, entry] of labels) {
    result[digest] = { ...entry };
  }
  return result;
}

export function exportLabels() {
  const out = {};
  for (const [digest, entry] of labels) {
    out[digest] = {
      emoji: entry.emoji,
      assigned_at: entry.assigned_at
    };
  }
  return out;
}

export function importLabels(data) {
  if (!data || typeof data !== 'object') return 0;
  let count = 0;
  for (const [digest, entry] of Object.entries(data)) {
    const key = normalizeDigest(digest);
    if (!key) continue;
    const emoji = entry?.emoji;
    if (typeof emoji !== 'string' || !emoji) continue;
    labels.set(key, {
      emoji,
      assigned_at: Number(entry?.assigned_at) || 0
    });
    count++;
  }
  return count;
}

export function clearAllLabels() {
  labels.clear();
}

// Wire into contact-secrets backup cycle (avoids circular import)
registerContactLabelHooks({
  export: exportLabels,
  import: importLabels
});
