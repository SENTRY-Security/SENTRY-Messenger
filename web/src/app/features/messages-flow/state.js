// /app/features/messages-flow/state.js
// State access for DR snapshots and vault keys. Stub only in this phase.

export function createMessageStateAccess(deps = {}) {
  void deps;
  return {
    // TODO: wire to contact-secrets / message_key_vault.
    getLocalCounter() {
      throw new Error('messages-flow state access not implemented');
    },

    // TODO: wire to contact-secrets / message_key_vault.
    loadDrSnapshot() {
      throw new Error('messages-flow state access not implemented');
    },

    // TODO: wire to contact-secrets / message_key_vault.
    saveDrSnapshot() {
      throw new Error('messages-flow state access not implemented');
    },

    // TODO: wire to contact-secrets / message_key_vault.
    vaultPutIncoming() {
      throw new Error('messages-flow state access not implemented');
    },

    // TODO: wire to contact-secrets / message_key_vault.
    vaultGetReplayKey() {
      throw new Error('messages-flow state access not implemented');
    }
  };
}
