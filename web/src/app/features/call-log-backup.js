/**
 * Call-Log Backup Module
 *
 * Encrypted cloud persistence for call-log entries in 1:1 conversations.
 * Follows the same pattern as contact-secrets backup:
 *   - Entries accumulated in memory during session
 *   - Encrypted with MK via wrapWithMK_JSON, uploaded to contact-secrets backup endpoint
 *   - Hydrated on login via unwrapWithMK_JSON from server backup
 *   - Cleared on logout (local data wiped, server backup persists)
 *
 * Uses its own reason ('call-log-backup') and info tag ('call-log-backup/v1')
 * to coexist with contact-secrets and biz-conv backups on the same endpoint.
 */

import { getMkRaw, getAccountToken, getAccountDigest, ensureDeviceId } from '../core/store.js';
import { log } from '../core/log.js';
import { wrapWithMK_JSON, unwrapWithMK_JSON } from '../../shared/crypto/aead.js';
import { fetchWithTimeout } from '../core/http.js';

const CALL_LOG_BACKUP_INFO = 'call-log-backup/v1';
let backupDirty = false;
let backupDebounceTimer = null;
let backupInFlight = false;
const BACKUP_DEBOUNCE_MS = 3000;

/**
 * In-memory store: conversationId → Map(callId → entry)
 */
const callLogMap = new Map();

function authHeaders() {
  const h = {};
  const token = getAccountToken();
  if (token) h['x-account-token'] = token;
  const digest = getAccountDigest();
  if (digest) h['x-account-digest'] = digest;
  const deviceId = ensureDeviceId();
  if (deviceId) h['x-device-id'] = deviceId;
  return h;
}

// ── Public API ──────────────────────────────────────────────

/**
 * Add a call-log entry to the in-memory store and schedule backup.
 */
export function addCallLogEntry(conversationId, entry) {
  if (!conversationId || !entry) return;
  const callId = entry.callLog?.callId || entry.callId;
  if (!callId) return;

  let convMap = callLogMap.get(conversationId);
  if (!convMap) {
    convMap = new Map();
    callLogMap.set(conversationId, convMap);
  }

  convMap.set(callId, {
    messageId: entry.messageId || entry.id || null,
    callId,
    ts: entry.ts || 0,
    direction: entry.direction || 'outgoing',
    text: entry.text || '',
    msgType: 'call-log',
    callLog: entry.callLog || null
  });

  markCallLogBackupDirty();
}

/**
 * Mark backup as needing sync and schedule debounced upload.
 */
export function markCallLogBackupDirty() {
  backupDirty = true;
  scheduleDebouncedBackup();
}

/**
 * Check if a call-log entry already exists.
 */
export function hasCallLogEntry(conversationId, callId) {
  if (!conversationId || !callId) return false;
  const convMap = callLogMap.get(conversationId);
  return convMap ? convMap.has(callId) : false;
}

/**
 * Clear all call-log entries on logout.
 */
export function clearCallLogOnLogout() {
  if (backupDebounceTimer) {
    clearTimeout(backupDebounceTimer);
    backupDebounceTimer = null;
  }
  callLogMap.clear();
  backupDirty = false;
  backupInFlight = false;
}

// ── Backup / Restore ────────────────────────────────────────

function scheduleDebouncedBackup() {
  if (backupDebounceTimer) clearTimeout(backupDebounceTimer);
  backupDebounceTimer = setTimeout(() => {
    backupDebounceTimer = null;
    if (backupDirty && !backupInFlight) {
      uploadCallLogBackup().catch(err => log({ callLogDebouncedBackupError: err?.message }));
    }
  }, BACKUP_DEBOUNCE_MS);
}

function buildBackupPayload() {
  const conversations = {};
  for (const [convId, entries] of callLogMap) {
    const items = [];
    for (const [, entry] of entries) {
      items.push(entry);
    }
    if (items.length > 0) {
      conversations[convId] = items;
    }
  }
  return { v: 1, conversations, updated_at: Date.now() };
}

/**
 * Encrypt and upload call-log backup to server.
 */
export async function uploadCallLogBackup() {
  if (!backupDirty && callLogMap.size === 0) return;
  if (backupInFlight) return;

  const mkRaw = getMkRaw();
  if (!mkRaw) {
    log({ callLogBackupSkip: 'no MK' });
    return;
  }

  backupInFlight = true;
  try {
    const payload = buildBackupPayload();
    backupDirty = false;

    const encrypted = await wrapWithMK_JSON(payload, mkRaw, CALL_LOG_BACKUP_INFO);

    const r = await fetchWithTimeout('/api/v1/contact-secrets/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        payload: JSON.stringify(encrypted),
        reason: 'call-log-backup'
      })
    }, 15000);

    if (r.ok) {
      log({ callLogBackupOk: callLogMap.size });
    } else {
      backupDirty = true;
      scheduleDebouncedBackup();
      log({ callLogBackupFail: r.status });
    }
  } catch (err) {
    backupDirty = true;
    scheduleDebouncedBackup();
    log({ callLogBackupError: err?.message });
  } finally {
    backupInFlight = false;
    if (backupDirty) scheduleDebouncedBackup();
  }
}

/**
 * Download and restore call-log backup from server.
 * Called during login hydration.
 */
export async function hydrateCallLogFromBackup() {
  const mkRaw = getMkRaw();
  if (!mkRaw) return;

  try {
    const r = await fetchWithTimeout('/api/v1/contact-secrets/backup?limit=5', {
      method: 'GET',
      headers: authHeaders()
    }, 15000);

    if (!r.ok) {
      log({ callLogHydrateFail: r.status });
      return;
    }

    const data = await r.json();
    const backups = data?.backups || data?.results || [];
    if (!backups.length) return;

    for (const backup of backups) {
      try {
        const payloadStr = backup?.payload;
        if (!payloadStr) continue;
        const envelope = typeof payloadStr === 'string' ? JSON.parse(payloadStr) : payloadStr;

        // Only process call-log-backup/v1 tagged envelopes
        if (envelope?.info !== CALL_LOG_BACKUP_INFO) continue;

        const decrypted = await unwrapWithMK_JSON(envelope, mkRaw);
        if (decrypted && decrypted.conversations) {
          // Restore into in-memory store
          for (const [convId, items] of Object.entries(decrypted.conversations)) {
            if (!Array.isArray(items)) continue;
            let convMap = callLogMap.get(convId);
            if (!convMap) {
              convMap = new Map();
              callLogMap.set(convId, convMap);
            }
            for (const entry of items) {
              const callId = entry.callLog?.callId || entry.callId;
              if (!callId) continue;
              if (!convMap.has(callId)) {
                convMap.set(callId, entry);
              }
            }
          }

          // Inject into timeline store
          const { appendUserMessage } = await import('./timeline-store.js');
          let injected = 0;
          for (const [convId, entries] of callLogMap) {
            for (const [, entry] of entries) {
              if (!entry.messageId || !entry.ts) continue;
              const ok = appendUserMessage(convId, {
                messageId: entry.messageId,
                msgType: 'call-log',
                direction: entry.direction || 'outgoing',
                text: entry.text || '',
                ts: entry.ts,
                callLog: entry.callLog || null,
                conversationId: convId
              });
              if (ok) injected++;
            }
          }

          log({ callLogHydrateOk: injected, total: callLogMap.size });
          return;
        }
      } catch (err) {
        log({ callLogHydrateDecryptFail: err?.message });
      }
    }

    log({ callLogHydrate: 'no call-log backup found' });
  } catch (err) {
    log({ callLogHydrateError: err?.message });
  }
}
