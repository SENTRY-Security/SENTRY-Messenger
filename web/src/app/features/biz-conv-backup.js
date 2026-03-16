/**
 * Business Conversation Backup Module
 *
 * Handles encrypted backup/restore of biz-conv seeds and chain states.
 * Uses the existing wrapWithMK_JSON / unwrapWithMK_JSON for encryption.
 * Stored on server via contact-secrets backup endpoint (extended payload).
 */

import { getMkRaw } from '../core/store.js';
import { log } from '../core/log.js';
import { BizConvStore, decryptMetaBlob } from './biz-conv.js';
import { wrapWithMK_JSON, unwrapWithMK_JSON } from '../../shared/crypto/aead.js';
import { fetchWithTimeout } from '../core/http.js';
import { getAccountToken, getAccountDigest, ensureDeviceId } from '../core/store.js';
import { bizConvList } from '../api/biz-conv.js';
import { upsertBizConvThread } from './conversation-updates.js';

const BIZ_CONV_BACKUP_INFO = 'biz-conv-backup/v1';
let backupDirty = false;
let backupDebounceTimer = null;
let backupInFlight = false;
const BACKUP_DEBOUNCE_MS = 2000; // Coalesce rapid changes, but flush quickly

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
 * Mark backup as needing sync and schedule an immediate debounced upload.
 * Event-driven: every state change triggers backup within BACKUP_DEBOUNCE_MS.
 * This ensures data is persisted before the tab can be closed.
 */
export function markBizConvBackupDirty() {
  backupDirty = true;
  scheduleDebouncedBackup();
}

function scheduleDebouncedBackup() {
  if (backupDebounceTimer) clearTimeout(backupDebounceTimer);
  backupDebounceTimer = setTimeout(() => {
    backupDebounceTimer = null;
    if (backupDirty && !backupInFlight) {
      uploadBizConvBackup().catch(err => log({ bizConvDebouncedBackupError: err?.message }));
    }
  }, BACKUP_DEBOUNCE_MS);
}

/**
 * Synchronous-safe flush for pagehide/beforeunload.
 * Uses navigator.sendBeacon as last resort since fetch may be cancelled.
 */
export function flushBizConvBackupBeacon() {
  if (!backupDirty || BizConvStore.conversations.size === 0) return;
  // sendBeacon is fire-and-forget, best effort on tab close
  // We can't encrypt here (async), so only useful if a recent upload succeeded.
  // The primary protection is the debounced upload that fires within 2s of any change.
  // This function exists as a safety net — trigger any pending debounce immediately.
  if (backupDebounceTimer) {
    clearTimeout(backupDebounceTimer);
    backupDebounceTimer = null;
  }
  // Best-effort: start upload (may or may not complete before tab dies)
  if (!backupInFlight) {
    uploadBizConvBackup().catch(() => {});
  }
}

/**
 * Encrypt and upload biz-conv backup to server.
 */
export async function uploadBizConvBackup() {
  if (!backupDirty && BizConvStore.conversations.size === 0) return;
  if (backupInFlight) return; // Prevent concurrent uploads

  const mkRaw = getMkRaw();
  if (!mkRaw) {
    log({ bizConvBackupSkip: 'no MK' });
    return;
  }

  backupInFlight = true;
  try {
    const payload = BizConvStore.buildBackupPayload();
    // Mark clean before upload — if new changes arrive during upload,
    // markBizConvBackupDirty will re-set and schedule another round.
    backupDirty = false;

    const encrypted = await wrapWithMK_JSON(payload, mkRaw, BIZ_CONV_BACKUP_INFO);

    const r = await fetchWithTimeout('/api/v1/contact-secrets/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        payload: encrypted,  // Must be object — server rejects typeof !== 'object'
        reason: 'biz-conv-backup'
      })
    }, 15000);

    if (r.ok) {
      log({ bizConvBackupOk: BizConvStore.conversations.size });
    } else {
      // Upload failed — re-mark dirty so next debounce retries
      backupDirty = true;
      scheduleDebouncedBackup();
      log({ bizConvBackupFail: r.status });
    }
  } catch (err) {
    backupDirty = true;
    scheduleDebouncedBackup();
    log({ bizConvBackupError: err?.message });
  } finally {
    backupInFlight = false;
    // If new changes arrived during upload, trigger another round
    if (backupDirty) scheduleDebouncedBackup();
  }
}

/**
 * Fetch the set of active group IDs from the server.
 * Used to filter stale groups during backup restore.
 * @returns {Promise<Set<string>|null>} Set of active conversation IDs, or null on failure
 */
export async function fetchActiveServerGroupIds() {
  try {
    const result = await bizConvList();
    const conversations = result?.conversations || [];
    const ids = new Set();
    for (const conv of conversations) {
      const convId = conv.conversation_id;
      if (convId && conv.status === 'active') ids.add(convId);
    }
    return ids;
  } catch (err) {
    log({ bizConvFetchActiveIdsFail: err?.message });
    return null;
  }
}

/**
 * Download and restore biz-conv backup from server.
 * Called during login hydration.
 * @param {Set<string>|null} [activeServerIds] - Pre-fetched active group IDs to filter stale groups
 */
export async function hydrateBizConvFromBackup(activeServerIds = null) {
  const mkRaw = getMkRaw();
  if (!mkRaw) return;

  try {
    // Try reason-filtered fetch first (efficient — only biz-conv-backup rows).
    // Fall back to unfiltered fetch if server doesn't support reason column yet.
    let backups = [];
    const r1 = await fetchWithTimeout('/api/v1/contact-secrets/backup?limit=3&reason=biz-conv-backup', {
      method: 'GET',
      headers: authHeaders()
    }, 15000);
    if (r1.ok) {
      const data1 = await r1.json();
      backups = data1?.backups || data1?.results || [];
    }
    if (!backups.length) {
      // Fallback: unfiltered fetch (older server without reason column)
      const r2 = await fetchWithTimeout('/api/v1/contact-secrets/backup?limit=10', {
        method: 'GET',
        headers: authHeaders()
      }, 15000);
      if (!r2.ok) {
        log({ bizConvHydrateFail: r2.status });
        return;
      }
      const data2 = await r2.json();
      backups = data2?.backups || data2?.results || [];
    }

    if (!backups.length) {
      console.warn('[biz-conv-backup] hydrate: 0 backup rows returned');
      return;
    }
    console.warn('[biz-conv-backup] hydrate: scanning', backups.length, 'backup rows for biz-conv-backup/v1');

    // Find the biz-conv backup (by parsing each backup's payload)
    for (const backup of backups) {
      try {
        const payloadStr = backup?.payload;
        if (!payloadStr) continue;
        const envelope = typeof payloadStr === 'string' ? JSON.parse(payloadStr) : payloadStr;

        // Only process biz-conv-backup/v1 tagged envelopes
        if (envelope?.info !== BIZ_CONV_BACKUP_INFO) {
          console.warn('[biz-conv-backup] hydrate: skip row (info=', envelope?.info, ')');
          continue;
        }

        const decrypted = await unwrapWithMK_JSON(envelope, mkRaw);
        if (decrypted && decrypted.conversations) {
          const totalInBackup = Object.keys(decrypted.conversations).length;
          await BizConvStore.restoreFromBackup(decrypted, activeServerIds);
          const restored = BizConvStore.conversations.size;
          log({ bizConvHydrateOk: restored, backupTotal: totalInBackup, filtered: totalInBackup - restored });
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
 * Sync group list from server and rebuild threads.
 * Called after hydrateBizConvFromBackup to ensure threads exist for all groups.
 * Decrypts meta when possible (requires seed from backup).
 */
export async function syncBizConvListFromServer() {
  try {
    const result = await bizConvList();
    const conversations = result?.conversations || [];

    // Build set of active server-side conversation IDs
    const activeServerIds = new Set();

    const selfDigest = getAccountDigest();
    const { getConversationThreads } = await import('./conversation-updates.js');
    const threads = getConversationThreads();

    for (const conv of (conversations || [])) {
      const convId = conv.conversation_id;
      if (!convId || conv.status !== 'active') continue;
      activeServerIds.add(convId);

      const state = BizConvStore.get(convId);
      const isOwner = selfDigest && conv.owner_account_digest
        ? selfDigest.toUpperCase() === conv.owner_account_digest.toUpperCase()
        : false;

      // Update local ownership info
      if (state) {
        state.owner_account_digest = conv.owner_account_digest;
        state.isOwner = isOwner;
      }

      // Try to decrypt meta if we have the key
      let groupName = state?.meta?.name || null;
      let groupAvatar = state?.meta?.avatar || null;
      if (state?._groupMetaKey && conv.encrypted_meta_blob) {
        try {
          const meta = await decryptMetaBlob(state._groupMetaKey, conv.encrypted_meta_blob);
          if (meta) {
            if (meta.name) groupName = meta.name;
            if (meta.avatar) groupAvatar = meta.avatar;
            // Merge server meta with existing meta to preserve fields (e.g. avatar)
            // that might be present in backup but absent from older server blobs
            if (state) {
              const prevMeta = state.meta || {};
              state.meta = { ...prevMeta, ...meta };
              // Ensure avatar is preserved if server meta didn't include it
              if (!state.meta.avatar && prevMeta.avatar) {
                state.meta.avatar = prevMeta.avatar;
              }
            }
          }
        } catch { /* can't decrypt yet */ }
      }

      // Ensure thread exists for UI (preserve existing unreadCount during sync)
      const existingThread = threads.get(convId);
      upsertBizConvThread(convId, {
        name: groupName,
        isOwner,
        status: 'active',
        avatar: groupAvatar,
        unreadCount: existingThread?.unreadCount ?? 0
      });
    }

    // Remove stale groups: locally restored from backup but no longer active on server
    // This handles dissolved/left groups whose backup wasn't updated before logout
    let removed = 0;
    const staleIds = [];
    for (const [convId] of BizConvStore.conversations) {
      if (!activeServerIds.has(convId)) staleIds.push(convId);
    }
    for (const convId of staleIds) {
      BizConvStore.remove(convId);
      threads.delete(convId);
      removed++;
    }
    if (removed > 0) {
      markBizConvBackupDirty();
      log({ bizConvSyncPurged: removed });
    }

    log({ bizConvListSync: conversations.length, active: activeServerIds.size });
  } catch (err) {
    log({ bizConvListSyncError: err?.message });
  }
}

/**
 * Flush any pending biz-conv backup before logout.
 * Must be called BEFORE clearBizConvOnLogout so the latest state is persisted.
 */
export async function flushBizConvBackupBeforeLogout() {
  if (backupDebounceTimer) {
    clearTimeout(backupDebounceTimer);
    backupDebounceTimer = null;
  }
  if (backupDirty || BizConvStore.conversations.size > 0) {
    try {
      await uploadBizConvBackup();
    } catch (err) {
      log({ bizConvLogoutFlushError: err?.message });
    }
  }
}

/**
 * Clear all biz-conv state on logout.
 */
export function clearBizConvOnLogout() {
  if (backupDebounceTimer) {
    clearTimeout(backupDebounceTimer);
    backupDebounceTimer = null;
  }
  BizConvStore.clear();
  backupDirty = false;
}
