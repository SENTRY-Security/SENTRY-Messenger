// /app/features/messages-flow/live/state-live.js
// State access for live (B-route) flow. Stub only.

export function createLiveStateAccess(deps = {}) {
  const adapters = deps?.adapters || null;

  return {
    // TODO: wire to DR state bootstrap (legacy adapter for now).
    async ensureDrReceiverState(conversationId, peerAccountDigest, peerDeviceId) {
      if (adapters?.ensureDrReceiverState) {
        return adapters.ensureDrReceiverState(conversationId, peerAccountDigest, peerDeviceId);
      }
      throw new Error('messages-flow live state access not implemented');
    },

    // TODO: wire to MessageKeyVault incoming key writes.
    async vaultPutIncomingKey(params = {}) {
      if (adapters?.vaultPutIncomingKey) {
        return adapters.vaultPutIncomingKey(params);
      }
      throw new Error('messages-flow live state access not implemented');
    }
  };
}
