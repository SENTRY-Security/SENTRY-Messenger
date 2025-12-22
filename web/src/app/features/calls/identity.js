import { normalizeAccountDigest, normalizePeerDeviceId } from '../../core/store.js';

export function buildCallPeerIdentity({ peerAccountDigest, peerDeviceId } = {}) {
  const digest = normalizeAccountDigest(peerAccountDigest);
  if (!digest) {
    throw new Error('peerAccountDigest required for call identity');
  }
  const deviceId = normalizePeerDeviceId(peerDeviceId);
  if (!deviceId) {
    throw new Error('peerDeviceId required for call identity');
  }
  return {
    peerKey: `${digest}::${deviceId}`,
    digest,
    deviceId
  };
}

export function logCallIdentitySet({ callId = null, peerAccountDigest = null, peerDeviceId = null, peerKey = null } = {}) {
  try {
    console.log('[call] identity:set', JSON.stringify({
      callId: callId || null,
      peerAccountDigest: peerAccountDigest || null,
      peerDeviceId: peerDeviceId || null,
      peerKey: peerKey || null
    }));
  } catch {}
}
