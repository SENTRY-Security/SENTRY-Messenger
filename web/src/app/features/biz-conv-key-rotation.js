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

import { BizConvStore, deriveGroupMetaKey, buildKDM, encryptTombstonePayload } from './biz-conv.js';
import {
  bizConvIncrementEpoch,
  bizConvConfirmEpoch,
  bizConvMembers,
  bizConvCreateTombstone
} from '../api/biz-conv.js';
import { markBizConvBackupDirty } from './biz-conv-backup.js';
import { getAccountDigest, ensureDeviceId } from '../core/store.js';
import { log } from '../core/log.js';

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
  const { reason = 'manual', removedDigest = null, sendKdmFn = null } = opts;

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
  const kdmPayload = buildKDM({
    conversationId,
    epoch: newEpoch,
    groupSeed: newSeed,
    meta: state.meta || null
  });

  for (const member of activeMembers) {
    const digest = member.account_digest || member.accountDigest;
    const deviceId = member.device_id || member.deviceId || null;
    try {
      if (typeof sendKdmFn === 'function') {
        await sendKdmFn(digest, deviceId, kdmPayload);
        distributedCount++;
      }
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
 * Stores the new seed and confirms epoch with server.
 *
 * @param {Object} kdm - Parsed KDM payload from initFromKDM
 */
export async function handleEpochKdm(kdm) {
  if (!kdm || !kdm.conversationId) return;

  const state = await BizConvStore.initFromKDM(kdm);
  if (!state) return;

  // Confirm epoch with server
  try {
    await bizConvConfirmEpoch(kdm.conversationId, kdm.epoch);
    log({ bizConvEpochConfirmed: { conversationId: kdm.conversationId?.slice(-8), epoch: kdm.epoch } });
  } catch (err) {
    log({ bizConvEpochConfirmError: { conversationId: kdm.conversationId?.slice(-8), error: err?.message } });
  }

  markBizConvBackupDirty();
}
