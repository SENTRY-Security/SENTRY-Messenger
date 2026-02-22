import { getDrSessMap, normalizePeerIdentity } from '../../core/store.js';
import { logCapped } from '../../core/log.js';
import { sessionStore } from '../../ui/mobile/session-store.js';
import { MessageKeyVault } from '../message-key-vault.js';

function slicePrefix8(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value).slice(0, 8);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 8) : null;
}

function normalizeConversationId(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function normalizeCounter(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (!Number.isInteger(num)) return null;
  if (num < 0) return null;
  return num;
}

function resolvePeerIdentityFromStore(conversationId) {
  if (!conversationId) return null;
  const convIndex = sessionStore?.conversationIndex;
  const entry = convIndex && typeof convIndex.get === 'function'
    ? convIndex.get(conversationId)
    : null;
  const threads = sessionStore?.conversationThreads;
  const thread = threads && typeof threads.get === 'function'
    ? threads.get(conversationId)
    : null;
  const peerAccountDigest = entry?.peerAccountDigest
    || entry?.peerKey
    || thread?.peerAccountDigest
    || thread?.peerKey
    || null;
  const peerDeviceId = entry?.peerDeviceId || thread?.peerDeviceId || null;
  return normalizePeerIdentity({ peerAccountDigest, peerDeviceId });
}

/**
 * Get the local processed counter for a conversation.
 * This is the maximum incoming counter that has a key in the vault.
 * 
 * Priority:
 * 1. Vault (server-side truth) - most reliable
 * 2. DR state NrTotal (memory fallback) - may be stale
 */
export async function getLocalProcessedCounter({ conversationId } = {}, deps = {}) {
  const convId = normalizeConversationId(conversationId);
  if (!convId) {
    logCapped('localCounterProviderTrace', {
      conversationIdPrefix8: slicePrefix8(conversationId),
      peerKeyPrefix8: null,
      ok: false,
      source: 'unknown',
      nrTotal: null,
      unknownReason: 'MISSING_CONVERSATION_ID',
      hasHolder: false
    }, 5);
    return 0;
  }

  const onUnknown = typeof deps?.onUnknown === 'function' ? deps.onUnknown : null;
  const resolvePeer = typeof deps?.resolvePeerIdentity === 'function'
    ? deps.resolvePeerIdentity
    : resolvePeerIdentityFromStore;
  const identity = resolvePeer(convId);

  // Try to get from vault (may be stale if vault put is still in-flight)
  let vaultResult = null;
  try {
    const getLatestState = typeof deps?.getLatestState === 'function'
      ? deps.getLatestState
      : MessageKeyVault.getLatestState;
    const getVaultKey = typeof deps?.getMessageKey === 'function'
      ? deps.getMessageKey
      : MessageKeyVault.getMessageKey;

    // optimization: if we have a serverMax hint, check if we have that specific key in vault.
    // If we do, that is our localMax (we are fully synced to server tip).
    const serverMax = deps?.serverMax;
    if (Number.isFinite(serverMax)) {
      const { ok } = await getVaultKey({
        conversationId: convId,
        senderDeviceId: identity?.deviceId || null,
        headerCounter: serverMax
      });
      if (ok) {
        logCapped('localCounterProviderTrace', {
          conversationIdPrefix8: slicePrefix8(convId),
          peerKeyPrefix8: slicePrefix8(identity?.key),
          ok: true,
          source: 'vault_tip_check',
          nrTotal: serverMax,
          hasHolder: true
        }, 5);
        return serverMax;
      }
    }

    const latestState = await getLatestState({
      conversationId: convId,
      senderDeviceId: identity?.deviceId || null
    });

    const vaultCounter = normalizeCounter(latestState?.incoming?.header_counter);
    if (vaultCounter !== null) {
      // [FIX] Do NOT return vault counter immediately — it may be stale.
      // After a live decrypt, DR state NrTotal is updated in memory instantly
      // but the vault put is async (10-100ms). During this window the vault
      // still reports the OLD counter, causing the next message's gap check
      // to see a false gap (counter > localMax+1) even though the DR state
      // has already advanced.  We take MAX(vault, drNrTotal) below.
      vaultResult = vaultCounter;
    }
  } catch (err) {
    // Vault query failed, fallback to DR state
    logCapped('localCounterVaultError', {
      conversationIdPrefix8: slicePrefix8(convId),
      error: err?.message || String(err)
    }, 5);
  }

  // Read DR state in memory (always up-to-date after live decrypt)
  let drCounter = null;
  if (identity?.key) {
    const drSessMap = typeof deps?.getDrSessMap === 'function'
      ? deps.getDrSessMap()
      : getDrSessMap();
    const holder = drSessMap && typeof drSessMap.get === 'function'
      ? drSessMap.get(identity.key)
      : null;
    drCounter = normalizeCounter(holder?.NrTotal);
  }

  // [FIX] Take MAX(vault, drNrTotal) to avoid stale-vault false gaps.
  // Both values are monotonically increasing, so MAX is always safe.
  const bestCounter = Math.max(vaultResult ?? -1, drCounter ?? -1);

  if (bestCounter >= 0) {
    const source = (vaultResult !== null && (vaultResult >= (drCounter ?? -1)))
      ? 'vault'
      : (drCounter !== null ? 'dr_state' : 'vault');
    logCapped('localCounterProviderTrace', {
      conversationIdPrefix8: slicePrefix8(convId),
      peerKeyPrefix8: slicePrefix8(identity?.key),
      ok: true,
      source,
      nrTotal: bestCounter,
      vaultCounter: vaultResult,
      drCounter,
      hasHolder: true
    }, 5);
    return bestCounter;
  }

  // Neither source has a valid counter
  if (!identity?.key) {
    logCapped('localCounterProviderTrace', {
      conversationIdPrefix8: slicePrefix8(convId),
      peerKeyPrefix8: null,
      ok: false,
      source: 'unknown',
      nrTotal: null,
      unknownReason: 'MISSING_PEER_IDENTITY',
      hasHolder: false
    }, 5);
    if (onUnknown) {
      onUnknown({
        conversationId: convId,
        reasonCode: 'MISSING_PEER_IDENTITY',
        source: 'unknown',
        unknownReason: 'MISSING_PEER_IDENTITY'
      });
    }
    return 0;
  }

  logCapped('localCounterProviderTrace', {
    conversationIdPrefix8: slicePrefix8(convId),
    peerKeyPrefix8: slicePrefix8(identity.key),
    ok: false,
    source: 'dr_state_fallback',
    nrTotal: null,
    unknownReason: 'MISSING_DR_STATE',
    hasHolder: false
  }, 5);
  if (onUnknown) {
    onUnknown({
      conversationId: convId,
      reasonCode: 'MISSING_DR_STATE',
      source: 'dr_state_fallback',
      unknownReason: 'MISSING_DR_STATE'
    });
  }
  return 0;
}
