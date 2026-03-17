/**
 * Business Conversation Feature Module
 *
 * In-memory store for business conversation state.
 * Hydrated from server-side encrypted backup on login, cleared on logout.
 */

import { bytesToB64Url, b64UrlToBytes } from '../../shared/utils/base64.js';
import {
  deriveGroupMetaKey,
  deriveSenderChainKey,
  deriveBizConvId,
  decryptMetaBlob,
  decryptPolicyBlob,
  decryptRoleBlob,
  encryptMetaBlob,
  encryptPolicyBlob,
  encryptRoleBlob,
  encryptTombstonePayload,
  decryptTombstonePayload,
  encryptWithChainState,
  decryptWithChainState,
  buildKDM,
  parseKDM
} from '../../shared/crypto/biz-conv.js';
import { upsertBizConvThread } from './conversation-updates.js';
import { getAccountDigest } from '../core/store.js';

// Re-export crypto utilities for convenience
export {
  deriveGroupMetaKey,
  deriveSenderChainKey,
  deriveBizConvId,
  encryptMetaBlob,
  decryptMetaBlob,
  encryptPolicyBlob,
  decryptPolicyBlob,
  encryptRoleBlob,
  decryptRoleBlob,
  encryptTombstonePayload,
  decryptTombstonePayload,
  buildKDM,
  parseKDM
};

// ── BizConvStore (Memory Singleton) ──────────────────────────────

function createConversationState(conversationId) {
  return {
    conversation_id: conversationId,
    owner_account_digest: null,
    status: 'active',

    // Keys (memory only)
    seeds: {},          // epoch → Uint8Array(32)
    currentEpoch: 0,
    _groupMetaKey: null, // CryptoKey cache

    // Decrypted metadata
    meta: null,
    policy: null,
    members: [],

    // Sender chain states: `${epoch}:${deviceId}` → ChainState
    senderChains: {},

    // Member profiles: accountDigest(upper) → { nickname, avatar }
    // Populated from KDM meta so non-contact members can display names/avatars
    memberProfiles: {},

    // UI state
    unreadCount: 0,
    lastMessagePreview: null,
    lastSyncTs: 0
  };
}

export const BizConvStore = {
  conversations: new Map(),

  get(conversationId) {
    return this.conversations.get(conversationId) || null;
  },

  getOrCreate(conversationId) {
    if (!this.conversations.has(conversationId)) {
      this.conversations.set(conversationId, createConversationState(conversationId));
    }
    return this.conversations.get(conversationId);
  },

  remove(conversationId) {
    this.conversations.delete(conversationId);
  },

  clear() {
    this.conversations.clear();
  },

  /**
   * List all active conversations sorted by last update.
   */
  listActive() {
    const result = [];
    for (const [, state] of this.conversations) {
      if (state.status === 'active') result.push(state);
    }
    result.sort((a, b) => {
      const tsA = a.lastMessagePreview?.ts || a.lastSyncTs || 0;
      const tsB = b.lastMessagePreview?.ts || b.lastSyncTs || 0;
      return tsB - tsA;
    });
    return result;
  },

  /**
   * Build backup payload for server-side encrypted persistence.
   */
  buildBackupPayload() {
    const conversations = {};
    for (const [convId, state] of this.conversations) {
      // Only backup active groups — dissolved/left groups are hard-deleted
      if (state.status !== 'active') continue;

      const seeds = {};
      for (const [epoch, seed] of Object.entries(state.seeds)) {
        seeds[epoch] = bytesToB64Url(seed);
      }
      const senderChains = {};
      for (const [key, chain] of Object.entries(state.senderChains)) {
        senderChains[key] = {
          chain_key_b64: bytesToB64Url(chain.chainKey),
          counter: chain.counter
          // skipped_keys not backed up (too large, short-lived)
        };
      }
      conversations[convId] = {
        seeds,
        current_epoch: state.currentEpoch,
        sender_chains: senderChains,
        meta: state.meta || null,
        owner_account_digest: state.owner_account_digest || null,
        status: state.status || 'active',
        member_profiles: state.memberProfiles || null,
        policy: state.policy || null
      };
    }
    return {
      v: 1,
      conversations,
      updated_at: Date.now()
    };
  },

  /**
   * Restore from decrypted backup payload.
   * @param {Object} backup - Decrypted backup with `conversations` map
   * @param {Set<string>|null} [activeServerIds] - If provided, skip groups not in this set
   */
  async restoreFromBackup(backup, activeServerIds = null) {
    if (!backup || !backup.conversations) return;

    for (const [convId, convData] of Object.entries(backup.conversations)) {
      // Skip groups that were left/dissolved (server no longer lists them)
      if (activeServerIds && !activeServerIds.has(convId)) continue;

      // Per-group try/catch: one corrupt group must not abort all restoration
      try {
        const state = this.getOrCreate(convId);

        // Restore seeds
        for (const [epoch, seedB64] of Object.entries(convData.seeds || {})) {
          state.seeds[Number(epoch)] = b64UrlToBytes(seedB64);
        }
        state.currentEpoch = convData.current_epoch || 0;

        // Derive groupMetaKey — try currentEpoch first, fall back to highest available epoch
        const currentSeed = state.seeds[state.currentEpoch];
        if (currentSeed) {
          state._groupMetaKey = await deriveGroupMetaKey(currentSeed);
        } else {
          // currentEpoch seed missing (e.g. stale backup after key rotation) — try highest epoch
          const epochs = Object.keys(state.seeds).map(Number).sort((a, b) => b - a);
          for (const ep of epochs) {
            if (state.seeds[ep]) {
              state._groupMetaKey = await deriveGroupMetaKey(state.seeds[ep]);
              state.currentEpoch = ep;
              break;
            }
          }
        }

        // Restore sender chain states
        for (const [key, chain] of Object.entries(convData.sender_chains || {})) {
          state.senderChains[key] = {
            chainKey: b64UrlToBytes(chain.chain_key_b64),
            counter: chain.counter,
            skippedKeys: new Map()
          };
        }

        // Restore metadata
        if (convData.meta) state.meta = convData.meta;
        if (convData.owner_account_digest) state.owner_account_digest = convData.owner_account_digest;
        if (convData.member_profiles) state.memberProfiles = convData.member_profiles;
        if (convData.policy) state.policy = convData.policy;
        state.status = convData.status || 'active';

        // Rebuild conversation thread so it appears in the UI
        if (state.status === 'active') {
          const selfDigest = getAccountDigest();
          const isOwner = selfDigest && state.owner_account_digest
            ? selfDigest.toUpperCase() === state.owner_account_digest.toUpperCase()
            : false;
          upsertBizConvThread(convId, {
            name: state.meta?.name || null,
            isOwner,
            status: 'active',
            avatar: state.meta?.avatar || null,
            unreadCount: 0  // Restoring from backup — don't show phantom unread badges
          });
        }
      } catch (err) {
        console.warn('[biz-conv] restoreFromBackup: skipping group', convId?.slice(0, 16), err?.message);
      }
    }
  },

  /**
   * Initialize a new conversation from a received KDM.
   */
  async initFromKDM(kdm) {
    // Accept both raw KDM (snake_case) and already-parsed KDM (camelCase)
    let parsed;
    if (kdm?.conversationId && kdm?.groupSeed) {
      // Already parsed format
      parsed = kdm;
    } else if (kdm?.msg_type === 'biz-conv-kdm') {
      // Raw format — parse it
      parsed = parseKDM(kdm);
    } else {
      parsed = parseKDM(kdm);
    }
    if (!parsed || !parsed.conversationId || !parsed.groupSeed) return null;

    const state = this.getOrCreate(parsed.conversationId);
    state.seeds[parsed.epoch] = parsed.groupSeed;
    state.currentEpoch = Math.max(state.currentEpoch, parsed.epoch);
    state._groupMetaKey = await deriveGroupMetaKey(parsed.groupSeed);

    return state;
  },

  /**
   * Resolve a member's profile (nickname/avatar) from KDM-provided data.
   * Falls back to null if not found.
   */
  getMemberProfile(conversationId, accountDigest) {
    const state = this.get(conversationId);
    if (!state?.memberProfiles || !accountDigest) return null;
    return state.memberProfiles[accountDigest.toUpperCase()] || null;
  },

  /**
   * Get or derive sender chain state for encryption.
   */
  async getSenderChainState(conversationId, epoch, deviceId) {
    const state = this.get(conversationId);
    if (!state) throw new Error('No active session for conversation');

    const key = `${epoch}:${deviceId}`;
    if (!state.senderChains[key]) {
      const seed = state.seeds[epoch];
      if (!seed) throw new Error(`No seed for epoch ${epoch}`);
      const chainKey = await deriveSenderChainKey(seed, epoch, deviceId);
      state.senderChains[key] = {
        chainKey,
        counter: 0,
        skippedKeys: new Map()
      };
    }
    return state.senderChains[key];
  },

  /**
   * Encrypt a message for a business conversation.
   */
  async encryptMessage(conversationId, deviceId, plaintext) {
    const state = this.get(conversationId);
    if (!state) throw new Error('No active session');

    const chainState = await this.getSenderChainState(conversationId, state.currentEpoch, deviceId);
    return encryptWithChainState(chainState, state.currentEpoch, deviceId, plaintext);
  },

  /**
   * Decrypt a message from a business conversation.
   */
  async decryptMessage(conversationId, envelope) {
    const state = this.get(conversationId);
    if (!state) throw new Error('No active session');

    const { epoch, sender_device_id } = envelope;
    const seed = state.seeds[epoch];
    if (!seed) throw new Error(`No seed for epoch ${epoch}`);

    const key = `${epoch}:${sender_device_id}`;
    if (!state.senderChains[key]) {
      const chainKey = await deriveSenderChainKey(seed, epoch, sender_device_id);
      state.senderChains[key] = {
        chainKey,
        counter: 0,
        skippedKeys: new Map()
      };
    }

    return decryptWithChainState(state.senderChains[key], seed, envelope);
  }
};
