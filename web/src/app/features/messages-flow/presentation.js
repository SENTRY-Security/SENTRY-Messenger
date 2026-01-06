// Presentation adapter for replay outputs. Placeholder logic is owned by UI; stub only here.

export function createMessagePresentation(deps = {}) {
  void deps;
  return {
    // TODO: apply decrypted message to UI state.
    applyDecryptedMessage() {
      throw new Error('messages-flow presentation not implemented');
    },

    // TODO: mark decrypt failures for UI.
    markDecryptFailed() {
      throw new Error('messages-flow presentation not implemented');
    }
  };
}
