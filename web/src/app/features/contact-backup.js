import { b64 } from '../crypto/aead.js';
import { getMkRaw, ensureDeviceId, getAccountDigest } from '../core/store.js';
import { log, logCapped } from '../core/log.js';
import { uploadContactSecretsBackup, fetchContactSecretsBackup } from '../api/contact-secrets.js';
import {
  buildContactSecretsSnapshot,
  importContactSecretsSnapshot,
  computeContactSecretsChecksum,
  encryptContactSecretPayload,
  decryptContactSecretPayload
} from '../core/contact-secrets.js';

import { sessionStore } from '../ui/mobile/session-store.js';

// Periodic backup retired in favor of Atomic Piggyback (Vault).
// const SNAPSHOT_INFO_TAG = 'contact-secrets/backup/v1';
// const SNAPSHOT_ALLOWED_INFO_TAGS = new Set([SNAPSHOT_INFO_TAG]);
// const encoder = new TextEncoder();
// const decoder = new TextDecoder();
const CORRUPT_BACKUP_REASON_DEFAULT = 'corrupt-contact-backup';
const corruptBackupSeen = new Set();

/**
 * Normalize backup object from API response (snake_case -> camelCase)
 */
function normalizeBackupResponse(backup) {
  if (!backup) return backup;
  return {
    ...backup,
    snapshotVersion: backup.snapshotVersion ?? backup.snapshot_version ?? null,
    updatedAt: backup.updatedAt ?? backup.updated_at ?? null,
    createdAt: backup.createdAt ?? backup.created_at ?? null,
    deviceId: backup.deviceId ?? backup.device_id ?? null,
    deviceLabel: backup.deviceLabel ?? backup.device_label ?? null,
    withDrState: backup.withDrState ?? backup.with_dr_state ?? null,
    accountDigest: backup.accountDigest ?? backup.account_digest ?? null,
  };
}

function ensureCorruptBackupStore() {
  if (!(sessionStore.corruptContactBackups instanceof Map)) {
    const entries = sessionStore.corruptContactBackups && typeof sessionStore.corruptContactBackups.entries === 'function'
      ? Array.from(sessionStore.corruptContactBackups.entries())
      : [];
    sessionStore.corruptContactBackups = new Map(entries);
  }
  return sessionStore.corruptContactBackups;
}

function normalizeBackupKey(backup) {
  if (!backup) return null;
  const candidates = [
    backup.messageId,
    backup.message_id,
    backup.id,
    backup.version,
    backup.snapshotVersion,
    backup.checksum
  ];
  for (const c of candidates) {
    if (c === undefined || c === null) continue;
    const key = String(c).trim();
    if (key) return key;
  }
  return null;
}

function recordCorruptBackup({ backup, reason = CORRUPT_BACKUP_REASON_DEFAULT } = {}) {
  const store = ensureCorruptBackupStore();
  const key = normalizeBackupKey(backup) || `ts:${Date.now()}`;
  if (key && corruptBackupSeen.has(key)) {
    return store.get(key) || null;
  }
  const entry = {
    accountDigest: getAccountDigest?.() || null,
    version: backup?.version ?? backup?.snapshotVersion ?? null,
    serverMessageId: backup?.messageId || backup?.message_id || backup?.id || null,
    reason: reason || CORRUPT_BACKUP_REASON_DEFAULT,
    ts: Date.now()
  };
  store.set(key, entry);
  corruptBackupSeen.add(key);
  sessionStore.lastCorruptContactBackup = entry;
  log({ contactSecretsBackupCorrupt: entry });
  return entry;
}

function getRecordedCorruptBackup(key) {
  const store = ensureCorruptBackupStore();
  if (key && store.has(key)) return store.get(key);
  return null;
}

let initialized = false;
let deviceLabel = null;
let latestPersistDetail = null;
let uploadTimer = null;
let lastUploadedChecksum = null;
let syncRequested = false;
let syncInFlight = false;
let syncCompleted = false;
let backupDisabled = false;
let lastHydrateResult = null;

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
  // Periodic backup retired.
  // if (typeof window !== 'undefined') {
  //   window.addEventListener('contactSecrets:persisted', handlePersistEvent);
  //   window.addEventListener('online', () => scheduleBackup('online'));
  // }
  // Attempt to sync (hydrate) soon after init, mainly for restoration check?
  // Actually hydrate calls fetchContactSecretsBackup.
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

// Encryption logic moved to contact-secrets.js
// async function encryptSnapshotPayload...
// async function decryptSnapshotPayload...

export async function getContactSecretsBackupPayload({ force = false, allowWithoutDrState = false, reason = 'manual' } = {}) {
  const isForced = !!force || reason === 'secure-logout' || reason === 'force-logout';
  if (backupDisabled && !isForced) return null;
  const mk = getMkRaw();
  if (!mk) return null;

  let snapshot = buildContactSecretsSnapshot();
  let summary = snapshot?.summary || null;
  let entryCount = Number.isFinite(Number(summary?.entries)) ? Number(summary.entries) : null;
  let withDrState = Number.isFinite(Number(summary?.withDrState)) ? Number(summary.withDrState) : null;

  if (!snapshot?.payload) return null;

  let shouldSkipForNoDrState = entryCount > 0 && withDrState === 0 && !isForced && !allowWithoutDrState;
  if (shouldSkipForNoDrState) {
    const refreshed = buildContactSecretsSnapshot();
    // If refreshed has state, use it.
    if (refreshed?.summary?.withDrState > 0) {
      snapshot = refreshed;
      summary = refreshed.summary;
      withDrState = summary.withDrState;
      shouldSkipForNoDrState = false;
    }
  }
  if (shouldSkipForNoDrState) return null;

  // Dirty check
  if (!isForced && snapshot.checksum && snapshot.checksum === lastUploadedChecksum) return null;

  try {
    const payloadEnvelope = await encryptContactSecretPayload(snapshot.payload, mk);
    // Return structure for atomic API
    // matches args for uploadContactSecretsBackup but returned as object
    return {
      payload: payloadEnvelope,
      checksum: snapshot.checksum || null,
      snapshotVersion: summary?.version || null,
      entries: entryCount,
      updatedAt: summary?.generatedAt || Date.now(),
      bytes: summary?.bytes || null,
      withDrState,
      deviceLabel: deviceLabel || detectDeviceLabel() || null,
      deviceId: ensureDeviceId(),
      // Helpers for post-process
      _snapshot: snapshot,
      _checksum: snapshot.checksum,
      accountDigest: getAccountDigest()
    };
  } catch (err) {
    log({ contactSecretsBackupPayloadError: err?.message || err });
    return null;
  }
}

export async function triggerContactSecretsBackup(
  reason = 'manual',
  {
    force = false,
    keepalive = false,
    sourceTag = null,
    allowWithoutDrState = false
  } = {}
) {
  if (uploadTimer) {
    clearTimeout(uploadTimer);
    uploadTimer = null;
  }
  const isForced = !!force || reason === 'secure-logout' || reason === 'force-logout';
  const summaryHint = latestPersistDetail?.summary || null;
  const hintEntries = Number.isFinite(Number(summaryHint?.entries)) ? Number(summaryHint.entries) : null;
  const hintWithDrState = Number.isFinite(Number(summaryHint?.withDrState)) ? Number(summaryHint.withDrState) : null;
  logCapped('contactSecretsBackupTriggerTrace', {
    reason,
    sourceTag: sourceTag || reason || null,
    force: isForced,
    entries: hintEntries,
    withDrState: hintWithDrState,
    allowWithoutDrState: allowWithoutDrState === true ? true : null
  }, 5);
  if (backupDisabled) {
    if (!isForced) {
      logCapped('contactSecretsBackupSkippedTrace', {
        reason,
        sourceTag: sourceTag || reason || null,
        force: isForced,
        entries: hintEntries,
        withDrState: hintWithDrState,
        skipReason: 'backup-disabled'
      }, 5);
    }
    return false;
  }
  const mk = getMkRaw();
  if (!mk) {
    if (!isForced) {
      logCapped('contactSecretsBackupSkippedTrace', {
        reason,
        sourceTag: sourceTag || reason || null,
        force: isForced,
        entries: hintEntries,
        withDrState: hintWithDrState,
        skipReason: 'mk-missing'
      }, 5);
    }
    return false;
  }
  let snapshot = buildContactSecretsSnapshot();
  let summary = snapshot?.summary || null;
  let entryCount = Number.isFinite(Number(summary?.entries)) ? Number(summary.entries) : null;
  let withDrState = Number.isFinite(Number(summary?.withDrState)) ? Number(summary.withDrState) : null;
  if (!snapshot?.payload) {
    if (!isForced) {
      logCapped('contactSecretsBackupSkippedTrace', {
        reason,
        sourceTag: sourceTag || reason || null,
        force: isForced,
        entries: entryCount,
        withDrState,
        skipReason: 'snapshot-missing'
      }, 5);
    }
    return false;
  }
  let shouldSkipForNoDrState = entryCount > 0 && withDrState === 0 && !isForced && !allowWithoutDrState;
  if (shouldSkipForNoDrState) {
    const refreshed = buildContactSecretsSnapshot();
    const refreshedSummary = refreshed?.summary || null;
    const refreshedEntries = Number.isFinite(Number(refreshedSummary?.entries)) ? Number(refreshedSummary.entries) : null;
    const refreshedWithDrState = Number.isFinite(Number(refreshedSummary?.withDrState))
      ? Number(refreshedSummary.withDrState)
      : null;
    snapshot = refreshed || snapshot;
    summary = refreshedSummary || summary;
    entryCount = refreshedEntries !== null ? refreshedEntries : entryCount;
    withDrState = refreshedWithDrState !== null ? refreshedWithDrState : withDrState;
    if (refreshedWithDrState === null) {
      shouldSkipForNoDrState = false;
    } else if (refreshedWithDrState > 0) {
      shouldSkipForNoDrState = false;
    }
  }
  if (shouldSkipForNoDrState) {
    logCapped('contactSecretsBackupSkippedTrace', {
      reason,
      sourceTag: sourceTag || reason || null,
      force: isForced,
      entries: entryCount,
      withDrState,
      skipReason: 'withDrState-absent'
    }, 5);
    log({ contactSecretsBackupSkipped: 'withDrState-absent', reason, entries: entryCount });
    return false;
  }
  if (!isForced && snapshot.checksum && snapshot.checksum === lastUploadedChecksum) {
    logCapped('contactSecretsBackupSkippedTrace', {
      reason,
      sourceTag: sourceTag || reason || null,
      force: isForced,
      entries: entryCount,
      withDrState,
      skipReason: 'checksum-unchanged'
    }, 5);
    return false;
  }
  try {
    const payloadEnvelope = await encryptContactSecretPayload(snapshot.payload, mk);
    const fetchOptions = keepalive ? { keepalive: true } : {};
    const { r } = await uploadContactSecretsBackup({
      payload: payloadEnvelope,
      checksum: snapshot.checksum || null,
      snapshotVersion: summary?.version || null,
      entries: entryCount,
      updatedAt: summary?.generatedAt || Date.now(),
      bytes: summary?.bytes || null,
      withDrState,
      deviceLabel,
      deviceId: ensureDeviceId()
    }, fetchOptions);
    if (r.status === 404) {
      backupDisabled = true;
      log({ contactSecretsBackupDisabled: 'upload-404' });
      logCapped('contactSecretsBackupResultTrace', {
        ok: false,
        status: r.status,
        snapshotVersion: summary?.version || null,
        updatedAt: summary?.generatedAt || null,
        bytes: summary?.bytes || null
      }, 5);
      return false;
    }
    if (r.ok) {
      lastUploadedChecksum = snapshot.checksum || null;
      log({ contactSecretsBackupUploaded: { status: r.status, snapshotVersion: snapshot.summary?.version || null, entries: snapshot.summary?.entries || null } });
      logCapped('contactSecretsBackupResultTrace', {
        ok: true,
        status: r.status,
        snapshotVersion: summary?.version || null,
        updatedAt: summary?.generatedAt || null,
        bytes: summary?.bytes || null
      }, 5);
      return true;
    }
    log({ contactSecretsBackupUploadFailed: { status: r.status, reason } });
    logCapped('contactSecretsBackupResultTrace', {
      ok: false,
      status: r.status,
      snapshotVersion: summary?.version || null,
      updatedAt: summary?.generatedAt || null,
      bytes: summary?.bytes || null
    }, 5);
    return false;
  } catch (err) {
    log({ contactSecretsBackupUploadError: err?.message || err, reason });
    logCapped('contactSecretsBackupResultTrace', {
      ok: false,
      status: null,
      snapshotVersion: summary?.version || null,
      updatedAt: summary?.generatedAt || null,
      bytes: summary?.bytes || null,
      errorMessage: err?.message || String(err)
    }, 5);
    return false;
  }
}

export async function hydrateContactSecretsFromBackup({ reason = 'post-login-hydrate' } = {}) {
  const recordResult = (result = {}) => {
    const meta = latestPersistDetail?.backupMeta || null;
    const snapshotVersion = result.snapshotVersion || latestPersistDetail?.snapshotVersion || latestPersistDetail?.summary?.version || null;
    lastHydrateResult = {
      ...result,
      snapshotVersion,
      backupMeta: meta
        ? {
          version: meta.version || null,
          updatedAt: meta.updatedAt || null,
          deviceId: meta.deviceId || null,
          deviceLabel: meta.deviceLabel || null
        }
        : null,
      ts: Date.now()
    };
    return lastHydrateResult;
  };
  if (backupDisabled) return recordResult({ ok: false, status: 404, entries: 0, corruptCount: 0, noData: true });
  const mk = getMkRaw();
  if (!mk) return recordResult({ ok: false, status: null, entries: 0, corruptCount: 0, noData: false });
  if (syncInFlight) return recordResult({ ok: false, status: null, entries: 0, corruptCount: 0, noData: false });
  syncInFlight = true;
  try {
    const { r, data } = await fetchContactSecretsBackup({ limit: 1 });
    const status = r?.status ?? null;
    if (status === 404) {
      backupDisabled = true;
      syncRequested = false;
      return recordResult({ ok: false, status, entries: 0, corruptCount: 0, noData: true });
    }
    if (!r?.ok) return recordResult({ ok: false, status, entries: 0, corruptCount: 0, noData: false });
    const backup = normalizeBackupResponse(Array.isArray(data?.backups) ? data.backups[0] : null);
    if (!backup?.payload) {
      syncCompleted = true;
      return recordResult({ ok: false, status, entries: 0, corruptCount: 0, noData: true });
    }
    if (backup.checksum && backup.checksum === lastUploadedChecksum && !latestPersistDetail) {
      syncCompleted = true;
      return recordResult({ ok: true, status, entries: 0, corruptCount: 0, noData: false, snapshotVersion: backup.snapshotVersion || null });
    }
    const backupKey = normalizeBackupKey(backup);
    if (backupKey && corruptBackupSeen.has(backupKey)) {
      return recordResult({
        ok: false,
        status,
        entries: 0,
        corruptCount: 1,
        corrupt: true,
        noData: false,
        corruptBackup: getRecordedCorruptBackup(backupKey),
        snapshotVersion: backup.snapshotVersion || null
      });
    }
    const decryptResult = await decryptContactSecretPayload(backup.payload, mk);
    if (!decryptResult.ok) {
      const recorded = decryptResult.corrupt ? recordCorruptBackup({ backup, reason: decryptResult.reason }) : null;
      syncCompleted = true;
      return recordResult({
        ok: false,
        status,
        entries: 0,
        corruptCount: decryptResult.corrupt ? 1 : 0,
        corrupt: !!decryptResult.corrupt,
        noData: false,
        corruptBackup: recorded,
        snapshotVersion: backup.snapshotVersion || null
      });
    }
    const snapshot = decryptResult.snapshot;
    const summary = importContactSecretsSnapshot(snapshot, { replace: true, reason, persist: true });
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
      try {
        if (typeof document !== 'undefined') {
          document.dispatchEvent(new CustomEvent('contactSecrets:restored', { detail: { source: reason, summary } }));
        }
      } catch { }
    }
    const corruptCount = Array.isArray(summary?.corruptEntries) ? summary.corruptEntries.length : 0;
    return recordResult({
      ok: !!summary,
      status,
      entries: summary?.entries || 0,
      corruptCount,
      noData: false,
      snapshotVersion: backup.snapshotVersion || summary?.version || null
    });
  } catch (err) {
    log({ contactSecretsBackupHydrateError: err?.message || err, reason });
    return recordResult({ ok: false, status: null, entries: 0, corruptCount: 0, noData: false });
  } finally {
    syncInFlight = false;
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
    const backup = normalizeBackupResponse(Array.isArray(data?.backups) ? data.backups[0] : null);
    if (!backup?.payload) {
      syncCompleted = true;
      return;
    }
    if (backup.checksum && backup.checksum === lastUploadedChecksum && !latestPersistDetail) {
      syncCompleted = true;
      return;
    }
    const backupKey = normalizeBackupKey(backup);
    if (backupKey && corruptBackupSeen.has(backupKey)) {
      log({ contactSecretsBackupSkippedCorrupt: backupKey });
      return;
    }
    const decryptResult = await decryptContactSecretPayload(backup.payload, mk);
    if (!decryptResult.ok) {
      if (decryptResult.corrupt) recordCorruptBackup({ backup, reason: decryptResult.reason });
      syncCompleted = true;
      return;
    }
    const snapshot = decryptResult.snapshot;
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
      try {
        if (typeof document !== 'undefined') {
          document.dispatchEvent(new CustomEvent('contactSecrets:restored', { detail: { source: 'backup-sync', summary } }));
        }
      } catch { }
    }
  } finally {
    syncInFlight = false;
  }
}

export function getLastBackupHydrateResult() {
  if (!lastHydrateResult) return null;
  try {
    return JSON.parse(JSON.stringify(lastHydrateResult));
  } catch {
    return { ...lastHydrateResult };
  }
}

export function getLatestBackupMeta() {
  if (!latestPersistDetail) return null;
  const meta = latestPersistDetail.backupMeta || null;
  return {
    snapshotVersion: latestPersistDetail.snapshotVersion || latestPersistDetail?.summary?.version || null,
    entries: latestPersistDetail?.summary?.entries || null,
    bytes: latestPersistDetail?.summary?.bytes || null,
    updatedAt: meta?.updatedAt || latestPersistDetail?.summary?.generatedAt || null,
    backupVersion: meta?.version || null,
    deviceId: meta?.deviceId || null,
    deviceLabel: meta?.deviceLabel || null,
    checksum: latestPersistDetail?.checksum || null
  };
}
