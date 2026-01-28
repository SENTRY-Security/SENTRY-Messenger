// State access for replay keys. Stub only in this phase.

export function createMessageStateAccess(deps = {}) {
  void deps;
  return {
    // TODO: wire to contact-secrets / message_key_vault.
    vaultGetReplayKey() {
      throw new Error('messages-flow state access not implemented');
    }
  };
}
