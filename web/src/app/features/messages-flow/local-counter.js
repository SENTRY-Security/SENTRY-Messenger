import { getDrSessMap, normalizePeerIdentity } from '../../core/store.js';
import { sessionStore } from '../../ui/mobile/session-store.js';

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

export async function getLocalProcessedCounter({ conversationId } = {}, deps = {}) {
  const convId = normalizeConversationId(conversationId);
  if (!convId) return 0;
  const onUnknown = typeof deps?.onUnknown === 'function' ? deps.onUnknown : null;
  const resolvePeer = typeof deps?.resolvePeerIdentity === 'function'
    ? deps.resolvePeerIdentity
    : resolvePeerIdentityFromStore;
  const identity = resolvePeer(convId);
  if (!identity?.key) {
    if (onUnknown) onUnknown({ conversationId: convId, reasonCode: 'MISSING_PEER_IDENTITY' });
    return 0;
  }
  const drSessMap = typeof deps?.getDrSessMap === 'function'
    ? deps.getDrSessMap()
    : getDrSessMap();
  const holder = drSessMap && typeof drSessMap.get === 'function'
    ? drSessMap.get(identity.key)
    : null;
  const counter = normalizeCounter(holder?.NrTotal);
  if (counter === null) {
    if (onUnknown) {
      onUnknown({
        conversationId: convId,
        reasonCode: holder ? 'INVALID_COUNTER' : 'MISSING_DR_STATE'
      });
    }
    return 0;
  }
  return counter;
}
