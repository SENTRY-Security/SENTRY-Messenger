import { encryptWithMK, decryptWithMK, b64, b64u8 } from '../crypto/aead.js';
import { getMkRaw, ensureDeviceId } from '../core/store.js';
import { log } from '../core/log.js';
import { uploadContactSecretsBackup, fetchContactSecretsBackup } from '../api/contact-secrets.js';
import {
  buildContactSecretsSnapshot,
  importContactSecretsSnapshot,
  computeContactSecretsChecksum
} from '../core/contact-secrets.js';

const SNAPSHOT_INFO_TAG = 'contact-secrets/backup/v1';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let initialized = false;
let deviceLabel = null;
let latestPersistDetail = null;
let uploadTimer = null;
let lastUploadedChecksum = null;
let syncRequested = false;
let syncInFlight = false;
let syncCompleted = false;
let backupDisabled = false;

function detectDeviceLabel() {
  if (typeof navigator === 'undefined') return null;
  const parts = [navigator.platform, navigator.vendor || '', navigator.userAgent || ''];
  return parts.join(' ').trim().slice(0, 120) || null;
}

function handlePersistEvent(event) {
  if (event?.detail) {
    latestPersistDetail = {
      ...event.detail,
      snapshotVersion: event.detail.snapshotVersion || event.detail?.summary?.version || null
    };
  } else {
    latestPersistDetail = null;
  }
  scheduleBackup('persist');
}

export function initContactSecretsBackup(options = {}) {
  if (initialized) return;
  initialized = true;
  deviceLabel = options.deviceLabel || detectDeviceLabel();
  if (typeof window !== 'undefined') {
    window.addEventListener('contactSecrets:persisted', handlePersistEvent);
    window.addEventListener('online', () => scheduleBackup('online'));
  }
  // Attempt to sync soon after init
  requestContactSecretsBackupSync();
}

function scheduleBackup(reason) {
  if (backupDisabled) return;
  if (uploadTimer) clearTimeout(uploadTimer);
  uploadTimer = setTimeout(() => {
    uploadTimer = null;
    triggerContactSecretsBackup(reason).catch((err) => {
      log({ contactSecretsBackupError: err?.message || err, reason });
    });
  }, reason === 'persist' ? 2500 : 5000);
}

async function encryptSnapshotPayload(payload, mkRaw) {
  const plain = encoder.encode(payload);
  const { cipherBuf, iv, hkdfSalt } = await encryptWithMK(plain, mkRaw, SNAPSHOT_INFO_TAG);
  return {
    v: 1,
    aead: 'aes-256-gcm',
    info: SNAPSHOT_INFO_TAG,
    salt_b64: b64(hkdfSalt),
    iv_b64: b64(iv),
    ct_b64: b64(cipherBuf)
  };
}

async function decryptSnapshotPayload(envelope, mkRaw) {
  if (!envelope || envelope.aead !== 'aes-256-gcm') return null;
  const salt = b64u8(envelope.salt_b64);
  const iv = b64u8(envelope.iv_b64);
  const ct = b64u8(envelope.ct_b64);
  const info = envelope.info || SNAPSHOT_INFO_TAG;
  const plain = await decryptWithMK(ct, mkRaw, salt, iv, info);
  return decoder.decode(plain);
}

export async function triggerContactSecretsBackup(reason = 'manual', { force = false, keepalive = false } = {}) {
  if (backupDisabled) return false;
  const mk = getMkRaw();
  if (!mk) return false;
  const snapshot = latestPersistDetail || buildContactSecretsSnapshot();
  if (!snapshot?.payload) return false;
  if (!force && snapshot.checksum && snapshot.checksum === lastUploadedChecksum) {
    return false;
  }
  try {
    const payloadEnvelope = await encryptSnapshotPayload(snapshot.payload, mk);
    const fetchOptions = keepalive ? { keepalive: true } : {};
    const { r } = await uploadContactSecretsBackup({
      payload: payloadEnvelope,
      checksum: snapshot.checksum || null,
      snapshotVersion: snapshot.summary?.version || null,
      entries: snapshot.summary?.entries || null,
      updatedAt: snapshot.summary?.generatedAt || Date.now(),
      bytes: snapshot.summary?.bytes || null,
      deviceLabel,
      deviceId: ensureDeviceId()
    }, fetchOptions);
    if (r.status === 404) {
      backupDisabled = true;
      log({ contactSecretsBackupDisabled: 'upload-404' });
      return false;
    }
    if (r.ok) {
      lastUploadedChecksum = snapshot.checksum || null;
      log({ contactSecretsBackupUploaded: { status: r.status, snapshotVersion: snapshot.summary?.version || null, entries: snapshot.summary?.entries || null } });
      return true;
    }
    log({ contactSecretsBackupUploadFailed: { status: r.status, reason } });
    return false;
  } catch (err) {
    log({ contactSecretsBackupUploadError: err?.message || err, reason });
    return false;
  }
}

export function requestContactSecretsBackupSync({ force = false } = {}) {
  if (syncCompleted && !force) return;
  syncRequested = true;
  scheduleSyncAttempt(0);
}

function scheduleSyncAttempt(delayMs) {
  if (!syncRequested) return;
  setTimeout(() => {
    performSync().catch((err) => {
      log({ contactSecretsBackupSyncError: err?.message || err });
      scheduleSyncAttempt(5000);
    });
  }, delayMs);
}

async function performSync() {
  if (!syncRequested || syncInFlight || backupDisabled) return;
  const mk = getMkRaw();
  if (!mk) {
    scheduleSyncAttempt(2000);
    return;
  }
  syncInFlight = true;
  try {
    const { r, data } = await fetchContactSecretsBackup({ limit: 1 });
    if (r.status === 404) {
      backupDisabled = true;
      syncRequested = false;
      log({ contactSecretsBackupDisabled: 'fetch-404' });
      return;
    }
    if (!r.ok) {
      return;
    }
    const backup = Array.isArray(data?.backups) ? data.backups[0] : null;
    if (!backup?.payload) {
      syncCompleted = true;
      return;
    }
    if (backup.checksum && backup.checksum === lastUploadedChecksum && !latestPersistDetail) {
      syncCompleted = true;
      return;
    }
    const snapshot = await decryptSnapshotPayload(backup.payload, mk);
    if (!snapshot) return;
    const summary = importContactSecretsSnapshot(snapshot, { replace: true, reason: 'remote-backup', persist: true });
    if (summary) {
      const checksumRecord = await computeContactSecretsChecksum(snapshot).catch(() => null);
      latestPersistDetail = {
        payload: snapshot,
        summary,
        checksum: checksumRecord?.value || null,
        snapshotVersion: backup.snapshotVersion || summary.version || null,
        backupMeta: {
          version: backup.version || null,
          updatedAt: backup.updatedAt || null,
          deviceId: backup.deviceId || null,
          deviceLabel: backup.deviceLabel || null
        }
      };
      lastUploadedChecksum = backup.checksum || checksumRecord?.value || null;
      syncCompleted = true;
    }
  } finally {
    syncInFlight = false;
  }
}
