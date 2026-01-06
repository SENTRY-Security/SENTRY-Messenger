// /app/features/messages-flow/presentation.js
// Presentation adapter. Placeholder logic is owned by UI; stub only here.

export function createMessagePresentation(deps = {}) {
  void deps;
  return {
    // TODO: plan placeholder ranges for gap/replay.
    planPlaceholdersForGap() {
      throw new Error('messages-flow presentation not implemented');
    },

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
