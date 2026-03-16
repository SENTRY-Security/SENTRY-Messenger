/**
 * Business Conversation Backup Module
 *
 * Handles encrypted backup/restore of biz-conv seeds and chain states.
 * Uses the existing wrapWithMK_JSON / unwrapWithMK_JSON for encryption.
 * Stored on server via contact-secrets backup endpoint (extended payload).
 */

import { getMkRaw } from '../core/store.js';
import { log } from '../core/log.js';
import { BizConvStore } from './biz-conv.js';
import { wrapWithMK_JSON, unwrapWithMK_JSON } from '../../shared/crypto/aead.js';
import { fetchWithTimeout } from '../core/http.js';
import { getAccountToken, getAccountDigest, ensureDeviceId } from '../core/store.js';

const BIZ_CONV_BACKUP_INFO = 'biz-conv-backup/v1';
let backupDirty = false;

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

/**
 * Mark backup as needing sync.
 */
export function markBizConvBackupDirty() {
  backupDirty = true;
}

/**
 * Encrypt and upload biz-conv backup to server.
 */
export async function uploadBizConvBackup() {
  if (!backupDirty && BizConvStore.conversations.size === 0) return;

  const mkRaw = getMkRaw();
  if (!mkRaw) {
    log({ bizConvBackupSkip: 'no MK' });
    return;
  }

  try {
    const payload = BizConvStore.buildBackupPayload();
    const encrypted = await wrapWithMK_JSON(payload, mkRaw, BIZ_CONV_BACKUP_INFO);

    const r = await fetchWithTimeout('/api/v1/contact-secrets/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        payload: JSON.stringify(encrypted),
        reason: 'biz-conv-backup'
      })
    }, 15000);

    if (r.ok) {
      backupDirty = false;
      log({ bizConvBackupOk: BizConvStore.conversations.size });
    } else {
      log({ bizConvBackupFail: r.status });
    }
  } catch (err) {
    log({ bizConvBackupError: err?.message });
  }
}

/**
 * Download and restore biz-conv backup from server.
 * Called during login hydration.
 */
export async function hydrateBizConvFromBackup() {
  const mkRaw = getMkRaw();
  if (!mkRaw) return;

  try {
    const r = await fetchWithTimeout('/api/v1/contact-secrets/backup?limit=1', {
      method: 'GET',
      headers: authHeaders()
    }, 15000);

    if (!r.ok) {
      log({ bizConvHydrateFail: r.status });
      return;
    }

    const data = await r.json();
    const backups = data?.backups || data?.results || [];
    if (!backups.length) return;

    // Find the biz-conv backup (by parsing each backup's payload)
    for (const backup of backups) {
      try {
        const payloadStr = backup?.payload;
        if (!payloadStr) continue;
        const envelope = typeof payloadStr === 'string' ? JSON.parse(payloadStr) : payloadStr;

        // Only process biz-conv-backup/v1 tagged envelopes
        if (envelope?.info !== BIZ_CONV_BACKUP_INFO) continue;

        const decrypted = await unwrapWithMK_JSON(envelope, mkRaw);
        if (decrypted && decrypted.conversations) {
          await BizConvStore.restoreFromBackup(decrypted);
          log({ bizConvHydrateOk: Object.keys(decrypted.conversations).length });
          return;
        }
      } catch (err) {
        log({ bizConvHydrateDecryptFail: err?.message });
      }
    }

    log({ bizConvHydrate: 'no biz-conv backup found in results' });
  } catch (err) {
    log({ bizConvHydrateError: err?.message });
  }
}

/**
 * Trigger backup if dirty. Call this periodically or on key events.
 */
export async function triggerBizConvBackupIfDirty() {
  if (!backupDirty) return;
  return uploadBizConvBackup();
}

/**
 * Clear all biz-conv state on logout.
 */
export function clearBizConvOnLogout() {
  BizConvStore.clear();
  backupDirty = false;
}
