/**
 * Business Conversation Backup Module
 *
 * Handles encrypted backup/restore of biz-conv seeds and chain states.
 * Uses the existing wrapWithMK_JSON / unwrapWithMK_JSON for encryption.
 * Stored on server via contact-secrets backup endpoint (extended payload).
 */

import { getMkRaw } from '../core/store.js';
import { log } from '../core/log.js';
import { BizConvStore, decryptMetaBlob, deriveGroupMetaKey } from './biz-conv.js';
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
  // [FIX] Use OR: flush when dirty OR when conversations exist.
  // Previous AND logic (`!backupDirty || size === 0`) skipped flush when
  // state was modified (e.g. meta updated from server) without markDirty,
  // causing name/avatar/chain state loss on tab close.
  if (!backupDirty && BizConvStore.conversations.size === 0) return;
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

      // Ensure local state exists for every server-side group.
      // If backup was lost or never uploaded, we still need a BizConvStore entry
      // so that future KDM processing and meta decryption can work.
      let state = BizConvStore.get(convId);
      if (!state) {
        state = BizConvStore.getOrCreate(convId);
        state.status = 'active';
      }

      const isOwner = selfDigest && conv.owner_account_digest
        ? selfDigest.toUpperCase() === conv.owner_account_digest.toUpperCase()
        : false;

      // Update local ownership info
      state.owner_account_digest = conv.owner_account_digest;
      state.isOwner = isOwner;

      // Self-heal: derive _groupMetaKey if missing but seeds are available.
      // This covers the case where restoreFromBackup partially failed or
      // the backup had a stale currentEpoch pointing to a missing seed.
      if (!state._groupMetaKey) {
        const seedEpochs = Object.keys(state.seeds).map(Number).sort((a, b) => b - a);
        for (const ep of seedEpochs) {
          if (state.seeds[ep]) {
            try {
              state._groupMetaKey = await deriveGroupMetaKey(state.seeds[ep]);
              state.currentEpoch = ep;
            } catch (err) {
              console.warn('[biz-conv-sync] deriveGroupMetaKey failed', convId.slice(0, 16), err?.message);
            }
            break;
          }
        }
      }

      // Resolve name/avatar: backup meta → server encrypted meta blob → null
      let groupName = state.meta?.name || null;
      let groupAvatar = state.meta?.avatar || null;
      if (state._groupMetaKey && conv.encrypted_meta_blob) {
        try {
          const meta = await decryptMetaBlob(state._groupMetaKey, conv.encrypted_meta_blob);
          if (meta) {
            if (meta.name) groupName = meta.name;
            if (meta.avatar) groupAvatar = meta.avatar;
            // Merge server meta with existing local meta.
            // Server meta is authoritative for core fields (name, owner, created_at);
            // local meta may have avatar not present in older server blobs.
            // Strip `members` if present — stored separately in state.memberProfiles.
            const prevMeta = state.meta || {};
            const { members: _m, ...merged } = { ...prevMeta, ...meta };
            // Ensure avatar is preserved if server meta didn't include it
            if (!merged.avatar && prevMeta.avatar) {
              merged.avatar = prevMeta.avatar;
            }
            state.meta = merged;
            // Mark backup dirty so the updated meta from server is persisted.
            // Without this, meta decrypted from server blob (e.g. name/avatar
            // changed by another member while we were offline) is only in memory
            // and lost on tab close or next login.
            markBizConvBackupDirty();
          }
        } catch (err) {
          // Log instead of swallowing — helps diagnose key/epoch mismatches
          console.warn('[biz-conv-sync] meta decrypt failed', convId.slice(0, 16), err?.message);
        }
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

    // Signal UI to re-render conversation list with restored name/avatar data.
    // Without this, the list may render before sync completes and show stale entries.
    try {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('biz-conv:threads-synced', {
          detail: { count: activeServerIds.size }
        }));
      }
    } catch (_) { /* ignore in non-browser env */ }
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
  // [FIX] If a debounced upload is currently in flight, wait for it to finish
  // before attempting our own upload.  Without this, the flush silently skips
  // when backupInFlight is true, and any state changes that occurred AFTER the
  // in-flight upload captured its payload are lost.
  if (backupInFlight) {
    // Poll briefly — uploadBizConvBackup is typically fast (<2s)
    const deadline = Date.now() + 5000;
    while (backupInFlight && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
    }
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
