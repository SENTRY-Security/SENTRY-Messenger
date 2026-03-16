/**
 * Business Conversation Key Rotation Module
 *
 * Handles epoch advancement and re-keying when membership changes.
 * Flow:
 *   1. Owner kicks a member or member leaves
 *   2. Owner generates new group_seed for epoch+1
 *   3. Owner calls server to increment epoch
 *   4. Owner distributes KDM (new seed) to all remaining active members via DR
 *   5. Each member receives KDM → stores new seed → confirms epoch with server
 *   6. Owner creates a tombstone recording the rotation event
 */

import { BizConvStore, deriveGroupMetaKey, buildKDM, parseKDM, encryptTombstonePayload, encryptMetaBlob } from './biz-conv.js';
import {
  bizConvIncrementEpoch,
  bizConvConfirmEpoch,
  bizConvMembers,
  bizConvCreateTombstone,
  bizConvUpdateMeta
} from '../api/biz-conv.js';
import { markBizConvBackupDirty } from './biz-conv-backup.js';
import { upsertBizConvThread } from './conversation-updates.js';
import { getAccountDigest, ensureDeviceId } from '../core/store.js';
import { sendDrPlaintext } from './dr-session.js';
import { log } from '../core/log.js';

/**
 * Default KDM sender via pairwise DR session.
 * Used when no explicit sendKdmFn is provided.
 */
async function defaultSendKdm(peerAccountDigest, peerDeviceId, kdmPayload) {
  if (!peerAccountDigest || !peerDeviceId) {
    log({ bizConvKdmSkip: 'missing peer info', peer: peerAccountDigest?.slice(-8) });
    return;
  }
  await sendDrPlaintext({
    text: JSON.stringify(kdmPayload),
    peerAccountDigest,
    peerDeviceId,
    messageId: `kdm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    metaOverrides: { msgType: 'biz-conv-kdm' }
  });
}

/**
 * Perform a full key rotation for a business conversation.
 * Called by the owner after a membership change (kick or leave event).
 *
 * @param {string} conversationId
 * @param {Object} opts
 * @param {string} opts.reason - 'member-removed' | 'member-left' | 'manual'
 * @param {string} [opts.removedDigest] - The account digest of the removed/left member
 * @param {Function} [opts.sendKdmFn] - async (peerDigest, peerDeviceId, kdmPayload) => void
 * @returns {Promise<{ newEpoch: number, distributedCount: number }>}
 */
export async function rotateGroupKey(conversationId, opts = {}) {
  const { reason = 'manual', removedDigest = null, sendKdmFn = defaultSendKdm } = opts;

  const selfDigest = getAccountDigest();
  const selfDeviceId = ensureDeviceId();
  const state = BizConvStore.get(conversationId);
  if (!state) throw new Error('No local state for conversation');

  const oldEpoch = state.currentEpoch;
  const newEpoch = oldEpoch + 1;

  // 1. Generate new group seed
  const newSeed = crypto.getRandomValues(new Uint8Array(32));

  // 2. Increment epoch on server
  const epochResult = await bizConvIncrementEpoch(conversationId);
  log({ bizConvEpochIncrement: { conversationId: conversationId?.slice(-8), newEpoch, serverEpoch: epochResult?.epoch } });

  // 3. Update local state
  state.seeds[newEpoch] = newSeed;
  state.currentEpoch = newEpoch;
  state._groupMetaKey = await deriveGroupMetaKey(newSeed);
  // Clear sender chains for old epoch (they're now stale for sending)
  // Keep them for decryption of old messages that may still arrive
  markBizConvBackupDirty();

  // 3b. Re-encrypt server meta blob with new key so it can be decrypted
  // after backup restore with the new epoch's key
  if (state.meta && state._groupMetaKey) {
    try {
      const encryptedMeta = await encryptMetaBlob(state._groupMetaKey, state.meta);
      await bizConvUpdateMeta(conversationId, JSON.stringify(encryptedMeta));
    } catch (err) {
      log({ bizConvRotationMetaUpdateError: err?.message });
    }
  }

  // 4. Get remaining active members
  let activeMembers = [];
  try {
    const membersResult = await bizConvMembers(conversationId);
    activeMembers = (membersResult?.members || []).filter(m => {
      const digest = m.account_digest || m.accountDigest;
      return digest && digest !== selfDigest && digest !== removedDigest;
    });
  } catch (err) {
    log({ bizConvRotationMembersError: err?.message });
    // Fallback to local member list
    activeMembers = (state.members || []).filter(m => {
      const digest = m.accountDigest || m.account_digest;
      return digest && digest !== selfDigest && digest !== removedDigest;
    });
  }

  // 5. Distribute KDM to each remaining member
  let distributedCount = 0;
  // Include member profiles in KDM meta so recipients can display names/avatars
  const kdmMeta = { ...(state.meta || {}) };
  if (state.memberProfiles && Object.keys(state.memberProfiles).length > 0) {
    kdmMeta.members = Object.entries(state.memberProfiles).map(([digest, profile]) => ({
      accountDigest: digest,
      nickname: profile.nickname || null,
      avatar: profile.avatar || null
    }));
  }
  const kdmPayload = buildKDM({
    conversationId,
    epoch: newEpoch,
    groupSeed: newSeed,
    meta: kdmMeta
  });

  for (const member of activeMembers) {
    const digest = member.account_digest || member.accountDigest;
    const deviceId = member.device_id || member.deviceId || null;
    try {
      await sendKdmFn(digest, deviceId, kdmPayload);
      distributedCount++;
    } catch (err) {
      log({ bizConvKdmDistributeError: { peer: digest?.slice(-8), error: err?.message } });
    }
  }

  // 6. Confirm our own epoch
  try {
    await bizConvConfirmEpoch(conversationId, newEpoch);
  } catch (err) {
    log({ bizConvSelfEpochConfirmError: err?.message });
  }

  // 7. Record tombstone for the rotation event
  try {
    const metaKey = state._groupMetaKey;
    if (metaKey) {
      const tombstonePayload = await encryptTombstonePayload(metaKey, {
        type: 'key-rotated',
        reason,
        removed_digest: removedDigest,
        old_epoch: oldEpoch,
        new_epoch: newEpoch,
        ts: Date.now(),
        actor: selfDigest
      });
      await bizConvCreateTombstone(conversationId, 'key-rotated', JSON.stringify(tombstonePayload));
    }
  } catch (err) {
    log({ bizConvRotationTombstoneError: err?.message });
  }

  log({
    bizConvKeyRotated: {
      conversationId: conversationId?.slice(-8),
      oldEpoch,
      newEpoch,
      distributed: distributedCount,
      reason
    }
  });

  markBizConvBackupDirty();
  return { newEpoch, distributedCount };
}

/**
 * Handle receiving a new epoch KDM (called when a member gets a rotated key).
 * Stores the new seed, creates/updates conversation thread, and confirms epoch with server.
 *
 * @param {Object} kdm - Raw or parsed KDM payload
 */
export async function handleEpochKdm(kdm) {
  if (!kdm) return;

  // Normalize: raw KDM uses snake_case (conversation_id), parsed uses camelCase (conversationId)
  let parsed = kdm;
  if (kdm.msg_type === 'biz-conv-kdm' && !kdm.conversationId) {
    parsed = parseKDM(kdm);
  }
  if (!parsed || !parsed.conversationId) {
    log({ bizConvKdmIgnored: 'no conversationId', keys: Object.keys(kdm || {}) });
    return;
  }

  const state = await BizConvStore.initFromKDM(parsed);
  if (!state) return;

  // Store group metadata from KDM if available
  const meta = parsed.meta || kdm.meta || null;
  if (meta) {
    state.meta = meta;
    if (meta.owner) state.owner_account_digest = meta.owner;
  }
  state.status = 'active';

  // Store member profiles from KDM if available (for displaying non-contact members)
  if (meta?.members && Array.isArray(meta.members)) {
    if (!state.memberProfiles) state.memberProfiles = {};
    for (const m of meta.members) {
      if (m?.accountDigest) {
        state.memberProfiles[m.accountDigest.toUpperCase()] = {
          nickname: m.nickname || null,
          avatar: m.avatar || null
        };
      }
    }
  }

  // Create/update conversation thread so the group appears in the conversation list
  const groupName = meta?.name || null;
  const memberCount = (meta?.members && Array.isArray(meta.members)) ? meta.members.length : 0;
  upsertBizConvThread(parsed.conversationId, {
    name: groupName,
    memberCount,
    isOwner: false,
    status: 'active',
    avatar: meta?.avatar || null,
    unreadCount: 0  // KDM is not a user message — don't show unread badge
  });

  // Dispatch a custom event so the UI can re-render the conversation list.
  // The message-flow-controller should also trigger this, but this is a safety net
  // in case the KDM arrives through a different code path (e.g. sync, restore).
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('biz-conv:thread-added', {
        detail: { conversationId: parsed.conversationId, name: groupName }
      }));
    }
  } catch (_) { /* ignore in non-browser env */ }

  // Confirm epoch with server
  try {
    await bizConvConfirmEpoch(parsed.conversationId, parsed.epoch);
    log({ bizConvEpochConfirmed: { conversationId: parsed.conversationId?.slice(-8), epoch: parsed.epoch } });
  } catch (err) {
    log({ bizConvEpochConfirmError: { conversationId: parsed.conversationId?.slice(-8), error: err?.message } });
  }

  markBizConvBackupDirty();
}
